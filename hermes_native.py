"""Turns for sessions the Hermes API server does not own, sent the way the Hermes CLI sends them.

Upstream gives every conversation one owning surface. The API server's ``/api/sessions/{id}/chat/stream``
admits turns only into sessions it created (``source`` ``api_server`` or ``bot_room``); a session created by
the desktop app, CLI, TUI or a messaging platform is refused with ``permission_denied``. Such turns go through
the documented ``hermes chat --resume <id> --oneshot --query-file - --format stream-json`` instead, which
submits through the session's owner like every other local surface, and its JSONL events are translated into
the SSE frames the client already consumes. Stop goes through ``hermes_interrupt.py``.

Standard library only; Hermes's interpreter and bootstrap come from ``hermes --print-runtime-command``.
"""
import json
import os
import re
import secrets
import shutil
import subprocess
import time
from threading import Lock

HERE = os.path.dirname(os.path.abspath(__file__))
INTERRUPT_HELPER = os.path.join(HERE, "hermes_interrupt.py")
# Sources whose sessions the API server owns: these keep the REST stream (clarify cards, run stop).
API_SOURCES = frozenset({"api_server", "bot_room"})
RUN_PREFIX = "uplink-native-"
RUN_ID_RE = re.compile(r"^" + re.escape(RUN_PREFIX) + r"[A-Za-z0-9_-]{16,64}$")
RESOLVE_TIMEOUT = 60
INTERRUPT_TIMEOUT = 60
RUN_TTL = 24 * 60 * 60
NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)
# The bootstrap's last statement runs the CLI module; the helper replaces exactly this tail.
_MAIN_TAIL = "runpy.run_module('hermes_cli.main', run_name='__main__', alter_sys=True)"


class NativeUnavailable(RuntimeError):
    pass


class Runtime:
    """Hermes's launch command, resolved once from the published launcher and re-resolved after a failure
    (a ``hermes update`` can move the interpreter)."""

    def __init__(self, cli=None):
        self.cli = cli
        self._base = None
        self._lock = Lock()

    def configure(self, cli):
        with self._lock:
            self.cli, self._base = cli, None

    def available(self):
        return bool(self._launcher())

    def _launcher(self):
        return self.cli or shutil.which("hermes")

    def invalidate(self):
        with self._lock:
            self._base = None

    def base(self):
        with self._lock:
            if self._base is None:
                self._base = self._resolve()
            return list(self._base)

    def _resolve(self):
        launcher = self._launcher()
        if not launcher:
            raise NativeUnavailable("the hermes command was not found (set HERMES_CLI or --hermes-cli)")
        try:
            done = subprocess.run([launcher, "--print-runtime-command"], capture_output=True, timeout=RESOLVE_TIMEOUT,
                                  stdin=subprocess.DEVNULL, creationflags=NO_WINDOW)
        except (OSError, subprocess.SubprocessError) as error:
            raise NativeUnavailable(f"could not run {launcher}: {error}") from error
        try:
            argv = json.loads(done.stdout.decode("utf-8").strip().splitlines()[-1])
        except (UnicodeDecodeError, ValueError, IndexError):
            argv = None
        if (done.returncode != 0 or not isinstance(argv, list) or len(argv) < 4
                or not all(isinstance(part, str) for part in argv) or argv[-2] != "-c"):
            raise NativeUnavailable("hermes --print-runtime-command returned no usable launch command")
        return argv

    def turn_command(self, session_id):
        return self.base() + ["chat", "--resume", session_id, "--oneshot", "--query-file", "-",
                              "--format", "stream-json"]

    def helper_command(self, script, *args):
        base = self.base()
        code = base[-1]
        if not code.endswith(_MAIN_TAIL):
            raise NativeUnavailable("unrecognized Hermes launch bootstrap; update Uplink")
        code = code[:-len(_MAIN_TAIL)] + f"runpy.run_path({script!r}, run_name='__main__')"
        return base[:-1] + [code, *args]


RUNTIME = Runtime()


def wants_native(source):
    """True for a session the API server does not own (see the module docstring)."""
    return isinstance(source, str) and bool(source) and source not in API_SOURCES


class Runs:
    """run_id -> session_id for native turns, so ``POST /v1/runs/{run_id}/stop`` can find the session."""

    def __init__(self):
        self._lock = Lock()
        self._runs = {}

    def start(self, session_id):
        run_id = RUN_PREFIX + secrets.token_urlsafe(18)
        now = time.monotonic()
        with self._lock:
            for key, (_, started) in list(self._runs.items()):
                if now - started > RUN_TTL:
                    del self._runs[key]
            self._runs[run_id] = (session_id, now)
        return run_id

    def finish(self, run_id):
        with self._lock:
            self._runs.pop(run_id, None)

    def session_of(self, run_id):
        with self._lock:
            entry = self._runs.get(run_id)
        return entry[0] if entry else None


RUNS = Runs()


def interrupt(session_id):
    """Interrupt the session's running turn. Returns (ok, reason)."""
    for attempt in (1, 2):
        try:
            command = RUNTIME.helper_command(INTERRUPT_HELPER, session_id)
            done = subprocess.run(command, capture_output=True, timeout=INTERRUPT_TIMEOUT,
                                  stdin=subprocess.DEVNULL, creationflags=NO_WINDOW)
        except NativeUnavailable as error:
            return False, str(error)
        except (OSError, subprocess.SubprocessError) as error:
            RUNTIME.invalidate()
            if attempt == 2:
                return False, f"interrupt helper failed: {error}"
            continue
        try:
            answer = json.loads(done.stdout.decode("utf-8", "replace").strip().splitlines()[-1])
            return bool(answer.get("ok")), str(answer.get("reason", ""))
        except (ValueError, IndexError, AttributeError):
            return False, (done.stderr.decode("utf-8", "replace").strip().splitlines() or ["interrupt failed"])[-1][:200]
    return False, "interrupt failed"


class Translator:
    """``hermes chat --format stream-json`` events -> the API server's session-stream SSE events.

    Event names and fields match what ``/api/sessions/{id}/chat/stream`` emits and ``web/app.js``'s
    ``handleFrame`` reads; every frame carries ``run_id`` so the client's Stop reaches ``RUNS``."""

    def __init__(self, session_id, run_id):
        self.session_id, self.run_id = session_id, run_id
        self.streamed = ""
        self.finished = False

    def _frame(self, event, **data):
        return event, {**data, "session_id": self.session_id, "run_id": self.run_id}

    def started(self):
        return [self._frame("run.started")]

    def translate(self, event):
        kind = event.get("type") if isinstance(event, dict) else None
        if kind == "text":
            text = event.get("text")
            if not isinstance(text, str) or not text:
                return []
            self.streamed += text
            return [self._frame("assistant.delta", delta=text)]
        if kind == "tool_use":
            data = {"tool_name": str(event.get("name") or "tool")}
            if isinstance(event.get("input"), dict):
                data["args"] = event["input"]
            if event.get("tool_call_id"):
                data["tool_call_id"] = str(event["tool_call_id"])
            return [self._frame("tool.started", **data)]
        if kind == "tool_result":
            data = {"tool_name": str(event.get("name") or "tool"), "preview": str(event.get("output") or "")}
            if event.get("tool_call_id"):
                data["tool_call_id"] = str(event["tool_call_id"])
            return [self._frame("tool.failed" if event.get("is_error") else "tool.completed", **data)]
        if kind == "result":
            return self._result(event)
        return []  # "system" init and anything newer: nothing for the client

    def _result(self, event):
        self.finished = True
        frames = []
        text = event.get("text") if isinstance(event.get("text"), str) else ""
        # A viewer that fell behind re-attaches and stops streaming deltas (``replay_gap``); the result carries
        # the whole reply, so send what the deltas missed.
        if text and text.startswith(self.streamed) and len(text) > len(self.streamed):
            frames.append(self._frame("assistant.delta", delta=text[len(self.streamed):]))
            self.streamed = text
        code = event.get("exit_code")
        if code == 0:
            frames.append(self._frame("assistant.completed", content=text))
            frames.append(self._frame("run.completed"))
        else:
            message = event.get("error") or ("interrupted" if code == 130 else f"turn did not complete (exit {code})")
            frames.append(self._frame("error", message=str(message)))
        frames.append(self._frame("done"))
        return frames

    def failure(self, message):
        """The process ended without a ``result`` record."""
        self.finished = True
        return [self._frame("error", message=message), self._frame("done")]


def sse(event, data):
    return f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n".encode("utf-8")


def spawn_turn(session_id):
    return subprocess.Popen(RUNTIME.turn_command(session_id), stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                            stderr=subprocess.PIPE, creationflags=NO_WINDOW)

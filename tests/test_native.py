import contextlib
import http.client
import json
import subprocess
import sys
import threading
import types
import unittest
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from uplink import interrupt_helper, native, server  # noqa: E402

# What `hermes chat --format stream-json` printed for a real turn (fields as observed on 2026-11-04).
CLI_EVENTS = [
    {"type": "system", "subtype": "init", "model": "", "session_id": ""},
    {"type": "text", "text": "Run"},
    {"type": "tool_use", "name": "terminal", "tool_call_id": "call_1", "input": {"command": "ls"}},
    {"type": "tool_result", "name": "terminal", "tool_call_id": "call_1", "output": "a.txt", "is_error": False},
    {"type": "text", "text": "ning"},
    {"type": "result", "session_id": "s", "exit_code": 0, "text": "Running done"},
]


def frames(body):
    out = []
    for block in body.decode("utf-8").split("\n\n"):
        lines = block.split("\n")
        if lines and lines[0].startswith("event: "):
            out.append((lines[0][7:], json.loads(lines[1][6:])))
    return out


class TranslatorTests(unittest.TestCase):
    def test_cli_events_become_the_session_stream_frames_the_client_reads(self):
        translator = native.Translator("s", "uplink-native-x")
        produced = translator.started()
        for event in CLI_EVENTS:
            produced += translator.translate(event)
        names = [name for name, _ in produced]
        self.assertEqual(names, ["run.started", "assistant.delta", "tool.started", "tool.completed", "assistant.delta",
                                 "assistant.delta", "assistant.completed", "run.completed", "done"])
        data = dict(produced[2][1])
        self.assertEqual((data["tool_name"], data["args"], data["tool_call_id"]), ("terminal", {"command": "ls"}, "call_1"))
        # The result's text extends what was streamed (replay gap): only the missing suffix is sent.
        self.assertEqual(produced[5][1]["delta"], " done")
        self.assertTrue(all(payload["run_id"] == "uplink-native-x" for _, payload in produced))

    def test_failed_or_interrupted_turn_ends_with_an_error_frame(self):
        translator = native.Translator("s", "r")
        produced = translator.translate({"type": "result", "exit_code": 3, "text": "",
                                         "error": "This chat is paused behind a turn"})
        self.assertEqual([name for name, _ in produced], ["error", "done"])
        self.assertIn("paused", produced[0][1]["message"])
        produced = native.Translator("s", "r").translate({"type": "result", "exit_code": 130, "text": ""})
        self.assertEqual(produced[0], ("error", {"message": "interrupted", "session_id": "s", "run_id": "r"}))

    def test_helper_command_replaces_only_the_cli_entry(self):
        runtime = native.Runtime("hermes")
        boot = "import os, sys, runpy; sys.path.insert(0, 'C:\\\\h'); " + native._MAIN_TAIL
        runtime._base = ["python.exe", "-I", "-c", boot]
        command = runtime.helper_command("E:\\u\\interrupt_helper.py", "sid")
        self.assertEqual(command[:3], ["python.exe", "-I", "-c"])
        self.assertTrue(command[3].endswith("runpy.run_path('E:\\\\u\\\\interrupt_helper.py', run_name='__main__')"))
        self.assertEqual(command[4], "sid")
        runtime._base = ["python.exe", "-I", "-c", "runpy.run_module('other')"]
        with self.assertRaises(native.NativeUnavailable):
            runtime.helper_command("x.py")


def sse(event, data):
    return f"event: {event}\ndata: {json.dumps(data)}\n\n".encode()


# What a gateway from 0.22.1 on streams for a turn into a session it does not own (the admission refusal is raised
# inside the turn, after the stream has started).
REFUSAL = [sse("run.started", {"run_id": "run_rest"}), sse("message.started", {"run_id": "run_rest"}),
           sse("error", {"message": "permission_denied", "run_id": "run_rest"}), sse("done", {"run_id": "run_rest"})]
ADMITTED = [sse("run.started", {"run_id": "run_rest"}), sse("assistant.delta", {"delta": "via rest"}),
            sse("run.completed", {"run_id": "run_rest"}), sse("done", {})]


class InterruptHelperTests(unittest.TestCase):
    def test_interrupt_works_without_outside_restart_wait(self):
        """0.22.1-0.22.5 have connect_gateway and the interrupt RPCs but not outside_restart_wait."""
        calls = []

        class Client:
            async def rpc(self, method, **params):
                calls.append((method, params))
                return {"execution_generation": 7}

        @contextlib.asynccontextmanager
        async def connect_gateway():
            yield Client()

        package = types.ModuleType("hermes_cli")
        package.gateway_client = types.SimpleNamespace(connect_gateway=connect_gateway)
        with mock.patch.dict(sys.modules, {"hermes_cli": package, "hermes_cli.gateway_client": package.gateway_client}), \
                mock.patch("builtins.print"):
            self.assertEqual(interrupt_helper.main(["helper", "sid"]), 0)
        self.assertEqual(calls, [("session.resume", {"session_id": "sid"}),
                                 ("session.interrupt", {"session_id": "sid", "execution_generation": 7})])


class Upstream(BaseHTTPRequestHandler):
    posted = []
    # desk1: refused (0.22.1+); old1: an older gateway admits it; api1: refused although the API server owns it.
    sources = {"desk1": "desktop", "old1": "desktop", "api1": "api_server"}

    def do_GET(self):
        source = Upstream.sources.get(self.path.rsplit("/", 1)[-1])
        body = json.dumps({"session": {"source": source}} if source else {}).encode()
        self.send_response(200 if source else 404)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        Upstream.posted.append(self.path)
        self.rfile.read(int(self.headers.get("Content-Length", "0")))
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.end_headers()
        for frame in ADMITTED if "/old1/" in self.path else REFUSAL:
            self.wfile.write(frame)
            self.wfile.flush()

    def log_message(self, *_args):
        pass


def fake_cli(session_id):
    """A real child process with the CLI's pipe contract: reads the prompt on stdin, prints JSONL."""
    # Hermes's bootstrap puts its stdio in UTF-8 on Windows; the fake does the same.
    script = ("import json, sys; [s.reconfigure(encoding='utf-8') for s in (sys.stdin, sys.stdout)]; "
              "text = sys.stdin.read(); "
              "print(json.dumps({'type': 'text', 'text': 'echo:' + text}), flush=True); "
              "print(json.dumps({'type': 'result', 'exit_code': 0, 'text': 'echo:' + text}), flush=True)")
    return subprocess.Popen([sys.executable, "-c", script], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                            stderr=subprocess.PIPE)


class NativeRoutingTests(unittest.TestCase):
    def setUp(self):
        self.upstream = ThreadingHTTPServer(("127.0.0.1", 0), Upstream)
        threading.Thread(target=self.upstream.serve_forever, daemon=True).start()
        config = server.Config(f"http://127.0.0.1:{self.upstream.server_port}", "test-api-key", "test-passphrase")
        self.server = server.UplinkServer(("127.0.0.1", 0), config)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        Upstream.posted = []
        patches = [mock.patch.object(native.RUNTIME, "available", return_value=True),
                   mock.patch.object(native, "spawn_turn", side_effect=fake_cli)]
        for patch in patches:
            patch.start()
            self.addCleanup(patch.stop)

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.upstream.shutdown()
        self.upstream.server_close()

    def request(self, method, path, body=None, headers=None):
        connection = http.client.HTTPConnection("127.0.0.1", self.server.server_port, timeout=10)
        connection.request(method, path, body=body, headers=headers or {})
        response = connection.getresponse()
        payload = response.read()
        connection.close()
        return response.status, payload

    def cookie(self):
        connection = http.client.HTTPConnection("127.0.0.1", self.server.server_port, timeout=10)
        connection.request("POST", "/__auth", body=json.dumps({"passphrase": "test-passphrase"}),
                           headers={"Content-Type": "application/json"})
        response = connection.getresponse()
        response.read()
        connection.close()
        cookie = SimpleCookie()
        cookie.load(response.getheader("Set-Cookie"))
        return cookie[server.SESSION_COOKIE].OutputString()

    def send(self, session_id, cookie):
        return self.request("POST", f"/api/sessions/{session_id}/chat/stream",
                            body=json.dumps({"input": "hi ✓", "client_turn_id": "t"}),
                            headers={"Cookie": cookie, "Content-Type": "application/json"})

    def test_refused_desktop_session_turn_continues_through_the_cli(self):
        status, body = self.send("desk1", self.cookie())
        self.assertEqual(status, 200)
        produced = frames(body)
        # The refusal and its done are not relayed; the CLI turn's own run.started rebinds the client's run id.
        self.assertEqual([name for name, _ in produced],
                         ["run.started", "message.started", "run.started", "assistant.delta", "assistant.completed",
                          "run.completed", "done"])
        self.assertTrue(produced[2][1]["run_id"].startswith(native.RUN_PREFIX))
        self.assertEqual(produced[3][1]["delta"], "echo:hi ✓")   # prompt crossed stdin as UTF-8
        self.assertEqual(Upstream.posted, ["/api/sessions/desk1/chat/stream"])

    def test_gateway_that_admits_a_desktop_session_streams_it_over_rest(self):
        with mock.patch.object(native, "spawn_turn") as spawn:
            status, body = self.send("old1", self.cookie())
        self.assertEqual(status, 200)
        self.assertEqual(body, b"".join(ADMITTED))
        spawn.assert_not_called()

    def test_refusal_of_an_api_session_is_relayed_not_rerouted(self):
        with mock.patch.object(native, "spawn_turn") as spawn:
            status, body = self.send("api1", self.cookie())
        self.assertEqual(status, 200)
        self.assertEqual(body, b"".join(REFUSAL))
        spawn.assert_not_called()

    def test_stop_of_a_native_run_interrupts_its_session(self):
        cookie = self.cookie()
        run_id = native.RUNS.start("desk1")
        with mock.patch.object(native, "interrupt", return_value=(True, "interrupted")) as interrupt:
            status, body = self.request("POST", f"/v1/runs/{run_id}/stop", body=b"", headers={"Cookie": cookie})
        self.assertEqual(status, 200)
        interrupt.assert_called_once_with("desk1")
        status, _ = self.request("POST", "/v1/runs/uplink-native-" + "x" * 20 + "/stop", body=b"",
                                 headers={"Cookie": cookie})
        self.assertEqual(status, 404)


if __name__ == "__main__":
    unittest.main()

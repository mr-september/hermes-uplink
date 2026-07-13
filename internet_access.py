"""Configure public browser access to Hermes Uplink through Tailscale Funnel.

This module intentionally owns the entire internet-access boundary.  Tailscale
is an externally installed Windows service; no credentials or provider state
are stored in this repository.
"""

from __future__ import annotations

import argparse
import dataclasses
import http.client
import json
import os
from pathlib import Path
import queue
import re
import shutil
import subprocess
import sys
import threading
import time
from typing import Any, Callable, Iterable, Mapping, Sequence
from urllib.parse import urlsplit
import webbrowser

from console_utils import enable_console_selection


ROOT = Path(__file__).resolve().parent
TAILSCALE_INSTALL_URL = "https://tailscale.com/download/windows"
PUBLIC_PORT = 443
DEFAULT_PORT = 8787
LOCAL_TARGET_HOST = "127.0.0.1"
LOCAL_PROXY_SERVER = "HermesUplink"
COMMAND_TIMEOUT_SECONDS = 30
LOGIN_TIMEOUT_SECONDS = 300
PROXY_START_TIMEOUT_SECONDS = 30
PROXY_POLL_SECONDS = 0.5
LOCAL_HEALTH_PATH = "/index.html"
HEALTH_PROBE_HEADER = "X-Hermes-Uplink-Health"
HEALTH_PROBE_VALUE = "1"


class InternetAccessError(RuntimeError):
    """An expected, user-actionable internet-access failure."""


class TailscaleCommandError(InternetAccessError):
    """Tailscale was unavailable or returned a failure."""

    def __init__(self, args: Sequence[str], result: "CommandResult") -> None:
        self.args = tuple(args)
        self.result = result
        detail = result.stderr.strip() or result.stdout.strip() or "no diagnostic output"
        super().__init__(f"tailscale {' '.join(args)} failed: {detail}")


@dataclasses.dataclass(frozen=True)
class CommandResult:
    returncode: int
    stdout: str = ""
    stderr: str = ""


@dataclasses.dataclass(frozen=True)
class FunnelRoute:
    hostname: str
    public_port: int
    path: str
    target: str
    allow_funnel: bool

    @property
    def url(self) -> str:
        return f"https://{self.hostname}:{self.public_port}{self.path}"


CommandRunner = Callable[[Sequence[str], float], CommandResult]
InteractiveRunner = Callable[[Sequence[str], float], CommandResult]


def _default_runner(args: Sequence[str], timeout: float) -> CommandResult:
    completed = subprocess.run(
        list(args),
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=timeout,
        check=False,
    )
    return CommandResult(completed.returncode, completed.stdout, completed.stderr)


CONSENT_URL_PATTERN = re.compile(r"https://login\.tailscale\.com/[^\s<>\"']+")


def extract_tailscale_consent_url(text: str) -> str | None:
    """Find a Tailscale web-consent URL in CLI output."""
    match = CONSENT_URL_PATTERN.search(text)
    return match.group(0).rstrip(".,;:)") if match else None


def _default_interactive_runner(args: Sequence[str], timeout: float) -> CommandResult:
    """Run a command while displaying output and opening consent URLs promptly."""
    command = list(args)
    process = subprocess.Popen(
        command,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        encoding="utf-8",
        errors="replace",
        bufsize=1,
    )
    output: list[str] = []
    lines: queue.Queue[str | None] = queue.Queue()

    def read_output() -> None:
        assert process.stdout is not None
        for line in process.stdout:
            lines.put(line)
        lines.put(None)

    reader = threading.Thread(target=read_output, name="tailscale-output", daemon=True)
    reader.start()
    consent_opened = False
    output_closed = False
    deadline = time.monotonic() + timeout

    while True:
        if output_closed and process.poll() is not None:
            break
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            process.kill()
            process.wait()
            if process.stdout is not None:
                process.stdout.close()
            raise subprocess.TimeoutExpired(command, timeout, output="".join(output))
        try:
            line = lines.get(timeout=min(0.1, remaining))
        except queue.Empty:
            continue
        if line is None:
            output_closed = True
            continue
        output.append(line)
        print(line, end="", flush=True)
        if not consent_opened:
            consent_url = extract_tailscale_consent_url("".join(output))
            if consent_url:
                consent_opened = True
                print(f"[*] Opening Tailscale approval page: {consent_url}", flush=True)
                try:
                    opened = webbrowser.open(consent_url, new=2, autoraise=True)
                except webbrowser.Error:
                    opened = False
                if not opened:
                    print("[!] The browser could not be opened automatically; open the URL above manually.", flush=True)

    returncode = process.wait()
    if process.stdout is not None:
        process.stdout.close()
    return CommandResult(returncode, "".join(output), "")


def find_tailscale_executable(
    environ: Mapping[str, str] | None = None,
    which: Callable[[str], str | None] = shutil.which,
) -> str | None:
    """Find the official Windows CLI without relying on shell expansion."""

    env = os.environ if environ is None else environ
    for name in ("tailscale.exe", "tailscale"):
        found = which(name)
        if found:
            return found

    candidates: list[Path] = []
    for variable in ("ProgramFiles", "ProgramFiles(x86)", "LOCALAPPDATA"):
        value = env.get(variable)
        if value:
            base = Path(value)
            candidates.extend(
                (
                    base / "Tailscale" / "tailscale.exe",
                    base / "Tailscale IPN" / "tailscale.exe",
                )
            )

    for candidate in candidates:
        if candidate.is_file():
            return str(candidate)
    return None


def _parse_json(stdout: str, context: str) -> dict[str, Any]:
    text = stdout.strip()
    if not text:
        raise InternetAccessError(f"Tailscale returned empty {context} JSON.")
    try:
        value = json.loads(text)
    except json.JSONDecodeError as exc:
        raise InternetAccessError(f"Tailscale returned invalid {context} JSON: {exc}") from exc
    if not isinstance(value, dict):
        raise InternetAccessError(f"Tailscale returned non-object {context} JSON.")
    return value


def _normalise_host(hostname: str) -> str:
    return hostname.rstrip(".").lower()


def _is_valid_public_hostname(hostname: str) -> bool:
    # Funnel's public HTTPS hostname is within the tailnet's ts.net namespace.
    return bool(
        re.fullmatch(
            r"(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+ts\.net",
            hostname,
            re.IGNORECASE,
        )
    )


def _split_host_port(value: str) -> tuple[str, int] | None:
    if not isinstance(value, str) or ":" not in value:
        return None
    host, port_text = value.rsplit(":", 1)
    if not port_text.isdigit():
        return None
    try:
        port = int(port_text)
    except ValueError:
        return None
    host = _normalise_host(host)
    if not _is_valid_public_hostname(host):
        return None
    return host, port


def _iter_web_sections(payload: Mapping[str, Any]) -> Iterable[Mapping[str, Any]]:
    """Support the current status shape and the nested service shape."""

    for key in ("Web", "web"):
        value = payload.get(key)
        if isinstance(value, dict):
            yield value

    for key in ("Services", "services"):
        services = payload.get(key)
        if not isinstance(services, dict):
            continue
        for service in services.values():
            if isinstance(service, dict):
                yield from _iter_web_sections(service)


def _normalise_target(target: str) -> str:
    return target.rstrip("/")


def parse_funnel_status(payload: Mapping[str, Any]) -> list[FunnelRoute]:
    """Parse `tailscale funnel status --json` without trusting display text."""

    allow_maps: list[Mapping[str, Any]] = []
    for key in ("AllowFunnel", "allowFunnel"):
        value = payload.get(key)
        if isinstance(value, dict):
            allow_maps.append(value)

    routes: list[FunnelRoute] = []
    seen: set[tuple[str, int, str, str]] = set()
    for web in _iter_web_sections(payload):
        for host_port, server in web.items():
            split = _split_host_port(host_port)
            if split is None or not isinstance(server, dict):
                continue
            hostname, public_port = split
            handlers = server.get("Handlers", server.get("handlers"))
            if not isinstance(handlers, dict):
                continue
            allowed = any(bool(mapping.get(host_port)) or bool(mapping.get(f"{hostname}:{public_port}")) for mapping in allow_maps)
            for path, handler in handlers.items():
                if not isinstance(path, str) or not isinstance(handler, dict):
                    continue
                target = handler.get("Proxy", handler.get("proxy"))
                if not isinstance(target, str):
                    continue
                route_key = (hostname, public_port, path, target)
                if route_key in seen:
                    continue
                seen.add(route_key)
                routes.append(FunnelRoute(hostname, public_port, path, target, allowed))
    return routes


def _target_matches(target: str, port: int) -> bool:
    try:
        parsed = urlsplit(target)
    except ValueError:
        return False
    if parsed.scheme.lower() != "http" or parsed.hostname != LOCAL_TARGET_HOST:
        return False
    if parsed.port != port or parsed.username or parsed.password:
        return False
    if parsed.path not in ("", "/") or parsed.query or parsed.fragment:
        return False
    return True


def matching_uplink_route(routes: Sequence[FunnelRoute], port: int) -> FunnelRoute | None:
    """Return the exclusive matching root route, or None if unconfigured.

    Any other public route on 443 is treated as a conflict because cleanup of
    this application must never disable an unrelated Funnel/Serve endpoint.
    """

    public_routes = [route for route in routes if route.public_port == PUBLIC_PORT]
    if not public_routes:
        return None
    if len(public_routes) != 1:
        raise InternetAccessError(
            "Tailscale already has multiple public routes on port 443; refusing to overwrite or clean them up."
        )
    route = public_routes[0]
    if route.path != "/" or not _target_matches(route.target, port) or not route.allow_funnel:
        raise InternetAccessError(
            "Tailscale port 443 is already configured for another service or is not publicly enabled; refusing to overwrite it."
        )
    return route


class TailscaleClient:
    def __init__(
        self,
        executable: str,
        runner: CommandRunner | None = None,
        interactive_runner: InteractiveRunner | None = None,
    ) -> None:
        self.executable = executable
        self._runner = runner or _default_runner
        self._interactive_runner = interactive_runner or _default_interactive_runner

    def run(self, args: Sequence[str], timeout: float = COMMAND_TIMEOUT_SECONDS) -> CommandResult:
        command = [self.executable, *args]
        try:
            return self._runner(command, timeout)
        except FileNotFoundError as exc:
            raise InternetAccessError(f"Tailscale executable was not found: {self.executable}") from exc
        except subprocess.TimeoutExpired as exc:
            raise InternetAccessError(f"Tailscale command timed out: {' '.join(args)}") from exc

    def run_interactive(self, args: Sequence[str], timeout: float = COMMAND_TIMEOUT_SECONDS) -> CommandResult:
        command = [self.executable, *args]
        try:
            return self._interactive_runner(command, timeout)
        except FileNotFoundError as exc:
            raise InternetAccessError(f"Tailscale executable was not found: {self.executable}") from exc
        except subprocess.TimeoutExpired as exc:
            raise InternetAccessError(f"Tailscale command timed out: {' '.join(args)}") from exc

    def status(self) -> dict[str, Any]:
        args = ["status", "--json"]
        result = self.run(args)
        if result.returncode != 0:
            raise TailscaleCommandError(args, result)
        return _parse_json(result.stdout, "status")

    def is_authenticated(self) -> bool:
        try:
            payload = self.status()
        except InternetAccessError:
            return False
        state = payload.get("BackendState", payload.get("backendState"))
        return state is not None and str(state).lower() in {"running", "connected"}

    def login(self) -> None:
        result = self.run_interactive(["up"], timeout=LOGIN_TIMEOUT_SECONDS)
        if result.returncode != 0:
            raise TailscaleCommandError(["up"], result)

    def funnel_status(self) -> list[FunnelRoute]:
        args = ["funnel", "status", "--json"]
        result = self.run(args)
        if result.returncode != 0:
            detail = result.stderr.strip() or result.stdout.strip()
            raise TailscaleCommandError(args, result) if detail else InternetAccessError("Tailscale Funnel status is unavailable.")
        return parse_funnel_status(_parse_json(result.stdout, "Funnel status"))

    def enable_funnel(self, port: int) -> None:
        target = f"http://{LOCAL_TARGET_HOST}:{port}"
        args = ["funnel", "--bg", "--yes", f"--https={PUBLIC_PORT}", target]
        result = self.run_interactive(args, timeout=LOGIN_TIMEOUT_SECONDS)
        if result.returncode != 0:
            raise TailscaleCommandError(args, result)

    def disable_funnel(self) -> None:
        args = ["funnel", f"--https={PUBLIC_PORT}", "off"]
        result = self.run(args)
        if result.returncode != 0:
            raise TailscaleCommandError(args, result)


def _request_local_proxy(port: int, path: str, timeout: float) -> tuple[int, Mapping[str, str]]:
    connection = http.client.HTTPConnection(LOCAL_TARGET_HOST, port, timeout=timeout)
    try:
        connection.request("GET", path, headers={HEALTH_PROBE_HEADER: HEALTH_PROBE_VALUE})
        response = connection.getresponse()
        response.read()
        return response.status, {key.lower(): value for key, value in response.getheaders()}
    finally:
        connection.close()


def is_local_proxy_healthy(port: int, timeout: float = 2.0) -> bool:
    try:
        client_status, client_headers = _request_local_proxy(port, LOCAL_HEALTH_PATH, timeout)
        auth_status, _ = _request_local_proxy(port, "/api/sessions", timeout)
    except (OSError, ValueError):
        return False
    server = client_headers.get("server", "")
    return client_status == 200 and LOCAL_PROXY_SERVER.lower() in server.lower() and auth_status == 401


def ensure_local_proxy(
    port: int,
    root: Path = ROOT,
    health_check: Callable[[int], bool] | None = None,
    process_starter: Callable[[Path], None] | None = None,
    sleeper: Callable[[float], None] = time.sleep,
    monotonic: Callable[[], float] = time.monotonic,
) -> None:
    health = health_check or is_local_proxy_healthy
    if health(port):
        return

    launcher = root / "launch_local.bat"
    if not launcher.is_file():
        raise InternetAccessError(f"Local launcher is missing: {launcher}")
    print("[*] Local Hermes Uplink proxy is not healthy; starting launch_local.bat.")
    if process_starter is None:
        if os.name != "nt":
            raise InternetAccessError("Automatic local-proxy startup is supported only on Windows.")
        creation_flags = getattr(subprocess, "CREATE_NEW_CONSOLE", 0)
        subprocess.Popen(
            ["cmd.exe", "/d", "/c", "call", str(launcher)],
            cwd=str(root),
            creationflags=creation_flags,
        )
    else:
        process_starter(launcher)

    deadline = monotonic() + PROXY_START_TIMEOUT_SECONDS
    while monotonic() < deadline:
        if health(port):
            return
        sleeper(PROXY_POLL_SECONDS)
    raise InternetAccessError(
        f"Local Hermes Uplink proxy did not become healthy on 127.0.0.1:{port} within {PROXY_START_TIMEOUT_SECONDS} seconds."
    )


def load_passphrase(root: Path = ROOT) -> str:
    path = root / ".uplink-pass.txt"
    try:
        value = path.read_text(encoding="ascii").strip()
    except OSError as exc:
        raise InternetAccessError("Run launch_local.bat first so the Uplink passphrase exists.") from exc
    if not re.fullmatch(r"[A-Za-z0-9]{20,}", value):
        raise InternetAccessError("The Uplink passphrase is missing or invalid; run launch_local.bat first.")
    return value


def copy_to_clipboard(value: str) -> bool:
    if os.name != "nt" or shutil.which("clip.exe") is None:
        return False
    try:
        subprocess.run(
            ["clip.exe"],
            input=value,
            text=True,
            encoding="utf-8",
            timeout=5,
            check=True,
        )
    except (OSError, subprocess.SubprocessError):
        return False
    return True


def build_client() -> TailscaleClient:
    executable = find_tailscale_executable()
    if executable is None:
        raise InternetAccessError(
            "Tailscale is not installed or tailscale.exe is not available in PATH. "
            f"Install it from {TAILSCALE_INSTALL_URL}, sign in, then run launch_internet.bat again."
        )
    return TailscaleClient(executable)


def ensure_authenticated(client: TailscaleClient) -> None:
    if client.is_authenticated():
        return
    print("[*] Tailscale is installed but this desktop is not signed in.")
    print("[*] A browser login may open now. Complete it, then this launcher will verify the session.")
    client.login()
    if not client.is_authenticated():
        raise InternetAccessError("Tailscale login did not reach the Running state; run tailscale up and retry.")


def read_routes(client: TailscaleClient) -> list[FunnelRoute]:
    try:
        return client.funnel_status()
    except TailscaleCommandError as exc:
        # No configured Funnel is a normal first-run state. Configuration will
        # produce the authoritative diagnostic if policy/HTTPS is unavailable.
        detail = exc.result.stderr.lower()
        if "no funnel" in detail or "not configured" in detail or "no serve" in detail:
            return []
        raise


def ensure_funnel_route(client: TailscaleClient, port: int) -> FunnelRoute:
    routes = read_routes(client)
    route = matching_uplink_route(routes, port)
    if route is not None:
        return route
    if any(existing.public_port == PUBLIC_PORT for existing in routes):
        raise InternetAccessError(
            "Tailscale port 443 is already in use by another route; refusing to overwrite it."
        )
    print("[*] Enabling Tailscale Funnel for the local Uplink proxy.")
    print("[*] If Tailscale requests Funnel approval, complete that browser step and wait for this command to return.")
    client.enable_funnel(port)
    route = matching_uplink_route(read_routes(client), port)
    if route is None:
        raise InternetAccessError("Funnel enabled without a verifiable Uplink route; inspect tailscale funnel status --json.")
    return route


def require_owned_route(routes: Sequence[FunnelRoute], port: int) -> FunnelRoute:
    if not routes:
        raise InternetAccessError("No matching Uplink Funnel route was found.")
    route = matching_uplink_route(routes, port)
    if route is None:
        raise InternetAccessError(
            "No matching Uplink route was found; refusing to disable unrelated Tailscale configuration."
        )
    return route


def start_access(port: int, root: Path = ROOT) -> int:
    ensure_local_proxy(port, root=root)
    passphrase = load_passphrase(root)
    client = build_client()
    ensure_authenticated(client)

    route = ensure_funnel_route(client, port)

    url = f"https://{route.hostname}/"
    copied = copy_to_clipboard(url)
    print()
    print("=" * 60)
    print("Stable public URL:")
    print(f"  {url}")
    if copied:
        print("  (URL copied to clipboard.)")
    print()
    print("Share the URL and passphrase separately.")
    print(f"Passphrase: {passphrase}")
    print("Status: ACTIVE — Uplink Funnel route verified.")
    print("The client device does not need Tailscale installed.")
    print("The desktop, Tailscale, local proxy, and Hermes gateway must remain available.")
    print("You may now safely close this terminal window; the route runs in the background.")
    print("=" * 60)
    return 0


def show_status(port: int) -> int:
    client = build_client()
    try:
        status = client.status()
        print(f"Tailscale state: {status.get('BackendState', status.get('backendState', 'unknown'))}")
    except InternetAccessError as exc:
        print(f"[!] {exc}")
        return 1
    try:
        routes = read_routes(client)
    except InternetAccessError as exc:
        print(f"[!] Funnel status unavailable: {exc}")
        return 1
    if not routes:
        print("Funnel: no public routes configured.")
        return 0
    for route in routes:
        print(
            f"Funnel route: https://{route.hostname}:{route.public_port}{route.path} "
            f"-> {route.target} (public={route.allow_funnel})"
        )
    try:
        route = matching_uplink_route(routes, port)
    except InternetAccessError as exc:
        print(f"Uplink ownership: conflict ({exc})")
        return 1
    if route:
        print(f"Uplink ownership: verified ({route.url})")
    else:
        print("Uplink ownership: no matching route.")
    return 0


def cleanup_access(port: int, assume_yes: bool = False) -> int:
    client = build_client()
    routes = read_routes(client)
    if not routes:
        print("[*] No Tailscale Funnel route is configured.")
        return 0
    try:
        route = require_owned_route(routes, port)
    except InternetAccessError as exc:
        print(f"[!] {exc}")
        return 1
    print(f"This will disable the Uplink Funnel route at https://{route.hostname}/.")
    if not assume_yes:
        answer = input("Continue? [y/N] ").strip().lower()
        if answer not in {"y", "yes"}:
            print("[*] Cancelled.")
            return 0
    client.disable_funnel()
    print("[+] Uplink Funnel route disabled. Tailscale remains installed and connected.")
    return 0


def _port_from_environment() -> int:
    raw = os.environ.get("HERMES_PORT", str(DEFAULT_PORT))
    if not raw.isdigit() or not 1 <= int(raw) <= 65535:
        raise InternetAccessError("HERMES_PORT must be a decimal TCP port from 1 through 65535.")
    return int(raw)


def _menu(port: int) -> int:
    while True:
        print()
        print("=" * 60)
        print("Hermes Uplink Internet Access")
        print("[1] Start or repair stable Tailscale Funnel access")
        print("[2] Show Tailscale/Funnel status")
        print("[3] Disable Uplink Funnel access")
        print("[4] Exit")
        print("=" * 60)
        try:
            choice = input("Choose an option: ").strip()
        except EOFError:
            return 0
        if choice == "4":
            print("[*] Exiting. Existing background Funnel configuration is unchanged.")
            return 0
        if choice not in {"1", "2", "3"}:
            print("[!] Choose 1, 2, 3, or 4.")
            continue
        try:
            if choice == "1":
                result = start_access(port)
            elif choice == "2":
                result = show_status(port)
            else:
                result = cleanup_access(port)
        except InternetAccessError as exc:
            print(f"[!] {exc}")
            result = 1
        if result == 0:
            print("[+] Operation completed.")
        else:
            print(f"[!] Operation failed with exit code {result}.")
        try:
            input("Press Enter to return to the menu...")
        except EOFError:
            return result


def main(argv: Sequence[str] | None = None) -> int:
    enable_console_selection()
    parser = argparse.ArgumentParser(description="Expose Hermes Uplink through Tailscale Funnel.")
    parser.add_argument("command", nargs="?", choices=("start", "status", "cleanup"))
    parser.add_argument("--port", type=int, default=None)
    parser.add_argument("--yes", action="store_true", help="Do not prompt for cleanup confirmation.")
    args = parser.parse_args(argv)
    try:
        port = _port_from_environment() if args.port is None else args.port
        if not 1 <= port <= 65535:
            raise InternetAccessError("--port must be from 1 through 65535.")
        if args.command == "start":
            return start_access(port)
        if args.command == "status":
            return show_status(port)
        if args.command == "cleanup":
            return cleanup_access(port, assume_yes=args.yes)
        return _menu(port)
    except KeyboardInterrupt:
        print("\n[*] Cancelled.")
        return 130
    except InternetAccessError as exc:
        print(f"[!] {exc}")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())

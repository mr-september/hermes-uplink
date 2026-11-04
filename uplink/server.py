"""The Uplink proxy: serves the client and gates the Hermes API behind a passphrase, on loopback only.

The browser authenticates once with the passphrase and gets an HttpOnly session cookie; API requests are then
forwarded to the Hermes API server with the API key added here, so the key never reaches the browser. Remote
HTTPS access terminates at Tailscale Funnel (uplink.funnel), which forwards to this process on localhost.
Turns into sessions the API server does not own go through the Hermes CLI instead (uplink.native).

    python -m uplink.server [--port N] [--upstream URL] [--hermes-cli PATH]
"""
import argparse
import dataclasses
import ipaddress
import json
import logging
import os
import re
import secrets
import select
import socket
import sys
import urllib.error
import urllib.parse
import urllib.request
from contextlib import closing
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from threading import BoundedSemaphore, Semaphore, Thread

from . import native
from .assets import AssetError, Site
from .auth import AttemptLimiter, Sessions
from .settings import (
    DEFAULT_UPSTREAM,
    HEALTH_PROBE_HEADER,
    HEALTH_PROBE_VALUE,
    KEY_FILE,
    KEY_PATTERN,
    LOCAL_LAUNCHER,
    PASS_FILE,
    PASS_PATTERN,
    PID_FILE,
    SettingsError,
    enable_console_selection,
    env_port,
    read_credential,
)

MAX_REQUEST_BODY = 1_048_576
MAX_AUTH_BODY = 8_192
MAX_ERROR_BODY = 1_048_576
UPSTREAM_TIMEOUT = 300
BODY_TIMEOUT = 30
REQUEST_HEADER_TIMEOUT = 30
MAX_ACTIVE_PROXY_REQUESTS = 32
MAX_ACTIVE_CONNECTIONS = 128
SSE_KEEPALIVE_INTERVAL = 15   # an SSE comment this often keeps cellular CGNAT mappings alive
SESSION_COOKIE = "hermes_uplink_session"
API_PREFIXES = ("/api/", "/v1/", "/health/")
FORWARDED_HEADERS = (
    "Content-Type", "Accept", "Last-Event-ID", "Idempotency-Key", "X-Client-Turn-ID",
    "X-Hermes-Client-Capabilities", "X-Hermes-Session-Key",
)
CHAT_STREAM_RE = re.compile(r"^/api/sessions/([^/?]+)/chat/stream$")
RUN_STOP_RE = re.compile(r"^/v1/runs/([^/?]+)/stop$")
# Session ids reach a CLI argv: refuse anything argparse could read as an option.
SESSION_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$")
CLIENT_GONE = (BrokenPipeError, ConnectionResetError, ConnectionAbortedError)
TEXT = "text/plain; charset=utf-8"
JSON = "application/json"
LOGGER = logging.getLogger("hermes_uplink")
_REJECTED = object()   # _read_body already answered the request


@dataclasses.dataclass(frozen=True)
class Config:
    upstream: str
    api_key: str
    passphrase: str


def is_loopback_host(host):
    if not host:
        return False
    if host.lower() == "localhost":
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


def validate_upstream(url, allow_remote=False):
    parsed = urllib.parse.urlparse(url)
    if parsed.scheme not in ("http", "https") or not parsed.hostname:
        raise ValueError("upstream must be an http(s) URL with a hostname")
    if parsed.username or parsed.password:
        raise ValueError("upstream credentials in the URL are not allowed")
    if not is_loopback_host(parsed.hostname):
        if not allow_remote:
            raise ValueError("upstream must be loopback unless --allow-remote-upstream is set")
        if parsed.scheme != "https":
            raise ValueError("remote upstreams must use HTTPS")
    return url.rstrip("/")


class UplinkServer(ThreadingHTTPServer):
    """One thread per connection, capped at MAX_ACTIVE_CONNECTIONS; excess connections are closed at once."""

    allow_reuse_address = True
    daemon_threads = True
    request_queue_size = 64

    def __init__(self, address, config, site=None):
        self.config = config
        self.site = site or Site()
        self.security_headers = {
            "X-Content-Type-Options": "nosniff",
            "X-Frame-Options": "DENY",
            "Referrer-Policy": "no-referrer",
            "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
            "Content-Security-Policy": self.site.csp,
        }
        self.sessions = Sessions()
        self.attempts = AttemptLimiter()
        self.proxy_slots = Semaphore(MAX_ACTIVE_PROXY_REQUESTS)
        self.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))   # never a system proxy
        self._connection_slots = BoundedSemaphore(MAX_ACTIVE_CONNECTIONS)
        super().__init__(address, Handler)

    def process_request(self, request, client_address):
        if not self._connection_slots.acquire(blocking=False):
            self.shutdown_request(request)
            return
        thread = Thread(target=self._process_request_thread, args=(request, client_address), daemon=True)
        try:
            thread.start()
        except BaseException:
            self.shutdown_request(request)
            self._connection_slots.release()
            raise

    def _process_request_thread(self, request, client_address):
        try:
            self.finish_request(request, client_address)
        except Exception:
            self.handle_error(request, client_address)
        finally:
            try:
                self.shutdown_request(request)
            finally:
                self._connection_slots.release()


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "HermesUplink"
    sys_version = ""

    # ---- routing ----

    def do_GET(self):
        self._dispatch()

    do_HEAD = do_POST = do_PUT = do_PATCH = do_DELETE = do_GET

    def do_OPTIONS(self):
        self._text(405, "method not allowed", {"Allow": "GET, HEAD, POST, PUT, PATCH, DELETE"})

    def _dispatch(self):
        path = self.path.split("?", 1)[0]
        if path == "/__auth":
            self._login()
        elif path == "/__logout":
            self._logout()
        elif path == "/health" or path.startswith(API_PREFIXES):
            self._api(path)
        elif (asset := self.server.site.get(path)) is None:
            self._text(404, "not found")
        elif self.command not in ("GET", "HEAD"):
            self._text(405, "method not allowed", {"Allow": "GET, HEAD"})
        else:
            self._send(200, asset.content_type, asset.body, {"Cache-Control": asset.cache_control})

    def _api(self, path):
        if not self._authenticated():
            self._text(401, "uplink authentication required")
            return
        if self.command == "POST":
            if chat := CHAT_STREAM_RE.match(path):
                self._with_proxy_slot(self._chat_stream, urllib.parse.unquote(chat.group(1)))
                return
            stop = RUN_STOP_RE.match(path)
            run_id = urllib.parse.unquote(stop.group(1)) if stop else ""
            if native.RUN_ID_RE.match(run_id):
                self._native_stop(run_id)
                return
        self._with_proxy_slot(self._proxy)

    # ---- passphrase gate ----

    def _login(self):
        if self.command != "POST":
            self._text(405, "method not allowed", {"Allow": "POST"})
            return
        passphrase = self.server.config.passphrase
        if not passphrase:
            self._text(503, "authentication is not configured")
            return
        body = self._read_body(MAX_AUTH_BODY)
        if body is _REJECTED:
            return
        try:
            payload = json.loads(body.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            self._text(400, "invalid authentication request")
            return
        offered = payload.get("passphrase") if isinstance(payload, dict) else None
        client = self.client_address[0] if self.client_address else "unknown"
        if not isinstance(offered, str) or not secrets.compare_digest(offered.encode(), passphrase.encode()):
            retry_after = self.server.attempts.record_failure(client)
            if retry_after:
                self._text(429, "too many authentication attempts", {"Retry-After": str(retry_after)})
            else:
                self._text(401, "incorrect passphrase")
            return
        self.server.attempts.reset(client)
        self._no_content(self._session_cookie(self.server.sessions.create()))

    def _logout(self):
        if self.command != "POST":
            self._text(405, "method not allowed", {"Allow": "POST"})
            return
        self.server.sessions.revoke(self._session_token())
        self._no_content(self._session_cookie(None))

    def _authenticated(self):
        return bool(self.server.config.passphrase) and self.server.sessions.valid(self._session_token())

    def _session_token(self):
        cookie = SimpleCookie()
        try:
            cookie.load(self.headers.get("Cookie", ""))
        except ValueError:   # http.cookies.CookieError
            return None
        morsel = cookie.get(SESSION_COOKIE)
        return morsel.value if morsel else None

    def _session_cookie(self, token):
        """The Set-Cookie value for a new session, or one that clears it when ``token`` is None."""
        if token is None:
            value = f"{SESSION_COOKIE}=; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT"
        else:
            value = f"{SESSION_COOKIE}={token}; Max-Age={self.server.sessions.ttl}"
        value += "; Path=/; HttpOnly; SameSite=Strict"
        if self.headers.get("X-Forwarded-Proto", "").lower() == "https":
            value += "; Secure"
        return value

    # ---- API forwarding ----

    def _with_proxy_slot(self, work, *args):
        slots = self.server.proxy_slots
        if not slots.acquire(blocking=False):
            self._text(503, "proxy is busy", {"Retry-After": "5"})
            return
        try:
            work(*args)
        finally:
            slots.release()

    def _proxy(self):
        body = self._read_body(MAX_REQUEST_BODY)
        if body is not _REJECTED:
            self._forward(body)

    def _chat_stream(self, session_id):
        """A turn: the API server's own sessions stream over REST; every other session goes through the
        Hermes CLI (uplink.native), because the API server refuses turns into sessions it does not own."""
        body = self._read_body(MAX_REQUEST_BODY)
        if body is _REJECTED:
            return
        text = self._native_input(session_id, body)
        if text:
            self._native_turn(session_id, text)
        else:
            self._forward(body)

    def _native_input(self, session_id, body):
        """The turn's text when it must go through the CLI, else None."""
        if not (SESSION_ID_RE.match(session_id) and native.RUNTIME.available()):
            return None
        if not native.wants_native(self._session_source(session_id)):
            return None
        try:
            payload = json.loads(body.decode("utf-8")) if body else {}
        except (UnicodeDecodeError, ValueError):
            return None
        text = payload.get("input") if isinstance(payload, dict) else None
        return text if isinstance(text, str) and text.strip() else None

    def _session_source(self, session_id):
        """The session's ``source``, or None when the API server does not report one."""
        request = self._upstream_request("/api/sessions/" + urllib.parse.quote(session_id, safe=""))
        try:
            with self.server.opener.open(request, timeout=30) as response:
                session = json.loads(response.read(MAX_ERROR_BODY).decode("utf-8")).get("session")
        except Exception:  # unknown source: the REST stream answers for itself
            return None
        return session.get("source") if isinstance(session, dict) else None

    def _upstream_request(self, path, data=None, method=None):
        request = urllib.request.Request(self.server.config.upstream + path, data=data, method=method)
        if self.server.config.api_key:
            request.add_header("Authorization", "Bearer " + self.server.config.api_key)
        return request

    def _forward(self, body):
        """Send this request upstream and relay the response (or answer with the upstream's error)."""
        method = self.command
        data = body if body else (b"" if method in ("POST", "PUT", "PATCH") else None)
        request = self._upstream_request(self.path, data, method)
        for name in FORWARDED_HEADERS:
            if value := self.headers.get(name):
                request.add_header(name, value)
        try:
            response = self.server.opener.open(request, timeout=UPSTREAM_TIMEOUT)
        except urllib.error.HTTPError as error:
            self._send(error.code, error.headers.get("Content-Type", JSON), error.read(MAX_ERROR_BODY))
            return
        except Exception:
            LOGGER.exception("upstream request failed")
            self._text(502, "upstream unavailable")
            return
        with response:
            self._relay(response)

    def _relay(self, response):
        content_type = response.headers.get("Content-Type", "application/octet-stream")
        is_event_stream = "text/event-stream" in content_type.lower()
        content_length = response.headers.get("Content-Length")
        self._start_response(response.status, content_type,
                             content_length if content_length and not is_event_stream else None)
        try:
            if self.command != "HEAD":
                self._pump(response, is_event_stream)
        except CLIENT_GONE:
            LOGGER.debug("client disconnected during upstream stream")
        except Exception:
            LOGGER.exception("proxy stream interrupted")

    def _pump(self, response, is_event_stream):
        """Copy the upstream body to the client; on SSE, ping while upstream is quiet."""
        read = getattr(response, "read1", response.read)
        fileno = None
        if is_event_stream:
            try:
                fileno = response.fileno()
            except (AttributeError, OSError, ValueError):
                pass
        while True:
            if fileno is not None:
                try:
                    ready, _, _ = select.select([fileno], [], [], SSE_KEEPALIVE_INTERVAL)
                except (OSError, ValueError):
                    break
                if not ready:
                    self.wfile.write(b": ping\n\n")
                    self.wfile.flush()
                    continue
            chunk = read(65536 if is_event_stream else 4096)
            if not chunk:
                break
            self.wfile.write(chunk)
            self.wfile.flush()

    # ---- turns through the Hermes CLI ----

    def _native_turn(self, session_id, text):
        try:
            turn = native.Turn(session_id, text)
        except (native.NativeUnavailable, OSError) as error:
            LOGGER.error("native turn could not start: %s", error)
            self._text(502, f"Hermes CLI unavailable: {error}")
            return
        LOGGER.info("native turn %s on session %s", turn.run_id, session_id)
        self._start_response(200, "text/event-stream", None)
        with closing(turn.frames(SSE_KEEPALIVE_INTERVAL)) as frames:
            try:
                for chunk in frames:
                    self.wfile.write(chunk)
                    self.wfile.flush()
            except (*CLIENT_GONE, socket.timeout):
                LOGGER.debug("client disconnected during native turn %s", turn.run_id)
            except Exception:
                LOGGER.exception("native turn stream interrupted")

    def _native_stop(self, run_id):
        if self._read_body(MAX_AUTH_BODY) is _REJECTED:
            return
        session_id = native.RUNS.session_of(run_id)
        if session_id is None:
            self._send(404, JSON, json.dumps({"error": {"message": "run not found"}}))
            return
        ok, reason = native.interrupt(session_id)
        LOGGER.info("native stop %s on session %s: %s", run_id, session_id, reason)
        self._send(200 if ok else 502, JSON, json.dumps({"ok": ok, "status": reason}))

    # ---- HTTP plumbing ----

    def setup(self):
        super().setup()
        self.connection.settimeout(REQUEST_HEADER_TIMEOUT)

    def handle_one_request(self):
        self.connection.settimeout(REQUEST_HEADER_TIMEOUT)
        super().handle_one_request()

    def _start_response(self, code, content_type, content_length):
        """Send the status and headers of a relayed or streamed body. Without a length, connection close is the
        only valid HTTP/1.1 delimiter for a body that is neither length-framed nor chunked."""
        self.send_response(code)
        for key, value in self.server.security_headers.items():
            self.send_header(key, value)
        self.send_header("Content-Type", content_type)
        self.send_header("Cache-Control", "no-store")
        if content_length is not None:
            self.send_header("Content-Length", content_length)
        else:
            self.send_header("Connection", "close")
            self.close_connection = True
        self.end_headers()
        self.connection.settimeout(UPSTREAM_TIMEOUT)

    def _send(self, code, content_type, body=b"", extra_headers=None):
        if isinstance(body, str):
            body = body.encode("utf-8")
        self.send_response(code)
        for key, value in self.server.security_headers.items():
            self.send_header(key, value)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        headers = {"Cache-Control": "no-store", **(extra_headers or {})}
        for key, value in headers.items():
            self.send_header(key, value)
        self.end_headers()
        if self.command != "HEAD" and body:
            self.wfile.write(body)

    def _text(self, code, message, extra_headers=None):
        self._send(code, TEXT, message, extra_headers)

    def _no_content(self, set_cookie):
        self._send(204, TEXT, b"", {"Set-Cookie": set_cookie})

    def _read_body(self, maximum):
        """The request body, or _REJECTED after answering a malformed, oversized, or stalled one."""
        if self.headers.get("Transfer-Encoding"):
            return self._reject_body(501, "chunked request bodies are not supported")
        raw_length = self.headers.get("Content-Length")
        if not raw_length:
            return b""
        if not raw_length.isdigit():
            return self._reject_body(400, "invalid content length")
        length = int(raw_length)
        if length > maximum:
            return self._reject_body(413, "request body too large")
        previous_timeout = self.connection.gettimeout()
        try:
            self.connection.settimeout(BODY_TIMEOUT)
            body = self.rfile.read(length)
        except socket.timeout:
            return self._reject_body(408, "request body timed out")
        finally:
            self.connection.settimeout(previous_timeout)
        if len(body) != length:
            return self._reject_body(400, "incomplete request body")
        return body

    def _reject_body(self, code, message):
        self.close_connection = True
        self._text(code, message, {"Connection": "close"})
        return _REJECTED

    def log_message(self, fmt, *args):
        headers = getattr(self, "headers", None)   # absent when the request line never arrived
        if headers is not None and headers.get(HEALTH_PROBE_HEADER) == HEALTH_PROBE_VALUE:
            return
        LOGGER.info("%s - %s", self.address_string(), fmt % args)


def _parse_args(argv):
    parser = argparse.ArgumentParser(prog="python -m uplink.server", description="Hermes Uplink local proxy")
    parser.add_argument("--port", type=int, default=None, help="default: HERMES_PORT or 8787")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--upstream", default=os.environ.get("HERMES_UPSTREAM", DEFAULT_UPSTREAM))
    parser.add_argument(
        "--allow-remote-upstream",
        action="store_true",
        help="allow an HTTPS upstream outside loopback; use only with an explicitly trusted server",
    )
    parser.add_argument(
        "--hermes-cli",
        default=os.environ.get("HERMES_CLI", ""),
        help="the hermes launcher that sends turns into sessions the API server does not own (default: hermes on PATH)",
    )
    args = parser.parse_args(argv)
    if args.port is None:
        try:
            args.port = env_port()
        except SettingsError as error:
            parser.error(str(error))
    if not 1 <= args.port <= 65535:
        parser.error("port must be between 1 and 65535")
    if not is_loopback_host(args.host):
        parser.error("the proxy only supports loopback binds; use an HTTPS tunnel for remote access")
    try:
        args.upstream = validate_upstream(args.upstream, args.allow_remote_upstream)
    except ValueError as error:
        parser.error(str(error))
    args.api_key = os.environ.get("HERMES_API_KEY") or read_credential(KEY_FILE, KEY_PATTERN)
    args.passphrase = os.environ.get("UPLINK_PASSPHRASE") or read_credential(PASS_FILE, PASS_PATTERN)
    if not args.api_key:
        parser.error(f"set HERMES_API_KEY or provide a valid {KEY_FILE} (run {LOCAL_LAUNCHER})")
    if not args.passphrase:
        parser.error(f"set UPLINK_PASSPHRASE or provide a valid {PASS_FILE} (run {LOCAL_LAUNCHER})")
    return args


def main(argv=None):
    args = _parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    try:
        httpd = UplinkServer((args.host, args.port), Config(args.upstream, args.api_key, args.passphrase))
    except AssetError as error:
        LOGGER.error("%s", error)
        return 1
    native.RUNTIME.configure(args.hermes_cli or None)
    if not native.RUNTIME.available():
        LOGGER.warning("hermes command not found: sessions created outside the API server stay read-only")
    enable_console_selection()
    try:
        PID_FILE.write_text(str(os.getpid()), encoding="ascii")
        LOGGER.info("proxy listening on http://%s:%s -> %s", args.host, args.port, args.upstream)
        httpd.serve_forever()
    except KeyboardInterrupt:
        LOGGER.info("proxy stopped")
    finally:
        httpd.server_close()
        PID_FILE.unlink(missing_ok=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())

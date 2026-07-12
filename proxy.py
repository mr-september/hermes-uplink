#!/usr/bin/env python3
"""Local Hermes API proxy with a browser session gate.

The proxy is intentionally loopback-only. Remote HTTPS access should terminate
at a tunnel or reverse proxy and forward to this process on localhost.
"""

import argparse
import ipaddress
import json
import logging
import os
import secrets
import socket
import time
import urllib.error
import urllib.parse
import urllib.request
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from threading import Lock, Semaphore


UPSTREAM = "http://127.0.0.1:8642"
PROXY_PORT = 8787
MAX_REQUEST_BODY = 1_048_576
MAX_AUTH_BODY = 8_192
MAX_ERROR_BODY = 1_048_576
UPSTREAM_TIMEOUT = 300
AUTH_SESSION_TTL = 12 * 60 * 60
AUTH_ATTEMPT_WINDOW = 60
AUTH_ATTEMPT_LIMIT = 10
MAX_ACTIVE_PROXY_REQUESTS = 32
REQUEST_HEADER_TIMEOUT = 30
SESSION_COOKIE = "hermes_uplink_session"
HERE = os.path.dirname(os.path.abspath(__file__))
PID_FILE = os.path.join(HERE, ".uplink.pid")
API_KEY = os.environ.get("HERMES_API_KEY", "")
PASS = os.environ.get("UPLINK_PASSPHRASE", "")

# The hash covers the inline application script in index.html. Keep it in sync
# when that script changes; the static client otherwise has no CSP exception.
CONTENT_SECURITY_POLICY = (
    "default-src 'self'; "
    "script-src 'self' 'sha256-sGOtit+FZm6+66TsEzQjU80YG9vXEP0qHf/qcuTimx0='; "
    "style-src 'self' 'unsafe-inline'; "
    "img-src 'self'; "
    "connect-src 'self' https: http://127.0.0.1:* http://localhost:*; "
    "worker-src 'self'; object-src 'none'; base-uri 'none'; "
    "form-action 'self'; frame-ancestors 'none'"
)
SECURITY_HEADERS = {
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
    "Content-Security-Policy": CONTENT_SECURITY_POLICY,
}

LOGGER = logging.getLogger("hermes_uplink")
SESSION_LOCK = Lock()
SESSIONS = {}
AUTH_ATTEMPTS = {}
PROXY_SEMAPHORE = Semaphore(MAX_ACTIVE_PROXY_REQUESTS)
READ_ERROR = object()


def build_opener():
    return urllib.request.build_opener(urllib.request.ProxyHandler({}))


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
    allow_reuse_address = True
    daemon_threads = True
    request_queue_size = 64


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "HermesUplink"
    sys_version = ""

    def setup(self):
        super().setup()
        self.connection.settimeout(REQUEST_HEADER_TIMEOUT)

    def handle_one_request(self):
        self.connection.settimeout(REQUEST_HEADER_TIMEOUT)
        super().handle_one_request()

    def _security_headers(self):
        for key, value in SECURITY_HEADERS.items():
            self.send_header(key, value)

    def _send(self, code, ctype, body=b"", extra_headers=None):
        if isinstance(body, str):
            body = body.encode("utf-8")
        self.send_response(code)
        self._security_headers()
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        for key, value in (extra_headers or {}).items():
            self.send_header(key, value)
        self.end_headers()
        if self.command != "HEAD" and body:
            self.wfile.write(body)

    def _read_body(self, maximum):
        if self.headers.get("Transfer-Encoding"):
            self._send(501, "text/plain; charset=utf-8", b"chunked request bodies are not supported")
            return READ_ERROR
        raw_length = self.headers.get("Content-Length")
        if raw_length in (None, ""):
            return b""
        try:
            length = int(raw_length)
        except (TypeError, ValueError):
            self._send(400, "text/plain; charset=utf-8", b"invalid content length")
            return READ_ERROR
        if length < 0:
            self._send(400, "text/plain; charset=utf-8", b"invalid content length")
            return READ_ERROR
        if length > maximum:
            self._send(413, "text/plain; charset=utf-8", b"request body too large")
            return READ_ERROR

        previous_timeout = self.connection.gettimeout()
        try:
            self.connection.settimeout(30)
            body = self.rfile.read(length)
        except socket.timeout:
            self._send(408, "text/plain; charset=utf-8", b"request body timed out")
            return READ_ERROR
        finally:
            self.connection.settimeout(previous_timeout)
        if len(body) != length:
            self._send(400, "text/plain; charset=utf-8", b"incomplete request body")
            return READ_ERROR
        return body

    def _client_id(self):
        return self.client_address[0] if self.client_address else "unknown"

    def _auth_rate_limited(self):
        now = time.monotonic()
        client_id = self._client_id()
        with SESSION_LOCK:
            for key, (started, _) in list(AUTH_ATTEMPTS.items()):
                if now - started >= AUTH_ATTEMPT_WINDOW * 2:
                    del AUTH_ATTEMPTS[key]
            started, count = AUTH_ATTEMPTS.get(client_id, (now, 0))
            if now - started >= AUTH_ATTEMPT_WINDOW:
                started, count = now, 0
            if count >= AUTH_ATTEMPT_LIMIT:
                retry_after = max(1, int(AUTH_ATTEMPT_WINDOW - (now - started)))
                return True, retry_after
            AUTH_ATTEMPTS[client_id] = (started, count + 1)
        return False, 0

    def _auth_success(self):
        with SESSION_LOCK:
            AUTH_ATTEMPTS.pop(self._client_id(), None)

    def _session_token(self):
        cookie_header = self.headers.get("Cookie", "")
        if not cookie_header:
            return None
        cookie = SimpleCookie()
        try:
            cookie.load(cookie_header)
        except ValueError:
            return None
        morsel = cookie.get(SESSION_COOKIE)
        return morsel.value if morsel else None

    def _session_valid(self):
        token = self._session_token()
        if not token:
            return False
        now = time.time()
        with SESSION_LOCK:
            expiry = SESSIONS.get(token)
            if expiry is None:
                return False
            if expiry <= now:
                del SESSIONS[token]
                return False
        return True

    def _new_session(self):
        token = secrets.token_urlsafe(32)
        expiry = time.time() + AUTH_SESSION_TTL
        with SESSION_LOCK:
            now = time.time()
            for key, expires in list(SESSIONS.items()):
                if expires <= now:
                    del SESSIONS[key]
            if len(SESSIONS) >= 256:
                oldest = min(SESSIONS, key=SESSIONS.get)
                del SESSIONS[oldest]
            SESSIONS[token] = expiry
        return token

    def _remove_session(self):
        token = self._session_token()
        if token:
            with SESSION_LOCK:
                SESSIONS.pop(token, None)

    def _cookie_secure(self):
        forwarded = self.headers.get("X-Forwarded-Proto", "")
        return forwarded.lower() == "https"

    def _session_cookie(self, token, expired=False):
        if expired:
            value = f"{SESSION_COOKIE}=; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT"
        else:
            value = f"{SESSION_COOKIE}={token}; Max-Age={AUTH_SESSION_TTL}"
        value += "; Path=/; HttpOnly; SameSite=Strict"
        if self._cookie_secure():
            value += "; Secure"
        return value

    def _handle_auth(self):
        if self.command != "POST":
            self._send(405, "text/plain; charset=utf-8", b"method not allowed", {"Allow": "POST"})
            return
        if not PASS:
            self._send(503, "text/plain; charset=utf-8", b"authentication is not configured")
            return
        limited, retry_after = self._auth_rate_limited()
        if limited:
            self._send(
                429,
                "text/plain; charset=utf-8",
                b"too many authentication attempts",
                {"Retry-After": str(retry_after)},
            )
            return
        body = self._read_body(MAX_AUTH_BODY)
        if body is READ_ERROR:
            return
        try:
            payload = json.loads(body.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            self._send(400, "text/plain; charset=utf-8", b"invalid authentication request")
            return
        passphrase = payload.get("passphrase") if isinstance(payload, dict) else None
        if not isinstance(passphrase, str) or not secrets.compare_digest(passphrase, PASS):
            self._send(401, "text/plain; charset=utf-8", b"incorrect passphrase")
            return
        self._auth_success()
        token = self._new_session()
        self.send_response(204)
        self._security_headers()
        self.send_header("Content-Length", "0")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Set-Cookie", self._session_cookie(token))
        self.end_headers()

    def _handle_logout(self):
        if self.command != "POST":
            self._send(405, "text/plain; charset=utf-8", b"method not allowed", {"Allow": "POST"})
            return
        self._remove_session()
        self.send_response(204)
        self._security_headers()
        self.send_header("Content-Length", "0")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Set-Cookie", self._session_cookie("", expired=True))
        self.end_headers()

    def _authed(self):
        return bool(PASS) and self._session_valid()

    def _deny(self):
        self._send(401, "text/plain; charset=utf-8", b"uplink authentication required")

    def _forward(self, method):
        path_only = self.path.split("?", 1)[0]
        if path_only == "/__auth":
            self._handle_auth()
            return
        if path_only == "/__logout":
            self._handle_logout()
            return
        if path_only in ("/", "/index.html", "/manifest.webmanifest", "/sw.js") or path_only.startswith("/vendor/"):
            self._serve_static(path_only)
            return
        if path_only.startswith("/api/") or path_only.startswith("/v1/") or path_only.startswith("/health"):
            if not self._authed():
                self._deny()
                return
            self._proxy(self.path, method)
            return
        self._send(404, "text/plain; charset=utf-8", b"not found")

    def _serve_static(self, path):
        relative = urllib.parse.unquote(path.lstrip("/"))
        root = os.path.realpath(HERE)
        fp = os.path.realpath(os.path.join(root, relative))
        vendor_root = os.path.realpath(os.path.join(root, "vendor"))
        exact = {
            os.path.realpath(os.path.join(root, "index.html")),
            os.path.realpath(os.path.join(root, "manifest.webmanifest")),
            os.path.realpath(os.path.join(root, "sw.js")),
        }
        try:
            in_vendor = os.path.commonpath((fp, vendor_root)) == vendor_root
        except ValueError:
            in_vendor = False
        if fp not in exact and not in_vendor:
            self._send(404, "text/plain; charset=utf-8", b"not found")
            return
        if not os.path.isfile(fp):
            self._send(404, "text/plain; charset=utf-8", b"not found")
            return
        ext = os.path.splitext(fp)[1].lower()
        ctype = {
            ".html": "text/html; charset=utf-8",
            ".js": "application/javascript; charset=utf-8",
            ".webmanifest": "application/manifest+json",
            ".css": "text/css; charset=utf-8",
            ".json": "application/json; charset=utf-8",
        }.get(ext, "application/octet-stream")
        try:
            with open(fp, "rb") as stream:
                data = stream.read()
        except OSError:
            LOGGER.exception("static file read failed: %s", fp)
            self._send(500, "text/plain; charset=utf-8", b"static file unavailable")
            return
        self._send(200, ctype, data, {"Cache-Control": "no-cache" if fp.endswith("index.html") else "no-store"})

    def _proxy(self, path, method):
        if not PROXY_SEMAPHORE.acquire(blocking=False):
            self._send(503, "text/plain; charset=utf-8", b"proxy is busy", {"Retry-After": "5"})
            return
        try:
            body = self._read_body(MAX_REQUEST_BODY)
            if body is READ_ERROR:
                return
            url = UPSTREAM + path
            request = urllib.request.Request(url, data=body or None, method=method)
            for name in ("Content-Type", "Accept", "Last-Event-ID"):
                value = self.headers.get(name)
                if value:
                    request.add_header(name, value)
            if API_KEY:
                request.add_header("Authorization", "Bearer " + API_KEY)
            try:
                response = build_opener().open(request, timeout=UPSTREAM_TIMEOUT)
            except urllib.error.HTTPError as error:
                self._send(
                    error.code,
                    error.headers.get("Content-Type", "application/json"),
                    error.read(MAX_ERROR_BODY),
                )
                return
            except Exception:
                LOGGER.exception("upstream request failed")
                self._send(502, "text/plain; charset=utf-8", b"upstream unavailable")
                return

            content_type = response.headers.get("Content-Type", "application/octet-stream")
            self.send_response(response.status)
            self._security_headers()
            self.send_header("Content-Type", content_type)
            self.send_header("Cache-Control", "no-store")
            content_length = response.headers.get("Content-Length")
            if content_length and "text/event-stream" not in content_type:
                self.send_header("Content-Length", content_length)
            self.end_headers()
            self.connection.settimeout(UPSTREAM_TIMEOUT)
            try:
                while True:
                    chunk = getattr(response, "read1", response.read)(4096)
                    if not chunk:
                        break
                    self.wfile.write(chunk)
                    self.wfile.flush()
            except (BrokenPipeError, ConnectionResetError):
                LOGGER.debug("client disconnected during upstream stream")
            except Exception:
                LOGGER.exception("proxy stream interrupted")
            finally:
                response.close()
        finally:
            PROXY_SEMAPHORE.release()

    def do_GET(self):
        self._forward("GET")

    def do_HEAD(self):
        self._forward("HEAD")

    def do_POST(self):
        self._forward("POST")

    def do_PUT(self):
        self._forward("PUT")

    def do_PATCH(self):
        self._forward("PATCH")

    def do_DELETE(self):
        self._forward("DELETE")

    def do_OPTIONS(self):
        self._send(405, "text/plain; charset=utf-8", b"method not allowed", {"Allow": "GET, HEAD, POST, PUT, PATCH, DELETE"})

    def log_message(self, fmt, *args):
        LOGGER.info("%s - %s", self.address_string(), fmt % args)


def _write_pid():
    with open(PID_FILE, "w", encoding="ascii", newline="") as stream:
        stream.write(str(os.getpid()))


def _remove_pid():
    try:
        os.remove(PID_FILE)
    except FileNotFoundError:
        pass
    except OSError:
        LOGGER.exception("could not remove pid file")


def main():
    global UPSTREAM, PROXY_PORT, API_KEY, PASS
    parser = argparse.ArgumentParser(description="Hermes Uplink local proxy")
    parser.add_argument("--upstream", default=os.environ.get("HERMES_UPSTREAM", UPSTREAM))
    port_value = os.environ.get("HERMES_PORT", str(PROXY_PORT))
    try:
        port_default = int(port_value)
    except ValueError:
        parser.error("HERMES_PORT must be an integer")
    parser.add_argument("--port", type=int, default=port_default)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument(
        "--allow-remote-upstream",
        action="store_true",
        help="allow an HTTPS upstream outside loopback; use only with an explicitly trusted server",
    )
    args = parser.parse_args()
    if not is_loopback_host(args.host):
        parser.error("the proxy only supports loopback binds; use an HTTPS tunnel for remote access")
    if not 1 <= args.port <= 65535:
        parser.error("port must be between 1 and 65535")
    try:
        upstream = validate_upstream(args.upstream, args.allow_remote_upstream)
    except ValueError as error:
        parser.error(str(error))
    api_key = os.environ.get("HERMES_API_KEY", API_KEY)
    passphrase = os.environ.get("UPLINK_PASSPHRASE", PASS)
    if not api_key:
        parser.error("HERMES_API_KEY is required")
    if not passphrase:
        parser.error("UPLINK_PASSPHRASE is required")

    UPSTREAM, PROXY_PORT, API_KEY, PASS = upstream, args.port, api_key, passphrase
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    httpd = UplinkServer((args.host, args.port), Handler)
    try:
        _write_pid()
        LOGGER.info("proxy listening on http://%s:%s -> %s", args.host, args.port, UPSTREAM)
        httpd.serve_forever()
    except KeyboardInterrupt:
        LOGGER.info("proxy stopped")
    finally:
        httpd.server_close()
        _remove_pid()


if __name__ == "__main__":
    main()

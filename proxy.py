#!/usr/bin/env python3
"""Local Hermes API proxy with a browser session gate.

The proxy is intentionally loopback-only. Remote HTTPS access should terminate
at a tunnel or reverse proxy and forward to this process on localhost.
"""

import argparse
import base64
import hashlib
import ipaddress
import json
import logging
import os
import re
import secrets
import select
import socket
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from threading import BoundedSemaphore, Lock, Semaphore, Thread

from uplink_common import (
    DEFAULT_PORT,
    DEFAULT_UPSTREAM,
    HEALTH_PROBE_HEADER,
    HEALTH_PROBE_VALUE,
    KEY_FILE,
    KEY_PATTERN,
    PASS_FILE,
    PASS_PATTERN,
    enable_console_selection,
    read_credential,
)


UPSTREAM = DEFAULT_UPSTREAM
MAX_REQUEST_BODY = 1_048_576
MAX_AUTH_BODY = 8_192
MAX_ERROR_BODY = 1_048_576
UPSTREAM_TIMEOUT = 300
AUTH_SESSION_TTL = 12 * 60 * 60
MAX_SESSIONS = 256
AUTH_ATTEMPT_WINDOW = 60
AUTH_ATTEMPT_LIMIT = 10
MAX_ACTIVE_PROXY_REQUESTS = 32
MAX_ACTIVE_CONNECTIONS = 128
REQUEST_HEADER_TIMEOUT = 30
SESSION_COOKIE = "hermes_uplink_session"
SSE_KEEPALIVE_INTERVAL = 15
FORWARDED_HEADERS = (
    "Content-Type", "Accept", "Last-Event-ID", "Idempotency-Key", "X-Client-Turn-ID",
    "X-Hermes-Client-Capabilities", "X-Hermes-Session-Key",
)
HERE = os.path.dirname(os.path.abspath(__file__))
WEB = os.path.join(HERE, "web")
PID_FILE = os.path.join(HERE, ".uplink.pid")
API_KEY = os.environ.get("HERMES_API_KEY", "")
PASS = os.environ.get("UPLINK_PASSPHRASE", "")

# Static assets are authorized by pinned digests, not by whatever happens to be on
# disk. `python proxy.py --update-hashes` rewrites web/pinned-hashes.json (and the SRI
# digests in index.html) as part of the same reviewed change as the asset edit;
# startup fails closed if a served file drifts. Text assets are hashed and served
# with line endings normalized to LF, so a CRLF checkout does not break SRI.
PINNED_HASHES_FILE = os.path.join(WEB, "pinned-hashes.json")
PINNED_FILES = ("index.html", "app.js", "app.css", "vendor/marked.umd.js", "sw.js")
SCRIPT_FILES = ("app.js", "vendor/marked.umd.js")   # loaded by index.html with SRI; allowed by CSP via the same digest
STATIC_FILES = {
    "/": "index.html",
    "/index.html": "index.html",
    "/manifest.webmanifest": "manifest.webmanifest",
    "/sw.js": "sw.js",
    "/app.js": "app.js",
    "/app.css": "app.css",
}
STATIC_DIRS = ("vendor", "assets")
CONTENT_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".webmanifest": "application/manifest+json",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".png": "image/png",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon",
}
TEXT_EXTENSIONS = (".html", ".js", ".css", ".webmanifest", ".json", ".svg")
SCRIPT_TAG_RE = re.compile(r'<script\s+src="([^"]+)"\s+integrity="sha256-([^"]+)"')
INLINE_SCRIPT_RE = re.compile(r"<script(?![^>]*\bsrc\b)", re.IGNORECASE)


def _read_file(full_path):
    with open(full_path, "rb") as stream:
        data = stream.read()
    if os.path.splitext(full_path)[1].lower() in TEXT_EXTENSIONS:
        data = data.replace(b"\r\n", b"\n").replace(b"\r", b"\n")
    return data


def _read_asset(relative_path):
    try:
        return _read_file(os.path.join(WEB, relative_path))
    except OSError as error:
        raise RuntimeError(f"required static asset is unavailable: {relative_path}") from error


def _sha256_base64(relative_path):
    return base64.b64encode(hashlib.sha256(_read_asset(relative_path)).digest()).decode("ascii")


def load_pinned_hashes():
    try:
        with open(PINNED_HASHES_FILE, "r", encoding="utf-8") as stream:
            hashes = json.load(stream)
    except (OSError, ValueError) as error:
        raise RuntimeError(f"could not read pinned digests: {PINNED_HASHES_FILE}") from error
    if not isinstance(hashes, dict) or set(hashes) != set(PINNED_FILES):
        raise RuntimeError(f"{PINNED_HASHES_FILE} must pin exactly: {', '.join(PINNED_FILES)}")
    return hashes


PINNED_HASHES = load_pinned_hashes()


def check_pinned_hashes():
    """Compare pinned digests with the files on disk and index.html's SRI attributes.

    Returns (is_match, mismatches); each mismatch is (item, expected, actual).
    """
    mismatches = []
    for rel_path, expected in PINNED_HASHES.items():
        actual = _sha256_base64(rel_path)
        if actual != expected:
            mismatches.append((rel_path, expected, actual))
    html = _read_asset("index.html").decode("utf-8")
    declared = {src: digest for src, digest in SCRIPT_TAG_RE.findall(html)}
    for src in SCRIPT_FILES:
        if declared.get(src) != PINNED_HASHES[src]:
            mismatches.append((f"index.html integrity for {src}", PINNED_HASHES[src], declared.get(src)))
    if INLINE_SCRIPT_RE.search(html):
        mismatches.append(("index.html inline <script>", "none", "present"))
    return not mismatches, mismatches


def validate_pinned_assets():
    _, mismatches = check_pinned_hashes()
    if mismatches:
        item, expected, actual = mismatches[0]
        raise RuntimeError(f"integrity check failed for {item}: expected sha256-{expected}, got sha256-{actual}")


def update_pinned_hashes():
    """Recompute digests, refresh index.html's SRI attributes, and rewrite pinned-hashes.json."""
    html_path = os.path.join(WEB, "index.html")
    script_digests = {src: _sha256_base64(src) for src in SCRIPT_FILES}
    html = _read_asset("index.html").decode("utf-8")
    html = SCRIPT_TAG_RE.sub(
        lambda m: m.group(0) if m.group(1) not in script_digests
        else f'<script src="{m.group(1)}" integrity="sha256-{script_digests[m.group(1)]}"',
        html,
    )
    with open(html_path, "w", encoding="utf-8", newline="\n") as stream:
        stream.write(html)
    hashes = {rel_path: _sha256_base64(rel_path) for rel_path in PINNED_FILES}
    with open(PINNED_HASHES_FILE, "w", encoding="utf-8", newline="\n") as stream:
        json.dump(hashes, stream, indent=2)
        stream.write("\n")
    return hashes


def build_csp(hashes):
    script_hashes = " ".join(f"'sha256-{hashes[src]}'" for src in SCRIPT_FILES)
    return (
        "default-src 'none'; "
        f"script-src 'strict-dynamic' {script_hashes}; "
        "style-src 'self'; "
        "script-src-attr 'none'; style-src-attr 'none'; "
        "img-src 'self'; "
        "connect-src 'self'; "
        "font-src 'self'; manifest-src 'self'; worker-src 'self'; object-src 'none'; "
        "base-uri 'none'; "
        "form-action 'self'; frame-ancestors 'none'"
    )


CONTENT_SECURITY_POLICY = build_csp(PINNED_HASHES)
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
TEXT = "text/plain; charset=utf-8"


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


def resolve_static(path):
    """Map a request path to an allowed static file under web/, or None."""
    exact = STATIC_FILES.get(path)
    if exact:
        return os.path.join(WEB, exact)
    relative = urllib.parse.unquote(path.lstrip("/"))
    directory = relative.split("/", 1)[0]
    if directory not in STATIC_DIRS:
        return None
    base = os.path.realpath(os.path.join(WEB, directory))
    full = os.path.realpath(os.path.join(WEB, relative))
    try:
        inside = os.path.commonpath((full, base)) == base
    except ValueError:
        inside = False
    return full if inside else None


class UplinkServer(ThreadingHTTPServer):
    allow_reuse_address = True
    daemon_threads = True
    request_queue_size = 64
    connection_slots = BoundedSemaphore(MAX_ACTIVE_CONNECTIONS)

    def process_request(self, request, client_address):
        if not self.connection_slots.acquire(blocking=False):
            self.shutdown_request(request)
            return
        thread = Thread(
            target=self._process_request_thread,
            args=(request, client_address),
            daemon=self.daemon_threads,
        )
        try:
            thread.start()
        except BaseException:
            self.shutdown_request(request)
            self.connection_slots.release()
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
                self.connection_slots.release()


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

    def _text(self, code, message, extra_headers=None):
        self._send(code, TEXT, message, extra_headers)

    def _no_content(self, set_cookie=None):
        self.send_response(204)
        self._security_headers()
        self.send_header("Content-Length", "0")
        self.send_header("Cache-Control", "no-store")
        if set_cookie:
            self.send_header("Set-Cookie", set_cookie)
        self.end_headers()

    def _read_body(self, maximum):
        if self.headers.get("Transfer-Encoding"):
            return self._reject_body(501, b"chunked request bodies are not supported")
        raw_length = self.headers.get("Content-Length")
        if raw_length in (None, ""):
            return b""
        try:
            length = int(raw_length)
        except (TypeError, ValueError):
            return self._reject_body(400, b"invalid content length")
        if length < 0:
            return self._reject_body(400, b"invalid content length")
        if length > maximum:
            return self._reject_body(413, b"request body too large")

        previous_timeout = self.connection.gettimeout()
        try:
            self.connection.settimeout(30)
            body = self.rfile.read(length)
        except socket.timeout:
            return self._reject_body(408, b"request body timed out")
        finally:
            self.connection.settimeout(previous_timeout)
        if len(body) != length:
            return self._reject_body(400, b"incomplete request body")
        return body

    def _reject_body(self, code, body):
        self.close_connection = True
        self._text(code, body, {"Connection": "close"})
        return READ_ERROR

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
            if len(SESSIONS) >= MAX_SESSIONS:
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
            self._text(405, b"method not allowed", {"Allow": "POST"})
            return
        if not PASS:
            self._text(503, b"authentication is not configured")
            return
        body = self._read_body(MAX_AUTH_BODY)
        if body is READ_ERROR:
            return
        try:
            payload = json.loads(body.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            self._text(400, b"invalid authentication request")
            return
        passphrase = payload.get("passphrase") if isinstance(payload, dict) else None
        if not isinstance(passphrase, str) or not secrets.compare_digest(passphrase, PASS):
            limited, retry_after = self._auth_rate_limited()
            if limited:
                self._text(429, b"too many authentication attempts", {"Retry-After": str(retry_after)})
                return
            self._text(401, b"incorrect passphrase")
            return
        self._auth_success()
        self._no_content(self._session_cookie(self._new_session()))

    def _handle_logout(self):
        if self.command != "POST":
            self._text(405, b"method not allowed", {"Allow": "POST"})
            return
        self._remove_session()
        self._no_content(self._session_cookie("", expired=True))

    def _authed(self):
        return bool(PASS) and self._session_valid()

    def _forward(self, method):
        path_only = self.path.split("?", 1)[0]
        if path_only == "/__auth":
            self._handle_auth()
        elif path_only == "/__logout":
            self._handle_logout()
        elif path_only in STATIC_FILES or path_only.startswith(("/vendor/", "/assets/")):
            self._serve_static(path_only)
        elif path_only.startswith(("/api/", "/v1/", "/health/")) or path_only == "/health":
            if self._authed():
                self._proxy(self.path, method)
            else:
                self._text(401, b"uplink authentication required")
        else:
            self._text(404, b"not found")

    def _serve_static(self, path):
        fp = resolve_static(path)
        if fp is None or not os.path.isfile(fp):
            self._text(404, b"not found")
            return
        try:
            data = _read_file(fp)
        except OSError:
            LOGGER.exception("static file read failed: %s", fp)
            self._text(500, b"static file unavailable")
            return
        ctype = CONTENT_TYPES.get(os.path.splitext(fp)[1].lower(), "application/octet-stream")
        cache = "no-cache" if fp.endswith("index.html") else "no-store"
        self._send(200, ctype, data, {"Cache-Control": cache})

    def _proxy(self, path, method):
        if not PROXY_SEMAPHORE.acquire(blocking=False):
            self._text(503, b"proxy is busy", {"Retry-After": "5"})
            return
        try:
            body = self._read_body(MAX_REQUEST_BODY)
            if body is READ_ERROR:
                return
            response = self._open_upstream(path, method, body)
            if response is not None:
                self._relay(response)
        finally:
            PROXY_SEMAPHORE.release()

    def _open_upstream(self, path, method, body):
        """Open the upstream request, or send the error response and return None."""
        data = body if body else (b"" if method in ("POST", "PUT", "PATCH") else None)
        request = urllib.request.Request(UPSTREAM + path, data=data, method=method)
        for name in FORWARDED_HEADERS:
            value = self.headers.get(name)
            if value:
                request.add_header(name, value)
        if API_KEY:
            request.add_header("Authorization", "Bearer " + API_KEY)
        try:
            return build_opener().open(request, timeout=UPSTREAM_TIMEOUT)
        except urllib.error.HTTPError as error:
            self._send(error.code, error.headers.get("Content-Type", "application/json"), error.read(MAX_ERROR_BODY))
        except Exception:
            LOGGER.exception("upstream request failed")
            self._text(502, b"upstream unavailable")
        return None

    def _relay(self, response):
        content_type = response.headers.get("Content-Type", "application/octet-stream")
        is_event_stream = "text/event-stream" in content_type.lower()
        self.send_response(response.status)
        self._security_headers()
        self.send_header("Content-Type", content_type)
        self.send_header("Cache-Control", "no-store")
        content_length = response.headers.get("Content-Length")
        if content_length and not is_event_stream:
            self.send_header("Content-Length", content_length)
        else:
            # Without a length or chunked framing, connection close is the
            # only valid HTTP/1.1 delimiter for streamed/dechunked bodies.
            self.send_header("Connection", "close")
            self.close_connection = True
        self.end_headers()
        self.connection.settimeout(UPSTREAM_TIMEOUT)
        try:
            if self.command != "HEAD":
                self._pump(response, is_event_stream)
        except (BrokenPipeError, ConnectionResetError):
            LOGGER.debug("client disconnected during upstream stream")
        except Exception:
            LOGGER.exception("proxy stream interrupted")
        finally:
            response.close()

    def _pump(self, response, is_event_stream):
        """Copy the upstream body to the client; on SSE, ping while upstream is quiet."""
        read = getattr(response, "read1", response.read)
        chunk_size = 65536 if is_event_stream else 4096
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
                    # SSE comment ping keeps cellular CGNAT mappings alive.
                    self.wfile.write(b": ping\n\n")
                    self.wfile.flush()
                    continue
            chunk = read(chunk_size)
            if not chunk:
                break
            self.wfile.write(chunk)
            self.wfile.flush()

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
        self._text(405, b"method not allowed", {"Allow": "GET, HEAD, POST, PUT, PATCH, DELETE"})

    def log_message(self, fmt, *args):
        if self.headers.get(HEALTH_PROBE_HEADER) == HEALTH_PROBE_VALUE:
            return
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
    global UPSTREAM, API_KEY, PASS
    parser = argparse.ArgumentParser(description="Hermes Uplink local proxy")
    parser.add_argument(
        "--update-hashes",
        action="store_true",
        help="recalculate static asset SHA-256 digests; rewrites web/pinned-hashes.json and web/index.html's SRI attributes",
    )
    parser.add_argument(
        "--check-hashes",
        action="store_true",
        help="verify whether pinned asset hashes match current files without starting server",
    )
    parser.add_argument("--upstream", default=os.environ.get("HERMES_UPSTREAM", DEFAULT_UPSTREAM))
    port_value = os.environ.get("HERMES_PORT", str(DEFAULT_PORT))
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

    if args.update_hashes:
        print("[+] Pinned digests updated (web/pinned-hashes.json, web/index.html SRI):")
        for path, digest in update_pinned_hashes().items():
            print(f"    {path}: {digest}")
        return

    if args.check_hashes:
        is_match, mismatches = check_pinned_hashes()
        if is_match:
            print("[+] All pinned asset digests match current files.")
            sys.exit(0)
        print("[!] Pinned asset hash drift detected:")
        for item, expected, actual in mismatches:
            print(f"    {item}:")
            print(f"      expected: {expected}")
            print(f"      actual:   {actual}")
        sys.exit(1)

    if not is_loopback_host(args.host):
        parser.error("the proxy only supports loopback binds; use an HTTPS tunnel for remote access")
    if not 1 <= args.port <= 65535:
        parser.error("port must be between 1 and 65535")
    try:
        upstream = validate_upstream(args.upstream, args.allow_remote_upstream)
    except ValueError as error:
        parser.error(str(error))
    API_KEY = API_KEY or read_credential(KEY_FILE, KEY_PATTERN)
    PASS = PASS or read_credential(PASS_FILE, PASS_PATTERN)
    if not API_KEY:
        parser.error(f"set HERMES_API_KEY or provide a valid {KEY_FILE} (run launch_local.bat)")
    if not PASS:
        parser.error(f"set UPLINK_PASSPHRASE or provide a valid {PASS_FILE} (run launch_local.bat)")
    validate_pinned_assets()

    UPSTREAM = upstream
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    enable_console_selection()
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

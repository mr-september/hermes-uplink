import base64
import hashlib
import http.client
import json
import re
import sys
import threading
import unittest
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import proxy  # noqa: E402


class UpstreamHandler(BaseHTTPRequestHandler):
    last_authorization = None
    last_content_length = None
    last_idempotency_key = None
    last_client_turn_id = None

    def _send(self, body=b'{"sessions":[]}'):
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        UpstreamHandler.last_authorization = self.headers.get("Authorization")
        UpstreamHandler.last_idempotency_key = self.headers.get("Idempotency-Key")
        UpstreamHandler.last_client_turn_id = self.headers.get("X-Client-Turn-ID")
        if self.path == "/api/stream":
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.end_headers()
            self.wfile.write(b"event: run.completed\ndata: {}\n\n")
            return
        self._send()

    def do_POST(self):
        UpstreamHandler.last_authorization = self.headers.get("Authorization")
        UpstreamHandler.last_content_length = self.headers.get("Content-Length")
        UpstreamHandler.last_idempotency_key = self.headers.get("Idempotency-Key")
        UpstreamHandler.last_client_turn_id = self.headers.get("X-Client-Turn-ID")
        length = int(self.headers.get("Content-Length", "0"))
        if length:
            self.rfile.read(length)
        self._send(b'{"id":"session-1"}')

    def log_message(self, *_args):
        pass


class ProxyIntegrationTests(unittest.TestCase):
    def setUp(self):
        self.original = proxy.UPSTREAM, proxy.API_KEY, proxy.PASS
        with proxy.SESSION_LOCK:
            proxy.SESSIONS.clear()
            proxy.AUTH_ATTEMPTS.clear()
        self.upstream = ThreadingHTTPServer(("127.0.0.1", 0), UpstreamHandler)
        self.upstream_thread = threading.Thread(target=self.upstream.serve_forever, daemon=True)
        self.upstream_thread.start()
        proxy.UPSTREAM = f"http://127.0.0.1:{self.upstream.server_port}"
        proxy.API_KEY = "test-api-key"
        proxy.PASS = "test-passphrase"
        self.server = proxy.UplinkServer(("127.0.0.1", 0), proxy.Handler)
        self.server_thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.server_thread.start()

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.upstream.shutdown()
        self.upstream.server_close()
        proxy.UPSTREAM, proxy.API_KEY, proxy.PASS = self.original
        with proxy.SESSION_LOCK:
            proxy.SESSIONS.clear()
            proxy.AUTH_ATTEMPTS.clear()

    def request(self, method, path, body=None, headers=None):
        connection = http.client.HTTPConnection("127.0.0.1", self.server.server_port, timeout=3)
        connection.request(method, path, body=body, headers=headers or {})
        response = connection.getresponse()
        payload = response.read()
        response_headers = dict(response.getheaders())
        connection.close()
        return response.status, response_headers, payload

    def authenticate(self):
        status, headers, _ = self.request(
            "POST",
            "/__auth",
            body=json.dumps({"passphrase": proxy.PASS}),
            headers={"Content-Type": "application/json"},
        )
        self.assertEqual(status, 204)
        cookie = SimpleCookie()
        cookie.load(headers["Set-Cookie"])
        return cookie[proxy.SESSION_COOKIE].OutputString()

    def test_cookie_authentication_and_logout(self):
        status, _, _ = self.request("GET", "/api/sessions")
        self.assertEqual(status, 401)

        status, _, _ = self.request("GET", "/api/sessions?t=test-passphrase")
        self.assertEqual(status, 401)

        cookie = self.authenticate()
        status, _, body = self.request("GET", "/api/sessions", headers={"Cookie": cookie})
        self.assertEqual(status, 200)
        self.assertEqual(body, b'{"sessions":[]}')
        self.assertEqual(UpstreamHandler.last_authorization, "Bearer test-api-key")

        status, _, _ = self.request("POST", "/__logout", headers={"Cookie": cookie})
        self.assertEqual(status, 204)
        status, _, _ = self.request("GET", "/api/sessions", headers={"Cookie": cookie})
        self.assertEqual(status, 401)

    def test_correct_passphrase_is_not_locked_out_by_failed_attempts(self):
        for _ in range(proxy.AUTH_ATTEMPT_LIMIT + 1):
            status, _, _ = self.request(
                "POST",
                "/__auth",
                body=json.dumps({"passphrase": "wrong-passphrase"}),
                headers={"Content-Type": "application/json"},
            )
        self.assertEqual(status, 429)
        status, _, _ = self.request(
            "POST",
            "/__auth",
            body=json.dumps({"passphrase": proxy.PASS}),
            headers={"Content-Type": "application/json"},
        )
        self.assertEqual(status, 204)

    def test_event_stream_response_is_connection_delimited(self):
        cookie = self.authenticate()
        status, headers, body = self.request("GET", "/api/stream", headers={"Cookie": cookie})
        self.assertEqual(status, 200)
        self.assertEqual(headers["Connection"].lower(), "close")
        self.assertIn(b"run.completed", body)

    def test_malformed_and_oversized_requests_are_rejected(self):
        cookie = self.authenticate()
        status, headers, _ = self.request(
            "POST",
            "/api/sessions",
            headers={"Cookie": cookie, "Content-Length": "not-a-number"},
        )
        self.assertEqual(status, 400)
        self.assertEqual(headers["Connection"].lower(), "close")

        status, headers, _ = self.request(
            "POST",
            "/api/sessions",
            headers={"Cookie": cookie, "Content-Length": str(proxy.MAX_REQUEST_BODY + 1)},
        )
        self.assertEqual(status, 413)
        self.assertEqual(headers["Connection"].lower(), "close")

    def test_static_path_cannot_escape_vendor_directory(self):
        status, _, _ = self.request("GET", "/vendor/%2e%2e/proxy.py")
        self.assertEqual(status, 404)

    def test_root_serves_client(self):
        status, headers, body = self.request("GET", "/")
        self.assertEqual(status, 200)
        self.assertIn("text/html", headers["Content-Type"])
        self.assertIn(b"Hermes Uplink", body)

    def test_root_csp_pins_scripts_and_disallows_untrusted_inline_styles(self):
        status, headers, body = self.request("GET", "/")
        self.assertEqual(status, 200)
        html = (Path(__file__).resolve().parents[1] / "index.html").read_bytes()
        match = re.search(rb"<script>(.*?)</script>", html, re.DOTALL)
        self.assertIsNotNone(match)
        # HTML parsing canonicalizes CRLF/CR to LF before CSP hashes are
        # checked. Hash the browser-visible script text, not raw file bytes.
        script = match.group(1).replace(b"\r\n", b"\n").replace(b"\r", b"\n")
        digest = base64.b64encode(hashlib.sha256(script).digest()).decode("ascii")
        self.assertIn(f"'sha256-{digest}'", headers["Content-Security-Policy"])
        self.assertEqual(digest, proxy.INLINE_SCRIPT_HASH)
        self.assertIn("'strict-dynamic'", headers["Content-Security-Policy"])
        self.assertNotIn("script-src 'self'", headers["Content-Security-Policy"])
        self.assertNotIn("'unsafe-inline'", headers["Content-Security-Policy"])
        self.assertNotIn(b" style=", body.lower())
        self.assertIn(
            f"integrity=\"sha256-{proxy.PINNED_ASSET_HASHES['vendor/marked.umd.js']}\"".encode(),
            body,
        )

    def test_pinned_assets_match_and_drift_fails_closed(self):
        for relative_path, expected_hash in proxy.PINNED_ASSET_HASHES.items():
            self.assertEqual(proxy._sha256_base64(relative_path), expected_hash)
        with self.assertRaisesRegex(RuntimeError, "integrity check failed for index.html"):
            proxy._validate_pinned_asset("index.html", "not-a-valid-digest")

    def test_text_asset_integrity_is_line_ending_independent(self):
        root = Path(__file__).resolve().parents[1]
        for relative_path in ("index.html", "sw.js"):
            raw = (root / relative_path).read_bytes()
            canonical = raw.replace(b"\r\n", b"\n").replace(b"\r", b"\n")
            expected = base64.b64encode(hashlib.sha256(canonical).digest()).decode("ascii")
            self.assertEqual(proxy._sha256_base64(relative_path), expected)

    def test_validation_requires_loopback_or_explicit_https_remote(self):
        self.assertTrue(proxy.is_loopback_host("127.0.0.1"))
        self.assertTrue(proxy.is_loopback_host("::1"))
        self.assertFalse(proxy.is_loopback_host("0.0.0.0"))
        with self.assertRaises(ValueError):
            proxy.validate_upstream("http://example.test:8642")
        with self.assertRaises(ValueError):
            proxy.validate_upstream("https://user:pass@example.test:8642", allow_remote=True)
        self.assertEqual(
            proxy.validate_upstream("https://example.test:8642", allow_remote=True),
            "https://example.test:8642",
        )

    def test_empty_body_post_forwards_content_length_zero(self):
        cookie = self.authenticate()
        UpstreamHandler.last_content_length = None
        status, _, body = self.request(
            "POST",
            "/api/sessions",
            body=b"",
            headers={"Cookie": cookie, "Content-Length": "0", "Content-Type": "application/json"},
        )
        self.assertEqual(status, 200)
        self.assertEqual(UpstreamHandler.last_content_length, "0")

    def test_compute_current_hashes_and_check_pinned_hashes(self):
        current = proxy.compute_current_hashes()
        self.assertEqual(current["assets"], proxy.PINNED_ASSET_HASHES)
        self.assertEqual(current["script"], proxy.INLINE_SCRIPT_HASH)
        self.assertEqual(current["style"], proxy.INLINE_STYLE_HASH)

        is_match, _, mismatches = proxy.check_pinned_hashes()
        self.assertTrue(is_match)
        self.assertEqual(mismatches, [])

    def test_idempotency_headers_are_forwarded_upstream(self):
        cookie = self.authenticate()
        UpstreamHandler.last_idempotency_key = None
        UpstreamHandler.last_client_turn_id = None
        test_uuid = "12345678-1234-5678-1234-567812345678"
        status, _, _ = self.request(
            "POST",
            "/api/sessions/s1/chat/stream",
            body=json.dumps({"input": "hello", "client_turn_id": test_uuid}),
            headers={
                "Cookie": cookie,
                "Content-Type": "application/json",
                "Idempotency-Key": test_uuid,
                "X-Client-Turn-ID": test_uuid,
            },
        )
        self.assertEqual(status, 200)
        self.assertEqual(UpstreamHandler.last_idempotency_key, test_uuid)
        self.assertEqual(UpstreamHandler.last_client_turn_id, test_uuid)

    def test_client_non_destructive_history_and_race_guards(self):
        # Scope-limited substring assertions against index.html. We do NOT
        # execute the JS (no jsdom in this harness), but the assertions are
        # bounded to specific function bodies so they don't false-positive on
        # unrelated renderThread([]) calls or whitespace tweaks elsewhere.
        #
        # If you find yourself tempted to make these assertions more permissive
        # (e.g. dropping whitespace checks), the right move is to add a jsdom
        # harness under tests/jsdom/ and exercise the actual functions.
        root = Path(__file__).resolve().parents[1]
        lines = (root / "index.html").read_text(encoding="utf-8").splitlines()

        def line_range(start, end):
            # 1-indexed inclusive
            return "\n".join(lines[start - 1:end])

        # Locate the openSession catch block by searching for the marker comment
        # Gemini added at the top of it. If that marker is removed, this test
        # fails loudly — that's the point.
        marker_idx = None
        for i, ln in enumerate(lines, start=1):
            if "NON-DESTRUCTIVE HISTORY INVARIANT" in ln:
                marker_idx = i
                break
        self.assertIsNotNone(
            marker_idx,
            "openSession catch block marker missing — non-destructive invariant anchor lost",
        )

        # Bounded read: from marker to 12 lines below (covers the if-block).
        block = line_range(marker_idx, marker_idx + 12)
        self.assertIn("sessionRenderCache.get(id)", block)
        # The whole point of the fix: renderThread([]) must NOT appear in this block.
        self.assertNotIn("renderThread([])", block)
        # And the catch must NOT unconditionally add an error message either;
        # it must check whether the thread is empty first.
        self.assertIn("t.hasChildNodes()", block)

        # refresh() active-stream guard: find the function and read its first ~12 lines.
        refresh_idx = None
        for i, ln in enumerate(lines, start=1):
            if ln.startswith("async function refresh(){"):
                refresh_idx = i
                break
        self.assertIsNotNone(refresh_idx, "refresh() function not found")
        refresh_block = line_range(refresh_idx, refresh_idx + 10)
        self.assertIn("streamingSessionId === activeId", refresh_block)

        # Lifecycle listeners must be wired at the bottom of the file (pagehide, online, offline).
        # We just check the substrings exist; exact line numbers drift with edits.
        full = (root / "index.html").read_text(encoding="utf-8")
        self.assertIn('window.addEventListener("online"', full)
        self.assertIn('window.addEventListener("offline"', full)
        self.assertIn('window.addEventListener("pagehide"', full)
        self.assertIn('offlineRetryBtn', full)


if __name__ == "__main__":
    unittest.main()

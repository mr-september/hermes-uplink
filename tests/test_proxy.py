import base64
import hashlib
import http.client
import json
import sys
import threading
import time
import unittest
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest import mock

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
        if self.path == "/api/stream_idle":
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.end_headers()
            self.wfile.flush()
            time.sleep(0.3)
            self.wfile.write(b"event: run.completed\ndata: {}\n\n")
            self.wfile.flush()
            return
        if self.path == "/api/stream_buffered":
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.end_headers()
            self.wfile.write(b"event: message\ndata: " + (b"B" * 6000) + b"\n\n")
            self.wfile.flush()
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

    def test_event_stream_keepalive_ping_injected_on_idle_upstream(self):
        cookie = self.authenticate()
        orig_interval = proxy.SSE_KEEPALIVE_INTERVAL
        proxy.SSE_KEEPALIVE_INTERVAL = 0.1
        try:
            status, headers, body = self.request("GET", "/api/stream_idle", headers={"Cookie": cookie})
            self.assertEqual(status, 200)
            self.assertEqual(headers["Connection"].lower(), "close")
            self.assertIn(b": ping\n\n", body)
            self.assertIn(b"run.completed", body)
        finally:
            proxy.SSE_KEEPALIVE_INTERVAL = orig_interval

    def test_event_stream_buffered_payload_delivered_immediately(self):
        cookie = self.authenticate()
        status, headers, body = self.request("GET", "/api/stream_buffered", headers={"Cookie": cookie})
        self.assertEqual(status, 200)
        self.assertIn(b"event: message\ndata: " + (b"B" * 6000) + b"\n\n", body)

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

    def test_unlisted_health_like_paths_are_not_proxied(self):
        cookie = self.authenticate()
        status, _, _ = self.request("GET", "/healthz", headers={"Cookie": cookie})
        self.assertEqual(status, 404)

    def test_root_serves_client(self):
        status, headers, body = self.request("GET", "/")
        self.assertEqual(status, 200)
        self.assertIn("text/html", headers["Content-Type"])
        self.assertIn(b"Hermes Uplink", body)

    def test_root_csp_pins_scripts_and_disallows_inline_code_and_styles(self):
        status, headers, body = self.request("GET", "/")
        self.assertEqual(status, 200)
        csp = headers["Content-Security-Policy"]
        self.assertIn("'strict-dynamic'", csp)
        self.assertNotIn("'unsafe-inline'", csp)
        self.assertNotIn("script-src 'self'", csp)
        for src in proxy.SCRIPT_FILES:
            digest = proxy.PINNED_HASHES[src]
            self.assertIn(f"'sha256-{digest}'", csp)
            self.assertIn(f'<script src="{src}" integrity="sha256-{digest}"'.encode(), body)
        self.assertEqual(body.count(b"<script"), body.count(b"<script src="))   # no inline script
        self.assertNotIn(b" style=", body.lower())

    def test_served_scripts_match_their_pinned_digests(self):
        for path, pin in (("/app.js", "app.js"), ("/vendor/marked.umd.js", "vendor/marked.umd.js")):
            status, _, body = self.request("GET", path)
            self.assertEqual(status, 200)
            digest = base64.b64encode(hashlib.sha256(body).digest()).decode("ascii")
            self.assertEqual(digest, proxy.PINNED_HASHES[pin])

    def test_pinned_assets_match_and_drift_fails_closed(self):
        is_match, mismatches = proxy.check_pinned_hashes()
        self.assertTrue(is_match, mismatches)
        proxy.validate_pinned_assets()
        drifted = dict(proxy.PINNED_HASHES, **{"index.html": "not-a-valid-digest"})
        with mock.patch.object(proxy, "PINNED_HASHES", drifted):
            with self.assertRaisesRegex(RuntimeError, "integrity check failed for index.html"):
                proxy.validate_pinned_assets()

    def test_text_asset_integrity_is_line_ending_independent(self):
        root = Path(__file__).resolve().parents[1]
        for relative_path in ("index.html", "app.js", "app.css", "sw.js"):
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


if __name__ == "__main__":
    unittest.main()

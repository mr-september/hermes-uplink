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

    def _send(self, body=b'{"sessions":[]}'):
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        UpstreamHandler.last_authorization = self.headers.get("Authorization")
        if self.path == "/api/stream":
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.end_headers()
            self.wfile.write(b"event: run.completed\ndata: {}\n\n")
            return
        self._send()

    def do_POST(self):
        UpstreamHandler.last_authorization = self.headers.get("Authorization")
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

    def test_root_csp_allows_current_inline_client(self):
        status, headers, _ = self.request("GET", "/")
        self.assertEqual(status, 200)
        html = (Path(__file__).resolve().parents[1] / "index.html").read_bytes()
        match = re.search(rb"<script>(.*?)</script>", html, re.DOTALL)
        self.assertIsNotNone(match)
        # HTML parsing canonicalizes CRLF/CR to LF before CSP hashes are
        # checked. Hash the browser-visible script text, not raw file bytes.
        script = match.group(1).replace(b"\r\n", b"\n").replace(b"\r", b"\n")
        digest = base64.b64encode(hashlib.sha256(script).digest()).decode("ascii")
        self.assertIn(f"'sha256-{digest}'", headers["Content-Security-Policy"])

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


if __name__ == "__main__":
    unittest.main()

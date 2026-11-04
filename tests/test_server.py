import base64
import hashlib
import http.client
import json
import shutil
import sys
import tempfile
import threading
import time
import unittest
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from uplink import assets, auth, server  # noqa: E402

PASSPHRASE = "test-passphrase"


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

    def _event_stream(self, *chunks, pause=0):
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.end_headers()
        self.wfile.flush()
        time.sleep(pause)
        for chunk in chunks:
            self.wfile.write(chunk)
        self.wfile.flush()

    def do_GET(self):
        UpstreamHandler.last_authorization = self.headers.get("Authorization")
        if self.path == "/api/stream":
            self._event_stream(b"event: run.completed\ndata: {}\n\n")
        elif self.path == "/api/stream_idle":
            self._event_stream(b"event: run.completed\ndata: {}\n\n", pause=0.3)
        elif self.path == "/api/stream_buffered":
            self._event_stream(b"event: message\ndata: " + (b"B" * 6000) + b"\n\n")
        else:
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
        self.upstream = ThreadingHTTPServer(("127.0.0.1", 0), UpstreamHandler)
        threading.Thread(target=self.upstream.serve_forever, daemon=True).start()
        config = server.Config(f"http://127.0.0.1:{self.upstream.server_port}", "test-api-key", PASSPHRASE)
        self.server = server.UplinkServer(("127.0.0.1", 0), config)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.upstream.shutdown()
        self.upstream.server_close()

    def request(self, method, path, body=None, headers=None):
        connection = http.client.HTTPConnection("127.0.0.1", self.server.server_port, timeout=3)
        connection.request(method, path, body=body, headers=headers or {})
        response = connection.getresponse()
        payload = response.read()
        response_headers = dict(response.getheaders())
        connection.close()
        return response.status, response_headers, payload

    def login(self, passphrase=PASSPHRASE):
        return self.request("POST", "/__auth", body=json.dumps({"passphrase": passphrase}),
                            headers={"Content-Type": "application/json"})

    def authenticate(self):
        status, headers, _ = self.login()
        self.assertEqual(status, 204)
        cookie = SimpleCookie()
        cookie.load(headers["Set-Cookie"])
        return cookie[server.SESSION_COOKIE].OutputString()

    def test_cookie_authentication_and_logout(self):
        self.assertEqual(self.request("GET", "/api/sessions")[0], 401)
        self.assertEqual(self.request("GET", "/api/sessions?t=test-passphrase")[0], 401)

        cookie = self.authenticate()
        status, _, body = self.request("GET", "/api/sessions", headers={"Cookie": cookie})
        self.assertEqual((status, body), (200, b'{"sessions":[]}'))
        self.assertEqual(UpstreamHandler.last_authorization, "Bearer test-api-key")

        self.assertEqual(self.request("POST", "/__logout", headers={"Cookie": cookie})[0], 204)
        self.assertEqual(self.request("GET", "/api/sessions", headers={"Cookie": cookie})[0], 401)

    def test_correct_passphrase_is_not_locked_out_by_failed_attempts(self):
        for _ in range(auth.ATTEMPT_LIMIT + 1):
            status, _, _ = self.login("wrong-passphrase")
        self.assertEqual(status, 429)
        self.assertEqual(self.login()[0], 204)

    def test_non_ascii_passphrase_attempt_is_refused_not_an_error(self):
        self.assertEqual(self.login("pässphrase")[0], 401)

    def test_event_stream_response_is_connection_delimited(self):
        cookie = self.authenticate()
        status, headers, body = self.request("GET", "/api/stream", headers={"Cookie": cookie})
        self.assertEqual(status, 200)
        self.assertEqual(headers["Connection"].lower(), "close")
        self.assertIn(b"run.completed", body)

    def test_event_stream_keepalive_ping_injected_on_idle_upstream(self):
        cookie = self.authenticate()
        with mock.patch.object(server, "SSE_KEEPALIVE_INTERVAL", 0.1):
            status, headers, body = self.request("GET", "/api/stream_idle", headers={"Cookie": cookie})
        self.assertEqual(status, 200)
        self.assertIn(b": ping\n\n", body)
        self.assertIn(b"run.completed", body)

    def test_event_stream_buffered_payload_delivered_immediately(self):
        cookie = self.authenticate()
        status, _, body = self.request("GET", "/api/stream_buffered", headers={"Cookie": cookie})
        self.assertEqual(status, 200)
        self.assertIn(b"event: message\ndata: " + (b"B" * 6000) + b"\n\n", body)

    def test_malformed_and_oversized_requests_are_rejected(self):
        cookie = self.authenticate()
        for length, expected in (("not-a-number", 400), ("-1", 400), (str(server.MAX_REQUEST_BODY + 1), 413)):
            status, headers, _ = self.request("POST", "/api/sessions", headers={"Cookie": cookie, "Content-Length": length})
            self.assertEqual(status, expected, length)
            self.assertEqual(headers["Connection"].lower(), "close")

    def test_only_the_client_files_are_served(self):
        self.assertEqual(self.request("GET", "/vendor/%2e%2e/uplink/server.py")[0], 404)
        self.assertEqual(self.request("GET", "/pinned-hashes.json")[0], 404)
        self.assertEqual(self.request("POST", "/index.html")[0], 405)

    def test_unlisted_health_like_paths_are_not_proxied(self):
        cookie = self.authenticate()
        self.assertEqual(self.request("GET", "/healthz", headers={"Cookie": cookie})[0], 404)

    def test_root_csp_pins_scripts_and_disallows_inline_code_and_styles(self):
        status, headers, body = self.request("GET", "/")
        self.assertEqual(status, 200)
        self.assertIn("text/html", headers["Content-Type"])
        csp = headers["Content-Security-Policy"]
        self.assertIn("'strict-dynamic'", csp)
        self.assertNotIn("'unsafe-inline'", csp)
        self.assertNotIn("script-src 'self'", csp)
        tags = assets.SCRIPT_TAG_RE.findall(body.decode("utf-8"))
        self.assertTrue(tags)
        for _, digest in tags:
            self.assertIn(f"'sha256-{digest}'", csp)
        self.assertEqual(body.count(b"<script"), len(tags))   # every script is external and carries SRI
        self.assertNotIn(b" style=", body.lower())

    def test_served_code_matches_its_pins(self):
        pins = json.loads((assets.WEB / assets.PIN_FILE_NAME).read_text(encoding="utf-8"))
        self.assertIn("js/main.js", pins)
        for name, pin in pins.items():
            status, _, body = self.request("GET", "/" + name)
            self.assertEqual(status, 200, name)
            self.assertEqual(base64.b64encode(hashlib.sha256(body).digest()).decode("ascii"), pin, name)

    def test_empty_body_post_forwards_content_length_zero(self):
        cookie = self.authenticate()
        UpstreamHandler.last_content_length = None
        status, _, _ = self.request("POST", "/api/sessions", body=b"",
                                    headers={"Cookie": cookie, "Content-Length": "0", "Content-Type": "application/json"})
        self.assertEqual(status, 200)
        self.assertEqual(UpstreamHandler.last_content_length, "0")

    def test_idempotency_headers_are_forwarded_upstream(self):
        cookie = self.authenticate()
        turn = "12345678-1234-5678-1234-567812345678"
        status, _, _ = self.request(
            "POST", "/api/sessions/s1/chat/stream",
            body=json.dumps({"input": "hello", "client_turn_id": turn}),
            headers={"Cookie": cookie, "Content-Type": "application/json", "Idempotency-Key": turn, "X-Client-Turn-ID": turn},
        )
        self.assertEqual(status, 200)
        self.assertEqual((UpstreamHandler.last_idempotency_key, UpstreamHandler.last_client_turn_id), (turn, turn))

    def test_upstream_validation_requires_loopback_or_explicit_https_remote(self):
        self.assertTrue(server.is_loopback_host("127.0.0.1"))
        self.assertTrue(server.is_loopback_host("::1"))
        self.assertFalse(server.is_loopback_host("0.0.0.0"))
        with self.assertRaises(ValueError):
            server.validate_upstream("http://example.test:8642")
        with self.assertRaises(ValueError):
            server.validate_upstream("https://user:pass@example.test:8642", allow_remote=True)
        self.assertEqual(server.validate_upstream("https://example.test:8642", allow_remote=True), "https://example.test:8642")


class PinnedAssetTests(unittest.TestCase):
    def setUp(self):
        self.web = Path(tempfile.mkdtemp()) / "web"
        shutil.copytree(assets.WEB, self.web)
        self.addCleanup(shutil.rmtree, self.web.parent)

    def test_checked_in_files_match_their_pins(self):
        self.assertEqual(assets.drift(), [])

    def test_crlf_checkout_still_matches(self):
        for name in ("index.html", "app.css", "js/main.js"):
            path = self.web / name
            path.write_bytes(path.read_bytes().replace(b"\n", b"\r\n"))
        self.assertEqual(assets.drift(self.web), [])

    def test_drift_refuses_to_serve_and_update_repins(self):
        css = self.web / "app.css"
        css.write_bytes(css.read_bytes() + b"\n/* edited */\n")
        with self.assertRaisesRegex(assets.AssetError, "integrity check failed for app.css"):
            assets.Site(self.web)
        assets.update(self.web)
        self.assertEqual(assets.drift(self.web), [])
        assets.Site(self.web)

    def test_update_refreshes_the_bootstrap_sri_and_csp(self):
        entry = self.web / "js" / "boot.js"
        entry.write_bytes(entry.read_bytes() + b"\n// edited\n")
        self.assertIn("index.html integrity for js/boot.js", [item for item, _, _ in assets.drift(self.web)])
        assets.update(self.web)
        site = assets.Site(self.web)
        digest = base64.b64encode(hashlib.sha256(site.get("/js/boot.js").body).digest()).decode("ascii")
        self.assertIn(f"'sha256-{digest}'", site.csp)


if __name__ == "__main__":
    unittest.main()

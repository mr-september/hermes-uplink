"""Run the browser's read-only Kanban board view in a real Chromium.

Like tests/test_client_clarify.py, this serves the real web/js modules together with a stripped copy of
index.html — boot.js removed and fetch replaced by a stub scripted per path prefix (window.__get) — loads
the assertions in tests/fixtures/kanban_board.js, and reads the results back from the dumped DOM. The
fixture covers capabilities gating, board rendering, the GOAL rollup rule, the truncated notice, and the
detail drawer.

Skipped when no Chrome/Chromium is available; set CHROME_BIN to point at one. GitHub-hosted runners ship
Google Chrome, so CI runs it.
"""
import json
import re
import subprocess
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from test_client_clarify import BROWSER, FIXTURES, WEB  # noqa: E402  (browser discovery and paths)

BOOT_TAG = re.compile(rb'<script src="js/boot\.js"[^>]*></script>')

STUB = b"""<script>
window.__calls = [];
window.__get = {};   // URL prefix -> {status, body}; the longest matching prefix answers
window.fetch = function(path, opts){
  opts = opts || {};
  window.__calls.push({path: String(path), method: opts.method || "GET"});
  const key = Object.keys(window.__get)
    .filter((k)=> String(path).startsWith(k))
    .sort((a, b)=> b.length - a.length)[0];
  const scripted = key ? window.__get[key] : null;
  const status = scripted ? (scripted.status || 200) : 404;
  const body = scripted ? (scripted.body || {}) : {};
  return Promise.resolve({ok: status >= 200 && status < 300, status: status,
                          json: async () => body, text: async () => ""});
};
</script>
<script type="module" src="/fixtures/kanban_board.js"></script>"""


class KanbanFixtureHandler(BaseHTTPRequestHandler):
    """index.html without boot.js (plus the scripted fetch stub), the real web/js and web/vendor, and the fixtures."""

    def do_GET(self):
        if self.path == "/":
            page = BOOT_TAG.sub(STUB, (WEB / "index.html").read_bytes(), count=1)
            if STUB.splitlines()[0].decode() not in page.decode():
                raise AssertionError("boot.js script tag not found in index.html")
            self._send(page, "text/html; charset=utf-8")
            return
        for prefix, directory in (("/js/", WEB / "js"), ("/vendor/", WEB / "vendor"), ("/fixtures/", FIXTURES)):
            if self.path.startswith(prefix):
                path = (directory / self.path[len(prefix):]).resolve()
                if not path.is_file() or directory.resolve() not in path.parents:
                    break
                self._send(path.read_bytes(), "text/javascript; charset=utf-8",
                           {"Cache-Control": "no-store"})
                return
        self.send_response(404)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def _send(self, body, content_type, extra=None):
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        for key, value in (extra or {}).items():
            self.send_header(key, value)
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *_args):
        pass


class KanbanBoardTests(unittest.TestCase):
    @unittest.skipUnless(BROWSER, "no Chrome/Chromium found (set CHROME_BIN to enable this test)")
    def test_kanban_board_in_a_real_browser(self):
        server = ThreadingHTTPServer(("127.0.0.1", 0), KanbanFixtureHandler)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        with tempfile.TemporaryDirectory(prefix="uplink-chrome-") as profile:
            completed = subprocess.run(
                [BROWSER, "--headless=new", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage",
                 f"--user-data-dir={profile}", "--virtual-time-budget=6000", "--timeout=20000",
                 "--dump-dom", f"http://127.0.0.1:{server.server_port}/"],
                capture_output=True, text=True, timeout=120, encoding="utf-8", errors="replace")
        server.shutdown()
        server.server_close()
        match = re.search(r"TESTRESULT (\{.*\})", completed.stdout)
        self.assertIsNotNone(match, "the fixture never reported; chromium exited with code "
                                    f"{completed.returncode}\nstdout tail:\n{completed.stdout[-2000:]}")
        report = json.loads(match.group(1))
        self.assertNotIn("error", report, f"fixture error: {report.get('error')}")
        self.assertGreaterEqual(report["total"], 20, "the fixture ran fewer checks than expected")
        self.assertEqual(report["failed"], [], "kanban board checks failed")


if __name__ == "__main__":
    unittest.main()

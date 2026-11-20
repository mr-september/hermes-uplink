"""Run the browser's clarify state machine in a real Chromium.

The client has no build step and no DOM in the Python suite, and the clarify card is its most
intricate state machine (select, lock, submit, skip, 409, server-side settle, batch). This test
serves the real web/js modules together with a stripped copy of index.html — boot.js removed and
fetch replaced by a recording stub — loads the assertions in tests/fixtures/clarify_state_machine.js,
drives the cards with real clicks, and reads the assertions back from the dumped DOM.

Skipped when no Chrome/Chromium is available; set CHROME_BIN to point at one. GitHub-hosted
runners ship Google Chrome, so CI runs it.
"""
import glob
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
WEB = ROOT / "web"
FIXTURES = ROOT / "tests" / "fixtures"
BOOT_TAG = re.compile(rb'<script src="js/boot\.js"[^>]*></script>')

STUB = b"""<script>
window.__calls = [];
window.__scripted = {};
window.fetch = function(path, opts){
  opts = opts || {};
  window.__calls.push({path: String(path), method: opts.method || "GET", body: opts.body || null});
  let status = opts.method === "POST" ? 204 : 401;   // background GETs (probe, sessions) stay unauthenticated
  try {
    const scripted = window.__scripted[JSON.parse(opts.body || "{}").clarify_id];
    if (scripted) status = scripted;
  } catch (err) {}
  const ok = status >= 200 && status < 300;
  return Promise.resolve({ok: ok, status: status, json: async () => ({}), text: async () => ""});
};
</script>
<script type="module" src="/fixtures/clarify_state_machine.js"></script>"""


def find_browser():
    env = os.environ.get("CHROME_BIN")
    if env:
        return env if Path(env).is_file() else None
    candidates = []
    if sys.platform == "win32":
        for program_files in (os.environ.get("PROGRAMFILES", r"C:\Program Files"),
                              os.environ.get("PROGRAMFILES(X86)", r"C:\Program Files (x86)")):
            candidates.append(Path(program_files) / "Google" / "Chrome" / "Application" / "chrome.exe")
            candidates.append(Path(program_files) / "Microsoft" / "Edge" / "Application" / "msedge.exe")
        local = os.environ.get("LOCALAPPDATA")
        if local:  # the Chromium Hermes itself ships is fine too
            candidates += [Path(p) for p in sorted(glob.glob(os.path.join(local, "ms-playwright",
                                                                          "chromium-*", "chrome-win", "chrome.exe")))]
    else:
        for name in ("google-chrome", "google-chrome-stable", "chromium", "chromium-browser"):
            found = shutil.which(name)
            if found:
                candidates.append(found)
    return next((str(path) for path in candidates if Path(path).is_file()), None)


BROWSER = find_browser()


class FixtureHandler(BaseHTTPRequestHandler):
    """index.html without boot.js (plus the fetch stub), the real web/js and web/vendor, and the fixtures."""

    def do_GET(self):
        if self.path == "/":
            page = BOOT_TAG.sub(STUB, (WEB / "index.html").read_bytes(), count=1)
            if STUB.splitlines()[0].decode() not in page.decode():
                raise AssertionError("boot.js script tag not found in index.html")
            self._send(page, "text/html; charset=utf-8")
            return
        for prefix, directory, suffix in (("/js/", WEB / "js", "utf-8"),
                                          ("/vendor/", WEB / "vendor", "utf-8"),
                                          ("/fixtures/", FIXTURES, "utf-8")):
            if self.path.startswith(prefix):
                name = self.path[len(prefix):]
                path = (directory / name).resolve()
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


class ClarifyStateMachineTests(unittest.TestCase):
    @unittest.skipUnless(BROWSER, "no Chrome/Chromium found (set CHROME_BIN to enable this test)")
    def test_clarify_cards_in_a_real_browser(self):
        server = ThreadingHTTPServer(("127.0.0.1", 0), FixtureHandler)
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
        self.assertGreaterEqual(report["total"], 15, "the fixture ran fewer checks than expected")
        self.assertEqual(report["failed"], [], "clarify state-machine checks failed")


if __name__ == "__main__":
    unittest.main()

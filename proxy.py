#!/usr/bin/env python3
"""
hermes-uplink proxy — stdlib reverse proxy + optional passphrase gate.

Design goals:
  * Same-origin client: serves index.html (and PWA assets) so the browser never
    needs the Hermes API key and never fights CORS.
  * Server-side key injection: HERMES_API_KEY is added here, never shipped to the edge.
  * Optional passphrase gate: if UPLINK_PASSPHRASE is set, the proxy requires it once
    (via `?t=PASS` or header `x-uplink-token`); on success it sets an HttpOnly cookie so
    the browser stays authed. This protects a publicly-tunneled endpoint WITHOUT ever
    exposing the real API key. If UPLINK_PASSPHRASE is empty, the gate is off (LAN-only).

Routes:
  /                       -> index.html
  /manifest.webmanifest   -> PWA manifest
  /sw.js                  -> service worker
  /__auth                 -> token check; sets cookie on success (204) or 401
  /api/*  /v1/*  /health* -> upstream (Bearer injected)

Only stdlib (http, urllib). No pip install on Windows.
"""
import argparse
import os
import urllib.request
import urllib.error
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

UPSTREAM = "http://127.0.0.1:8642"
PROXY_PORT = 8787
API_KEY = os.environ.get("HERMES_API_KEY", "")
PASS = os.environ.get("UPLINK_PASSPHRASE", "")
COOKIE = "uplink_auth"
HERE = os.path.dirname(os.path.abspath(__file__))


def build_opener():
    return urllib.request.build_opener(urllib.request.ProxyHandler({}))


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    # ---- auth ----
    def _cookie_ok(self):
        c = self.headers.get("Cookie") or ""
        return (COOKIE + "=1") in c

    def _token_ok(self):
        return (self.headers.get("x-uplink-token") == PASS) or ("t=" + PASS) in self.path

    def _authed(self):
        if not PASS:
            return True
        return self._cookie_ok() or self._token_ok()

    def _handle_auth(self):
        if PASS and self._token_ok():
            self.send_response(204)
            self.send_header("Set-Cookie",
                COOKIE + "=1; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000")
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        self.send_response(401)
        self.send_header("Content-Type", "text/plain; charset=utf-8")
        msg = "uplink auth required"
        self.send_header("Content-Length", str(len(msg)))
        self.end_headers()
        self.wfile.write(msg.encode())

    def _deny(self):
        self.send_response(401)
        self.send_header("Content-Type", "text/plain; charset=utf-8")
        msg = "uplink auth required"
        self.send_header("Content-Length", str(len(msg)))
        self.end_headers()
        self.wfile.write(msg.encode())

    # ---- main dispatch ----
    def _forward(self, method):
        self.close_connection = True
        path = self.path.split("?", 1)[0]

        if path == "/__auth":
            self._handle_auth()
            return

        if path in ("/", "/index.html", "/manifest.webmanifest", "/sw.js") or path.startswith("/vendor/"):
            self._serve_static(path)
            return

        if path.startswith("/api/") or path.startswith("/v1/") or path.startswith("/health"):
            if not self._authed():
                self._deny()
                return
            self._proxy(path, method)
            return

        self._send(404, "text/plain", b"not found")

    def _serve_static(self, path):
        fname = "index.html" if path in ("/", "/index.html") else path.lstrip("/")
        # prevent path traversal: resolve and ensure it stays under HERE
        fp = os.path.normpath(os.path.join(HERE, fname))
        if not fp.startswith(os.path.normpath(HERE)) or not os.path.isfile(fp):
            self._send(404, "text/plain", b"not found")
            return
        ext = os.path.splitext(fname)[1].lower()
        ctype = {
            ".html": "text/html; charset=utf-8",
            ".js": "application/javascript",
            ".webmanifest": "application/manifest+json",
            ".css": "text/css",
            ".json": "application/json",
        }.get(ext, "application/octet-stream")
        with open(fp, "rb") as f:
            data = f.read()
        self._send(200, ctype, data)

    def _proxy(self, path, method):
        url = UPSTREAM + path
        length = int(self.headers.get("Content-Length", 0) or 0)
        body = self.rfile.read(length) if length else None
        req = urllib.request.Request(url, data=body, method=method)
        for k in ("Content-Type",):
            v = self.headers.get(k)
            if v:
                req.add_header(k, v)
        if API_KEY:
            req.add_header("Authorization", "Bearer " + API_KEY)
        try:
            resp = build_opener().open(req, timeout=300)
        except urllib.error.HTTPError as e:
            self._send(e.code, "application/json", e.read())
            return
        except Exception as e:
            self._send(502, "text/plain", ("upstream error: " + str(e)).encode())
            return
        ct = resp.headers.get("Content-Type", "application/octet-stream")
        data = resp.read()
        self._send(resp.status, ct, data)

    def _send(self, code, ctype, body):
        if isinstance(body, str):
            body = body.encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def do_GET(self):
        self._forward("GET")

    def do_POST(self):
        self._forward("POST")

    def do_PATCH(self):
        self._forward("PATCH")

    def do_DELETE(self):
        self._forward("DELETE")

    def log_message(self, *a):
        pass


def main():
    global UPSTREAM, PROXY_PORT, API_KEY, PASS
    p = argparse.ArgumentParser(description="Hermes Uplink proxy")
    p.add_argument("--upstream", default=os.environ.get("HERMES_UPSTREAM", UPSTREAM))
    p.add_argument("--port", type=int, default=int(os.environ.get("HERMES_PORT", PROXY_PORT)))
    p.add_argument("--key", default=API_KEY)
    p.add_argument("--pass", dest="passphrase", default=PASS)
    p.add_argument("--host", default="127.0.0.1")
    a = p.parse_args()
    UPSTREAM, PROXY_PORT, API_KEY, PASS = a.upstream, a.port, a.key, a.passphrase
    if not API_KEY:
        print("[warn] HERMES_API_KEY empty — upstream may reject requests.")
    if not PASS:
        print("[warn] UPLINK_PASSPHRASE empty — proxy is OPEN (only safe on a trusted LAN).")
    httpd = ThreadingHTTPServer((a.host, a.port), Handler)
    print(f"hermes-uplink proxy on http://{a.host}:{a.port} -> {UPSTREAM}"
          f"{' (passphrase gate ON)' if PASS else ' (NO AUTH)'}")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nstopped.")


if __name__ == "__main__":
    main()

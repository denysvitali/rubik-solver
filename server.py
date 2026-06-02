#!/usr/bin/env python3
"""Static server for the Rubik detector.

Two layers of cache-busting so the browser can NEVER run stale JS:
  1. `Cache-Control: no-store` (+ Pragma/Expires) on every response.
  2. index.html is served dynamically with a unique `?v=<token>` appended to
     the detector.js / app.js / style references, regenerated every request.

opencv.js is intentionally NOT busted (10 MB, never changes) so it stays cached.
"""
import http.server
import socketserver
import time
import os
import urllib.request

PORT = 8085
ROOT = os.path.dirname(os.path.abspath(__file__))

# Files whose <script>/<link> refs get a fresh version token each page load.
BUSTED = ("detector.js", "app.js")

# Sample image: fetched server-side from the clean origin URL (no binary is
# committed to the repo, and no third-party image proxy is used) and served
# same-origin so the canvas isn't CORS-tainted when we read its pixels.
SAMPLE_URL = "https://www.wfmt.com/wp-content/uploads/2023/02/rubiks.jpg"
_sample_cache = None


def fetch_sample():
    global _sample_cache
    if _sample_cache is None:
        req = urllib.request.Request(SAMPLE_URL, headers={"User-Agent": "Mozilla/5.0"})
        _sample_cache = urllib.request.urlopen(req, timeout=20).read()
    return _sample_cache


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=ROOT, **kw)

    def end_headers(self):
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()

    def do_GET(self):
        path = self.path.split("?", 1)[0]
        if path in ("/", "/index.html"):
            return self._serve_index()
        if path == "/sample.jpg":
            return self._serve_sample()
        return super().do_GET()

    def _serve_sample(self):
        try:
            body = fetch_sample()
        except Exception as exc:  # network error → 502 so the UI can report it
            self.send_error(502, f"Could not fetch sample image: {exc}")
            return
        self.send_response(200)
        self.send_header("Content-Type", "image/jpeg")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _serve_index(self):
        token = f"{int(time.time())}-{os.getpid()}"
        try:
            with open(os.path.join(ROOT, "index.html"), "r", encoding="utf-8") as fh:
                html = fh.read()
        except OSError:
            self.send_error(404)
            return
        for name in BUSTED:
            html = html.replace(f'src="{name}"', f'src="{name}?v={token}"')
        body = html.encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


if __name__ == "__main__":
    socketserver.TCPServer.allow_reuse_address = True
    with socketserver.TCPServer(("0.0.0.0", PORT), Handler) as httpd:
        print(f"Serving on http://0.0.0.0:{PORT} (no-store + per-request cache-bust)")
        httpd.serve_forever()

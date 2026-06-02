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

PORT = 8085
ROOT = os.path.dirname(os.path.abspath(__file__))

# Files whose <script>/<link> refs get a fresh version token each page load.
BUSTED = ("detector.js", "app.js")


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
        return super().do_GET()

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

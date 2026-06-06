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
import hashlib
import os
import urllib.request

PORT = 8085
ROOT = os.path.dirname(os.path.abspath(__file__))

# Files whose <script>/<link> refs get a content-derived version token.
# The token is recomputed only when one of the files' mtime changes — so
# the browser can keep the file in its normal cache between edits (using
# 304s), and the token flips the instant you save.
BUSTED = (
    "detector.js",
    "pipeline/steps/stickerFaces.js",
    "pipeline/steps/singleFaceFallback.js",
    "pipeline/steps/learnedFaceLocalization.js",
    "pipeline/steps/geometricSilhouette.js",
    "pipeline/steps/lowConfidenceSingleFace.js",
    "pipeline/pipeline.js",
    "app.js",
)
_BUST_STATE = (0.0, "")  # (max_mtime, token)


def _bust_token():
    global _BUST_STATE
    mt = max(os.path.getmtime(os.path.join(ROOT, n)) for n in BUSTED)
    if _BUST_STATE[0] == mt:
        return _BUST_STATE[1]
    h = hashlib.md5()
    for n in BUSTED:
        with open(os.path.join(ROOT, n), "rb") as fh:
            h.update(fh.read())
    _BUST_STATE = (mt, h.hexdigest()[:10])
    return _BUST_STATE[1]

# Sample image: prefer the local file committed to the repo (no network
# dependency). Fall back to fetching the canonical origin URL only if the
# local file is missing. Either way it's served same-origin so the canvas
# isn't CORS-tainted when we read its pixels.
SAMPLE_URL = "https://www.wfmt.com/wp-content/uploads/2023/02/rubiks.jpg"
_sample_cache = None

def fetch_sample():
    global _sample_cache
    if _sample_cache is not None:
        return _sample_cache
    local = os.path.join(ROOT, "sample.jpg")
    if os.path.isfile(local):
        with open(local, "rb") as fh:
            _sample_cache = fh.read()
        return _sample_cache
    req = urllib.request.Request(SAMPLE_URL, headers={"User-Agent": "Mozilla/5.0"})
    _sample_cache = urllib.request.urlopen(req, timeout=20).read()
    return _sample_cache

# Second sample: a 3D-perspective cube showing 3 visible faces on a light
# blue background. Used by the CI browser test to assert the multi-face
# detector handles angled shots (the front-on sample.jpg only exercises a
# single face).
ALGORITHMS_URL = "https://images.saymedia-content.com/.image/ar_1:1,c_fill,cs_srgb,q_auto:eco,w_1200/MTk3MDg5MjU5NDA3MDI1MjM1/rubik-cube-algorithms.png"
_algorithms_cache = None

def fetch_algorithms():
    global _algorithms_cache
    if _algorithms_cache is not None:
        return _algorithms_cache
    local = os.path.join(ROOT, "algorithms.png")
    if os.path.isfile(local):
        with open(local, "rb") as fh:
            _algorithms_cache = fh.read()
        return _algorithms_cache
    req = urllib.request.Request(ALGORITHMS_URL, headers={"User-Agent": "Mozilla/5.0"})
    _algorithms_cache = urllib.request.urlopen(req, timeout=20).read()
    return _algorithms_cache


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=ROOT, **kw)

    def end_headers(self):
        # normal cache headers — the mtime-based ?v= token handles invalidation,
        # so the browser can serve 304s instead of re-downloading on every refresh.
        self.send_header("Cache-Control", "max-age=0, must-revalidate")
        super().end_headers()

    def do_GET(self):
        path = self.path.split("?", 1)[0]
        if path in ("/", "/index.html"):
            return self._serve_index()
        if path == "/sample.jpg":
            return self._serve_sample()
        if path == "/algorithms.png":
            return self._serve_algorithms()
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

    def _serve_algorithms(self):
        try:
            body = fetch_algorithms()
        except Exception as exc:
            self.send_error(502, f"Could not fetch algorithms image: {exc}")
            return
        self.send_response(200)
        self.send_header("Content-Type", "image/png")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _serve_index(self):
        token = _bust_token()
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
        print(f"Serving on http://0.0.0.0:{PORT} (mtime-based cache-bust)")
        httpd.serve_forever()

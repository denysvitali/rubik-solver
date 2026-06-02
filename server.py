#!/usr/bin/env python3
"""Static server for the Rubik detector that disables caching, so the browser
always picks up the latest app.js / detector.js (no stale-cache surprises)."""
import http.server
import socketserver

PORT = 8085


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()


if __name__ == "__main__":
    socketserver.TCPServer.allow_reuse_address = True
    with socketserver.TCPServer(("0.0.0.0", PORT), NoCacheHandler) as httpd:
        print(f"Serving on http://0.0.0.0:{PORT} (no-cache)")
        httpd.serve_forever()

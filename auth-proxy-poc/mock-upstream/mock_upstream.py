#!/usr/bin/env python3
"""Echoes any HTTP request as JSON. Streams 5 SSE events on /__sse."""
import http.server
import json
import sys
import time


class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        sys.stderr.write("mock %s %s\n" % (self.command, self.path))

    def do_GET(self):    self._dispatch()
    def do_POST(self):   self._dispatch()
    def do_PUT(self):    self._dispatch()
    def do_DELETE(self): self._dispatch()
    def do_PATCH(self):  self._dispatch()

    def _dispatch(self):
        if self.path.startswith("/__sse"):
            self._sse()
        else:
            self._echo()

    def _echo(self):
        n = int(self.headers.get("Content-Length", "0"))
        body = self.rfile.read(n).decode("utf-8", "replace") if n else ""
        payload = {
            "method":  self.command,
            "path":    self.path,
            "headers": {k.lower(): v for k, v in self.headers.items()},
            "body":    body,
        }
        data = json.dumps(payload).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _sse(self):
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        for i in range(1, 6):
            self.wfile.write(("data: chunk-%d\n\n" % i).encode())
            self.wfile.flush()
            time.sleep(0.05)


http.server.HTTPServer(("0.0.0.0", 8081), Handler).serve_forever()

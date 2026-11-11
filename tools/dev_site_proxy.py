#!/usr/bin/env python3
"""Serve the local app/ shell against a remote CineVault API.

The local catalogue is a small sample, so screens look nothing like production.
This keeps the files being edited local and sends every data request to a real
server, normally reached through an SSH tunnel that the script opens itself.
"""
from __future__ import annotations

import argparse
import gzip
import http.client
import mimetypes
import socket
import subprocess
import sys
import time
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
APP_DIR = ROOT / "app"
UPSTREAM_PREFIXES = ("/api/", "/media/", "/data/")
UPSTREAM_PATHS = {"/config.local.js"}
HOP_HEADERS = {"connection", "keep-alive", "transfer-encoding", "te", "trailer", "upgrade", "proxy-authenticate", "proxy-authorization", "host"}
CHUNK = 64 * 1024


def port_open(port: int) -> bool:
    with socket.socket() as probe:
        probe.settimeout(0.5)
        return probe.connect_ex(("127.0.0.1", port)) == 0


def open_tunnel(target: str, key: str, local_port: int, remote_port: int) -> subprocess.Popen | None:
    if port_open(local_port):
        return None
    command = ["ssh", "-N", "-o", "ExitOnForwardFailure=yes", "-o", "ServerAliveInterval=30", "-o", "IdentitiesOnly=yes", "-L", f"{local_port}:127.0.0.1:{remote_port}"]
    if key:
        command += ["-i", str(Path(key).expanduser())]
    process = subprocess.Popen(command + [target])
    for _ in range(40):
        if port_open(local_port):
            return process
        if process.poll() is not None:
            break
        time.sleep(0.25)
    process.terminate()
    raise SystemExit(f"SSH tunnel to {target} did not open")


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    upstream_port = 0

    def log_message(self, format: str, *args) -> None:  # noqa: A002
        if "/api/" in self.path or (args and str(args[1])[:1] in "45"):
            super().log_message(format, *args)

    def local_file(self, path: str) -> Path | None:
        if path in UPSTREAM_PATHS or path.startswith(UPSTREAM_PREFIXES):
            return None
        relative = urllib.parse.unquote(path).lstrip("/")
        candidate = (APP_DIR / relative).resolve()
        if relative and candidate.is_file() and candidate.is_relative_to(APP_DIR.resolve()):
            return candidate
        if not Path(relative).suffix:
            return APP_DIR / "index.html"
        return None

    def accepts_gzip(self) -> bool:
        return "gzip" in (self.headers.get("Accept-Encoding") or "")

    def serve_local(self, candidate: Path, head: bool) -> None:
        body = candidate.read_bytes()
        kind = mimetypes.guess_type(candidate.name)[0] or "application/octet-stream"
        textual = kind.startswith("text/") or kind in {"application/javascript", "application/json", "image/svg+xml"}
        if textual:
            kind += "; charset=utf-8"
        # Production sits behind Caddy with compression on; speed measurements must see the same bytes.
        compressed = textual and self.accepts_gzip()
        if compressed:
            body = gzip.compress(body, 6)
        self.send_response(200)
        self.send_header("Content-Type", kind)
        if compressed:
            self.send_header("Content-Encoding", "gzip")
            self.send_header("Vary", "Accept-Encoding")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store, max-age=0")
        self.end_headers()
        if not head:
            self.wfile.write(body)

    def relay(self) -> None:
        length = int(self.headers.get("Content-Length") or 0)
        payload = self.rfile.read(length) if length else None
        headers = {name: value for name, value in self.headers.items() if name.lower() not in HOP_HEADERS}
        headers["Host"] = f"127.0.0.1:{self.upstream_port}"
        connection = http.client.HTTPConnection("127.0.0.1", self.upstream_port, timeout=120)
        try:
            connection.request(self.command, self.path, body=payload, headers=headers)
            response = connection.getresponse()
            kind = response.getheader("Content-Type") or ""
            if "application/json" in kind and self.accepts_gzip() and not response.getheader("Content-Encoding") and self.command != "HEAD":
                body = gzip.compress(response.read(), 6)
                self.send_response(response.status)
                for name, value in response.getheaders():
                    if name.lower() not in HOP_HEADERS and name.lower() != "content-length":
                        self.send_header(name, value)
                self.send_header("Content-Encoding", "gzip")
                self.send_header("Vary", "Accept-Encoding")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
                return
            self.send_response(response.status)
            sized = False
            for name, value in response.getheaders():
                if name.lower() in HOP_HEADERS:
                    continue
                sized = sized or name.lower() == "content-length"
                self.send_header(name, value)
            if not sized:
                self.send_header("Connection", "close")
                self.close_connection = True
            self.end_headers()
            if self.command != "HEAD":
                while chunk := response.read1(CHUNK):
                    self.wfile.write(chunk)
                    self.wfile.flush()
        except (OSError, http.client.HTTPException) as error:
            if not self.wfile.closed:
                try:
                    self.send_error(502, f"Upstream is unavailable: {error}")
                except OSError:
                    pass
        finally:
            connection.close()

    def handle_any(self) -> None:
        path = urllib.parse.urlsplit(self.path).path
        candidate = self.local_file(path) if self.command in {"GET", "HEAD"} else None
        if candidate:
            self.serve_local(candidate, self.command == "HEAD")
        else:
            self.relay()

    do_GET = do_HEAD = do_POST = do_PUT = do_DELETE = do_OPTIONS = handle_any  # noqa: N815


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=8090)
    parser.add_argument("--upstream-port", type=int, default=8092, help="Local port where the real API answers")
    parser.add_argument("--ssh", default="", help="user@host to tunnel to; omit when the API already listens on --upstream-port")
    parser.add_argument("--ssh-key", default="")
    parser.add_argument("--remote-port", type=int, default=8081)
    args = parser.parse_args()
    tunnel = open_tunnel(args.ssh, args.ssh_key, args.upstream_port, args.remote_port) if args.ssh else None
    Handler.upstream_port = args.upstream_port
    server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    server.daemon_threads = True
    print(f"Local app/ on http://127.0.0.1:{args.port}, data from 127.0.0.1:{args.upstream_port}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        if tunnel:
            tunnel.terminate()
    return 0


if __name__ == "__main__":
    sys.exit(main())

"""Local proxy that disables thinking for Ollama's OpenAI-compatible API.

StructureClaw has no setting to turn off reasoning, and Ollama only accepts it
per request, so this proxy injects ``reasoning_effort: "none"`` into every
/v1/chat/completions body and streams the response back unchanged.

It also serves the same proxy over TLS on listen_port + 1, because the
benchmark's LLM judge refuses non-HTTPS endpoints. Node must trust the
self-signed cert: NODE_EXTRA_CA_CERTS=ollama/localhost-cert.pem

Usage: python nothink_proxy.py [listen_port] [upstream]
       defaults: 18435 (http) / 18436 (https), http://127.0.0.1:11434
       (11435-11534 is in a Windows reserved port range on this machine)
"""
import http.client
import json
import os
import ssl
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit

LISTEN_PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 18435
UPSTREAM = urlsplit(sys.argv[2] if len(sys.argv) > 2 else "http://127.0.0.1:11434")
CERT_DIR = Path(__file__).resolve().parent
# Optional: append every exchange (request body, raw response, timings) to
# <dir>/exchanges.jsonl, so an agent run can be reconstructed afterwards.
DUMP_DIR = os.environ.get("NOTHINK_PROXY_DUMP_DIR")
DUMP_LOCK = threading.Lock()
HOP_BY_HOP = {"connection", "keep-alive", "transfer-encoding", "content-length", "host"}


def dump_exchange(record):
    Path(DUMP_DIR).mkdir(parents=True, exist_ok=True)
    line = json.dumps(record, ensure_ascii=False)
    with DUMP_LOCK, open(Path(DUMP_DIR) / "exchanges.jsonl", "a", encoding="utf-8") as f:
        f.write(line + "\n")


class Handler(BaseHTTPRequestHandler):
    # HTTP/1.0: the response body is delimited by closing the connection,
    # which lets us relay streamed (SSE) responses without re-chunking.
    protocol_version = "HTTP/1.0"

    def _forward(self):
        body = self.rfile.read(int(self.headers.get("Content-Length") or 0))
        if self.command == "POST" and self.path.rstrip("/").endswith("/chat/completions") and body:
            payload = json.loads(body)
            payload["reasoning_effort"] = "none"
            body = json.dumps(payload).encode()

        headers = {k: v for k, v in self.headers.items() if k.lower() not in HOP_BY_HOP}
        headers["Content-Length"] = str(len(body))
        started = time.time()
        is_tls = isinstance(self.connection, ssl.SSLSocket)
        conn = http.client.HTTPConnection(UPSTREAM.hostname, UPSTREAM.port, timeout=3600)
        conn.request(self.command, self.path, body=body or None, headers=headers)
        resp = conn.getresponse()

        captured = []
        sent = 0
        disconnected = None
        try:
            self.send_response(resp.status)
            for k, v in resp.getheaders():
                if k.lower() not in HOP_BY_HOP:
                    self.send_header(k, v)
            self.end_headers()
            while chunk := resp.read1(65536):
                if DUMP_DIR:
                    captured.append(chunk)
                self.wfile.write(chunk)
                self.wfile.flush()
                sent += len(chunk)
        except (ConnectionError, ssl.SSLError) as exc:
            disconnected = repr(exc)
            sys.stderr.write(f"[nothink-proxy] client disconnected after {time.time() - started:.1f}s: {exc!r}\n")
        finally:
            conn.close()
            ended = time.time()
            sys.stderr.write(
                f"[nothink-proxy] {'https' if is_tls else 'http'} {self.path} req={len(body)}B "
                f"resp={sent}B {ended - started:.1f}s\n"
            )
            if DUMP_DIR and self.path.rstrip("/").endswith("/chat/completions"):
                dump_exchange({
                    "t_start": started,
                    "t_end": ended,
                    "channel": "https" if is_tls else "http",
                    "status": resp.status,
                    "disconnected": disconnected,
                    "request": json.loads(body) if body else None,
                    "response": b"".join(captured).decode("utf-8", errors="replace"),
                })

    do_GET = do_POST = do_DELETE = _forward

    def log_message(self, fmt, *args):
        sys.stderr.write("[nothink-proxy] %s\n" % (fmt % args))


if __name__ == "__main__":
    tls_server = ThreadingHTTPServer(("127.0.0.1", LISTEN_PORT + 1), Handler)
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.load_cert_chain(CERT_DIR / "localhost-cert.pem", CERT_DIR / "localhost-key.pem")
    tls_server.socket = context.wrap_socket(tls_server.socket, server_side=True)
    threading.Thread(target=tls_server.serve_forever, daemon=True).start()

    print(f"nothink proxy :{LISTEN_PORT} (http), :{LISTEN_PORT + 1} (https) -> {UPSTREAM.geturl()}", flush=True)
    ThreadingHTTPServer(("127.0.0.1", LISTEN_PORT), Handler).serve_forever()

#!/usr/bin/env python3
"""A language server that only logs: each notification's method and file name
go to $FAKE_LSP_LOG, one per line. It answers `initialize`, and exits (as if
it crashed) when asked for a hover."""
import json
import os
import sys

log = open(os.environ["FAKE_LSP_LOG"], "a", buffering=1)
stdin, stdout = sys.stdin.buffer, sys.stdout.buffer


def send(msg):
    body = json.dumps(msg).encode()
    stdout.write(b"Content-Length: %d\r\n\r\n" % len(body) + body)
    stdout.flush()


while True:
    length = None
    while True:
        line = stdin.readline()
        if not line:
            sys.exit(0)
        if line.strip() == b"":
            break
        if line.lower().startswith(b"content-length:"):
            length = int(line.split(b":")[1])
    msg = json.loads(stdin.read(length))
    method = msg.get("method")
    if method == "initialize":
        send({"jsonrpc": "2.0", "id": msg["id"], "result": {"capabilities": {"textDocumentSync": 1}}})
    elif method == "textDocument/hover":
        log.write("crash\n")
        sys.exit(1)
    elif "id" in msg:
        send({"jsonrpc": "2.0", "id": msg["id"], "result": None})
    elif method.startswith("textDocument/"):
        uri = msg["params"]["textDocument"]["uri"]
        log.write(f"{method.split('/')[1]} {os.path.basename(uri)}\n")

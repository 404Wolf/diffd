#!/usr/bin/env python3
"""A stand-in for the OpenAI Responses API, playing a scripted agent, so a
real Codex can be tested against diffd without network access or a model.

    scripts/mock-responses.py <port> <log.jsonl>

Point Codex at it with a custom model provider (base_url http://127.0.0.1:<port>/v1,
wire_api "responses"). The "agent" it plays:

- told about diffd feedback (a message mentioning wait_for_feedback): calls
  wait_for_feedback, replies to each thread it got with `reply`, answers chat
  messages with `say`, then says it's done;
- anything else: answers "mock: <what you said>" (after 8 s if you said "take your time",
  to have a turn in progress while something else happens).

Every request is logged as one JSON line: the last input item and what it answered.
"""
import json
import re
import sys
import time
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT = int(sys.argv[1])
LOG = open(sys.argv[2], "a", buffering=1)
counter = 0
lock = threading.Lock()


def next_id(prefix):
    global counter
    with lock:
        counter += 1
        return f"{prefix}_{counter}"


def tool_name(tools, suffix):
    """The name Codex gave an MCP tool (it adds a server prefix or namespace)."""
    for t in tools:
        name = t.get("name") or (t.get("function") or {}).get("name") or ""
        if name.endswith(suffix):
            return name, t.get("namespace")
        for sub in t.get("tools", []) or []:
            sname = sub.get("name", "")
            if sname.endswith(suffix):
                return sname, t.get("name")
    return None, None


def text_of(item):
    content = item.get("content")
    if isinstance(content, str):
        return content
    return "".join(c.get("text", "") for c in content or [] if isinstance(c, dict))


def decide(body):
    """What the scripted agent does next: a list of output items."""
    items = body.get("input", [])
    tools = body.get("tools", [])
    last = items[-1] if items else {}
    # The latest user message, and the tool calls made since.
    user_at = max((i for i, it in enumerate(items) if it.get("type") == "message" and it.get("role") == "user"), default=-1)
    user_text = text_of(items[user_at]) if user_at >= 0 else ""
    since = items[user_at + 1:]
    calls = [it for it in since if it.get("type") == "function_call"]
    outputs = {it.get("call_id"): it.get("output") for it in since if it.get("type") == "function_call_output"}

    def call(suffix, args):
        name, namespace = tool_name(tools, suffix)
        if not name:
            return [message(f"mock: no {suffix} tool among {[t.get('name') for t in tools]}")]
        item = {"type": "function_call", "call_id": next_id("call"), "name": name, "arguments": json.dumps(args)}
        if namespace:
            item["namespace"] = namespace
        return [item]

    if "wait_for_feedback" in user_text:
        waited = [c for c in calls if c["name"].endswith("wait_for_feedback")]
        if not waited:
            found = re.search(r"review_id=([A-Za-z0-9_-]+)", user_text)
            args = {"timeout_seconds": 5}
            if found:
                args["review_id"] = found.group(1)
            return call("wait_for_feedback", args)
        feedback = outputs.get(waited[-1]["call_id"]) or ""
        if isinstance(feedback, list):
            feedback = "".join(c.get("text", "") for c in feedback if isinstance(c, dict))
        # Codex prefixes tool output ("Wall time: …\nOutput:"): the JSON starts at the first brace.
        try:
            batch, _ = json.JSONDecoder().raw_decode(feedback[feedback.index("{"):])
        except ValueError:
            batch = {}
        done = {json.loads(c["arguments"]).get("thread_id") for c in calls if c["name"].endswith("reply")}
        said = any(c["name"].endswith("say") for c in calls)
        for item in batch.get("items", []):
            if item.get("type") == "thread" and item.get("thread_id") not in done:
                return call("reply", {"thread_id": item["thread_id"], "body": "mock agent: I read your comment and I'm on it."})
            if item.get("type") == "chat" and not said:
                return call("say", {"review_id": batch.get("review_id"), "body": "mock agent: got your message."})
        return [message("mock: answered the review feedback.")]
    return [message(f"mock: {user_text[:200]}")]


def message(text):
    return {"type": "message", "role": "assistant", "id": next_id("msg"), "content": [{"type": "output_text", "text": text}]}


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *args):
        pass

    def do_GET(self):
        body = json.dumps({"models": [], "data": []}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length)
        try:
            body = json.loads(raw or b"{}")
        except ValueError:
            body = {}
        if not self.path.rstrip("/").endswith("/responses"):
            self.send_response(404)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        out = decide(body)
        last_user = next((text_of(it) for it in reversed(body.get("input", [])) if it.get("role") == "user"), "")
        if "take your time" in last_user and out and out[0].get("type") == "message":
            time.sleep(8)
        items = body.get("input", [])
        LOG.write(json.dumps({"path": self.path, "last": items[-1] if items else None, "answer": out,
                              "tools": [t.get("name") for t in body.get("tools", [])]}) + "\n")
        rid = next_id("resp")
        events = [{"type": "response.created", "response": {"id": rid}}]
        events += [{"type": "response.output_item.done", "item": it} for it in out]
        events.append({"type": "response.completed", "response": {"id": rid, "usage": {
            "input_tokens": 0, "input_tokens_details": None, "output_tokens": 0,
            "output_tokens_details": None, "total_tokens": 0}}})
        payload = "".join(f"event: {e['type']}\ndata: {json.dumps(e)}\n\n" for e in events).encode()
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)


ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()

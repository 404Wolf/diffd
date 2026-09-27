#!/usr/bin/env python3
"""A tiny MCP client for diffd's Streamable HTTP endpoint, for demos and tests.

    python3 scripts/mcp_client.py share_diff '{"repo_path": "/tmp/diffd-demo", "from": "HEAD", "title": "Demo"}'

Set DIFFD_MCP to talk to another server (default http://localhost:3433/mcp).

As a library: `Mcp("http://localhost:3433/mcp").call("wait_for_feedback", {...})`.
"""
import json
import os
import sys
import urllib.request


class Mcp:
    def __init__(self, url: str = "http://localhost:3433/mcp", client: str = "claude-code") -> None:
        """`client` is the name the MCP client gives: the page names the agent after it."""
        self.url = url
        self.session: str | None = None
        self.next_id = 0
        self.protocol = "2025-06-18"
        init = self._rpc("initialize", {
            "protocolVersion": self.protocol,
            "capabilities": {},
            "clientInfo": {"name": client, "version": "0"},
        })
        self.protocol = init.get("protocolVersion", self.protocol)
        self.instructions = init.get("instructions", "")
        self._post({"jsonrpc": "2.0", "method": "notifications/initialized"})

    def _post(self, body: dict, timeout: float = 600) -> dict | None:
        req = urllib.request.Request(self.url, data=json.dumps(body).encode(), method="POST")
        req.add_header("Content-Type", "application/json")
        req.add_header("Accept", "application/json, text/event-stream")
        req.add_header("MCP-Protocol-Version", self.protocol)
        if self.session:
            req.add_header("Mcp-Session-Id", self.session)
        with urllib.request.urlopen(req, timeout=timeout) as res:
            self.session = res.headers.get("Mcp-Session-Id", self.session)
            ctype = res.headers.get("Content-Type", "")
            raw = res.read().decode()
        if not raw.strip():
            return None
        if "text/event-stream" in ctype:
            # Take the last JSON-RPC response in the stream.
            messages = [json.loads(l[5:]) for l in raw.splitlines() if l.startswith("data:") and l[5:].strip()]
            responses = [m for m in messages if "id" in m and ("result" in m or "error" in m)]
            return responses[-1] if responses else None
        return json.loads(raw)

    def _rpc(self, method: str, params: dict) -> dict:
        self.next_id += 1
        res = self._post({"jsonrpc": "2.0", "id": self.next_id, "method": method, "params": params})
        if res is None or "error" in res:
            raise RuntimeError(f"{method}: {res}")
        return res["result"]

    def tools(self) -> list[str]:
        return [t["name"] for t in self._rpc("tools/list", {})["tools"]]

    def call(self, tool: str, args: dict) -> dict | str:
        result = self._rpc("tools/call", {"name": tool, "arguments": args})
        text = result["content"][0]["text"]
        if result.get("isError"):
            raise RuntimeError(f"{tool} failed: {text}")
        try:
            return json.loads(text)
        except json.JSONDecodeError:
            return text


if __name__ == "__main__":
    mcp = Mcp(os.environ.get("DIFFD_MCP", "http://localhost:3433/mcp"))
    print(json.dumps(mcp.call(sys.argv[1], json.loads(sys.argv[2] if len(sys.argv) > 2 else "{}")), indent=2))

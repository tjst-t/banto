#!/usr/bin/env python3
"""hello-py: 契約が TypeScript でないモジュールも運べることを示す最小の MCP サーバ。

サードパーティ依存なし。MCP over stdio は改行区切りの JSON-RPC 2.0 なので、
ループを手で書く（initialize / tools/list / tools/call の3つだけ支える）。
"""
import json
import sys

TOOLS = [
    {
        "name": "greet",
        "description": "Greet someone by name.",
        "inputSchema": {
            "type": "object",
            "properties": {"name": {"type": "string"}},
            "required": ["name"],
        },
    },
    {
        "name": "python_version",
        "description": "Return the Python interpreter version running this server.",
        "inputSchema": {"type": "object", "properties": {}},
    },
]


def handle(req: dict) -> dict | None:
    method = req.get("method")
    req_id = req.get("id")

    if method == "initialize":
        return {
            "jsonrpc": "2.0",
            "id": req_id,
            "result": {
                "protocolVersion": "2024-11-05",
                "capabilities": {"tools": {}},
                "serverInfo": {"name": "hello-py", "version": "0.0.0"},
            },
        }
    if method == "notifications/initialized":
        return None  # 通知には応答しない
    if method == "tools/list":
        return {"jsonrpc": "2.0", "id": req_id, "result": {"tools": TOOLS}}
    if method == "tools/call":
        params = req.get("params", {})
        name = params.get("name")
        args = params.get("arguments", {})
        if name == "greet":
            text = f"Hello, {args.get('name', 'world')}!"
        elif name == "python_version":
            text = sys.version
        else:
            return {
                "jsonrpc": "2.0",
                "id": req_id,
                "result": {"content": [{"type": "text", "text": f"unknown tool: {name}"}], "isError": True},
            }
        return {"jsonrpc": "2.0", "id": req_id, "result": {"content": [{"type": "text", "text": text}]}}

    if req_id is None:
        return None  # 未知の通知は無視する
    return {"jsonrpc": "2.0", "id": req_id, "error": {"code": -32601, "message": f"unknown method: {method}"}}


def main() -> None:
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        req = json.loads(line)
        resp = handle(req)
        if resp is not None:
            sys.stdout.write(json.dumps(resp) + "\n")
            sys.stdout.flush()


if __name__ == "__main__":
    main()

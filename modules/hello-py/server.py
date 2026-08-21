#!/usr/bin/env python3
"""hello-py: 契約が TypeScript でないモジュールも運べることを示す最小の MCP サーバ。

サードパーティ依存なし。MCP over stdio は改行区切りの JSON-RPC 2.0 なので、
ループを手で書く（initialize / tools/list / tools/call / resources/* を支える）。

**自分の URI 空間を持つ**（要件 C14）。`banto://hello-py/greeting/<name>` を
resources/read で返す。画面はこのモジュールが持ち込む（要件 C1）が、
**subprocess で TypeScript でもないので `in-page` は名乗れない**（決定20）
——`sandboxed`（iframe）で走る。第三者モジュールとまったく同じ立場である。
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
                "capabilities": {"tools": {}, "resources": {}},
                "serverInfo": {"name": "hello-py", "version": "0.0.0"},
            },
        }
    if method == "notifications/initialized":
        return None  # 通知には応答しない
    if method == "resources/list":
        return {
            "jsonrpc": "2.0",
            "id": req_id,
            "result": {
                "resourceTemplates": [
                    {
                        "uriTemplate": "banto://hello-py/greeting/{name}",
                        "name": "greeting",
                        "description": "A greeting for someone",
                        "mimeType": "text/plain",
                    }
                ],
                "resources": [],
            },
        }
    if method == "resources/read":
        uri = req.get("params", {}).get("uri", "")
        prefix = "banto://hello-py/greeting/"
        if not uri.startswith(prefix):
            # 握りつぶさない。持っていない URI は、持っていないと言う。
            return {
                "jsonrpc": "2.0",
                "id": req_id,
                "error": {"code": -32602, "message": f"持っていない uri: {uri}"},
            }
        who = uri[len(prefix):] or "world"
        return {
            "jsonrpc": "2.0",
            "id": req_id,
            "result": {
                "contents": [
                    {
                        "uri": uri,
                        "mimeType": "text/plain",
                        "text": f"Hello, {who}!\nPython {sys.version.split()[0]} から返している。",
                    }
                ]
            },
        }
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

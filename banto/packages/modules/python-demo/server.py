#!/usr/bin/env python3
# 要件C6の完了条件——「TypeScriptでないモジュールが1本、実際に動いている」
# ためだけの最小Module。Python の 30 行で足りる（要件C6の見積もりどおり）。
# banto独自の語彙は使わず、公式のMCP Python SDKにそのまま乗る（規則12）。

from mcp.server.mcpserver import MCPServer

server = MCPServer(name="banto-module-python-demo", version="0.1.0")


@server.tool()
def echo(text: str) -> str:
    """受け取った文字列をそのまま返す——contract が言語をまたいで動くことの確認用。"""
    return f"echo: {text}"


if __name__ == "__main__":
    server.run(transport="stdio")

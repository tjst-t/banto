#!/usr/bin/env python3
# 要件C6の完了条件——「TypeScriptでないモジュールが1本、実際に動いている」
# ためだけの最小Module。Python の 30 行で足りる（要件C6の見積もりどおり）。
# banto独自の語彙は使わず、公式のMCP Python SDKにそのまま乗る（規則12）。

from mcp.server.mcpserver import MCPServer

server = MCPServer(name="banto-module-python-demo", version="0.1.0")


# **自分が何者かを名乗る**（決定・2026-09-06、アーキ仕様 §5.4「banto の拡張は
# _meta に載せる」）。host は Config の宣言と突き合わせ、**より厳しい方向の申告だけ**
# を採る。visibility は admin＝AI には見せない（host だけが読む）。
# 公式SDKの resource(meta=...) にそのまま乗るだけで、banto 専用のファイルは要らない。
@server.resource(
    "demo://module",
    name="この Module の申告",
    mime_type="application/json",
    meta={
        "dev.banto/visibility": "admin",
        "dev.banto/module": {
            "satisfies": ["demo"],
            "dependsOn": [],
            "isolation": "subprocess",
            "scope": "instance",
        },
    },
)
def module_meta() -> str:
    """この Module の申告（host が読む）。"""
    return "banto-module-python-demo"


@server.tool()
def echo(text: str) -> str:
    """受け取った文字列をそのまま返す——contract が言語をまたいで動くことの確認用。"""
    return f"echo: {text}"


if __name__ == "__main__":
    server.run(transport="stdio")

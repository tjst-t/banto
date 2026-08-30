# step0-host-mcp-client

**捨てる。本実装に流れ込ませない。**

## 問い

1. Claude Code CLI（Agent SDK 経由）は Module に initialize するとき、
   何を `clientCapabilities` として advertise するか（`tasks` / `elicitation.url`
   を含むか）
2. `_meta` は host 自前の MCP クライアントに届くか
3. host 自前接続と Runner（SDK）側接続を同じ stdio Module に張ると、
   同じプロセスに繋がるか、別プロセスになるか

`docs/specs/v4-architecture.md` §2.5・§10（item 9・13）・§2.4 の前提になる、
PoC の中でいちばん最初に効く実験（他の全実験が「host は MCP クライアントを
持てる」ことを当然の前提として使うため）。

## 偽物を本物に寄せた点

- `module.mjs` は `createSdkMcpServer`（in-process）ではなく、
  `@modelcontextprotocol/sdk` の `Server` を素の subprocess として立てている。
  in-process だと参照渡しになり JSON-RPC の枠も無いので、**第三者 Module**
  （banto のコードに依存しない、実際に stdio で繋ぐもの）を模した
- 最初 Module 側の記録を `console.error`（stderr）に出していたが、Agent SDK が
  MCP subprocess の stderr をキャプチャして表に出さない（実行しても何も見えな
  かった）。**観測を機構の外側に置く**（教訓11）ため、ファイルへの直接書き込み
  （`module.observed.log`）に変えた

## ガードを外したら通ってしまうことの確認

該当なし（本実験はセキュリティ境界ではなく、SDK/CLI の実際の挙動確認）。

## 結果（数値・実測）

```
[module pid=2198194] initialized. clientCapabilities={} clientVersion={"name":"banto-host-poc","version":"0.0.0"}
[module pid=2198242] initialized. clientCapabilities={"elicitation":{"form":{}},"roots":{"listChanged":true}} clientVersion={"name":"claude-code","title":"Claude Code","version":"2.1.237",...}
```

- Claude Code CLI 2.1.237 が advertise する capabilities：`elicitation.form` と
  `roots.listChanged` のみ。**`tasks` 無し・`elicitation.url` 無し**
- host 自前クライアント（`@modelcontextprotocol/sdk` の `Client`）の
  `tools/list` に `_meta`（`jp.banto.poc/kind`）がそのまま届いた
- 同時に張った2接続は **pid が異なる**——別プロセス

## 仕様書のどの行を更新したか

- `docs/specs/v4-architecture.md` §2.5（host は自分の MCP クライアントを持つ、
  stdio の2重接続）
- `docs/specs/v4-architecture.md` §2.4（MRTR・`elicitation.url` の未確認注記）
- `docs/specs/v4-architecture.md` §10 item 9（stdio 2重起動の追記）・
  item 13（Tasks/url capability 無しの追記）
- `docs/notes/2026-08-30-poc.md`（生ログ・経緯）

## 破棄

段3（本実装）の頭で `poc/` ごと削除する。

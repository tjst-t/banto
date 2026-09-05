# Runner↔代理サーバの接続をHTTPに訂正した経緯

**結論は `docs/specs/v4-architecture.md` §2.5「Runner は実 Module に直接繋がない」
に書いた。ここには却下した案と、そこに至った実測の経緯だけを残す。**

## 何が起きたか

Phase 1の本実装中、Vaultの`requestAlias`（`server.elicitInput()`を呼ぶ）を
実際にRunner経由で呼んだところ、常に失敗した：

```
McpError: MCP error -32603: Client does not support form elicitation.
```

## 切り分け

1. `packages/core`から独立した最小再現（`{type:'sdk', instance}`で低レベル
   `Server`を繋ぎ、`elicitInput()`を呼ぶだけ）で同じエラーを再現——
   我々の中継プロキシ（agent-proxy.ts）のロジックの問題ではなく、
   `instance`形式そのものの問題だと切り分けた
2. 同じ`elicitInput()`呼び出しを、実stdio接続・実HTTP接続それぞれに
   繋ぎ直して検証——**どちらも`onElicitation`が正しく発火し、往復した**
3. Agent SDKの内部コード（`sdk.mjs`）を読むと、`{type:'sdk', instance}`で
   繋ぐ内部ブリッジは`elicitation`capabilityを宣言する箇所がまったく無い
   （grep で確認）。一方、実stdio/実HTTPで繋いだ場合はCLIプロセス自身が
   正規のMCPクライアントとしてハンドシェイクするため、elicitationが機能する

## 却下した案

- **stdio接続に変える**：動くことは確認したが、Module（特にVaultのような
  instance単位のもの）ごとに、代理サーバを持つだけのための追加プロセスが
  要る。HTTPなら同じhostプロセス内でエンドポイントを増やすだけで済む
- **仕様を変えてElicitationをやめる**：§2.4「人に聞くはElicitationに乗せる」
  の前提を崩す変更で、Module起点の判断待ち（VaultのrequestAlias等）の
  設計全体に波及する。ユーザーとの相談の結果、仕様は変えず接続方式を
  変える方を選んだ（2026-09-03）

## 採った案

Runner↔代理サーバの接続をHTTP（`StreamableHTTPServerTransport`）にする。
§2.5のModule→host中継（`/relay`）で同じ実装パターンをすでに持っているため、
Runner→host方向にもう1エンドポイント（`/agent-relay/<module名>`）を足すだけで
済む。型キャストの嘘（`sdk-shim.ts`）も不要になった——副次的な単純化。

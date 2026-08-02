---
id: imp-0010
type: improvement
kind: incident
origin: agent
class: spec-impl-mismatch
status: fixed
refs: [task-0102-banto-live, task-0105]
---

# WebSocket error ハンドラ未登録でプロセス全体がクラッシュする

## 内容
packages/banto-host/src/server.ts の handleConnection に ws.on("error") が無い。不正 WS frame（WS_ERR_EXPECTED_MASK: MASK must be set）が1つ届くと unhandled 'error' で Node プロセス全体が死ぬ。

- 2026-08-01 に journal で複数回確認（restart counter 3→4）。検証環境の provision にも巻き添え（provision 中に daemon が死ぬと応答が返らない）
- 引き金のクライアントは未特定（ブラウザ/Caddy は mask するため非準拠クライアント）

## 対応
- **修正済み**: 615de88「fix(host): WebSocket 接続エラーでプロセス全体が落ちるのを防ぐ（error ハンドラ追加）」（2026-08-01 main 反映、PO が banto.service 再起動して本番適用済み）
  - ws.on("error") で console.error（握りつぶさない）+ ws.terminate()（socket 即破棄 → close 発火 → clients から除去）
  - 検証: typecheck OK / 実サーバに不正 frame 送信でプロセス生存・/health 正常 / banto-host-server.spec.ts 33 pass
- **未実施（別途 backlog）**: このクラスのバグ（クライアント入力でプロセスが落ちる）の回帰テスト追加。G7 として imp-0014 の関連項目

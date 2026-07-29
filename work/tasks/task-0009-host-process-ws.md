---
id: task-0009
type: task
kind: feature
title: 番頭ホストプロセス（常駐）とWS API・CLIクライアント
status: draft
parent: epic-0001
depends: [task-0008]
refs: [adr-0010]
scope:
  paths: ["packages/banto-host/**", "tests/acceptance/**"]
acceptance:
  - { id: a1, text: "番頭ホストが常駐プロセスとして起動し、WebSocketで会話できる。クライアントからpromptを送るとターンが走り、テキスト差分・Tool実行・ターン終了がイベントとして流れる" }
  - { id: a2, text: "Tool実行イベントが論理名（kobo.query.ready 等）で通知される。wire名はプロバイダとの境界に閉じる（決定22）" }
  - { id: a3, text: "同じWS APIに複数クライアントが同時接続でき、同一セッションのイベントを全員が受け取る（CLIとWebUIが同格のクライアントになる土台）" }
  - { id: a4, text: "CLIクライアントが提供され、端末から番頭と会話できる" }
  - { id: a5, text: "WS APIの受け入れテストがKoboにもLLMにも接続せずに実行でき、npm run build・npm run typecheck・npm test が通る" }
---

## 背景

epic-0001 より。task-0004〜0008 で番頭の中身（Tool契約基盤・記憶・SKILL）は揃ったが、`banto-host` はライブラリのままで起動する入口が無い。本タスクで常駐プロセス化する。

**インターフェースは端末TUIではなくWS APIとする。** pi の InteractiveMode をそのまま使うと端末専用になり、WebUI を作るときに作り直しになる。Kobo 自身が「HTTP＋WS、GUI/CLIはその同格クライアント」という形（CLAUDE.md・決定6）であり、Banto も同じ形にすれば CLI と WebUI が同じ API にぶら下がる。プロトタイプ（`prototype/banto-shell.html`）のチャットUIは、このAPIの上に載る。

## スコープ外

- WebUI 本体（チャットペイン・キャンバス。epic-0002）
- 認証（Kobo と同じくローカルネットワーク前提。必要になった時点で別途）
- systemd ユニット・インストーラ（epic-0003）
- セッションの永続化・復元（当面はプロセス内の単一セッション。必要になってから）

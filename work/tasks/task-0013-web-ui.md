---
id: task-0013
type: task
kind: feature
title: WebUI（チャット＋キャンバスの2ペイン）とテスト用GUI部品
status: done
parent: epic-0002
depends: [task-0012]
refs: [adr-0010, spec-ui]
scope:
  paths: ["packages/banto-web/**", "packages/banto-host/**", "tsconfig.json", "package.json", "CLAUDE.md", "tests/acceptance/**"]
acceptance:
  - { id: a1, text: "ブラウザで開けるWebUIがあり、チャットペインから番頭と会話できる（task-0009のWS APIの一クライアントとして動く）" }
  - { id: a2, text: "キャンバスペインがあり、番頭が canvas.open を呼ぶとタブが現れて対応するReactコンポーネントが描画される。タブの切替・クローズができる" }
  - { id: a3, text: "GUIカタログのcomponent参照からReactコンポーネントが解決される（決定12：iframeを使わず直接import）" }
  - { id: a4, text: "テスト用のGUI部品が最低1つあり、canvas.openで渡したパラメータを表示する。キャンバス機構の動作確認に使える" }
  - { id: a5, text: "UIはキャンバスの表示状態を自前で持たず、ホストから配信された状態を描く（D3・D5）" }
  - { id: a6, text: "npm run build・npm run typecheck・npm test がリポジトリ全体で通る" }
---

## 背景

ADR-0010 決定2・12・16 より。Banto の UI はチャット＋キャンバスの2エリア構成で、キャンバスは番頭が出し入れするコンテンツ領域。決定12 で埋め込み方式は **iframe 不採用・React コンポーネント直接 import** に確定しており、Banto フロントエンドは React となる。

task-0009 で WS API を、task-0012 でキャンバス機構・カタログ・`canvas.*` Tool を作った。本タスクはその上に載る画面を作る。UI は WS API の一クライアントに過ぎず、CLI と同格（決定6 の Kobo と同じ形）。

意匠は PO 承認済みのプロトタイプ（`prototype/banto-shell.html`）に寄せる。

Kobo 由来のGUI（アテンションキュー・ボード等）はまだ無いため、キャンバスの中身の検証用に最小のテスト用GUI部品を用意する。

## スコープ外

- Kobo の Extension Pack が登録するプラガブルGUI（Kobo側）
- 基本GUIセットの本体（ファイル・Git閲覧・ブラウザ・シェル・セッションビューア。task-0011 とその後続）
- モバイル実機検証（決定21で実装フェーズのタスクとして先送り済み）
- 認証・マルチセッション（現状は1ホスト＝1セッション）

---
id: task-0049
type: task
kind: feature
title: Kobo GUI（アテンションキュー・ボード）のキャンバス登録
status: draft
parent: epic-0010
depends: [task-0012]
refs: [adr-0010]
scope:
  paths: ["packages/banto-web/src/**", "packages/banto-host/src/**", "packages/banto-daemon/src/**", "tests/acceptance/**"]
acceptance:
  - { id: a1, text: "Kobo GUI（アテンションキュー・ボード）がキャンバスのカタログエントリとして登録され、canvas.open で表示できる（epic-0002 のカタログ形式＝Tool 契約＋component 参照に乗る）" }
  - { id: a2, text: "Kobo のイベント（タスク状態の変化・状態遷移）が WebSocket 経由で GUI に反映される（イベントログの意味論は Kobo に残る）" }
  - { id: a3, text: "カタログのエントリは Kobo モジュールの接続情報を使い、コンポーネント側にエンドポイントを直書きしない（決定25）" }
  - { id: a4, text: "npm run build・npm run typecheck・npm run typecheck:web が通る" }
---

## 背景

決定18 のセッションビューアとも関連。epic-0002 のスコープ外だった Kobo GUI（アテンションキュー・ボード）をここで扱う。Kobo が Module として配線される（epic-0010・task-0048）のに合わせて、Kobo の GUI をキャンバスのカタログエントリとして登録し、番頭が `canvas.open` で出せるようにする。カタログの形式は epic-0002（task-0012）で入った「Tool 契約を土台に component 参照を拡張したもの」にそのまま乗る。

## スコープ外

- Kobo 内部の統治ロジック・状態遷移の変更（Kobo に残る）
- キャンバス機構・カタログ本体の変更（epic-0002 で実装済み。本タスクはその上に載せる）
- セッションビューア（決定18・Worker Pool 側の GUI。epic-0002 の範囲）

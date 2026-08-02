---
id: task-0048
type: task
kind: feature
title: Kobo の Module 登録（接続情報・kobo.* Tool・GUI・SKILL を1単位で登録。決定25/27a）
status: draft
parent: epic-0010
refs: [adr-0010, adr-0009]
scope:
  paths: ["packages/banto-core/src/**", "packages/banto-host/src/**", "packages/banto-daemon/src/**", "packages/banto-cli/src/**", "tests/acceptance/**"]
acceptance:
  - { id: a1, text: "Kobo の接続情報（URL・認証）がモジュールの接続情報として登録でき、モジュールの解決がそれを指す（Worker Pool の service.ts と同じパターンで、独立プロセスの URL を指す）" }
  - { id: a2, text: "Kobo の API（イベントログ・状態・タスクの読み取り）が banto-core の Tool 契約で kobo.* 名前空間に公開され、番頭が kobo.* Tool を呼び出せる" }
  - { id: a3, text: "task-0001 の ready クエリと合わせて、番頭が Kobo の着手可能タスク一覧を kobo.* 経由で読める" }
  - { id: a4, text: "Kobo に接続できないとき、黙って成功扱いにしない（I2）。エラーが番頭に届く" }
  - { id: a5, text: "登録は起動時の登録で足りる（決定27）。動的追加・削除はしない" }
  - { id: a6, text: "npm run build・npm run typecheck・npm test がリポジトリ全体で通る" }
---

## 背景

ADR-0010 決定25・27（a）より。Kobo は「①接続情報 ②番頭へのTool ③キャンバスへのGUI ④SKILL」を1単位で登録する Module であり、Banto 中核はモジュール登録機構だけを持つ（D5）。epic-0010 の配線の中核を担うタスクで、task-0001（ready クエリ）・task-0024（Worker Pool サービス利用）・task-0046（Environment Pool サービス利用）と合わせて、番頭が Kobo の情報を `kobo.*` Tool 契約で読み、Kobo が各モジュールをサービス利用する経路を成立させる。

PO 裁定（2026-07-28）により Kobo は独立プロセスのまま。接続情報は Worker Pool の service.ts と同じパターンで独立プロセスの URL を指す。

## スコープ外

- Kobo 内部の統治ロジック（スケジューリング・quota・依存ゲート・イベントログの意味論）— Kobo に残る（epic-0010 スコープ外と同じ）
- Kobo GUI（アテンションキュー・ボード）のキャンバス登録 — task-0049
- モジュール HTTP 面の認証（決定27b の未決事項・別課題）

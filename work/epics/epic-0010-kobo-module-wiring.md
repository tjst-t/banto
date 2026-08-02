---
id: epic-0010
type: epic
title: Kobo を Module として配線する
status: draft
refs: [adr-0010, adr-0009]
---

## 目的

Kobo（独立プロセス、packages/banto-daemon。HTTP API＋WebSocket）を、ADR-0010 決定25・27 の Module として Banto に配線する。**PO 裁定（2026-07-28）により Kobo は独立プロセスのまま**（in-process のプラグイン化はしない）。Worker Pool（service.ts）と同じパターンで、Module の接続情報が独立プロセスの URL を指す。Banto 中核が持つのはモジュール登録機構とキャンバス機構だけで、データの意味論は持たない（D5）。

**本 epic は epic-0005（Worker Pool）・epic-0008（Environment Pool）から、Kobo 側の統合タスク（task-0024・task-0046）を移管する。** 両 epic は Kobo 側の統合を除いて配下タスクが全て done になっており、配線をここで束ねて進める。

## ユースケース

- 番頭が `kobo.*` Tool で Kobo のイベントログ・状態・タスクを読める（kobo.* Tool 面。task-0001 の ready クエリと合わせて整備）
- Kobo が Worker Pool をサービス利用する（task-0024。自前で spawn を抱えない）
- Kobo が Environment Pool をサービス利用する（task-0046。自前で env ドライバ・台帳を抱えない。台帳の一元化）
- Kobo GUI（アテンションキュー・ボード）がキャンバスに表示される

## スコープ外

- Kobo 内部の統治ロジック（スケジューリング・quota・依存ゲート・イベントログの意味論）— Kobo に残る
- セッション開始リクエスト（epic-0004）— 別 epic として維持。Kobo 配線の完了後に合流を検討
- モジュールの動的追加・削除（決定27: 起動時の登録で足りる）

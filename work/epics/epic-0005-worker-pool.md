---
id: epic-0005
type: epic
title: Worker Pool（職人ランタイム）— Koboから独立したモジュール
status: done
refs: [adr-0010, adr-0009]
---

## 目的

ADR-0010 決定23 で決めたとおり、Worker Pool（職人ランタイム）を Kobo から独立したモジュールとして立ち上げる。Kobo のサブシステムではなく、Kobo が無くても単体で成立する実行能力とする。これにより番頭は Kobo の完成を待たずに職人へ実作業を委譲できる（D10）。

現状、spawn 系の実装（`spawn-ledger.ts`・`pi-rpc-driver.ts`・`scheduler.ts`）は `packages/banto-daemon`（＝Kobo）の中にあり、Kobo に従属している。この従属関係を解く。

## ユースケース

- 番頭が Kobo 無しで職人を起動し、調査・実装を委譲して結果を受け取れる
- 稼働中の職人セッションにライブアタッチして出力を見られる（決定18のセッションビューアの実体）
- Kobo は、独立した Worker Pool を利用する側に回る（自前で spawn を抱えない）

## スコープ外

- Kobo 側のスケジューリング・quota・依存ゲート等の統治ロジック（Koboに残る）
- 番頭核ホスト・記憶・Tool契約基盤（epic-0001）
- キャンバスへのセッションビューア描画（epic-0002）

---
id: task-0010
type: task
kind: refactor
title: Worker PoolをKoboから切り出し独立モジュール化する
status: draft
parent: epic-0005
refs: [adr-0010]
scope:
  paths: ["packages/banto-worker-pool/**", "packages/banto-daemon/src/**", "packages/banto-core/src/**", "tests/acceptance/**", "tsconfig.json"]
acceptance:
  - { id: a1, text: "職人の起動・監視・停止・ライブアタッチが packages/banto-worker-pool として独立して提供され、Kobo（banto-daemon）に依存せず単体で使える" }
  - { id: a2, text: "Kobo は自前で spawn せず、独立した Worker Pool を利用する側になる。既存の依存ゲート・quota・スケジューリングの振る舞いは変わらない" }
  - { id: a3, text: "既存の acceptance テストが全て通り、Worker Pool 単体の受け入れテストが Kobo を起動せずに実行できる" }
---

## 背景

ADR-0010 決定23 より。Worker Pool は Kobo のサブシステムではなく独立したモジュールとし、Kobo より先に作ると決定した。現状は spawn 系（`spawn-ledger.ts`・`pi-rpc-driver.ts`・`scheduler.ts`）が `packages/banto-daemon` の中にあり、Kobo に従属している。

この従属を解くと、番頭は Kobo 無しでも職人へ実作業を委譲できるようになり（D10がKoboの完成を待たない）、決定18のセッションビューアも Kobo 非依存になる。

決定23 は「既存の Kobo 内 spawn 実装をどう扱うか（切り出すか、Kobo が独立 Worker Pool を呼ぶ形に変えるか）は実装フェーズで決める」としており、その判断は本タスクで行う。

## スコープ外

- Kobo 側の統治ロジック（依存ゲート・quota・マージキュー）の変更。Worker Pool へ移すのは実行能力のみで、統治は Kobo に残す
- 番頭から職人へ委譲する Tool（`worker.*` 等）の設計・実装（別タスク）
- セッションビューアのGUI描画（epic-0002）

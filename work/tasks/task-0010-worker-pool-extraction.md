---
id: task-0010
type: task
kind: refactor
title: Worker Poolを独立モジュールとして切り出す（Kobo非依存で単体で動く）
status: draft
parent: epic-0005
refs: [adr-0010]
scope:
  paths: ["packages/banto-worker-pool/**", "packages/banto-daemon/src/**", "packages/banto-core/src/**", "tests/acceptance/**", "tsconfig.json"]
acceptance:
  - { id: a1, text: "職人の起動・監視・停止・ライブアタッチが packages/banto-worker-pool として独立して提供され、Kobo（banto-daemon）に依存せず単体で使える" }
  - { id: a2, text: "Worker Pool が決定27の登録単位（接続情報・番頭へのTool・GUI・SKILL）を満たすモジュールとして登録でき、番頭が worker.* Tool で職人へ委譲できる" }
  - { id: a3, text: "Worker Pool が独立したサービスとして自分のToolをHTTPで公開し、Banto を起動せずに呼び出せる（決定27b・27c）" }
  - { id: a4, text: "既存の acceptance テストが全て通り、Worker Pool 単体の受け入れテストが Kobo も Banto も起動せずに実行できる" }
  - { id: a5, text: "npm run build・npm run typecheck・npm test がリポジトリ全体で通る" }
---

## 背景

ADR-0010 決定23 より。Worker Pool は Kobo のサブシステムではなく独立したモジュールとし、Kobo より先に作ると決定した。現状は spawn 系（`spawn-ledger.ts`・`pi-rpc-driver.ts`・`scheduler.ts`）が `packages/banto-daemon` の中にあり、Kobo に従属している。

この従属を解くと、番頭は Kobo 無しでも職人へ実作業を委譲できるようになり（D10がKoboの完成を待たない）、決定18のセッションビューアも Kobo 非依存になる。

決定23 は「既存の Kobo 内 spawn 実装をどう扱うか（切り出すか、Kobo が独立 Worker Pool を呼ぶ形に変えるか）は実装フェーズで決める」としていた。**本タスクでは「切り出して、Kobo は当面ライブラリとして参照し続ける」を採る。**

**Kobo が Worker Pool を「サービスとして」利用する形への切り替えは task-0024 に分けた。** 理由：Kobo の spawn 経路は既存の acceptance 331件と e2e が守っている領域であり、能力の切り出しと提供元の差し替えを1つの変更で行うと、回帰が出たときにどちらが原因か切り分けられない。切り出し（本タスク）は振る舞いを変えず、差し替え（task-0024）は振る舞いの検証に集中する。

**実装方針**：`pi-rpc-driver.ts`（PiRpcDriver・worktree操作）と `spawn-ledger.ts` は Kobo に依存していない（node標準と `@banto/core` の型のみ）ため、そのまま新パッケージへ移す。banto-daemon はそこから再輸出して参照し、実装の重複を作らない。

## スコープ外

- **Kobo が Worker Pool をサービスとして利用する形への切り替え（task-0024）**
- Kobo 側の統治ロジック（依存ゲート・quota・マージキュー）の変更。Worker Pool へ移すのは実行能力のみで、統治は Kobo に残す
- セッションビューアのReactコンポーネント（epic-0002。本タスクはライブアタッチのデータ側まで）

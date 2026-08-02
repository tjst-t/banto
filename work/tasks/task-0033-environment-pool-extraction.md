---
id: task-0033
type: task
kind: refactor
title: Environment Pool を独立モジュールとして切り出す（Kobo非依存で単体で動く）
status: done
parent: epic-0008
refs: [adr-0010]
scope:
  paths: ["packages/banto-environment-pool/**", "packages/banto-daemon/src/**", "packages/banto-core/src/**", "tests/acceptance/**", "tsconfig.json"]
acceptance:
  - { id: a1, text: "EnvDriver の実行能力（docker/process ドライバ・runner・環境台帳・sops）が packages/banto-environment-pool として独立して提供され、Kobo（banto-daemon）に依存せず単体で使える" }
  - { id: a2, text: "banto-daemon は新パッケージから再輸出して参照し、実装の重複を作らない。振る舞いは変えない" }
  - { id: a3, text: "既存の acceptance / e2e が全て通り、Environment Pool 単体の受け入れテストが Kobo も Banto も起動せずに実行できる" }
  - { id: a4, text: "npm run build・npm run typecheck・npm test がリポジトリ全体で通る" }
---

## 背景

ADR-0010 決定32 より。動作検証環境（`EnvDriver`）は Kobo のサブシステムではなく独立したモジュールとする（決定23 の Worker Pool と同じ扱い）。現状は具象（`docker-driver.ts`・`process-driver.ts`・`env-driver-runner.ts`・`env-ledger.ts`・`sops.ts`）が `packages/banto-daemon` の中にあり、Kobo に従属している。

契約（`banto-core/src/env-driver.ts`）は既にランタイム中立で、7動詞の型と定数だけを持つ。この従属を解くと、番頭は Kobo 無しでも動作検証の結果を機構が返した事実として受け取れる（決定29(a) と噛み合う）。

## 本タスクの範囲

**「切り出して、Kobo は当面ライブラリとして参照し続ける」を採る**（決定32a・task-0010 と同じ2段階の1段目）。

- **切り出しは振る舞いを変えない。** 能力の移動のみで、サービス化（番頭への `env.*` 提供）や Kobo の提供元差し替えは別タスク。1つの変更で複数を行うと、回帰が出たときの切り分けができない（task-0010 の判断と同じ）
- 具象ドライバ・runner・台帳・sops は Kobo に依存していない（node標準と `@banto/core` の型のみ）ため、そのまま新パッケージへ移す。banto-daemon はそこから再輸出する

## スコープ外

- **Environment Pool のサービス化・番頭への `env.*` 提供（別タスク）**
- **Kobo が Environment Pool をサービスとして利用する形への切り替え（別タスク、task-0024 相当）**
- モジュール HTTP 面の認証（決定27b／32d の帰結。未決事項）
- 環境 quota の上限を誰が決めるか（決定32e。実装時に詰める）

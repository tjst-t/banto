---
id: task-0058
type: task
kind: feature
title: Environment Pool を独立サービスにする（決定61）
status: done
parent: epic-0010
refs: [adr-0013, adr-0010]
scope:
  paths: ["packages/banto-environment-pool/**", "deploy/**", "tests/acceptance/**"]
acceptance:
  - { id: a1, text: "banto-environment-pool が単体プロセスとして起動し、決定27b の規約（POST {baseUrl}/tools/{Tool名}）で env.* を公開する。形は banto-worker-pool の service.ts / bin.ts に揃える" }
  - { id: a2, text: "既定ポートが Kobo(3000)・Banto(4100)・Worker Pool(4300) と衝突しない" }
  - { id: a3, text: "既定で 127.0.0.1 だけを待ち受ける。広げるには明示を要求し、広げたときは起動ログに警告を出す（決定40）" }
  - { id: a4, text: "検証環境への中継（{baseUrl}/env/<envId>/）が独立プロセスでも動く。WebSocket の upgrade も通る（決定39b）" }
  - { id: a5, text: "banto-host に組み込みモジュールとして載せる従来の使い方も壊れない（同じ Tool 定義を service と module の両方から使う）" }
  - { id: a6, text: "systemd ユニットを追加する。単一インストーラ（決定19）はまだ存在しないので、その作成は別タスクとする" }
  - { id: a7, text: "npm run build・npm run typecheck・npm test が通る", verify: "npm run typecheck && npm test" }
---

## 背景

Environment Pool は決定32 で独立モジュールとして切り出されたが、**サービスの口（`service.ts` / `bin.ts`）が無く、banto-host の中でしか動かない**。ADR-0013 決定60 で Kobo が `env.*` をモジュール経由で使うと決めたため、このままだと **Kobo が番頭ホストの稼働に依存する**——決定27b が「Banto が単一障害点になり、依存の向きが逆転する」として避けた状態になる。

Worker Pool の `service.ts` は最初から「Banto も Kobo もそれぞれのクライアント」という前提で書かれている。同じ形を Environment Pool に足す。

**このタスクは追加のみで、既存の振る舞いを変えない**（決定32a の2段階と同じ考え方）。Kobo 側の切り替えは task-0059。

## スコープ外

- Kobo の env コード削除（task-0059）
- モジュール HTTP 面の認証（決定40 で「前段で守る」と決着済み。ここでは待ち受けを閉じるまで）

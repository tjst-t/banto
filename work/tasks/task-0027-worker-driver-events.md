---
id: task-0027
type: task
kind: fix
title: Worker Poolがドライバのライフサイクルイベントを購読していない
status: draft
parent: epic-0005
refs: [task-0010, adr-0010]
scope:
  paths: ["packages/banto-worker-pool/**", "tests/acceptance/**"]
acceptance:
  - { id: a1, text: "WorkerPool が RuntimeDriver.subscribe でイベントを購読し、職人の起動・終了・起動失敗を把握する" }
  - { id: a2, text: "プロセスが終了した職人が、覗きに行かなくても終了として分かる" }
  - { id: a3, text: "npm run build・npm run typecheck・npm test がリポジトリ全体で通る" }
---

## 背景

task-0010 の実装漏れ。`RuntimeDriver` は `process_started` / `process_exited` / `spawn_failed` を発行できる契約になっているが、`WorkerPool` が `subscribe` を呼んでいない。そのため**職人が終わったことに誰も気づけず**、`worker.list` の生存確認（プロセスの存否）でしか分からない。

生存確認でも終了は分かるので致命的ではないが、「終了した瞬間」を捉えられないため、決定29 のイベントログ（task-0026）の土台としても必要になる。

task-0026（報告経路）から分けた理由：こちらは既存契約の配線漏れで小さく、先に直せる。task-0026 はイベントログと購読の設計を含むため大きい。

## スコープ外

- イベントログと起動元の購読（task-0026）
- 職人からの報告・質問（task-0026）

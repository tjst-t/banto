---
id: task-0102
type: task
kind: improvement
title: "決定94 の残り（概念を 7→5 に畳み切る）"
status: queued
refs: ["adr-0020", "adr-0019"]
scope:
  paths: ["packages/**", "docs/adr/**", "work/**"]
acceptance:
  - { id: a1, text: "npm test / npm run typecheck が通る" }
  - { id: a2, text: "稼働中の banto に反映し、起動ログで確認している" }
review:
  policy: manual
---
## 背景

ADR-0020 決定94 は「概念を 7 → 5」と決めたが、**2026-08-13 時点で畳めたのは束縛だけ**
（`defaults.host` ＋ `picks` → `roles`）。ADR の「実装した形」節は roles の表しか示しておらず、
読むと完了したように見えるため、レビューで指摘された。

## やること

- `NotSupported` を型で持つ（`resolve(ref) → Binding | NotSupported`）。Agent SDK は
  Claude 以外に繋げないので、契約が「どのモデルもどのハーネスでも動く」と仮定してはいけない
- `hostUsable` / `workerUsable` → **Policy 1つ**に畳む
- `ModelRef` を1文字列にするか、3フィールドのまま行くかを決める（**D1：公開I/F**。
  `worker.delegate` の `model` 引数や Kobo のタスク定義に波及する）
- Catalog を**ハーネスへの問い合わせ**に倒す（いまは `CLAUDE_KNOWN_MODELS` の直書き＋自前台帳）
- `LlmDefaults.workerTier` の撤去（`defaults()` が常に `"standard"` を返す死んだ欄）
- モデル操作 Tool 17 → 4

## 注意（今日2回踏んだ）

**書き先を移すときは、その欄に書く全部の経路を探すこと。** `roles` へ移したときは
`migrateOnce` / `migrateWorkerDefault` / `repairDefaults` / `tiers()` の4箇所あり、
さらに `repairDefaults` は backend を落として書き潰していた。
**スキーマを変えるときは、そのファイルを書く全プロセスを入れ直すこと**（工房が古いコードで書き戻した）。

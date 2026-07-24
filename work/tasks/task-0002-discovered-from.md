---
id: task-0002
type: task
kind: feature
title: discovered-from自動付与(refs先頭に発見元タスクID)
status: draft
refs: [followup-directive-2026-07, research-orchestrator-survey]
scope:
  paths: ["packages/banto-core/src/tools.ts", "packages/banto-core/src/task-frontmatter.ts", "packages/banto-daemon/src/**", "tests/acceptance/**"]
acceptance:
  - { id: a1, text: "escalate・incident・report_friction・request_design の生成ツールが、発見元taskIDをrefsの先頭に自動付与する" }
  - { id: a2, text: "検証ツール(watcher/スキーマ検証)が、エージェント生成ドキュメントのrefs先頭欠落を警告する" }
---

## 背景

調査(research-orchestrator-survey B / Beads discovered-from)より。エージェントが作業中に発見した仕事(escalate・incident・friction・design-request)は発見元タスクへのリンクが長期運用の鍵。schemas仕様 §1 に規約として追記済み。生成ツール群は今後のSprint(Extension Pack/改善ループ)で実装されるため、本タスクはそれらのツール実装時の横断要件となる。

## スコープ外

- 生成ツール自体の新規実装(各Sprintのスコープ。本タスクは付与規約の実装と検証のみ)

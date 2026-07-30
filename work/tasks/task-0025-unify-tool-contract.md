---
id: task-0025
type: task
kind: refactor
title: Tool契約の型を1つに統合する（ランタイム中立をbanto-coreへ戻す）
status: draft
parent: epic-0007
refs: [imp-0003, adr-0010]
scope:
  paths: ["packages/banto-core/src/**", "packages/banto-host/**", "packages/banto-worker-pool/**", "packages/banto-daemon/src/**", "tests/acceptance/**"]
acceptance:
  - { id: a1, text: "Tool契約の型が1つになり、契約（名前・パラメータスキーマ・説明・実行）が banto-core にある" }
  - { id: a2, text: "pi 向けの型変換はアダプタ（banto-host）に閉じ、モジュールがToolを定義するのに pi への型依存が要らない" }
  - { id: a3, text: "既存Tool（canvas.* / memory.* / skill.* / file.* / git.* / worker.* と、職人・監査向けの report_* / audit_report）がすべて同じ契約で表され、振る舞いが変わらない" }
  - { id: a4, text: "npm run build・npm run typecheck・npm test・npm run test:e2e が通る" }
---

## 背景

`imp-0003` より。Tool定義の型が2つ並立している（banto-core の `BantoTool` と banto-host の
`NamespacedToolDefinition`）。ADR-0010 決定1「ツール定義はランタイム中立の共通ライブラリに
置き、各ハーネスのアダプタは薄い皮に留める」と、決定27b「契約体系を2つ持たない」の
どちらにも反している。

実害は task-0010 で顕在化した：Worker Pool は pi を**バイナリとして**使うだけで型依存が
無かったのに、Tool を定義するために pi の型を引き込む必要が生じた。モジュールが増えるたび
同じことが起きる。

## スコープ外

- Tool の追加・削除。本タスクは型の統合のみで、振る舞いは変えない
- 決定22 の wire 名変換の方式変更（変換の位置は変わらない）

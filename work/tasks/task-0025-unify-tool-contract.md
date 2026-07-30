---
id: task-0025
type: task
kind: refactor
title: Tool契約の型を1つに統合する（依存を注入する中立な型を新設し、pi向けはアダプタに寄せる）
status: draft
parent: epic-0007
refs: [imp-0003, adr-0010]
scope:
  paths: ["packages/banto-core/src/**", "packages/banto-host/**", "packages/banto-worker-pool/**", "packages/banto-daemon/src/**", "tests/acceptance/**"]
acceptance:
  - { id: a1, text: "Tool契約の型が1つになり、契約（名前・パラメータスキーマ・説明・実行）が banto-core にある。実行に必要な依存は注入で受け、特定の依存（DaemonClient等）を型に焼き込まない" }
  - { id: a2, text: "pi 向けの型変換はアダプタ（banto-host）に閉じ、モジュールがToolを定義するのに pi への型依存が要らない。Worker Pool が pi の型を import しなくなる" }
  - { id: a3, text: "既存Tool（canvas.* / memory.* / skill.* / file.* / git.* / worker.* と、職人・監査向けの report_* / audit_report）がすべて同じ契約で表され、振る舞いが変わらない" }
  - { id: a4, text: "banto-core が pi を import しないことの既存検証（banto-core-layering.spec.ts）が通り続ける" }
  - { id: a5, text: "npm run build・npm run typecheck・npm test・npm run test:e2e が通る" }
---

## 背景

`imp-0003` より。Tool定義の型が2つ並立している（banto-core の `BantoTool` と banto-host の
`NamespacedToolDefinition`）。ADR-0010 決定1「ツール定義はランタイム中立の共通ライブラリに
置き、各ハーネスのアダプタは薄い皮に留める」と、決定27b「契約体系を2つ持たない」の
どちらにも反している。

実害は task-0010 で顕在化した：Worker Pool は pi を**バイナリとして**使うだけで型依存が
無かったのに、Tool を定義するために pi の型を引き込む必要が生じた。モジュールが増えるたび
同じことが起きる。

**注意：既存の `BantoTool` をそのまま採用先にはできない。** `execute(client: DaemonClient, args)`
と Kobo のクライアントに結合しており、「中立な型」ではなく「Koboを呼ぶ型」になっている
（imp-0003 の (3)）。したがって本タスクは「戻す」のではなく、**依存を注入で受ける中立な型を
新設し、既存の2つをそこへ寄せる**作業になる。

**見立てを狭める点**：`typebox` は pi ではなく独立した JSON Schema ビルダなので、パラメータは
typebox のままで中立化できる。pi 固有なのは `label` / `promptSnippet` / `renderCall` /
`renderResult` / `executionMode` と `execute` の第5引数・戻り値型だけ。アダプタは
「name/description/parameters/execute を写し、残りは既定値」で済む。

## スコープ外

- Tool の追加・削除。本タスクは型の統合のみで、振る舞いは変えない
- 決定22 の wire 名変換の方式変更（変換の位置は変わらない）
- 決定1と決定11の継ぎ目の仕様化（imp-0003 の (2)）。本タスクで実際の形が決まってから、
  ADRへ追記するかを判断する

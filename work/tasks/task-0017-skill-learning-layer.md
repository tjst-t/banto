---
id: task-0017
type: task
kind: feature
title: SKILLの学習層（記憶の第二層）とオーバーライドの陳腐化検出
status: draft
parent: epic-0001
depends: [task-0015]
refs: [adr-0010]
scope:
  paths: ["packages/banto-core/src/**", "packages/banto-host/**", "tests/acceptance/**"]
acceptance:
  - { id: a1, text: "番頭が実務の中で得た手順の改善を、既定のSKILLとは別の学習層として保存できる" }
  - { id: a2, text: "同名のSKILLがある場合、学習層が既定（番頭核・モジュールのいずれも）より優先される（決定26）" }
  - { id: a3, text: "学習層のオーバーライドは、元にした既定の版を記録する" }
  - { id: a4, text: "既定側が変わったオーバーライドを検出でき、黙って古いまま使わずincidentを積む（P3・決定26）" }
  - { id: a5, text: "npm run build・npm run typecheck・npm test がリポジトリ全体で通る" }
---

## 背景

ADR-0010 決定26 より。SKILLは「番頭核の既定・モジュールの既定・番頭の学習層」の3層で、学習層が既定を上書きする。これによりモジュールを更新しても番頭の学びが消えず、番頭の学びがモジュールの既定を汚さない。

学習層は決定10 (b)「タスク完了ごとの SKILL.md 自動蒸留（procedural memory）」の置き場であり、記憶の第二層に当たる。第一層（好み・習慣）は task-0007 で実装済みで、`MemoryStore` の背後に保存形式を隠す形を踏襲する。

**決定26 が明示した危険への対処が本タスクの要点**：層A資産は「壊れると静かに劣化する」（`spec-improvement-loop` §1）ため、オーバーライドが既定の改良を黙って隠す事故が起きやすい。元にした版を記録し、既定が変わったら incident を積む（P3）。この検出が無いと、モジュールの改良が永久に届かない状態が静かに続く。

## スコープ外

- 蒸留の自動化（どのタイミングで何を蒸留するかの判断）。まず手動で学習層に書ける状態を作り、自動化はその後
- 記憶の第三層（FTS5全文検索＋セッション横断検索）
- 既定側へのフィードバック（改善提案）の自動生成。`spec-improvement-loop` 層Aの流れに乗せるが、本タスクは検出までとする

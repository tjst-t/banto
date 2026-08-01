---
id: task-0005
type: task
kind: feature
title: ADR/spec確定時のwork/起票をSKILL化する（決定15）
status: draft
parent: epic-0001
depends: [task-0004]
refs: [adr-0010]
scope:
  paths: ["packages/banto-host/skills/**", "docs/spec/document-system.md"]
acceptance:
  - { id: a1, text: "packages/banto-host/skills/work-handoff/SKILL.md（agentskills.io形式）が作成され、「ADR/specをacceptedにした際は対応するwork/epic・taskをrefs付きで起票する」手順が明文化されている" }
  - { id: a2, text: "同SKILLに、acceptedなADR/specとrefsで紐付くwork/タスクの有無を定期的に棚卸しし、無ければP3に従いincidentを起票する手順が含まれる" }
  - { id: a3, text: "docs/spec/document-system.md にこのSKILLへの参照が追記されている" }
---

## 背景

ADR-0010（`docs/adr/adr-0010-pluggable-harness.md`）決定15より。Kobo は `docs/`（ADR/spec置き場）を監視しない設計（`document-system.md` §1の分離）のため、引き継ぎは技術的に強制できず、番頭の手続き記憶（SKILL.md）による自己規律＋P3棚卸し監査の二段構えとすることが決定済み。本タスク自体がその最初の適用例（このタスクを起票する行為も、決定15が要求する「引き継ぎ」の実践）。

## スコープ外

- Kobo にdocs/を監視させる技術的強制（ADR-0010決定15で不採用と決定済み）
- 番頭核ホストの記憶システム本体の実装（SKILL読み込み機構自体はepic-0001の他タスクの対象。本タスクはSKILLの中身の執筆のみ）

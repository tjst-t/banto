---
id: task-0032
type: task
kind: feature
title: 記憶の分類に fact（事実）を追加する
status: draft
parent: epic-0001
refs: [adr-0010]
scope:
  paths: ["packages/banto-core/**", "packages/banto-host/**", "packages/banto-web/**", "tests/acceptance/**", "docs/proposals/**"]
acceptance:
  - { id: a1, text: "kind: fact で保存・取り出しができ、好みの一覧に混ざらない" }
  - { id: a2, text: "システムプロンプトに「事実」の節が出る。順は 事実 → 好み → 習慣" }
  - { id: a3, text: "memory.save / memory.recall / 記憶ビューアが fact を扱える" }
  - { id: a4, text: "既存の記憶が影響を受けない（リテラルの追加であること）" }
  - { id: a5, text: "npm run build・npm run typecheck・npm run typecheck:web・npm test が通る" }
---

## 背景

ADR-0010 決定31。職人が起草した提案（`docs/proposals/2026-07-30-memory-kind-fact.md`）を
POが採用。

POの名前・役割・許諾範囲のような属性情報の置き場が無く、`preference` に押し込まれていた。
**手元の記憶を確認したところ実際にそうなっていた**（「POの名前は『たくみ』である」が
preference として保存されていた）。好みの一覧に名前が並ぶと、番頭がそれを「変えてよいもの」
として扱いうる。

## 決定29(a) の `fact` との関係

同音異義。あちらは証拠の状態（観測か自己申告か）、こちらは言明の種類。記憶における
確からしさは `kind` ではなく出所が担う（決定28）ので、軸が重ならない。決定31(b) 参照。

## スコープ外

- 既に `preference` として保存されている事実の付け替え。記憶は番頭の持ち物なので、
  会話の中で番頭が supersede して直す（機構は既にある）

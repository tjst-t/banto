---
id: task-0031
type: task
kind: feature
title: studio モジュール（番頭の記憶とSKILLを見せる。閲覧のみ）
status: done
parent: epic-0002
refs: [adr-0010]
scope:
  paths: ["packages/banto-host/**", "packages/banto-web/**", "tests/acceptance/**", "docs/proposals/**"]
acceptance:
  - { id: a1, text: "SKILLの一覧・本文・出所（番頭核／モジュール）がキャンバスGUIで見える" }
  - { id: a2, text: "記憶の一覧がキャンバスGUIで見える。種別で絞れ、訂正済みも履歴として確認できる" }
  - { id: a3, text: "GUIはモジュールのデータAPIから取る（決定25）。番頭のToolは呼ばない" }
  - { id: a4, text: "studio モジュールは memory.*/skill.* のドメインを所有しない（決定27a）。番頭向けToolを持たない" }
  - { id: a5, text: "npm run build・npm run typecheck・npm run typecheck:web・npm test が通る" }
---

## 背景

`docs/proposals/2026-07-30-banto-studio-module.md`（職人が起草、POが採用を判断）より。

**SKILLビューアは計画に無かった穴。** 決定18 の基本GUIセットにも入っておらず、番頭がどんな
手順を知っているかを人が確かめる手段が無かった。記憶ビューアの閲覧部分も併せて入れる。

## 採らなかったもの（提案との差）

- **記憶の編集・削除**：task-0023 が既に規定済み（削除は追記で表す・出所の可視化・訂正履歴）。
  GUIの都合で先取りしない
- **SKILL の書き込み**：決定26 の学習層（task-0017）の領域
- **モジュールが memory.*/skill.* の Tool を持つ形**：ドメインは中核の持ち物（決定27a）。
  studio は GUI とデータ取得の口（`studio.*`）だけを持ち、番頭向け Tool は持たない

## スコープ外

- 記憶の削除・編集（task-0023）
- SKILL の作成・編集（task-0017）

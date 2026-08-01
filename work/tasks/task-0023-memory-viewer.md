---
id: task-0023
type: task
kind: feature
title: 記憶ビューア（キャンバスGUI。一覧・出所の可視化・削除）
status: draft
parent: epic-0002
depends: [task-0022]
refs: [adr-0010]
scope:
  paths: ["packages/banto-host/**", "packages/banto-web/**", "tests/acceptance/**"]
acceptance:
  - { id: a1, text: "キャンバスGUIとして記憶の一覧が見える。好み・習慣の種別と、出所（明示保存／自動抽出）が判別できる" }
  - { id: a2, text: "POが記憶を削除できる。削除は追記で表され、有効な記憶は読み出し時に導出される（D3）" }
  - { id: a3, text: "訂正済み（superseded）の記憶は既定で隠れ、履歴として確認もできる" }
  - { id: a4, text: "GUIはworkspaceと同様、モジュールのデータAPIから取得する（決定25）。番頭のToolは呼ばない" }
  - { id: a5, text: "npm run build・npm run typecheck・npm test がリポジトリ全体で通る" }
---

## 背景

ADR-0010 決定28 より。抽出した記憶を自動で有効にする代わりに、**出所を残しPOが消せる面を用意する**と決めた。誤った記憶は毎セッション注入され静かに溜まるため、この面が無いと自動抽出は危険な機能になる。

記憶は番頭核が持つもので workspace モジュールの管轄ではないため、モジュールの置き方（Banto中核が提供するのか、記憶モジュールを立てるのか）は実装時に決める。決定25 の「Banto中核はデータの意味論を持たない」との兼ね合いを見て判断する。

## スコープ外

- 記憶の編集（削除と訂正で足りるか使って判断する）
- 第三層の検索面

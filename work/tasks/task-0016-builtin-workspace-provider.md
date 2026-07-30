---
id: task-0016
type: task
kind: refactor
title: 基本GUIセットを組み込みモジュールとして再配置し、データAPIとGUIを揃える
status: draft
parent: epic-0002
depends: [task-0015]
refs: [adr-0010]
scope:
  paths: ["packages/banto-host/**", "packages/banto-web/**", "tests/acceptance/**"]
acceptance:
  - { id: a1, text: "ファイル／Git閲覧が「組み込みモジュール」として登録され、Tool・GUIコンポーネント・データAPIの3点が1つの単位に揃う" }
  - { id: a2, text: "task-0011で作った file.* / git.* Tool が、Banto直付けではなくこのモジュールの提供物として登録される（振る舞いは変わらない）" }
  - { id: a3, text: "同じ実装の上に、番頭向けTool と UI向けデータAPI の2つの口が出る。判断・整形のロジックは1箇所にある（D5）" }
  - { id: a4, text: "キャンバスでファイルツリーとDIFFが表示され、GUIは自分のToolではなくモジュールのデータAPIから情報を得る（決定25）" }
  - { id: a5, text: "npm run build・npm run typecheck・npm test がリポジトリ全体で通る" }
---

## 背景

ADR-0010 決定25・27 より。基本GUIセットは他のモジュールと同じ登録の仕組みに乗る組み込みモジュールである。

task-0011 で `file.*` / `git.*` の Tool を作ったが、これは `bin.ts` が Banto の直付けToolとして登録している。決定25 の下では、これらは「ワークスペースモジュール」の提供物であり、同じモジュールが GUI コンポーネントとデータAPIも提供する。**振る舞いを変えるのではなく、所属を正す**作業。

決定25 の「人が GUI でできることは番頭にもできる。ただし経路が異なる」に従い、キャンバスのファイルツリーは番頭の `file.list` Tool を呼ばず、モジュールのデータAPI（この場合 Banto ホスト自身が提供する）から取得する。ロジックは1箇所に置き、Tool と データAPI はその上の薄い口とする（D5）。

## スコープ外

- ブラウザビュー（CDP転送）・シェル・セッションビューア（それぞれ別タスク。セッションビューアは epic-0005 の Worker Pool に依存）
- Git の変更操作（決定24で持たないと決定済み）
- テスト用GUI（`demo.*`）の扱い——実物が揃った時点で不要になる可能性が高い。本タスクでは残置し、判断は後続へ

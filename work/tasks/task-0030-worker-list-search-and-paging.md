---
id: task-0030
type: task
kind: feature
title: 職人一覧の絞り込みとページ送り（Worker Pool 側で行う）
status: draft
parent: epic-0005
depends: [task-0028]
refs: [adr-0010]
scope:
  paths: ["packages/banto-worker-pool/**", "packages/banto-web/**", "tests/acceptance/**", "docs/proposals/**"]
acceptance:
  - { id: a1, text: "worker.list が limit / offset でページを返し、総件数も返す。新しいものから並ぶ" }
  - { id: a2, text: "query で絞り込める。taskId だけでなく起動時の指示も対象になる" }
  - { id: a3, text: "職人ビューアの絞り込みとページ送りが Worker Pool 側の結果をそのまま描く（UIが全件を持たない）" }
  - { id: a4, text: "npm run build・npm run typecheck・npm run typecheck:web・npm test が通る" }
---

## 背景

`docs/proposals/2026-07-30-worker-list-pagination.md`（職人が起草、POが採用を判断）より。
決定30c で畳んだ職人も履歴に残すようにしたため、長く使うと一覧が膨らむ。

task-0029 では表示側で絞り込みとページ送りを行ったが、UIが全件を受け取る形のままだった。
本タスクで Worker Pool 側へ移す。

## 提案からの変更点

- **A案（limit / offset）を採用。** 提案はDBの走査コストを論拠に比較していたが、Worker Pool の
  一覧は既に全件メモリ上にあるためその負荷は無い。決め手は「任意のページへ飛べること」
  （UIのページャの要件。カーソル方式では満たせない）
- **`includeTotal` は設けない。** 総件数は配列長なので、払っていないコストのための切り替えを
  増やさない（D6）
- **検索（query）を追加**（POの要望）。起動時の指示も対象にする

## スコープ外

- セッション本文の全文検索。ファイルを開いて回ることになるので、一覧の応答とは別の機構にする

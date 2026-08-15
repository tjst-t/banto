---
id: imp-0039
title: kobo.amend が review / environment / model_tier を見ておらず、「渡された中身と同じです」と嘘の理由で断る
status: open
severity: P1
origin: 幹「電卓開発」からの言伝（dentaku task-0015 / task-0016 で実測・2026-08-15）
refs:
  - packages/banto-daemon/src/daemon.ts:1191-1257（classifyAmendment）
  - packages/banto-daemon/src/daemon.ts:1296-1325（amendTask）
---

## 何が起きるか

`review.policy` が `po` のタスクへ `{taskId, reason, review: {policy: "auto"}}` を渡すと、
500 で **`task-0015 は渡された中身と同じです（改訂するものがありません）`** と断られる。
`kobo.task` は同じタスクを「レビュー: po」と表示しているので、**実際には違うのに「同じ」と
言っている**——理由が嘘になっている。dentaku の task-0015 / task-0016 の2本で再現。

## 原因（番頭がコードで確認済み）

`amendTask` は渡された `review` / `environment` / `model_tier` を**契約へは重ねている**
（daemon.ts:1296-1303）。しかし差分を数える `classifyAmendment`（daemon.ts:1191-1257）が
比べているのは **acceptance / scope / title / body の4つだけ**。
review・environment・model_tier は比較対象に無いので `changes` が空になり、
直後の「I2: 何も変わっていないのに『改訂した』と記録しない」に引っかかって断られる。

つまりこの3項目は**引数として受け取れるのに、渡しても絶対に効かない**。
道具の説明には並んでいるので、外からは「渡せるが効かない」に見える。

## 直し方

`classifyAmendment` に3項目の比較を足す。

- **review.policy** — 変更を `changes` に載せる。**緩める方向は PO の判断**という現行の線は
  維持する。厳しさの順は `po` > `banto` > `auto` なので、**緩む向き（po→banto / po→auto /
  banto→auto）は `loosens = true`**、厳しくする向きは番頭が通してよい。
  監査は無効化しない（何に対して監査したかは変わらない）。
  これで、断り文が「同じ中身です」ではなく**「緩める方向なので PO の判断が要ります」**という
  正しい理由になり、番頭は取次へ上げられる。
- **environment** — `changes` に載せる。「何を確かめるか」ではなく「どこで確かめるか」なので、
  検証コマンドの訂正と同じ扱いで**番頭が通してよい**（`loosens = false`）。ただし
  **監査は無効化する**（前の監査は別の環境で取った証拠なので、安全側に倒す）。
- **model_tier** — `changes` に載せる。緩めでも監査無効化でもない。

## 受け入れ条件（案）

- `review.policy` が `po` のタスクへ `{review:{policy:"auto"}}` を番頭として渡すと、
  **「緩める方向なので PO の判断が要ります」で断られる**（「同じ中身です」ではない）
- 同じ改訂を PO として渡すと**通り**、`kobo.task` の表示が `auto` に変わる
- `auto` → `po`（厳しくする向き）は**番頭でも通る**
- `environment` を変えると通り、監査が無効化されて implementing へ戻る
- `model_tier` を変えると通り、監査は無効化されない
- 3項目のどれも変えずに同じ中身を渡したときだけ「同じ中身です」と断る（現行の I2 は維持）

## 経緯（なぜ困るか）

PO が途中で「レビューは全部マージしてからでよい（連作は自動着地でよい）」と方針を変えたが、
その指示が届く前に 10 本が `review: po` で積まれていた。po→auto は PO 自身の指示なので
`amend` で直せるはずが、この形で断られ、**積み直して supersede するしか手が無い**（9本ぶん）。
方針変更が積んだ後に来るのは普通に起きるので、amend で直せる必要がある。

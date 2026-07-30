---
id: imp-0005
type: improvement
kind: enhancement
origin: po
class: capability-gap
status: open
refs: [imp-0004, task-0010, adr-0010]
---

## 内容

職人（worker）に **WebFetch / WebSearch**（外部の取得・検索）の Tool を持たせたい（PO要望、2026-07-30）。調査タスクを職人へ委譲するとき、ドキュメントや API 仕様を自分で引けないと、番頭が全部渡すことになり D10（番頭は細かい仕事をしない）が空回りする。

## imp-0004 との関係（先に直す）

**imp-0004 が先。** `PiRpcDriver` はいま `SpawnOptions.tools` を読んでおらず、職人に渡す Tool を絞れない。この状態で web 系を足しても「全職人が常に web を持つ」形にしかできない。imp-0004 で `tools` を効かせてから、web 系を**選べる Tool の集合**として用意する。

## 設計で決めること

- **pi 側に web fetch/search があるか。** あればそれを有効化するだけ。無ければ拡張で足す（決定29e の `worker-report.ts` が拡張の雛形。banto-core 非依存の薄いアダプタにする）
- **既定で全職人に付けるか、明示指定か（D1）。** 外部ネットワークアクセスは職人に新しい能力を与える。取得先の制限（許可リスト等）が要るか、コスト・レート制限をどう扱うかを決める。番頭の判断で `worker.delegate` の `tools` に含める形が素直だが、既定に入れるなら one-way な外部依存として扱う
- **検証の経路との重複を避ける。** 動作検証は Environment Pool（決定32）が担う。web 取得は「調査のための読み取り」であって検証ではない——役割を混ぜない

## スコープ外

- Environment Pool（決定32・task-0033）。あれは実行して結果を得る経路で、これは読み取り経路

---
id: task-0024
type: task
kind: refactor
title: KoboがWorker Poolをサービスとして利用する形へ切り替える
status: draft
parent: epic-0010
depends: [task-0010, task-0018]
refs: [adr-0010]
scope:
  paths: ["packages/banto-daemon/src/**", "packages/banto-worker-pool/**", "tests/acceptance/**", "tests/e2e/**"]
acceptance:
  - { id: a1, text: "Kobo は自前で職人を spawn せず、独立した Worker Pool を利用する側になる" }
  - { id: a2, text: "既存の依存ゲート・quota・スケジューリング・マージキューの振る舞いが変わらない（既存の acceptance と e2e が通る）" }
  - { id: a3, text: "Worker Pool が落ちているときの扱いが決まっており、黙って成功扱いにしない（I2）" }
  - { id: a4, text: "npm run build・npm run typecheck・npm test・npm run test:e2e が通る" }
---

## 背景

ADR-0010 決定23・27c より。Worker Pool は Kobo から独立したモジュールで、Kobo はその利用者になる。task-0010 で Worker Pool を独立パッケージとして切り出したが、Kobo は当面ライブラリとして参照し続けている。本タスクでその参照を、決定27b のモジュール間呼び出し（ライブラリ＋レジストリ方式・当事者間で直接）に置き換える。

**task-0010 から分けた理由**：Kobo の spawn 経路は既存の acceptance 331件と e2e が守っている領域。能力の切り出しと提供元の差し替えを1つの変更でやると、回帰が出たときにどちらが原因か切り分けられない。本タスクは「振る舞いを変えないこと」の検証に集中する。

## スコープ外

- Kobo 側の統治ロジックそのものの変更（依存ゲート・quota・マージキューは Kobo に残る）
- Worker Pool の機能追加（task-0010 の範囲で足りるか、ここで判明したら別途起票する）

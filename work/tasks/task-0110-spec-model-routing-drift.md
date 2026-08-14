---
id: task-0110
type: task
kind: improvement
title: "spec-daemon-core §3.5 のモデル tier 表を ADR-0021 の形へ改訂する"
status: queued
refs: ["adr-0021", "adr-0011", "inc-0024"]
scope:
  paths: ["docs/spec/**", "work/**"]
acceptance:
  - { id: a1, text: "spec-daemon-core §3.5 が、核の台帳（役ごとのモデル）を指している" }
  - { id: a2, text: "meta/config.yaml の独自ルーティング表の記述が消えている" }
review:
  policy: manual
---
## 背景

`spec-daemon-core` §3.5「モデルtier（層B）」は `meta/config.yaml` に独自のルーティング表を
持つと規定しているが、**実装にそんな表は無い**（inc-0024）。ADR-0021 で解決先が
核の台帳（`<data>/model-roles.json`）に一本化されたので、spec を実態へ寄せる。

**黙って寄せない**のが P3 の趣旨だったが、いまは ADR で決まっているので改訂してよい。

## 書くこと

- 等級 → モデルの解決は**核の台帳**（決定101）。Kobo は等級までしか渡さない（決定60a）
- **呼び出し側の上書き**（Kobo の `executor`/`rework`/`audit`）は Kobo が持つ（決定99a）
- **失敗駆動の昇格**（監査2回不通過で一段上）は、昇格先の等級に割り当てが無ければ
  **落ちずに止まる**（決定104）——その場合どうするかを spec に書く

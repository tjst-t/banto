---
id: task-0046
type: task
kind: refactor
title: Environment Pool をサービス化し、Kobo を利用側へ回す（台帳を1つにする）
status: draft
parent: epic-0010
depends: [task-0034]
refs: [adr-0010, spec-environment]
scope:
  paths: ["packages/banto-environment-pool/**", "packages/banto-daemon/src/**", "packages/banto-host/src/**", "tests/acceptance/**"]
acceptance:
  - { id: a1, text: "Environment Pool が独立したサービスとして立ち、Kobo と番頭が同じ1つの台帳を見る" }
  - { id: a2, text: "Kobo が env ドライバを自前で抱えるのをやめ、Environment Pool を利用する側に回る" }
  - { id: a3, text: "TTL 執行・照合が1箇所になる（いま Kobo と Environment Pool の両方にある）" }
  - { id: a4, text: "既存の acceptance / e2e が通る" }
---

## 背景

ADR-0010 決定32a の2段目（task-0010 → task-0024 と同じ関係）。task-0033 で切り出し、
task-0034 で契約を入れたが、**Kobo は依然として env ドライバをライブラリとして直接呼んでいる**。

**いま台帳が2つある。** Kobo は自分の `dataDir` に、番頭側の Environment Pool は
`<dataDir>/environment-pool` に、それぞれ別の台帳を持つ。epic-0008 の受け入れ条件
「台帳・TTL・quota・reconcile が Environment Pool 側にあり、番頭が起こした環境も
消し忘れなく片付く」は、**番頭側については満たしたが Kobo 側は別勘定のまま**。

task-0034 で番頭側に TTL 執行と照合を実装したので、**同じ機構が2箇所にある**状態でもある
（決定32e は1箇所に寄せることを求めている）。

## いま困っていないこと

Kobo はまだ Banto に配線されていない（PO判断 2026-08-01）。台帳が2つあっても、
番頭の経路は自分の台帳で完結しており実害は出ていない。**Kobo を配線する段で必ず要る**。

## スコープ外

- モジュール HTTP 面の認証（`spec-environment` §8・別課題だが、サービス化と同時に要る）

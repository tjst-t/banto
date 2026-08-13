---
id: task-0107
type: task
kind: improvement
title: "段1b: 採用（policy）を核の台帳の母集団へ移す"
status: done
refs: ["adr-0021"]
scope:
  paths: ["packages/**", "tests/**", "work/**"]
acceptance:
  - { id: a1, text: "npm test / npm run typecheck が通る" }
  - { id: a2, text: "Claude のモデルにも採用の旗が立つ（症状1が消える）" }
  - { id: a3, text: "実データの移行を件数で確認している（32モデル・56旗）" }
review:
  policy: manual
---
## やること（ADR-0021 段取り 1b・決定101e）

- `models[*].policy` → 核の台帳の **`adopted`（母集団1つ）**。役ごとに採り直さない
- 役の `only` は**任意**。未指定＝母集団ぜんぶ
- **役の面で選べば採用も立つ**（いまの `setRole` の振る舞いを残す）
- 役を知らない読み手3つ（`llm.list` の `adopted` 既定・`fetch_models` の消失警告・
  「探して採用」の `scope:"host"` 固定）は**母集団を答える**

## なぜ 1a と分けるか

`policy` の読み手は5箇所あり、同じ段で動かすと「挙動が変わらない」を試験で押さえられない。

## 済んだこと（2026-08-13）

`policy` → 台帳の `adopted`（母集団1つ）。`models()` の `policy` は母集団から**導出**するので、
読み手9箇所はそのまま動く。**役ごとに採り直さない**ので画面に二度手間は出ない（決定101e）。

実データの写しで実測：**32 → 32**、オーバーレイの `policy` は0件、`contextWindow` は落ちない、
`resolveForWorker` の答えも同じ。

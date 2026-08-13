---
id: task-0111
type: task
kind: improvement
title: "番頭と職人を Claude で回したときのサブスクリプション消費を測る"
status: queued
refs: ["adr-0020", "adr-0021"]
scope:
  paths: ["docs/**", "work/**"]
acceptance:
  - { id: a1, text: "1日ぶんの消費が数で出ている（番頭・職人それぞれ）" }
  - { id: a2, text: "枠に対してどのくらいかが分かり、続けるか変えるかを判断できる" }
review:
  policy: manual
---
## 背景

**ADR-0020 未決3 のまま。** いま実機は**番頭も職人も Claude**で回っている
（番頭 `opus`／職人 reasoning=`opus` standard=`sonnet` fast=`haiku`）。
ADR-0021 の移行でも「走っているほうを正」としたので、この構成が続く。

**Pro x20 の枠がある前提**（PO裁定 2026-08-13）だが、**実際にどのくらい使うかは測っていない**。
職人は「タスクをひたすら積む」運用（ADR-0013）なので、同時実行数と等級が費用を決める。

## 測り方の候補

- `result` の `modelUsage`（`ClaudeAgentHarness` は既に読んでいる。文脈長だけ使っている）
- 職人側は `claude-agent/host.ts` の経路
- **合成データで測らない。実際に回した1日で測る**（教訓）

## 決めること

測った結果しだいで、職人の等級ごとの割り当てを見直すか（例：fast をローカル無料へ戻す）。
**「モデルはローカル無料の DeepSeek が主」という以前の裁定は、職人については上書きされている**
（ADR-0021 移行の裁定）ので、戻すならそこも裁定し直す。

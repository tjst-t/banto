---
id: task-0106
type: task
kind: improvement
title: "段1a: 役の台帳を核に作る（版印つき・書き口は部分更新1本）"
status: queued
refs: ["adr-0021"]
scope:
  paths: ["packages/**", "tests/**", "work/**"]
acceptance:
  - { id: a1, text: "npm test / npm run typecheck が通る（**挙動が変わらない**のが完了条件）" }
  - { id: a2, text: "LLM 画面から番頭を選び直しても backend が落ちない" }
  - { id: a3, text: "稼働中の banto に反映し、実データの移行を件数で確認している" }
review:
  policy: manual
---
## やること（ADR-0021 段取り 1a）

- **役の台帳を別ファイルに作る**（決定101a）。`schemaVersion` を持ち、**版が違えば読み手は止まる**
  ——番頭ホストと工房は別サービスで再起動が独立し、工房は mtime で走行中に読み直すため、
  版印が無いと古い版が新しい形を読んで**黙って別のモデルで走る**
- `roles` を `llm-registry.json` からそこへ移す（`backend` を落とさない）
- **書き口を部分更新1本に**（決定101c）。`roles` へ書く経路は7つあり、`backend` を運ぶのは2つだけ
  （`llm.set_role` / `core-settings` / `bin.ts` の移行 / `repairDefaults` / `migrateRoles` /
  `migrateWorkerDefault` / `migrateOnce`）
- `llm.set_role` に `backend` を足す
- **`policy` は据え置き・画面も据え置き**（1b でやる）

## 注意

**台帳の読み手が居ないうちは、書き手（番頭ホスト）だけが触る。** 工房が新しい台帳を読むのは
段2。それまで工房は従来どおり `llm-registry.json` を読む。

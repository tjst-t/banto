---
id: task-0109
type: task
kind: improvement
title: "段3: 画面を「供給の面」と「役の面」に割り直す"
status: queued
refs: ["adr-0021"]
scope:
  paths: ["packages/**", "tests/**", "work/**"]
acceptance:
  - { id: a1, text: "npm run typecheck:web / build:web が通り、実ブラウザで確認している" }
  - { id: a2, text: "役の面1枚で、番頭と職人の等級の既定が選べる（バックエンド横断）" }
  - { id: a3, text: "「LLM・モデル」画面から役割の割り当てが消えている" }
review:
  policy: manual
---
## やること（ADR-0021 段取り 3・決定102）

- **役の面**（核）1枚：番頭・職人の等級ごとに、母集団から既定を選ぶ。**バックエンド横断**
- **供給の面**：いまの「LLM・モデル」画面は**実体が pi バックエンドの面**なので、そう名乗る。
  役割の割り当て（番頭 Select・番頭チップ・職人の等級チップ）はそこから外す
- Claude Code の面は認証の状態だけ（**項目で書ける範囲に限る**・決定102a）。
  専用ビューは banto-web の静的レジストリでしか解決できない
- 区画 id に接頭辞の規約（`backend:pi` 等）

## PO 裁定

**この形で作り、物を見てから最終確認**（2026-08-13）。

---
id: task-0003
type: task
kind: feature
title: アテンションカード生成のプッシュ通知
status: draft
refs: [followup-directive-2026-07, research-orchestrator-survey]
scope:
  paths: ["packages/banto-daemon/src/**", "packages/banto-core/src/events.ts", "tests/acceptance/**"]
acceptance:
  - { id: a1, text: "カード生成イベント(blocking発生・レビュー待ち・failed・評価カード・定期レビュー)でntfy(または層B設定のチャネル)に通知が届く" }
  - { id: a2, text: "通知文に経緯1行とカード種別が含まれる(D8)" }
  - { id: a3, text: "静穏時間設定(層B)が効き、静穏時間中は通知が抑制される" }
---

## 背景

調査(research-orchestrator-survey C / Operator)より。アテンションキューは「開けば分かる」が「開くきっかけ」が仕様に欠けていた。daemonからntfy等の携帯到達チャネルへカード生成時のみ通知する。spec-ui §6(通知)・spec-daemon-core §6 に追記済み。

## スコープ外

- カード生成機構そのもの(アテンションキュー実装: Sprint S30a8fd)。本タスクはカード生成イベント→通知チャネル送出の配線
- 通知チャネルの多重化・購読管理(必要になったら)

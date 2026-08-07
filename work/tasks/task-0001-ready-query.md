---
id: task-0001
type: task
kind: feature
title: readyクエリのAPI/CLI実装
status: done
parent: epic-0010
refs: [followup-directive-2026-07, research-orchestrator-survey]
scope:
  paths: ["packages/banto-daemon/src/**", "packages/banto-cli/src/**", "packages/banto-core/src/daemon-client.ts", "tests/acceptance/**"]
acceptance:
  - { id: a1, text: "依存グラフ・スコープ重複・quotaを反映した着手可能タスク一覧が GET /api/v1/ready で返る" }
  - { id: a2, text: "banto ready(CLI)とボードのNext表示が同一クエリを使う(実装の重複がない)" }
---

## 背景

調査(research-orchestrator-survey A / Beads `bd ready`)より。依存駆動ゲートの判定結果「いま着手可能な仕事」を一級クエリとしてAPI/CLIに公開する。検討エージェントの分解判断・ボードNext表示・spawnスケジューラがすべて同じクエリを見ることで、判定の真実を一箇所に保つ(D3)。spec-daemon-core §6 に追記済み。

## スコープ外

- ボード(Web GUI)本体の実装(Sprint S30a8fd)
- spawnスケジューラのready購読(auto-spawn。backlog既存項目)

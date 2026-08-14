---
id: task-0099
type: task
kind: conflict
title: "コンフリクト解消: task-0097 vs main"
status: queued
refs: ["task-0097"]
scope:
  paths: ["**"]
acceptance:
  - { id: a1, text: "コンフリクトが解消されており、task-0097 の意図が mainline と統合されている" }
review:
  policy: auto
---
## 背景

プロジェクト `banto` でタスク `task-0097`（Dockerfile.test の Node 22 → 24 更新）を
メインライン `main` へ rebase しようとしたところ、コンフリクトが発生しました。

元タスクはコンフリクト解消まで一時停止（paused）されます。
このタスク（task-0099）が merged になると、元タスクが再開されます。
このタスクが failed になると、元タスクも failed になります（I2: 連鎖失敗）。

## コンフリクト情報

**元タスク**: `task-0097` — Dockerfile.test の Node 22 → 24 更新
**ブランチ**: `task/task-0097`（元タスク）vs `main`（メインライン）

**コンフリクトしたファイル**:

- (詳細は git status を参照)

**rebase エラー（抜粋）**:

```
rebase failed in worktree /home/ubuntu/worktrees/github.com/tjst-t/banto/task-task-0097: Error: Command failed: git rebase main
Rebasing (1/1)error: could not apply 5fbf177... fix(docker): 検証環境の Node を 24 系に揃える（task-0097）
hint: Resolve all conflicts manually, mark them as resolved with
hint: "git add/rm <conflicted_files>", then run "git rebase --continue".
hint: You can instead skip this commit: run "git rebase --skip".
hint: To abort and get back to the state before "git rebase", run "git rebase --abort".
Could not apply 5fbf177... fix(docker): 検証環境の Node を 24 系に揃える（task-0097）

```

## 解消方針

1. `main` の最新コミットを確認し、変更意図を把握してください
2. `task/task-0097` の変更意図を確認してください
3. 両ブランチの変更を統合したコンフリクト解消コミットを `task/task-0097` に作成してください
4. `acceptance` を確認し、解消後に全ての受け入れ基準が成立することを確認してください

## スコープ外

- 元タスク（`task-0097`）の機能追加や変更 — コンフリクト箇所の統合のみ
- `main` への直接 push — このタスク完了後にマージキューが処理します

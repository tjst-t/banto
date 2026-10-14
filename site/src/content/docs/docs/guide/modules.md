---
title: Module
description: banto に最初から入っている Module の一覧。
---

Module は、AI からも人からも使える部品です。AI は tool として呼び、人は画面（Canvas）で開きます。

## 作業する

| Module | できること |
|---|---|
| **Shell** | コンテナの中でコマンドを流す。長いコマンドは待たずに流し、終わったら AI に知らせる |
| **FileSystem** | ファイルを読む・書く・人に見せる |
| **Terminal** | 人が触れるターミナル。閉じても続きから使える |
| **Browser** | コンテナの中のブラウザ。AI が操作し、人も同じ画面を見て触れる |
| **Subagent** | 別の AI（Claude Code・OpenCode）に仕事を頼む |

## 動かす・公開する

| Module | できること |
|---|---|
| **Service** | 開発サーバなど、動き続けるものを登録して起こしておく。落ちたら起こし直す |
| **Publish** | Service を `<名前>.<banto の名前>` で公開する。前に banto のログインが付く |

## 秘密を扱う

| Module | できること |
|---|---|
| **Vault** | トークンや鍵を預かる。AI には名前だけを渡し、値は AI の文脈に出さない |

## 開発の流れ

| Module | できること |
|---|---|
| **Repositories** | リポジトリの一覧。GitHub から clone する・新しく作る・Project を始める |
| **Backlog** | ストーリー・タスク・バグの一覧。リポジトリの専用のブランチに置く |
| **Factory** | Backlog のタスクを流すと、worktree を作って実装・テスト・レビューし、main へ取り込む |

---
id: task-0036
type: task
kind: feature
title: 会話の永続化と一覧・再開（ホストの再起動を越えて残る）
status: draft
parent: epic-0006
depends: [task-0035]
refs: [adr-0010, imp-0002, vision]
scope:
  paths: ["packages/banto-host/src/**", "tests/acceptance/**"]
acceptance:
  - { id: a1, text: "会話がホストのプロセスを越えて残る。banto serve を止めて上げ直しても、以前のスレッドの内容が読める" }
  - { id: a2, text: "過去のスレッドを一覧でき、選んで再開できる。再開したスレッドには元の会話が復元され、続きから話せる" }
  - { id: a3, text: "会話の真実がどこにあるかが一箇所に決まっており、同じ内容を二重に持たない（D3）。派生でしか無いもの（Tool の実行状態など）は保存しない" }
  - { id: a4, text: "保存に失敗したら黙って進まない（I2）。会話が消えているのに残っているように見せない" }
  - { id: a5, text: "既存の acceptance / e2e が通り、npm run build・typecheck・test が通る" }
---

## 背景

`imp-0002` / epic-0006 より。いま会話履歴はホストのメモリ上にしか無く、`banto serve` を再起動すると消える（記憶 `memory.jsonl` は残る）。過去の会話を一覧して再開する手段も無い。

「割り込みが PO の文脈を壊さない」（vision）はプロセスが生きている間だけの話ではない。**あとで戻れないなら、そもそも別スレッドへ逃がす気にならない。** task-0035 で並行できるようにしたスレッドが、再起動で消える状態のままでは epic の目的を満たさない。

## 本タスクの範囲

- スレッドの会話を永続化する
- スレッドの一覧と再開（過去のスレッドを選んで続きから話す）
- **会話の真実の置き場所を一箇所に決める**（下記）

## 実装メモ

- **pi の `SessionManager` がファイル永続化と一覧をすでに持っている**（`SessionManager.create(cwd, sessionDir)` / `.open(path)` / `.list(cwd, sessionDir)`）。いま `createBantoHostSession()` は `SessionManager.inMemory()` を既定にしているだけで、差し替え口は開いている。**自前の会話ストアを作らない**（D6）——職人のセッション（`--session-dir`）と同じ手であり、決定30d「起こし直しは同じセッションの再開」も同じ機構に乗っている
- **詰めること：`TranscriptEntry` と pi のセッションファイルの関係**。いまホストは会話を `TranscriptEntry[]` として別に持っており、そこには pi のメッセージではないもの（職人からの `notice`・Tool の実行状態）が混ざっている。会話本体は pi のセッションが真実、`notice` 等は Banto 側が持つ——という分け方でよいかを実装時に確定させ、**同じ内容を二重に保存しない**（D3）
- 一覧は「新しいものから」。`worker.list`（決定30/task-0030）で同じ判断をしている——溜まった履歴を辿る用途なので直近が先頭

## スコープ外

- **UI の履歴面**（task-0037）。本タスクはホスト側の保存・一覧・再開まで
- 会話の検索・グルーピング（UIプロトタイプ二次改訂の「今日／今週／先月」等）。まず残ること・戻れることを作る
- 会話の圧縮・要約。pi の compaction に乗せるかは別途

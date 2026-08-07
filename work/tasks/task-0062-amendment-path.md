---
id: task-0062
type: task
kind: feature
title: 積んだ後の訂正を表せるようにする（新タスク＋superseded・決定64）
status: done
parent: epic-0010
refs: [adr-0013, inc-0028]
scope:
  paths: ["packages/banto-daemon/**", "packages/banto-core/src/events.ts", "tests/acceptance/**"]
acceptance:
  - { id: a1, text: "取り込み済みタスクの定義ファイルが書き換えられたとき、反映しないという事実がイベントに残る。番頭が『直したのに何も起きない』を黙って踏まない（I2）" }
  - { id: a2, text: "書き換えても契約（scope.paths・acceptance）は変わらない。砦は維持される（決定62c・64）" }
  - { id: a3, text: "訂正の作法が番頭に届く：新しいタスクを積み、元を superseded にする経路が Tool／API から辿れる" }
  - { id: a4, text: "superseded にした元タスクの職人・検証環境が畳まれる（終端状態の後始末に乗る）" }
  - { id: a5, text: "npm run typecheck / npm test が通る", verify: "npm run typecheck && npm test" }
---

## 背景

ADR-0013 決定64（PO裁定 2026-08-06）。inc-0028 の解決。

**取り込み済みのタスクは、定義ファイルを書き換えても更新されない。** これは砦として正しく
効いている——番頭は `work/tasks/*.md` を書けるので、後から `scope.paths` を広げて
マージ前ゲートを緩められては困る。**しかし裏返しとして、正当な訂正もできない。**

タスクを積む主体が番頭になると（決定58）、会話の中で要件が変わるのは普通の出来事になる。
訂正経路が無いと、番頭は**黙って失敗する経路**を踏む（I2 に反する）。

## やること

1. **書き換えの検知をイベントに残す**。`task-watcher` は既存タスクを見つけると mtime だけ
   記録して読み飛ばしている。**取り込み済みだった**という事実を残す（新しいイベント種を
   足すか、`task_ingest_rejected` に理由を載せるかは実装時に決める。イベントログの形式は
   累積する副作用なので、増やすなら最小限にする）
2. **訂正の作法を書く**。新しいタスクを積み、元を `superseded` にする——これが訂正の
   表し方であることを、番頭が読む場所（SKILL か Tool の説明）に置く

## スコープ外

- `queued` / `ready` の間の再取り込み（決定64 で不採用）
- 番頭から積む口そのもの（`kobo.*`）— Phase 2 の入口タスク

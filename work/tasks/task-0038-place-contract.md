---
id: task-0038
type: task
kind: feature
title: 場所（Place）の共通契約と範囲チェックの一般化
status: done
parent: epic-0009
refs: [adr-0010, imp-0004]
scope:
  paths: ["packages/banto-core/src/**", "packages/banto-host/src/**", "tests/acceptance/**"]
acceptance:
  - { id: a1, text: "PlaceProvider の契約が banto-core にある。list() で {id,label,path} を返すだけで、作る・壊すは含まない" }
  - { id: a2, text: "静的な場所をホストの設定で登録できる。モジュールにはしない（決定36d）" }
  - { id: a3, text: "file.* / git.* が場所を引数で受け取る。省略時の既定は決めてあり、黙って別の場所を読まない" }
  - { id: a4, text: "範囲チェックが「登録された場所のいずれかの中か」で行われる。シンボリックリンクを解決した後に判定する既存の性質を保つ" }
  - { id: a5, text: "worker.delegate の worktreePath が同じ砦を通る。登録された場所の外を指したら弾く（いま無検査という穴を塞ぐ）" }
  - { id: a6, text: "/ のような広い場所を登録したら起動ログで警告が出る。Tool の結果には常に場所名が載る（決定36d）" }
  - { id: a7, text: "既存の acceptance / e2e が通り、npm run build・typecheck・test が通る" }
---

## 背景

ADR-0010 決定36（c）(d)(e)(g)。

**砦は既にあるが、穴が1つ空いている。** `file.*` には `resolveInWorkspace`（リンク解決後に判定）があり、`git.*` は `cwd` 固定で外を向けない。ところが **`worker.delegate` の `worktreePath` は誰も検査していない**——番頭が任意の絶対パスを指定すれば、職人はそこを書き換える。複数リポジトリ化と関係なく塞ぐべきもので、`docs/notes/handoff.md` に「職人の作業場所は必ず `/tmp/banto-play`」という手運用の約束が書いてあるのは、砦が無いからである。

## 実装メモ

- 判定基準を「1つの固定ルート」から「**登録された場所のいずれかの中**」へ一般化する。読み取りも副作用も同じ砦を通す
- **引数は消さない。場所の外を指したときに弾く**（既存の Tool 契約を壊さない）
- `workspaceRoot()` は「場所が1つも登録されていないときの既定」に格下げされる
- GUI（FileBrowser / GitViewer）は同じ Tool 契約を HTTP 経由で呼ぶので、**引数が1つ増えるだけで場所の選択UIが成り立つ**（決定25）

## スコープ外

- repo-manager モジュール本体（task-0039）
- Kobo の worktree 操作を寄せる段（task-0039 のスコープ外にも記載）

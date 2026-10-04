# 残っている仕事の一覧はどこにあるか

一覧（ストーリー・タスク・バグ）は、2026-10-04 から作業ツリーの `docs/tasks.json` ではなく、
このリポジトリの専用のブランチ **`backlog`**（コードとつながらない orphan）の `tasks.json` にある。

- 読み書きは Backlog の Module（画面と AI の tool）を通す。1件の変更ごとに `backlog` ブランチへ1コミット積む
- tool の外で見るだけなら `git show backlog:tasks.json`
- 仕様は `docs/specs/v4-modules.md` §4.4、経緯は `docs/notes/2026-10-04-backlog-branch-store.md`

ほかの文書にある「`docs/tasks.json` の〈id〉」は、この一覧の項目の id を指す。

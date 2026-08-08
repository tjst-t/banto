---
id: inc-0038
type: incident
kind: incident
origin: agent
class: environment-contract
status: resolved
refs: [task-0084, task-0075]
---

## 内容

**マージ前ゲートの検証環境では git が動いていなかった。** git を呼ぶテストは全部落ちる。

ゲートは職人の **worktree** で検証を回す。worktree の `.git` はディレクトリではなく
**ファイル**で、中身は本体への参照：

```
gitdir: /home/ubuntu/ghq/github.com/tjst-t/loamium/.git/worktrees/task-task-0005
```

このパスは**ホストのもの**で、コンテナの中には存在しない。結果：

```
fatal: not a git repository: /home/.../loamium/.git/worktrees/task-task-0005
```

## なぜ気づきにくいか

**`git check-ignore` は 128（git のエラー）を返す。** テストは「1 = 無視されない」を
期待しているので、`expected 128 to be 1` と出る——**git が動いていないことが、
テストの失敗に化ける**。loamium で実際に2件がこれだった。

**もう1つ紛らわしい形もある**（別の穴・実測）：`repoPath` をそのまま bind mount した
場合は所有者違いで `detected dubious ownership` になり、**これも 128**。
症状が同じで原因が2つある。

## 直したこと（task-0084）

ドライバが `run` の one-off コンテナに、**本体の `.git` を同じ絶対パスで読み取り専用に
見せる**。worktree かどうかは `.git` がファイルかどうかで判る（`gitdir:` を読む）。
普通のリポジトリなら何もしない——既に bind mount に入っている。

**読み取り専用にしてある。** 検証は読む仕事で、他人のリポジトリの履歴を書き換えられては
困る。ただし `git commit` するような検証コマンドは通らない——**要るようになったら
そのとき決める**（いまは「git が動かない」より確実に良い）。

所有者違いの方（`dubious ownership`）は**イメージ側の話**なので、
`RUN git config --system --add safe.directory '*'` を banto 自身の `Dockerfile.test` と
`kobo-onboarding` SKILL に入れた。

## 直したあと（実機）

**loamium/task-0005 が最後まで通った**（1943件すべて green → ゲート通過 → マージ）。

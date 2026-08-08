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

**読み取り専用にしてある。** 見せているのは `<本体>/.git` で、これは**全 worktree と
PO の作業チェックアウトが共有している実物**。書けるようにすると、検証コマンドが
`git reset --hard`・ref の削除・`gc` などで **PO の実リポジトリを壊せる**。
検証は他人のコードを走らせる場所なので、ここは開けない。

### 何が通って、何が落ちるか（実測）

| 操作 | 結果 |
|---|---|
| `git log` / `diff` / `rev-parse` / `check-ignore` | **通る** |
| `git status` | **通る**（index の更新は best-effort なので落ちない） |
| `git add` / `git commit` | **128 で落ちる** |
| `git stash` | 落ちる |

境界は「**その worktree の git 状態を書き換えるか**」。読む系と `status` は全部通る。

### 実際に困る検証（見当）

- リポジトリ自身にコミットするテスト（git hooks / pre-commit を実リポジトリで試すもの）
- `git stash` を使う道具（husky / lint-staged 系）
- リリース系の dry-run（semantic-release / changesets。タグやコミットを打つ）

「作業ツリーが汚れていないこと」を `git diff --exit-code` で見る類は**読みなので通る**。

**banto 自身はいまのところ影響なし**（調査済み）。リポジトリ自身に git を使っているのは
`source-hygiene.spec.ts` の `git ls-files`（読み）だけで、他の受け入れテストは全部
`os.tmpdir()` に本物のリポジトリを作って書いている——コンテナの中の書ける場所。

### 要るようになったときの筋（PO 了承済み・2026-08-08）

**read-write にするのではなく、worktree ではなく clone を渡す。** 自己完結していて
書き放題で、壊れても実リポジトリに波及しない。コストは clone の時間だけ。
`.git` を rw で見せる案は採らない——共有物を検証コマンドに開けることになる。

所有者違いの方（`dubious ownership`）は**イメージ側の話**なので、
`RUN git config --system --add safe.directory '*'` を banto 自身の `Dockerfile.test` と
`kobo-onboarding` SKILL に入れた。

## 直したあと（実機）

**loamium/task-0005 が最後まで通った**（1943件すべて green → ゲート通過 → マージ）。

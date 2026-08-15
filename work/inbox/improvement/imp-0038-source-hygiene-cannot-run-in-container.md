---
id: imp-0038
title: worktree を docker で検証すると source-hygiene が構造的に落ちる（.git が解決できない）
status: open
severity: P2
origin: imp-0035 の検証（2026-08-15・番頭が env.verify で実測）
refs:
  - tests/acceptance/source-hygiene.spec.ts:33
  - meta/environments.yaml（test プロファイル）
---

## 何が起きるか

worktree（例 `/home/ubuntu/worktrees/github.com/tjst-t/banto/kobo-realign-3`）を
`env.verify` の test プロファイル（docker）に掛けると、`npm test` が必ず 1 件落ちる。

```
test at tests/acceptance/source-hygiene.spec.ts:1:903
✖ 追跡しているテキストファイルに NUL が無い（あると grep から丸ごと消える）
  Error: Command failed: git ls-files -z
  fatal: not a git repository: (null)
```

worktree の `.git` は「本体のリポジトリを指すファイル」なので、コンテナに `/app` だけを
マウントすると外への参照が解決できず、`git ls-files` が使えない。
**変更内容とは無関係に落ちる**ので、番頭が docker で検証するたびに「失敗 1 件」を毎回
読み飛ばす判断を迫られる——I1 の観点で、機構が返す事実に恒常的なノイズが混ざっている。

## 直し方の候補（未決）

- (a) 試験の側：`git` が使えないときは **skip ではなく、ファイル走査に切り替えて同じことを確かめる**
  （NUL の検査自体は git を必要としない。追跡外のファイルを拾わない工夫だけ要る）
- (b) 環境の側：test プロファイルで本体リポジトリの `.git` も読める形にマウントする
- (c) 試験の側：`git` が無ければ skip する（**弱い**。docker では永久に検査されなくなる）

現時点では (a) を推す。検査の中身を落とさずにノイズだけ消えるため。

## 影響

- 番頭が docker で検証するたびに、失敗 1 件を「既知」と判断して読み飛ばす必要がある
- 判断を人（番頭）が毎回やるので、いつか本物の失敗を一緒に読み飛ばす

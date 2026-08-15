---
id: imp-0023
kind: improvement
status: open
created: 2026-08-14
refs: [inc-0032, inc-0034]
---

# 検証環境が作業ツリーに root 所有のファイルを残し、あとで掃除できなくなる

## 何が起きるか

検証環境（docker ドライバ）は作業ツリーを bind mount して、**コンテナ内の root**として
走る。その中で `npm ci` などを打つと、`node_modules` 配下に **root 所有のディレクトリ**が
作られる。ホスト側の職人は非 root なので、**あとからそれを消せない**。

2026-08-14 の作業ツリー棚卸しで実際に詰まった。`git worktree remove` が
`Permission denied` で失敗し、**今回の掃除だけで5ディレクトリ**が該当した。

```
drwxr-xr-x root root .../node_modules/...
```

`sudo` はこのホストでは `no new privileges` で完全に塞がっているため、
**正規の手段が無い**。職人は最終的に、既存の root 起動コンテナを使って
`docker run --rm -v <dir>:/target docker-test:latest rm -rf ...` で消した——
つまり **「root で作ったものを root で消す」ために、わざわざコンテナを立て直した**。

## なぜ問題か

- **掃除のたびに詰まる。** 作業ツリーは1本あたり 1〜2GB あり（今回 16G → 6.3G）、
  放置すると増え続けるのに、消すのに毎回この迂回が要る。
- **迂回の方が危ない。** `docker run --rm -v <dir>:/target ... rm -rf` は、
  マウント先を書き間違えたときの被害が大きい。掃除のために危険な道具を
  常用させる形になっている。
- **気づきにくい。** `git worktree remove` の `Permission denied` は
  「git の問題」に見えるが、実際は検証環境の副作用だ。

## 直し方（案）

いずれも「コンテナが作業ツリーに root で書き込まない」ことを狙う。

1. **`node_modules` を名前付きボリュームに隔離する。** kobo-onboarding の SKILL には
   既に「`npm ci` の置き先（`/app/node_modules`）は compose でボリュームにしろ」と
   書いてある——**banto 自身の検証環境がそれに従っていない**。これが本命。
   ボリュームの中なら、作業ツリーには root 所有のものが残らない。
2. **コンテナをホストの uid で走らせる**（`--user $(id -u):$(id -g)`）。
   ただしイメージ側が root 前提だと別の問題が出るので、1の方が素直。
3. どうしても残るなら、**環境を畳むときに機構の側で後始末する**。
   掃除の責任を、作った側（検証環境）に持たせる。

## 補足

「テストが git を呼ぶと `detected dubious ownership` で止まる」（SKILL に既出）のも、
根は同じ**所有者の食い違い**だ。個別に対処するより、
**bind mount した作業ツリーにコンテナが書かない**という原則に寄せた方がよい。

## 再発 2026-08-15（さらに悪い形で残る／掃除の迂回も塞がった）

「モバイルの自動フォーカス」の枝で、レビュー用に切った作業ツリー
`/home/ubuntu/worktrees/github.com/tjst-t/banto/mobile-no-autofocus` が同じ穴を踏んだ。
今回は**中途半端な残骸**になっている。

- `env.verify`（docker / `test`）を2回回したあと、
  `packages/banto-web/node_modules/.vite/deps/` 配下に **root 所有のファイルが 325 個**残った
- `git worktree remove` は「①管理エントリを外す → ②ディレクトリを消す」の順で動くらしく、
  **①だけ済んで②が Permission denied で止まった**。結果、
  `git worktree list` からは消えているのに**ディスク上には 35M・544ファイルが残る**
  （中の `.git` は、もう存在しない gitdir を指す宙ぶらりん）
- **追跡ファイルは②の途中まで消えている**。`meta/environments.yaml` も無くなったため、
  imp-0023 の従来の迂回（そのパスに検証環境を立てて root で `rm -rf`）**すら使えない**
  ——`env.verify` は「このリポジトリには検証環境の定義がない」で断る

つまりこの穴は「掃除が面倒」ではなく、**掃除する手立てが残らない状態を作る**ところまで来ている。
上の案1（`node_modules` をボリュームに隔離）を早く入れたい。

残骸そのものは、PO のホスト権限（root）でなければ消せない。

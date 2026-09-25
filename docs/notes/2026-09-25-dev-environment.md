# 開発の自由度と閉じ込め——実測と選択肢（2026-09-25）

ユーザー：「閉じ込めが厳しすぎて開発もまともにできなそう。開発ごとにいろんなツールを入れて開発したいが、
その仕組みができていない。Docker を使う？ セキュリティと開発の自由度を両立したい」。
きっかけ：サブエージェント（OpenCode）に Rust の Hello World を頼んだら、`cargo build` が
`/usr/libexec/gcc/x86_64-linux-gnu/13/collect2` の `Permission denied` で止まった。

**このノートは実測と選択肢の記録。まだ何も決めていない。**

## 実測1：ビルドが止まる理由（Shell と同じ `exec` の閉じ込め、`/tmp/ll-probe/probe.mjs`）

許可リストは PATH から組む（v4-security.md「許可リストの組み方」）。実行を許すのは PATH の
ディレクトリと git の下請けの置き場だけで、兄弟の `lib`・`libexec`・`share` は読み取りだけ。

| | 結果 |
|---|---|
| `cargo build`（`TMPDIR` は根の中） | 失敗——リンクで gcc の下請け（`/usr/libexec/gcc/…/collect2`）を実行できない |
| `cc a.c` | 失敗——`cc1`（同じく `/usr/libexec`）を実行できない |
| `/usr/libexec` に実行を足すと `cargo build` | **通る** |
| 同じく `cc a.c` | まだ失敗——`/usr/include/stdc-predef.h` が読めない（`/usr/include` が許可に無い） |
| `python3 -m venv` | 通る |

**言語の道具はそれぞれ別の置き場を持つ**（`/usr/libexec`・`/usr/include`・`/usr/lib/jvm`・
`/usr/lib/rustlib`・`~/.rustup`…）。PATH から組む最小の許可リストでは、道具ごとに穴が見つかる。
しかも**閉じ込めの中では root になれないので、`apt install` のような道具の追加はそもそもできない**
（Project の中に入れられるもの——npm・venv・cargo のホームを根の中に向けたもの——だけ）。

## 実測2：閉じ込めを抜けられる口がある（`/tmp/ll-probe/sock.mjs`・`escape.mjs`）

Landlock（この機械は kernel 6.8・ABI 4）は、**名前付きの UNIX ソケットへの接続を縛らない**
（v4-security.md の表で「ソケット：明示的に制限できない」としていたが、その帰結を見ていなかった）。

| 閉じ込めの中から | 結果 |
|---|---|
| `~/.claude/.credentials.json` を直接開く | 開けない（Landlock が効いている） |
| `/var/run/docker.sock` に HTTP で `/version` | **200**——Docker の API に届く。このユーザーは `docker` グループにいるので、コンテナを作ってホストの `/` をマウントできる＝root 相当（コンテナは作っていない） |
| `systemd-run --user` で、ユーザーの systemd（`/run/user/1000/bus`）にコマンドを頼む | **閉じ込めの外で走り、認証情報のファイルを開けた**（中身は読んでいない） |

`test -r` では「読めた」と出たが、`access(2)` は Landlock を通らない——開いて確かめた（測り方の訂正）。

**Shell とサブエージェントのどちらの閉じ込めも、AI が書いたコマンドなら抜けられる。**
（前からある穴で、今日の変更によるものではない。）

## 選択肢

1. **Landlock の許可を広げる**（`/usr` 全体などシステムの置き場に読み取り＋実行）。システムのファイルは
   秘密ではないので、守る意味はほぼ変わらない。ビルドは通るようになる。**ただし道具は入れられない**
   （root になれない）し、ソケットの穴は残る
2. **Project ごとにコンテナを作り、AI のコマンドはその中で走らせる**（仕様で未決のまま置いてある
   Environment Module——v4-modules.md §4・§5-10）。名前のある型：**Dev Containers**
   （`devcontainer.json`、Codespaces・Gitpod・DevPod・Coder が使う標準。参照実装は
   `@devcontainers/cli`）。コンテナの中では root なので道具を自由に入れられ、壊してもホストに響かない。
   道具の入れ方は `devcontainer.json`（image・features・postCreateCommand）に書くので、再現でき、人の
   VS Code とも共有できる。**docker.sock もユーザーの D-Bus もホームもコンテナに入れない**ので、
   実測2の口がそもそも無い
3. **ソケットの穴だけを先に塞ぐ**（1・2 のどちらを選んでも、ホストで閉じ込めて走らせるものには要る）。
   候補：seccomp で `socket(AF_UNIX)` を断る（`socketpair` は通す）／banto を docker グループに
   いない専用ユーザーで走らせる。どちらも壊れるものを測ってから

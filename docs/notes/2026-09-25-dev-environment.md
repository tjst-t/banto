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

## 方向の決定と試作（2026-09-25、ユーザー「その方向で」「LXD と Incus は？」→ Incus）

**方向（ユーザーと合意）**：Landlock はやめ、仕切りを2つにする——**banto 本体**（会話の本体＝Runner・
Claude のログイン・Vault・設定。AI に渡してはいけないものだけ）と、**Project ごとのシステムコンテナ**
（それ以外の Project のもの全部：ファイル・Shell・FileSystem・サブエージェント・Project の Module・入れた道具）。
経緯：

- 最初は「AI のコマンドとサブエージェントだけコンテナ、Module はホストで Landlock」を提案したが、
  ユーザーが「複雑。Project 単位のものは全部コンテナにまとめたほうがシンプル。一般的に使われているものがいい。
  システムコンテナとか」と返した。**仕切りを2つにする形**に改めた
- 会話の本体を外に残す理由：コンテナは「AI が root で何でもできる場所」になる——中に置いたものは全部
  AI が読めるものとして扱う。本物の Claude ログインは中に置けない。会話の本体は自分ではコマンドを
  実行しない（組み込みの Bash 等は切ってある——`adapter.ts` の `tools: RUNNER_BUILTIN_TOOLS`）
- **帰結**：コンテナの中では Module の名乗り（中継の合言葉）も AI が読める。中継の承認は
  「Project・呼び出し元・宛先・種別・名前」の単位（`grantKey`、alias は入らない）なので、なりすましで
  一度許した道具からどの鍵でも引き出せる。**コンテナから来たものは「その Project の AI」と同じに扱い、
  鍵の値は名前ごとに人に聞く**形に変える必要がある（未実装）
- Docker ではなくシステムコンテナ：中の root がホストで一般ユーザーになる（Docker は既定でホストの root）、
  入れた道具が残る、systemd がそのまま使える、中で Docker を動かせる、同じ操作で VM に上げられる。
  代償は Docker ほど一般的でないことと Linux 限定（Landlock も Linux 限定だった）
- **Incus を選んだ**（LXD ではなく）：普通の apt パッケージ（snap の自動更新・閉じ込めが無い）、
  Ubuntu の universe に 6.0 LTS がある、images.linuxcontainers.org の多くのディストリビューションが使える
  （LXD は 2024 年から使えない）、コミュニティ運営・Apache 2.0。LXD 5 系からの分岐で操作はほぼ同じ

**私の誤り**：システムコンテナが使えるか調べようと `lxc version` を打ったら、Ubuntu の `lxd-installer` が
**LXD の snap を自動で入れた**。ユーザーに報告し、Incus を選んだので消した（`snap remove --purge lxd`）。
**`lxc` は打たない**（入っていなければ入れにいく）。

### ホストに加えた変更（すべてユーザーの許可のうえ）

1. LXD（snap）を削除
2. `apt install incus`（Ubuntu 公式、13 パッケージ。qemu は入れていない）
3. `incus admin init --minimal`（置き場 `default`＝`dir`、ブリッジ `incusbr0`）。`incus-user` が
   `incusbr-1000` を作った
4. ユーザー `ubuntu` を `incus` グループへ（`incus-admin` ではない）
5. `/etc/subuid`・`/etc/subgid` に `root:1000:1`（控え：`*.bak-2026-09-25`）
6. 試作のコンテナ `poc9`（区画 `user-1000`）と `/home/ubuntu/poc9-project`

**止められた変更**：`DOCKER-USER` に Incus のブリッジの許可を足す操作（ファイアウォール）は、自動モードの
安全装置に止められた。**コンテナは外に出られない**ままで、中での `apt install` とビルドは未計測。

### 試作の結果

`poc/09-project-container/README.md`。要点：起動 0.19 秒・コマンド1回 50 ms・ファイルの持ち主は両方向で
揃う・Module を中で起こしてホストから MCP で話せる・中のエージェントがホストの Claude ログイン中継を使える
（中継はブリッジ側で待ち受ける）・前回の抜け道とホストの秘密は中に存在しない。
**残る観察**：ホストで 0.0.0.0 に待ち受けているサービス（banto の API など）にはコンテナから届く。

### 試作の続き（外向きの通信が通ったあと）

ユーザーが `DOCKER-USER` に `incusbr-1000` の許可を足した（再起動・Docker の再起動で消える。恒久化は未決）。

- 中で root として `apt install build-essential rustc cargo python3-venv`：50 秒
- uid 1000 で Project の中：`cargo build`（247 ms）・`cc`・venv に `pip install requests`、すべて動く。できたファイルは
  ホスト側でも uid 1000
- **中で Docker は動かなかった**：`docker.io` は入るが、コンテナの起動で `open sysctl … reopen fd 8: permission denied`。
  中の runc 1.3.4 と Incus 6.0.0（Ubuntu 版）の組み合わせの問題と見られる。システムコンテナを勧めた理由の1つ
  「中で Docker を動かせる」は、**いまのこの機械では成り立っていない**——候補は新しい Incus か、Docker が要る
  Project だけ VM

### 中で Docker が動かない原因（2026-09-25、ユーザー「単なる権限の話じゃない？」）

私は測る前に「Incus の版の問題」と決めつけて、新しい Incus を入れる案を出していた（規則1）。測り直した：

- ホストの AppArmor に拒否の記録は無かった。コンテナの中で同じ sysctl を手で書くと、同じ netns・新しい netns・
  新しい proc のどれでも通る。`--network host`（Docker がこの sysctl を書かない）なら Docker は中で動く
- Incus のプロファイルは記録しない拒否（`deny`）を使う。AppArmor を一時的に `noquiet` にして捕まえた：
  `operation="open" name="/sys/net/ipv4/ip_unprivileged_port_start" comm="runc:[2:INIT]" requested_mask="w"`
  ——**権限（Incus が生成する AppArmor のプロファイル）が原因**。runc は CVE-2025-52881 の修正で `/proc` を
  付け直してから fd で開き直すので、AppArmor にはパスが `/sys/…` に見え、`deny /sys/[^fdck]*{,/**} wklx,` に当たる
  （runc の issue #4968、Ubuntu の LP#2131008 と同じ現象）
- **設定で許可を足すことはできない**：AppArmor の `deny` は許可の規則では上書きできない。権限を絞った区画では
  `raw.lxc` 等の低い層の設定も禁止。残る手は (1) 上流で直った Incus（PR #2624、入れ子を許したコンテナでは
  `/proc`・`/sys` の保護を外す——入れ子を許せば、コンテナは自分で `/proc`・`/sys` を付けられるので、その保護は
  もともと効いていない、という理由。6.19・6.0.6 LTS）、(2) コンテナの AppArmor を丸ごと外す（上流の直し方より
  広く弱める）、(3) 中の runc を古くする（脱出の脆弱性が戻る）。Ubuntu の incus 6.0.0-1ubuntu0.3 には (1) が
  入っていない。LXD の snap（5.21.5 以降）は直っている

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

### Incus を 6.0.6 LTS に上げた（2026-09-25、ユーザー「1で」）

- Zabbly の `lts-6.0` を足した（鍵の指紋 `4EFC590696CB15B87C73A3AD82CC8797C838DCFD` を公式の値と照合、
  `/etc/apt/keyrings/zabbly.asc`・`/etc/apt/sources.list.d/zabbly-incus-lts-6.0.sources`）。推奨パッケージを入れると
  VM の画面用の音声・映像ライブラリまで 70 近く付くので、`--no-install-recommends` で入れた。6.0.0 → 6.0.6、
  既存のコンテナはそのまま
- **中の Docker が動いた**（既定のネットワーク・中から外へ・port 公開）。入れ子を許したコンテナでだけ `/proc`・`/sys` の
  保護規則が消え、許していないコンテナには残る——**入れ子は Docker を使う Project だけに許す**
- 上げた直後の1回だけ `incus restart` が5分以上返らなかった（再現せず）。banto は停止を待ちすぎない（上限→強制停止）

### 外向き通信の許可を永続化する（2026-09-25、ユーザー「永続化する」）

Docker が起動するたびに `DOCKER-USER` へ Incus のブリッジ（`incusbr+`＝incusbr で始まる全部）の許可を足す
systemd の drop-in にした（`ExecStartPost`、何度実行しても同じ結果）。ファイルは `~/banto-host-setup/`
（`incus-docker-forward.sh`→`/usr/local/sbin/`、`incus-forward.conf`→`/etc/systemd/system/docker.service.d/`）。
**入れる操作は自動モードの安全装置に止められた**のでユーザーに頼んだ。Docker 本体は再起動しない（動いている
コンテナを止めないため）——今の規則はユーザーが手で足したものが効いていて、次に Docker が起動したときから drop-in が効く。

### 仕様を書き換えた（2026-09-25）

- `v4-security.md`：§1 に「閉じ込めは Project ごとのシステムコンテナで行う」を置き、Landlock の節は §2「移行が
  終わるまでの閉じ込め（廃止を決定）」にまとめた——**今のコードを触る人のために、移行が済むまで残す**。
  中継の表（§3）に「コンテナの中から値を返す口を呼ぶ（鍵の名前ごとに聞く）」を足し、`/proc`・子の env の行に
  「コンテナの中では効かない」と注記した
- `v4-modules.md` §2.1：「Shell は自分で閉じ込める（Landlock）」（2026-09-02）を置き換えた。**コンテナは
  Environment Module ではなく host が用意する場所**なので、「必須 Module が任意 Module に依存しない」という
  当時の理由は保たれる
- `v4-architecture.md`：採用技術の表・サブエージェントの閉じ込め・§10 item 31（未決の一覧は security §1 にだけ置く）
- 書いている途中で、**Claude の中継の待ち受け先を「決定」と「未決」の両方に書いていた**のに気づいて直した
  （試作で 127.0.0.1 は届かず proxy デバイスも使えないと測ってあるので、待ち受け先は決定。未決はどの部品が持つか）
- 本実装の段取りは tasks.json の `container-*`（前提の確認→作る・止める→E2E→Module を中で起こす→鍵の名前ごとの
  承認→サブエージェント→入れ子の設定→Landlock を外す）

### 残っていた2つを決めた（2026-09-25、ユーザー「どちらもあなたの案で OK」）

- Claude のログインの中継は、banto 全体の `subagent-settings` が持つ（host で動く同梱のコード、鍵の設定もここ）
- 外から足した banto 全体の Module は、banto 全体用のコンテナ1台で動かす——**banto 本体で動くのは banto 自身の
  コードだけ**、という1本の規則になる

### 本実装：コンテナの部品（`@banto/container`）で踏んだこと（2026-09-25）

- **`incus init` が返らなかった原因は標準入力だった**。`incus init` は標準入力がターミナルでないとき、そこから
  設定（YAML）を読む——開いたままだと入力の終わりを待ち続ける（実測：開いたまま＝時間切れ、空＝4 秒）。
  **その前に立てた仮説（権限を絞った口 `incus-user` がアイドルで終わる瞬間の競合）は誤りだった**：最初に止まった
  時刻がデーモンの終了と2秒差だったのを根拠にしたが、狙っても再現せず（8 回中 0 回）、直前に使っていても止まった。
  その仮説のために足した「`incus monitor` を持ち続ける」仕組みは、理由が無くなったので消した。**直したのは
  「標準入力を必ず閉じる」の1点**、時間の上限は保険として残す（規則1——測る前に犯人を決めない、をまた破った）
- **`incus query` は区画を付けない**——`default` を見に行って「権限が無い」と断られる。`incus project get-current`
  で引いて付ける
- **`incus exec --cwd` は、入れないと黙って `/` で動かす**。移るのはユーザーを切り替える前で、中の root はホストの
  グループが中に対応していないフォルダに入れない。ユーザーを切り替えたあとに自分で `cd` し、入れなければ 126 で止める
- **`sg incus` で起こすと主グループが incus に変わる**——作るファイルのグループが中に対応せず、`process.getgid()` も
  985 を返して `raw.idmap` に使うと断られた。**`sudo -u <user>` で起こせば主グループはそのまま、incus も持てる**。
  gid はユーザーの登録情報（`os.userInfo().gid`）から取る

### 置き場を btrfs にした（2026-09-25、実測で決めた）

E2E は Project ごとにコンテナを1台作る（100 台近く）。`dir` は毎回 3.4 秒・1台 602MB の丸写しで、数十 GB に
なる。btrfs の置き場（ループファイル）を試すと、1台目はイメージの展開で 4.5 秒、2台目から 0.2 秒、3台と
イメージで 627MB。**banto 専用の btrfs の置き場 `banto`（50GiB の枠、実際に使った分だけ）を前提にした**——
前提の確認で名指しする。

### core への配線と E2E（2026-09-25）

- 設定 `projectContainers`（移行中のスイッチ）で、Project の Module を Project のコンテナで起こす。無ければ今までどおり
  Landlock。E2E は `BANTO_E2E_CONTAINERS=1` でコンテナの形になる（置き場をホームの下へ、`TMPDIR` もそこへ）
- **踏んだこと**：
  - Module が並んで起きて、同じコンテナへ同時に装置を足し、Incus に `ETag doesn't match` で断られた——コンテナごとに
    書き換えを1本ずつ通す
  - 元の Ubuntu のイメージには git も無い——**banto の土台イメージ**（git・curl・証明書・ssh・unzip・xz と、ホストの
    node 一式）を一度だけ作る（64 秒）。以後は btrfs の写しで一瞬
  - 起こした直後は経路が無い（DHCP 前）——host のアドレスを引くのは経路ができるまで待つ
  - **受信箱の「同じ知らせは1件」が同時の2件をすり抜けていた**（前からあった競合）——コンテナを用意する待ちが入り、
    会話と画面が同時に同じ Module を起こして同じ失敗を2か所で受けるようになって表に出た。書き込み中の鍵も1件に数える
  - Landlock の形では Module がホストの環境を丸ごと受け継いでいた。コンテナでは決めた変数しか渡さない（良い性質）——
    E2E の偽エージェントの印も届かなくなった（サブエージェントの作業で扱う）
  - Shell の「閉じ込めで弾かれた」説明は、コンテナでは「中に無い」になる（弾かれるのではなく存在しない）
- Landlock の形のフル E2E：129/130（既知の module-settings-canvas:242 だけ）——スイッチ無しの動きは変わらない

### 残りを全部入れた（2026-09-25、ユーザー「1〜4を全部対応して、デプロイして」）

1. **鍵の名前ごとの承認**：コンテナの中の呼び手（合言葉に `inContainer` の印）が値を返す口を呼ぶとき、承認の鍵に
   宛先が名乗った識別子（`dev.banto/auditArgs`）を足す。**識別子が空でも「コンテナの形」の鍵にする**——本体の頃の
   承認を黙って引き継がない。`lookupAlias` は識別子を名乗らないので Project ごとに1回のまま、`resolveAlias` は鍵ごと
2. **サブエージェント**：Module ごとコンテナへ。Claude の中継は `subagent-settings`（host）へ移し、中継の MCP の口
   （`openClaudeLoginProxy`／`closeClaudeLoginProxy`）で1回ごとに開く。待ち受けはブリッジの host 側のアドレスで、
   **自分のものでないアドレスを渡されたら開かない**（呼び手がアドレスを選べるので）。閉じ忘れは12時間で閉じる
3. **中で Docker を使う**・**全体用のコンテナ**・**Landlock を消す**
   - 全体用のコンテナの名前は置き場（dataDir）から作る（同じ機械の別の banto・E2E と混ざらない）
   - **どこで動くかを1箇所にした**（`modulePlacement`）。起こす処理と画面の「サンドボックス」列の両方がここを引く。
     最初は画面を宣言の `confinement` から出そうとしたが、それはもう置き場所を決めていない——**写しを作ると食い違う**
     （規則3）。画面の列は「Project のコンテナ／全体のコンテナ／banto 本体」
   - **却下した案**：`secretsAllowedFor` に「置き場所が host かつ第三者なら断る」を残す——host に置かれる第三者は
     構造上いないので、決して真にならない検査になる。書いてあると守っているように読める（規則13 の裏）。消して、
     理由をコメントに残した
   - 移行中のスイッチ（設定 `projectContainers`・`BANTO_E2E_CONTAINERS`）は外した
4. **E2E**：3つに分けたフルで 43＋44＋44 件すべて通過。**前から落ちていた module-settings-canvas:242 は、開発用
   Infisical の `.identity.json` がこの作業ツリーに無かったのが原因**（本体の作業ツリーにはある。無いと
   `start-core.ts` が警告だけ出して進み、Vault の一覧から Infisical が消える）——置いたら通った
   - **片づけの競合**：終わりの片づけ（globalTeardown）は webServer を止める**前**に走るので、host がまだコンテナを
     触っていると `Instance is busy` で消せない。次の回の片づけが「置き場が消えた回」しか見ていなかったので、
     置き場が残る限り（1日）動いたまま残っていた。**印の pid が生きていない回のものも消す**ようにした
   - `landlock-guard.spec.ts` は `wide-root.spec.ts` に改名（中身は広い根の警告）
- **気づいたが触っていないもの**（規則7）：フロントの `npm run lint` が前から赤い（`docs/tasks.json` frontend-lint-red）。
  宣言の `confinement` の名前と中身（container-confinement-field）
- **turn-reattach が1回落ちた**（最後のフル、44 件中1件）。落ちた回はターンがそもそも始まっていなかった——画面は送る前に
  Module の用意（画面つき tool の一覧、上限5秒）を待つ。**Project のコンテナが初めて起きる回はこれが 2.8 秒を越え**、
  「Enter から 2.5 秒で開き直す」決め打ちの試験が、送る前に開き直していた。host に「走っているか」を聞いてから開き直す
  ように直した（新しいコンテナの形で3回とも通過）。**製品側に残ること**：新しい Project の最初の1通は、コンテナが
  起きるまで（約3秒）送られない。その間に開き直すと、打った文は消える（前からある形だが、窓が 0.2 秒から約3秒に広がった）
- 最後のフル：43＋44＋44 件すべて通過

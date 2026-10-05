# 新しいホストへのインストール用スクリプト（2026-10-04〜）

決まったことは Memory（「新しいホストへのインストール用スクリプト」「インストール用スクリプトの事実と試し方」）。
このノートは設計の下書きと、実装で分かったことを追記する。

## ユーザーの要望

- まっさらなホストで1行（`curl -fsSL https://raw.githubusercontent.com/tjst-t/banto/release/install.sh | bash -s -- --domain <名前> [--cloudflare-token …]`）
- Incus・Caddy も入れて設定まで。最後にログインのリンク（`scripts/login-link.mjs`）を出す
- Cloudflare のトークンを渡せば HTTPS（Let's Encrypt・DNS-01）。後から打ち直して HTTPS 化もできる
- 決めた値は覚え、打ち直しで変えられる（渡さなければ前の値のまま）

## 今の host（手本、2026-10-04 に人が貼ったもの）

- `banto-host.service`：User=ubuntu、WorkingDirectory=REL/banto、`Environment=NODE_ENV=production LANG=C.UTF-8 PATH=…`、
  `ExecStart=/usr/local/bin/node packages/core/dist/cli.js`、KillMode=mixed、Restart=always、RestartSec=3、
  LimitNOFILE=1048576、StandardOutput=append:~/banto-host.log、After=network-online.target incus.socket incus.service、
  StartLimitIntervalSec=60/Burst=5。drop-in で OOMScoreAdjust=-800
- `banto-frontend.service`：WorkingDirectory=REL/banto/apps/frontend、`ExecStart=/usr/local/bin/npm run start`（= next start -H 0.0.0.0 -p 4175）、
  ログ ~/banto-frontend.log、ほかは同じ
- Caddy：`/usr/local/bin/caddy`（caddyserver.com の custom build、`github.com/caddy-dns/cloudflare` 入り）を drop-in で
  差し替え（`ExecStart=/usr/local/bin/caddy run --config /etc/caddy/Caddyfile`、`--environ` は付けない＝トークンが journal に出る）、
  `EnvironmentFile=/etc/caddy/cloudflare.env`（root:caddy 0640）
- Caddyfile の banto の部分：
  - `<名前>`：`/api/*` → 127.0.0.1:4737、ほか → 127.0.0.1:4175（同じオリジン）
  - `sandbox.<名前>` → 127.0.0.1:4176（画面とは別オリジンが必須）
  - `*.<名前>`：`respond 404`（Publish の道は publish-caddy が admin API でこの前に差し込む）
  - TLS は `tls { dns cloudflare {env.CLOUDFLARE_API_TOKEN} }`
- config.json：`publicUrl: https://<名前>`、`sandboxPublicUrl: https://sandbox.<名前>`、`allowedEmbedderOrigins` に `https://<名前>`
- Publish（publish-caddy）の設定は データ置き場の Module の `settings.json`（baseDomain・adminUrl・reach）

## 気をつけること（調べて分かったこと）

- **core は 0.0.0.0 で待ち受け、Project のコンテナは Incus のブリッジ越しに core の `/relay`（Claude の中継）へ来る**
  （`cli.ts` の hostRelayUrl = `http://<hostAddress>:<port>/relay`）。**4737 を 127.0.0.1 に絞るとコンテナから
  Claude が使えなくなる**。外（LAN）から 4737・4176・4175 を直に叩かせないのは、待ち受けを絞るのではなく
  ファイアウォール（nftables の banto 専用の表：lo と incusbr* 以外からの 4737/4176/4175 を落とす）で行う案
- Incus：24.04 は Zabbly `lts-6.0`、26.04 は Zabbly `stable`（lts-6.0 に resolute が無い・Ubuntu の 6.0.5 は前提 6.0.6 に足りない）。
  Zabbly の鍵の指紋 `4EFC590696CB15B87C73A3AD82CC8797C838DCFD` を照合。`--no-install-recommends`、`btrfs-progs` を別に入れる
- banto の前提（`packages/container/src/prereqs.ts`、`node packages/container/dist/doctor.js` で確かめる）：
  Incus 6.0.6+／6.19+、ユーザーが `incus` グループ（起動は systemd の User= でグループを引き直す）、
  `/etc/subuid`・`/etc/subgid` に `root:<uid>:1`（足したら incus を再起動）、btrfs の置き場 `banto`
- 置き場 `banto`：`/` が btrfs ならその中のフォルダを source、違えば `size=50GiB` のループファイル（ディスクの空きを見て小さくする）
- `incus init`/`launch` は標準入力を閉じる（`</dev/null`）。閉じないと待ち続ける
- コンテナの土台はホストの node の配布一式（`<prefix>/bin/node`・`bin/npm`・`lib/node_modules/npm`）を写して作る——
  **npm つきの公式の tarball を /usr/local に**入れる（apt の node は不可）
- host の守り（`docs/runbooks/host-resource-protection.md`）：system.slice の CPUWeight=1000・MemoryLow=2G、banto の unit に OOMScoreAdjust=-800
- 稼働中の版の置き場は「設定から最新版に更新」の Fork と共通にする相談中（`versions/<commit>` と `current` の symlink、
  `banto-update@.service`、polkit、`scripts/update.mjs`）。決まるまでは `~/.local/share/banto-release` に clone する形で作り、
  「上げる」段は1つの関数に閉じ込めて差し替えやすくする

## 更新の形（Fork「設定から最新版に更新」で決定・2026-10-04、fork/self-update 377a2bb8）

install.sh はこれに合わせる（「上げる」段の差し替え先）：
- `<releaseDir>`（既定 ~/.local/share/banto-release）の下に `repo.git`（bare、origin は GitHub）・`versions/<commit の頭12>`（repo.git の worktree、detached、build 済み）・`current`・`previous` の symlink
- `banto/scripts/update.mjs`：いつも current の版のもの。初回は取ってきた版のものを `--first`（待たない・戻す先なし・起こし直さない——起こすのは install.sh）。`--commit`・`--now`・`--dry-run`
- `banto/scripts/setup-update.sh`：polkit・`banto-update.service`・polkit の規則・古い形からの移行・unit の `<releaseDir>/` → `<releaseDir>/current/` の置き換え。install.sh はこれを呼ぶ。banto-host・banto-frontend の unit は install.sh が作り、ExecStart・WorkingDirectory は current を通す
- 起きたの判定：120秒以内に `GET http://127.0.0.1:<port>/api/admin/update`（機械の合言葉）の current.commit が新しい commit＋画面の口が答える
- 2回目以降の install.sh の「上げる」は current の update.mjs を呼ぶ（待って起こし直すのも update.mjs）
- 改訂：unit は `banto-update.service` 1本（template ではない）。polkit は banto-update.service の start と banto-host・banto-frontend の restart だけ。root の段は無い
- fork/self-update に入った（f5f5ea52 update.mjs、2e596626 setup-update.sh、レビュー前）。main に入るのを待って取り込む。setup-update.sh は sudo 経由で動き root 直は断る、1回目に REL を versions の形へ移すので 2回目からは `<releaseDir>/current/banto/scripts/setup-update.sh` を呼ぶ。update.mjs は config の `uiPort`（無ければ 4175）で画面の口を確かめる

### main に入った形（f408e782、2026-10-04 12:00、Fork「設定から最新版に更新」からの知らせ）
- unit は `update.mjs --from-request` で起こす。初回は `--first`
- setup-update.sh は root の段（polkitd・banto-update.service・polkit・pkcheck）を先に済ませ、置き場を動かすのは後。打ち直しで続きから。**置き場の外に写してから打つ**（1回目は置き場そのものを動かす）
- 画面のポート：setup-update.sh が banto-frontend.service の起動の仕方から読んで banto-update.service に `BANTO_UPDATE_UI_URL` を書く。読めないと止まるので install.sh は `BANTO_UI_URL=http://127.0.0.1:<port>/` を渡す
- 起きた判定：unit が failed・inactive・auto-restart・NRestarts 増 → すぐ戻す。起動中は最大600秒。HTTP は GET /api/admin/update の current.commit と画面の口
- 古い版はコンテナの装置が指していれば消さない
- banto-update.service：Nice=10・IOSchedulingClass=idle・CPUWeight=20。polkit は banto-update の start・stop、banto-host・banto-frontend の restart だけ
- bootstrap config に `releaseDir`（既定 ~/.local/share/banto-release）
- 詳しくは docs/runbooks/release.md D と v4-architecture.md §2.5

### update.mjs の持ち主からの返事（2026-10-04 14:55）
fork/self-update で直して main に入れたら知らせが来る。入ったら install.sh を合わせる：
- `--wait-timeout <分>`（超えたら cancelled）→ 「やめる印」を置く代わりにこれを使う
- 片づけを済ませてから終わりの状態を書く（片づけ中は note「古い版を片づけています」）→ 試験の場の lock 待ちの工夫を見直す
- setup-update.sh `--check`（sudo なし。0＝変えるものなし／1＝あり／2＝root でないと分からない→打つ側に倒す）→ install.sh の unit の中身の写しを消す
- restart-when-idle.mjs は sudo なしで試し、断られたら sudo
- update.mjs のヘッダの写しの一覧に install.sh が足される
- ブランチを選ぶのは見送り（release だけ）
- **main と release に入った（024e52ee、15:08）**。`--check` は polkit の規則を中身でなく「効いているか」で見る（24.04 は rules.d が root:polkitd 750 で読めない）。2 は更新が走っている・unit が無いときだけ。2 なら setup を打つ。終わりの状態の直後に始めた回は最大5秒待つ

## 試験の場（Memory「インストール用スクリプトの事実と試し方」）

この Project のコンテナの中の Incus（`sudo incus`）に、入れ子のシステムコンテナ（`security.nesting=true`、
`security.syscalls.intercept.mknod/setxattr=true`）を立てて、その中で install.sh を流す。3段目なので：
- その中の Incus は AppArmor が使えない → `INCUS_SECURITY_APPARMOR=false` の drop-in（試験の場だけ）
- その中のコンテナには `raw.lxc: lxc.apparmor.profile=unchanged` が要る（2026-10-04 に手で確かめた）。banto のコンテナは
  権限を絞った区画（user-<uid>）に作るので、試験の場では admin で区画に `restricted.containers.lowlevel=allow` を付けて
  その区画の default プロファイルに入れる等の手当てが要る（未確認）
- **これらの手当ては試験の場のスクリプトにだけ置き、install.sh には入れない**

## 実装で分かったこと（2026-10-04）

作ったもの：`install.sh`（リポジトリの直下）・`banto/scripts/install-test/run.sh`（入れ子のシステムコンテナで流す）・
`checks.sh`（中で b〜e・g を見る）・`cloudflare.test.mjs`（Cloudflare の API の偽物）。仕様は `v4-security.md` §1「入れ方」、
人向けは `docs/runbooks/install.md`。

### 試験で踏んだもの（どれも install.sh の不具合だった）

- **`sudo -v` は NOPASSWD でも止まる**：ユーザーが sudo グループ（`%sudo ALL=(ALL:ALL) ALL`）と NOPASSWD の規則の
  両方に当たると、`-v` は**当たる規則が全部 NOPASSWD のとき**しかパスワードを省かない（`verifypw=all`）。クラウドの
  イメージの既定のユーザーがこの形。`sudo true`（コマンドに当たる最後の規則で決まる）にした
- **`… | put_root_file` で「変わったか」が消える**：パイプの右側は別のシェルなので、`FILE_CHANGED=1` が呼んだ側に
  戻らない。Caddy の設定を書き換えたのに reload せず、古い設定のまま動いていた（打ち直しの試験で `http` の転送が
  301 のままだったので気づいた）。`< <(…)` か here-doc で渡す。**名前を変えて打ち直すと Caddy が替わらない**、に
  なるところだった
- **同梱の vault-local は host で `age-keygen`・`sops`・`ssh-keygen`/`ssh-agent` を使う**——人が決めた手順の一覧に
  無かったが、無いと起動のたびに `spawn age-keygen ENOENT` で繋がらない。`age`・`openssh-client` は apt（universe）、
  `sops` は Ubuntu の apt に無いので GitHub の配布物を版（3.13.3）と sha256 で固定して `/usr/local/bin` に入れた。
  一度失敗した vault-local は数回で再試行をやめるので、後から入れても host を起こし直すまで繋がらない
- `cut -c` は日本語をバイトで切る（コミットの題を短くしたら文字化け）
- 打ち直しで止まらずに通っても、**通ったことと中身が変わったことは別**——試験は「Caddy の設定が替わった」を
  ファイルではなく `https://<新しい名前>/` が実際に答えるかで見る

### 試験の側の思い違い（install.sh は正しかった）

- Caddy の `redir … permanent` は 301（308 にした——POST の本文を落とさない。Caddy 自身の自動転送も 308）
- Cookie があっても `X-Banto-Client` が無い要求は「人の要求ではない」として **401**（403 ではない）
- `prepare` が返す `connected` は宣言の名前（`shell`）で、接続名（`shell-<Project>`）ではない
- `ss` の出力の相手側の列に `0.0.0.0:*` が出るので、待ち受けの確かめは4列目だけを見る

### 決めたこと（迷ったもの）

- **覚える場所は `/etc/banto/install.conf`**（`~/.config/banto/install.json` ではなく）：値が1台に1つのもの
  （Caddy・DNS・ファイアウォール・Incus の置き場。口が決まっているので banto は1台に1つ）を決め、root しか書けない
  所に置けば、別のユーザーで打ち直したときに `user=` で気づいて断れる。`source` せず「キー=値」として読む。
  **IP は `--ip` で渡したときだけ覚える**（渡さなければ毎回既定経路から引く——DHCP で変わったら打ち直しで追従する）
- **前の名前は覚えない**：名前を替えたときに `allowedEmbedderOrigins` から外す「前の名前」は、config.json の
  `publicUrl` から導く（規則3）
- **MemoryLow は 4G**（依頼の文は 2G）：`host-resource-protection.md` と仕様 §1 が 2026-10-04 に 2G→4G へ改めている
  ——新しいほうに合わせた。**人に確かめる**
- **Caddy の unit の `EnvironmentFile` は `-` つき**（`EnvironmentFile=-/etc/caddy/cloudflare.env`）：トークン無しの形では
  ファイルが無いので、`-` が無いと Caddy が起きない
- **Caddy の reload は設定が変わったときだけ**：reload は Caddyfile から全体を読み直すので、publish-caddy が admin API で
  足した道が一度消える（publish-caddy は一定の間隔で突き合わせて足し直す）。トークン・unit が変わったときは
  restart（環境変数は reload で読み直されない）
- **http のサイトを明示する**（Caddy の自動の転送に任せない）：内部の CA のときに `http://<名前>/banto-ca.crt` で
  ルート証明書を配る道が要るため。ほかの道は 308 で https へ
- **sandbox は `*.<名前>` のサイトの中に host の一致で置く**——証明書を `*.<名前>` の1枚にするため（Caddyfile で
  `sandbox.<名前>` を別のサイトにすると、それだけの証明書を別に取る）
- **画面の unit は node で next を直に起こす**（`node …/node_modules/next/dist/bin/next start -H 127.0.0.1 -p 4175`）：
  `npm run start` の中身は `-H 0.0.0.0` 固定で、`-- -H 127.0.0.1` を足すと同じ引数が2つ並び、どちらが効くかが
  next の引数の読み方次第になる。package.json は開発・E2E でも使うので変えない（規則7）
- **初回の起動は「上げる」の外**：`upgrade_banto` は取り込み・build・（動いていれば）空いてから起こし直す、まで。
  初めて起こす・止まっていたら起こすのは、doctor のあとの段（前提がそろってから起こすため）
- **build 済みの印は `.git/banto-built-commit`**（作業ツリーに置くと `git status` が汚れ、「手を入れた跡」と区別できない）
- `--cloudflare-token` を渡さず端末があるときは毎回聞く（Enter で飛ばせる）。端末が無ければ聞かずに内部の CA

### 試験の場の手当て（install.sh には入れていない）

- 中の Incus の AppArmor：パッケージを入れる**前**に `incus.service.d/` に drop-in を置いておけば、入ったときから効く
  ——install.sh を段に分けて流す必要は無かった
- 区画の低い層：install.sh の doctor が banto のユーザーとして Incus に初めて繋いだときに `user-<uid>` ができる。
  Project のコンテナは Project を作って Module を起こすまで作られないので、1回目のあとに admin で
  `restricted.containers.lowlevel=allow` と default のプロファイルの `raw.lxc` を入れれば間に合う
- 土台イメージを作るとき、入れ子の中で `cgroup2_devices … Failed to load bpf program` の ERROR がログに出るが、
  コンテナは起き、土台イメージもできた（害は無い）
- Project を作ってから Shell が繋がるまで約 130 秒（初回は土台イメージを作るため。images: から取る・apt・publish）

### 試験の結果（2026-10-04、install.sh は b89d8d48 の版）

`banto/scripts/install-test/run.sh` で、トークン無しの形を流した：

| | 24.04（ユーザー bantotester・uid 1001） | 26.04（ユーザー devops・uid 1001） |
|---|---|---|
| Incus | 6.0.6（Zabbly lts-6.0） | **7.5.1**（Zabbly stable。doctor の版の規則は 6.19 以上で通る） |
| まっさらから1回目 | 286 秒 | 320 秒 |
| Project を作ってから Shell が繋がるまで | 133 秒（土台イメージを作る分を含む） | 146 秒 |
| 結果 | PASS 67・FAIL 0 | PASS 68・FAIL 0（Cloudflare の形の Caddy の設定の確かめを足した分） |

外から 4737・4176・4175 が落ちるのが nftables の表のおかげであることは、表を止めると 200 が返り、入れ直すと
届かなくなることで確かめた（24.04、手で）。

**試していないもの**：Cloudflare のトークンを使う形を本物で（DNS のレコードの部分は偽物の API で、Caddy の設定は
validate まで）・`/var/lib/incus` が btrfs でないホスト（ループファイルの置き場。入れ子の試験の場は / が btrfs で、
ループ装置も使えない）・Docker が入っているホスト（転送の drop-in）・apt の caddy が既にあるホスト（drop-in で
差し替える側）・手で組んだ host（今の banto の host）に流すこと・端末がある形（トークンを聞く・Claude のログインを流す）・
arm64・Claude のログインそのもの（`claude auth login` があることと、ログインしていなければ `auth status` が 1 を返すことまで）

## Fable のレビューを受けて（2026-10-04 の続き）

人の確認：MemoryLow 4G・sops/age/openssh を入れる・publish-caddy の settings.json を先に置く・`/etc/banto/install.conf`
はこのまま（人の返事はまだで、こちらの判断を採った）。

### 直したもの・決めたこと

- **sudo の記憶**：npm ci・build・Claude の installer は、ユーザーの権限で走る「外から取ってきたもの」。前の形は sudo の
  keepalive が回ったまま流していたので、npm の依存の postinstall 等が `sudo -n` で root になれた。いまは
  - root が要る段（apt・Incus・Caddy・unit・nftables・config.json）を先にまとめる
  - build の前に keepalive を止めて `sudo -K`、`setsid --wait` で端末から切り離し、出力はパイプ（`| sed`）に通す
    ——子に端末の装置を渡さない
  - build のあとに root が要る段（doctor・起こす・起こし直す）は `sudo true` で取り直す（パスワードの要る人には2度目を
    聞く。build が要らない打ち直しでは消さないので聞かない）
  - Claude の installer とログインは最後、sudo を消してから
  - **「root が要る段を全部 build の前に」はできない**：起こす・起こし直すは build の後でないと意味が無い。polkit で
    ユーザーに banto の unit の再起動を許す形（fork/self-update の setup-update.sh）が入れば、取り直しを無くせる
  - 試験で分かったこと（パスワードの要る sudo のユーザー・端末の無い形）：記憶を作った直後、同じシェルの
    `sudo -n true` は通り、**`setsid --wait sudo -n true` は通らなかった**（新しいセッションの子は、作った記憶の
    記録に当たらない）。`drop_sudo` のあとは、どちらも通らない。端末のある形は確かめていない
- **Claude の installer**：`https://claude.ai/install.sh` そのものの sha256・署名は公開されていない（2026-10-04 に探した）。
  台本は本体を同じ配布元の manifest.json の sha256 と照合する。ファイルに落としてから流すことで、途中で切れた台本を
  流さないことだけは守れる
- **Caddy の版**：caddyserver.com の download API は `version=` を受けても最新を返す（v2.11.6 を3通りで確かめた）。
  `p=…/caddy/v2@vX` は 400。版の固定は xcaddy で自分で組むしか無く、Go が要るのでやめた。取ってきた版を出し、
  `CADDY_MIN_VERSION`（2.5.0）以上かだけ見る。上げるのは `caddy upgrade`（runbook）
- **Caddy の読み直し**：「毎回 reload」と「admin API の実物と比べる」のうち**比べる**を選んだ。理由：reload すると
  publish-caddy が admin API で足した公開の道が消え、次の突き合わせ（`RECONCILE_INTERVAL_MS` = 15 秒）まで、その公開先は
  `*.<名前>` の受け皿の 404 になる。打ち直しのたびにそれを起こす理由は無い。比べ方は「Caddyfile を `caddy adapt` で
  JSON にしたもの」と「`GET /config/` から `@id` が `banto-publish-` で始まる道を除いたもの」を、キーを並べ替えて
  文字列で比べる。比べられない（admin が unix ソケット・止まっている）ときは違うとみなして読み直す。
  **publish-caddy が読み直しのあと実際に道を張り直すことは、この試験の場では確かめていない**（publish-caddy を入れて
  公開するところまで流していない。根拠はコードの突き合わせの間隔と、無い道を足す処理）
- **Caddy の unit の判定**：前の形は `systemctl cat` に印があるかで「自分の unit」と見ていたので、apt の caddy に drop-in を
  置いた2回目に、drop-in の印を見て `/etc/systemd/system/caddy.service` を丸ごと書いていた。`FragmentPath` と drop-in の
  有無で判定する
- **ファイアウォール**：Incus の持つブリッジ（`managed` で `type: bridge`、全区画）の名前を表に入れる。区画のブリッジは
  doctor が banto のユーザーとして初めて Incus に繋いだときにできるので、doctor のあとにもう一度表を作る。default の
  プロファイルが Incus の持たないブリッジに繋がっていれば警告（人の br0 を表で許すと LAN を許すことになるので、入れない）。
  表が消えていれば打ち直しで入れ直す（前は「unit は動いている・設定は同じ」で何もしなかった）
- **Cloudflare**：作るレコードに comment `banto install.sh` を付ける（直す PATCH では付けない——人が作ったものを自分の
  ものにしない）。名前を替えたら前の名前の `<旧名>`・`*.<旧名>` のうち、印つきでこのホストの IP を向くものだけ消す。
  `--no-cloudflare` は cloudflare.env を消し、`tls_mode=internal` を覚えて以後はトークンを聞かない
- **config.json を真実に**：`port`・`sandboxPort`・`uiPort`・`releaseDir` を書く（名前は fork/self-update の update.mjs が
  読むものに合わせた）。install.sh は書いた値を読み戻し、Caddy・unit・nftables はそれを使う。そのため設定の段を
  Incus より前（Node のすぐ後）に動かした
- **環境変数のトークン**：`CLOUDFLARE_API_TOKEN` は写したらすぐ unset（以後の子——apt・npm・Claude の installer——に渡さない）

### 差し替えのときにやること（fork/self-update が main に入ってから）

`upgrade_banto` を `scripts/update.mjs` に差し替えるときに、次を片づける：

- **unit のパス**：`WorkingDirectory`・`ExecStart` の `$REL/banto` を `$REL/current/banto` に。setup-update.sh も unit の
  中の `<releaseDir>` を `<releaseDir>/current` に書き換えるので、install.sh が打ち直しで古い形に戻さないこと
  （install.sh が unit を作るなら current の形で作り、setup-update.sh の書き換えは「もう current なら何もしない」に頼る）
- **置き場の判定**：いまは `$REL/.git` が無ければ clone し、`$REL` があって clone でなければ止まる。新しい形
  （`repo.git`・`versions/`・`current`）を「入っている」とみなし、古い形（`$REL` そのものが clone）は setup-update.sh の
  移し替えに任せる。古い形の判定と `.git/banto-built-commit` は捨てる
- **`--branch`**：update.mjs が取ってくるブランチをどこで決めるか（config.json か引数か）に合わせ、install.conf の
  `branch` をそこへ渡す（真実を1つに）
- **待ち方の timeout**：いまは `restart-when-idle.mjs --timeout 30`。update.mjs の待ち方（待つ・やめる・すぐ）と上限に合わせる。
  時間切れのときに「前の版のまま」で終わる今の形（RESTART_PENDING）を保つ
- **setup-update.sh の自前の再起動との衝突**：setup-update.sh は unit を書き換えたあと自分で起こし直す。install.sh も
  設定・unit が変わったら起こし直すので、同じ回に2度起こさないよう、どちらが起こすかを1つに決める
- **polkit**：polkitd は入れてある（apt_install）。規則（banto の unit の restart をユーザーに許す）は setup-update.sh が置く。
  入ったら、build のあとの sudo の取り直しを無くせる（起こし直しを polkit で行う）

### 試験の場で変えたこと

- 外から届かないことを「表を消す→外から 200→打ち直し→000」で自動で見る
- `grep -q 'dns cloudflare'`（自分で書いた文字列を自分で探していた恒真）をやめ、`caddy adapt` の JSON の
  `challenges.dns.provider.name == "cloudflare"` を見る
- トークンありの形を、中に立てた偽の Cloudflare（`cloudflare-fake.mjs`、`BANTO_CLOUDFLARE_API` で向ける）で流す。
  DNS のレコードは偽物に作られ、Let's Encrypt は `.test` を受けないので取れず、「まだ取得中」で終わる道を通る
- run のログ・banto-host.log・Caddy の journal に、authToken の値・偽のトークンが無いこと、banto-host.log と Caddy の
  journal に `#banto-login=` が無いことを見る（**run のログにはログインのリンクが出る**——最後の画面に出すと決めたもの
  なので、run のログについては `#banto-login=` を見ない）
- config.json 0600・`~/.config/banto` 0700・install.conf 0644 root:root
- apt の caddy の形（unit の本体が /usr/lib にある）で2回流し、`/etc` に unit を書かないこと
- パスワードの要る sudo のユーザーで、drop_sudo のあとに記憶が使えないこと

### 2回目の試験で見つかったもの（2026-10-04）

- **名前を替える回が途中で止まると、次の回が起こし直さず、前の名前のまま動き続けた**：設定の段（config.json）は
  先に済み、Cloudflare の段で止まった。次の回は config.json を「そのまま」と見て、「この回に変えたら起こし直す」形では
  起こし直さなかった——画面の住所が変わらず、新しい名前でのログインが 403（Origin が違う）・サンドボックスの
  frame-ancestors も前の名前のまま。**起こし直すかは、動いている banto の起きた時刻と、config.json・unit・build の印の
  更新時刻を比べて決める**ようにした（覚えておく値を増やさず、実物から導く）
- 同じ形で、**前の名前を config.json から引くと見失う**（config.json はもう新しい名前）。前の名前は、いま入口に効いている
  `/etc/caddy/banto.d/banto.caddy`（DNS の段が通ってから書く）から引くようにした
- 試験の場の誤り：名前を替える回で偽の Cloudflare の基点（`BANTO_CLOUDFLARE_API`）を渡し忘れ、本物の Cloudflare に偽の
  トークンで問うていた（`6003 Invalid request headers` で止まった——止まり方としては正しい）
- `caddy upgrade` は Cloudflare の DNS のモジュールを保ったまま最新に替える（試験の場で写しに対して流して確かめた。
  v2.11.6 → v2.11.6、`dns.providers.cloudflare` あり）
- 試験の場の誤り（3回目で見つけた）：外から見る試験の場のアドレスを `incus list` の最初の IPv4 で取っていたので、中の
  Incus のブリッジ（`incusbr-1001`）のアドレスを拾い、**「外から 4737 に届かない」が何も見ていないのに通っていた**。
  1回目・2回目は順番の都合で eth0 を拾っていた。対照に置いた「外から 443 は通る」「表を消すと届く」が落ちて気づいた
  ——eth0 のアドレスを取るように直した
- **パイプの右の `grep -q` は pipefail の下で偽になりうる**（4回目の試験の「config.json の口」が1度だけ落ちた——値は
  正しく、`systemctl cat … | grep -q` で grep が先に終わり、左が SIGPIPE で落ちた）。試験だけでなく **install.sh にも
  同じ形があった**（`caddy list-modules | grep -qx dns.providers.cloudflare` は出力が長く、落ちると「Cloudflare の DNS が
  入っていません」で止まるか、Caddy を取り直す）。`grep … >/dev/null`（入力を最後まで読む）に直した。
  落ちたのは 4 回の試験のうち 1 回・1 箇所（規則6：間欠的な落ち方は機構の壊れ——待ち・やり直しではなく形を直した）

### レビュー後の試験の結果（2026-10-04、main に rebase した版——fork/self-update が入った main の上でも同じく PASS 113・FAIL 0）

24.04（ユーザー bantotester）：**PASS 113・FAIL 0**。まっさらから1回目 281 秒。26.04 はこの版では流していない
（前の版で PASS 68）。この版で新しく通したもの：表を消す→外から 200→打ち直し→000、apt の caddy の形で2回流して
/etc に unit を書かない、偽の Cloudflare でトークンありの形（「まだ取得中」で終わる・印つきで作る・人のレコードは
向け先だけ直す・cloudflare.env 0640 root:caddy・Publish の基のドメイン）、名前を替える回が Cloudflare に届かず止まる→
次の回が起こし直し・前の名前の印つきだけ消す・残りを最後の画面に出す、--no-cloudflare、秘密の grep、権限、
Zabbly の鍵の混ざった束を断る、パスワードの要る sudo のユーザーで drop_sudo のあと記憶が使えない
- 2回目の rebase の時点（2026-10-04）で **fork/self-update は main に入っていた**（update.mjs・setup-update.sh・bootstrap の
  releaseDir）。差し替えはこのレビューの範囲外（人の指示：「差し替え自体は main に入ってから」）なので、上の
  「差し替えのときにやること」は次の仕事として残す。install.sh が書く `releaseDir`・`uiPort` は、main の bootstrap.ts と
  update.mjs が読む名前と同じ（既定値も同じ `~/.local/share/banto-release`・4175）

## 「上げる」段を update.mjs・setup-update.sh に差し替えた（2026-10-04 の続き）

main（f408e782）に入った update.mjs・setup-update.sh の契約に合わせた。決まったことは仕様（v4-security §1「入れ方」・
アーキ §2.5）と runbook（install.md「置き場の形」）。

### 形

- **初めて**：install.sh が `repo.git` を作り（`git init --bare`、origin は `--repo`、`+refs/heads/release:refs/remotes/origin/release`
  で取る）、取ってきた release の `banto/scripts/update.mjs` を `git show` で置き場の外（mktemp）に写して `--first` で流す。
  update.mjs が worktree を作り組み立てて `current` を張る（起こさない）。このとき sudo の記憶を消している（組み立ては
  取ってきたコードを動かす）。そのあと sudo を取り直して setup-update.sh → doctor → 起こす
- **setup-update.sh は要るときだけ打つ**：古い形・polkit の規則が無い・`banto-update.service` が無いか中身（画面の口・
  node・置き場）が今と違う。契約上は何度打っても同じ（変えたものが無ければ起こし直さない）だが、打つと必ず
  `sudo true` から始まる——打ち直しで sudo を使わずに済ませるため、要らなければ打たない。置き場の外に写してから打つ
  （手順書 D）。`BANTO_UI_URL=http://127.0.0.1:<uiPort>/`・`NODE_BIN=/usr/local/bin/node` を渡す
- **unit は current を通すパスで書く**。古い形の置き場だけは clone を指したまま書く——setup-update.sh の書き換え
  （中の `<置き場>` を `<置き場>/current` に）の結果と、install.sh が current の形で書くものが同じ中身になるので、
  打ち直しで書き換えが行ったり来たりしない（試験で `/etc/systemd/system/banto-host.service` が打ち直しで変わらないことを
  見ている——変わると mtime で起こし直す判定に掛かる）
- **打ち直し**：sudo の記憶を消してから `current` の update.mjs（いつも今動いている版のもの）を待つ形で呼ぶ。
  起こし直すのは update.mjs で、polkit の規則（restart だけ許す）を使う——**打ち直しでは sudo を取り直さない**
  （前の形は build のあとに sudo を取り直していた。初めてのときだけ残る：setup-update.sh と start が要るため）
- **待ちの上限は install.sh が持つ**：update.mjs は待ち続ける（画面から人がやめられる）。install.sh は端末の前の人が
  打つもので、終わらないと困る——前の形（restart-when-idle --timeout 30）と同じ 30 分にした。state.json の段が `wait` に
  なってから数え、越えたら update.mjs の「やめる印」（`<dataDir>/update/cancel`）を置く。update.mjs は作りかけを消して
  `cancelled`（今の版のまま）で終わる——契約どおりの止め方で、殺さない。組み立ての時間は数えない（組み立て中に
  やめる印を置くと、組み立て終わる前に消える）
- **結果は state.json から読む**（この回のもの：startedAt が install.sh が呼んだ時刻以降）。done → 通る・cancelled →
  通るが最後の画面に「まだ上げていない」・rolled-back／failed → 理由（error）とログの場所を出して止まる。終了コード 3
  （ほかの更新が走っている）も止まる
- **版は同じで設定・unit だけが新しい**ときは、前と同じく起きた時刻とファイルの更新時刻で判定し、
  `restart-when-idle.mjs --dry-run --timeout 30`（空くまで待つだけ）のあと `systemctl restart`（polkit の規則で sudo 無し）。
  restart-when-idle 自身は `sudo systemctl restart` を打つので、そのままでは使えない
- **`--branch` はやめた**：update.mjs・setup-update.sh・self-update.ts が `refs/heads/release` 固定。install.sh だけ別の
  ブランチを入れても、次の更新（画面・打ち直し）で release に戻される。update.mjs にブランチを足すのは update.mjs の持ち主の
  仕事なので足していない（報告に書いた）。試験の場は bundle に release という名前で入れる
- **取り込み元は覚えない**：install.conf から `repo`・`branch` を外し、`repo.git` の origin を真実にした（update.mjs も
  それを使う）。`--repo` を渡したときだけ origin を替える
- 消したもの：`.git/banto-built-commit`・clone の `git status` の判定・版を上げたときの restart-when-idle の呼び出し
- **写しが1つ増えた**：install.sh の `FETCH_REFSPEC`（update.mjs のヘッダの「同じものの写しがある所」には載っていない）

### 古い形からの移行

前の install.sh（clone の形）で入れた host に打つと、置き場が古い形と分かり、unit は clone を指したまま（前と同じ中身）
書き、setup-update.sh に移させる（clone の origin から repo.git を作り、今の clone を組み立て直さずに versions/ に入れ、
unit を current に書き換えて起こし直す）。そのあと update.mjs で release の最新に上げる。

### 試験で分かったこと（差し替え）

- **画面の「更新」で新しい版が答えたあとも、update.mjs はしばらく lock を持っている**（state.json を `done` にしてから
  古い版を片づける——node_modules ごと消すので数十秒）。その間に install.sh を打つと update.mjs が終了コード 3（ほかの
  更新が走っている）で断り、install.sh は理由を出して止まる。止まり方としては正しい（打ち直せば通る）。試験は
  banto-update.service が終わるのを待つようにした
- **oneshot の unit は走っている間 `activating`**——`systemctl is-active` は 0 を返さない（試験の待ちが空振りした）。
  `ActiveState` で見る
- **走っている run.sh を書き換えると、bash が途中から別の行を読んで暴れる**（試験の結果の後半が無効になった）。
  run.sh は写しから流すようにした
- 起きない版（`cli.ts` の末尾で throw する版）では、update.mjs が起こし直したあと unit が落ちたのをその場で見て前の版に
  戻し、`rolled-back`。install.sh は「新しい版が起きなかったので、update.mjs が前の版に戻しました：…」とログの場所を出して
  止まる。current と host は前の版のまま
- update.mjs で上げたあと、Project の Module を起こし直す（prepare）と、Project のコンテナの banto の装置の source が
  `versions/<新しい版>/banto` になる（古い版の source は消える）

### update.mjs・setup-update.sh の持ち主に伝えること

1. **install.sh に `FETCH_REFSPEC` の写しが増えた**——update.mjs のヘッダの「同じものの写しがある所」に install.sh を足して
   ほしい（release 以外を取るように変えるなら、install.sh も）
2. **ブランチを選べない**：install.sh の `--branch` はやめた。別のブランチで動かしたい要望が出たら、update.mjs（と
   setup-update.sh・self-update.ts）側でブランチを持つ形（例：config.json か repo.git の設定）が要る
3. **update.mjs の待つ形に上限が無い**：install.sh は state.json の段を見て、30 分で「やめる印」を置いている。
   `--wait-timeout <分>`（越えたら cancelled で終わる）があれば、install.sh は印を置かずに済む
4. **`done` を書いてから片づける間も lock を持っている**：state.json を読む側は `done` で終わったと思うが、次の update.mjs は
   断られる。片づけを `done` より前にするか、片づけ中であることを state.json に出す（`note`）とよい
5. **setup-update.sh に「変えるものがあるか」だけを答える口が無い**（`--dry-run` は差分を出すだけで終了コードでは
   答えず、ユーザーに読めない `/etc/polkit-1/rules.d/` を読むのに sudo を使う）。install.sh は「要るか」を自分で判定している（polkit の規則・banto-update.service の有無と、中の画面の口・node・
   置き場）——setup-update.sh の書く中身を install.sh が知っている写しになっている。`--check`（sudo を使わず、変えるものが
   無ければ 0）があれば、その写しを消せる
6. **restart-when-idle.mjs は `sudo systemctl restart` を打つ**——polkit の規則がある host では sudo 無しの `systemctl restart`
   で足りる。install.sh は `--dry-run`（空くまで待つだけ）のあと自分で `systemctl restart` している

### 差し替えの試験の結果（2026-10-04、24.04、ユーザー bantotester）

- 本筋（`run.sh`）：**PASS 146・FAIL 0**（まっさらから 285 秒）。版ごとのフォルダの形・update.mjs で上がる
  （current・previous が替わる・host が新しい版で答える・コンテナの装置の source が新しい版）・起きない版で前の版に戻して
  止まる・画面の「更新」の口（リンクで入ったセッションで POST /api/admin/update → banto-update.service が上げる）・
  打ち直しで sudo を取り直さない、を含む
- 移行（`run.sh --migrate-from 1f935395`、前の install.sh とコードで古い形に入れ、今の install.sh を打つ）：**PASS 22・FAIL 0**
- 26.04（ユーザー devops、Incus は Zabbly stable）の本筋：**PASS 146・FAIL 0**（まっさらから 333 秒）。移行は 26.04 では流していない

### 024e52ee に合わせた（2026-10-05）

- 待ちの上限：install.sh が state.json を見て「やめる印」を置く形をやめ、`update.mjs --wait-timeout 30` を渡す。
  update.mjs は前景で流し、終わったら state.json の終わりの状態を読む（片づけのあとに書かれ、すぐ lock が外れる）
- setup-update.sh を打つかは `setup-update.sh --check` に聞く（sudo を使わない。0 なら打たない、1・2 なら打つ）。
  install.sh が持っていた banto-update.service の中身・polkit の規則の有無の写しは消した。`--check` を知らない古い版の
  setup-update.sh（古い形の clone の中のもの）は「知らない引数」で 2 を返すので、打つ側に倒れる
- 試験の場：画面の更新のあと unit が activating を抜けるのを待つ工夫を消した——終わりの状態は片づけのあとなので、
  checks.sh が state.json の終わりの状態を待てば足りる。次の段の打ち直しが lock で止まらないことが確かめになる
- restart-when-idle.mjs は sudo 無しで打ち、断られたら sudo で打ち直す形になった——install.sh の「--dry-run で待ってから
  自分で systemctl restart」をやめ、そのまま呼ぶ（polkit の規則がある host では sudo を使わない）

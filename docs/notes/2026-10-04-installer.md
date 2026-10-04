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

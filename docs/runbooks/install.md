# banto を新しいホストに入れる

**何をするか・なぜそうするか**は `docs/specs/v4-security.md` §1「ホストの前提」と「入れ方」。
ここは人が打つ手順だけを書く。

**対象**：Ubuntu 24.04・26.04（amd64・arm64）。**sudo できる普通のユーザーで打つ**——そのユーザーが banto を動かす
（root では断る）。

## 1. 入れる（1行）

```sh
curl -fsSL https://raw.githubusercontent.com/tjst-t/banto/release/install.sh | bash -s -- --domain banto.example.com
```

途中で sudo のパスワードを聞かれる——**初めて入れるときは、最初の版を組み立てたあとにもう一度聞かれる**（npm の依存と
build はユーザーの権限で流すので、その間は sudo の記憶を消している。取ってきたコードに root を使わせないため）。
打ち直しでは2度目は聞かない（上げる・起こし直すは polkit の規則で、sudo を使わない）。端末から打てば、Cloudflare の
API トークンも聞かれる（Enter だけなら飛ばす。一度 `--no-cloudflare` にしたら聞かない）。
最後に次が出る：

- **開く URL**：`https://<名前>/`
- **ログインのリンク**（10 分・1回だけ）。開いて入ったら、**設定 → ログイン でパスキーを登録**する。切れたら
  `cd ~/.local/share/banto-release/current/banto && node scripts/login-link.mjs` で出し直す
- **HTTPS の状態**と、**次にやること**

### HTTPS の2つの形

| | Cloudflare のトークンを渡す | 渡さない |
|---|---|---|
| 証明書 | Let's Encrypt（DNS-01）。`*.<名前>` の1枚＋`<名前>` | Caddy の内部の CA |
| DNS | `<名前>` と `*.<名前>` の A レコードを作る／直す（向け先はこのホストの LAN の IP、`proxied: false`） | **人が用意する**（DNS か各端末の hosts に `<IP> <名前> sandbox.<名前>`） |
| 端末 | そのまま | **端末ごとに CA を信頼する**：`http://<名前>/banto-ca.crt` を開いて入れる（ホストでは `/var/lib/caddy/.local/share/caddy/pki/authorities/local/root.crt`） |
| Publish（公開） | 使える（基のドメイン＝`<名前>` を書いておく） | 使えない |

トークンは Cloudflare の画面で作る：**Zone → Zone → Read** と **Zone → DNS → Edit**、対象はその名前を含むゾーン。
渡し方は3つ（どれもコマンド行や画面に値を残さない順に）：

```sh
# 端末から見えない形で聞かせる
curl -fsSL …/install.sh | bash -s -- --domain banto.example.com --cloudflare-token -
# 環境変数（シェルの履歴に残らないよう、read で入れる）
read -rs CLOUDFLARE_API_TOKEN && export CLOUDFLARE_API_TOKEN
curl -fsSL …/install.sh | bash -s -- --domain banto.example.com
# 引数（ps やシェルの履歴に値が見える。避けられるなら上の2つ）
curl -fsSL …/install.sh | bash -s -- --domain banto.example.com --cloudflare-token <トークン>
```

トークンが置かれるのは `/etc/caddy/cloudflare.env`（root:caddy 0640）だけ。

### オプション

| 引数 | 意味 |
|---|---|
| `--domain <名前>` | 画面の名前。初回は必須。`sandbox.<名前>`（Canvas のサンドボックス）・`*.<名前>`（Publish）も使う |
| `--cloudflare-token <値>` / `-` | 上の表 |
| `--no-cloudflare` | Cloudflare をやめて内部の CA に戻す（下の「Cloudflare をやめる」） |
| `--ip <IPv4>` | DNS のレコードの向け先（既定：既定経路のインターフェースの IPv4） |
| `--repo <URL\|パス>` | 取ってくるリポジトリ（既定 GitHub の banto）。取るのは **`release` ブランチだけ**（画面からの更新 `update.mjs` が release 固定のため。`--branch` はやめた）。`file://`・ローカルのパス・git bundle も受ける。覚えるのは `repo.git` の origin |
| `--pool-size <N>GiB` | Incus の置き場 `banto` の大きさ（`/var/lib/incus` が btrfs でないときのループファイル。既定は空きの半分・最大 50GiB） |
| `--no-claude-login` | Claude のログインをその場で流さない（打つコマンドを出すだけ） |

## 2. Claude にログインする

banto が使うのは、banto を動かすユーザーの `~/.claude` の資格情報。入れたときに端末があればその場で流れる。
後からなら、そのユーザーで：

```sh
~/.local/bin/claude auth login
```

## 3. 打ち直す（値を変える・最新にする）

**同じコマンドをもう一度打てばよい。** 済んだ段は確かめて飛ばす。

- **渡した値だけが変わり、渡さなかった値は前のまま**（`/etc/banto/install.conf` に覚えている。秘密は入らない）。
  例：名前を替える `bash -s -- --domain new.example.com`
- **上げるのは画面の「更新」と同じ本体**（`<置き場>/current/banto/scripts/update.mjs`）：release に新しいコミットが
  あれば新しい版のフォルダ（`versions/<commit の頭12>`）で組み立て、**動いているもの（会話・サブエージェントの仕事・
  Module の呼び出し）が無くなってから**起こし直し、新しい版が答えるかを確かめる。**起きなければ前の版に戻し**、
  install.sh は理由を出して止まる（前の版で動いたまま）。待つのは最長 30 分——越えたら上げずに終わる（作りかけは消える。
  空いたら画面の 設定 → 更新 か、同じコマンドをもう一度）
- 版は同じでも、設定や unit が変わったときは、空くのを待って起こし直す
- 何も変わっていなければ起こし直さない
- 画面の 設定 → 更新 からも上げられる（install.sh が `banto-update.service` と polkit の規則を置いてある——
  `docs/runbooks/release.md` D）

### 置き場の形

`~/.local/share/banto-release`（`config.json` の `releaseDir`）は版ごとのフォルダの形
（`docs/specs/v4-architecture.md` §2.5「画面から banto を更新する」）：

| 場所 | 中身 |
|---|---|
| `repo.git` | release を取ってくる bare のリポジトリ（origin は `--repo`） |
| `versions/<commit の頭12>/` | 版ごとの作業ツリー（組み立て済み） |
| `current` → `versions/…` | 動かす版。banto の unit はここを通る |
| `previous` → `versions/…` | 1つ前の版（戻す先） |

**前の install.sh で入れた host**（置き場そのものが clone の古い形）に打つと、`setup-update.sh` が版ごとのフォルダの形に
移す（今の clone は組み立て直さずに `versions/` に入る。元の unit と `.git` は `~/.local/share/banto-release.setup-backup/`）。
そのあと release の最新に上げる。

### 後から HTTPS（Let's Encrypt）にする

内部の CA で入れたあとでも、トークンを渡して打ち直せば替わる：

```sh
curl -fsSL https://raw.githubusercontent.com/tjst-t/banto/release/install.sh | bash -s -- --cloudflare-token -
```

DNS のレコードを作り、Caddy の設定を `dns cloudflare` に替えて起こし直し、Publish の基のドメインを書く。
各端末に入れた内部の CA は、もう要らなければ外してよい。

### Cloudflare をやめる（内部の CA に戻す）

```sh
curl -fsSL https://raw.githubusercontent.com/tjst-t/banto/release/install.sh | bash -s -- --no-cloudflare
```

保存したトークン（`/etc/caddy/cloudflare.env`）を消し、Caddy を内部の CA に戻し、Publish の基のドメインを外す。
**DNS のレコードは消さない**（内部の CA でも名前を引くのに使える）。要らなければ Cloudflare の画面で消す。
Cloudflare の画面でトークンも無効にする。

### 名前を替えたときの古い DNS のレコード

トークンありの形で `--domain` を替えると、前の名前の `<旧名>`・`*.<旧名>` のうち、**install.sh が作ったもの**
（Cloudflare の comment が `banto install.sh`）で**このホストの IP を向いているもの**だけを消す。それ以外は消さずに、
最後の画面の「残っている DNS のレコード」に出す——人が作ったものや別のホストのものを消さないため。

### Caddy を上げる

caddyserver.com の配布は版を選べず、install.sh は Caddy が入っていれば触らない。上げるときは（入っている
モジュール——Cloudflare の DNS——ごと最新に替わる）：

```sh
sudo /usr/local/bin/caddy upgrade
sudo systemctl restart caddy
/usr/local/bin/caddy version
```

### Docker を後から入れたとき

Docker は Incus のブリッジの転送を止めるので、Docker を入れたら同じコマンドを打ち直す（転送を許す drop-in
`/etc/systemd/system/docker.service.d/incus-forward.conf` と `/usr/local/sbin/incus-docker-forward.sh` を置く）。

### 手で組んだ host（今の banto の host など）に流すとき（未試験）

install.sh は手で組んだ host の形に合わせて作ってあるが、**手で組んだ host に流したことはまだ無い**。流す前に：

- **`/etc/caddy/Caddyfile` から banto のサイト（`<名前>`・`sandbox.<名前>`・`*.<名前>`）を消す**——banto の設定は
  `/etc/caddy/banto.d/banto.caddy` に作るので、残っていると同じ名前のサイトが2つになり、Caddy が受け付けない
  （install.sh はそこで止まり、banto の設定を元に戻す）
- `banto-host.service`・`banto-frontend.service` は**作り直される**（手で足した行は消える。drop-in は残る）。
  画面は `127.0.0.1:4175` で待つようになるので、Caddy 以外から 4175 に来ていたものは届かなくなる
- 置き場が古い形（clone）なら `setup-update.sh` が版ごとのフォルダの形に移し、起こし直す（release.md D と同じ）
- Cloudflare のトークンが `/etc/caddy/cloudflare.env` にあれば、それを使う（DNS のレコードも確かめ直す）

## 4. 入れ直す（動かすユーザーを替える等）

banto は1台に1つ（口 4737・4176・4175 が決まっている）。`/etc/banto/install.conf` の `user=` と違うユーザーで打つと断る。
替えるなら、前のユーザーの分を止めて（下の 5 の 1〜2）、`/etc/banto/install.conf` を消してから新しいユーザーで打つ。
データ（`~/.local/share/banto`）と設定（`~/.config/banto`）はユーザーのホームにあるので、引き継ぐなら写す。

## 5. アンインストール（手順だけ。install.sh は消す口を持たない）

**データを消す前に、要るものを写す**（Project のファイルは各 Project の根にあり、banto は消さない）。

```sh
# 1. banto を止めて unit を消す（画面からの更新の unit と polkit の規則も）
sudo systemctl disable --now banto-host.service banto-frontend.service banto-firewall.service
sudo systemctl stop banto-update.service 2>/dev/null
sudo rm -f /etc/systemd/system/banto-host.service /etc/systemd/system/banto-frontend.service /etc/systemd/system/banto-firewall.service \
  /etc/systemd/system/banto-update.service /etc/polkit-1/rules.d/50-banto-update.rules
sudo rm -rf /etc/systemd/system/banto-host.service.d /etc/systemd/system/banto-frontend.service.d
sudo rm -f /etc/systemd/system/system.slice.d/50-banto-protect.conf
sudo systemctl daemon-reload
# 2. ファイアウォールの表と覚えた値
sudo nft delete table inet banto 2>/dev/null; sudo rm -rf /etc/banto
# 3. Caddy の banto の設定（Caddyfile の import の1行も消す）。apt の caddy に drop-in で差し替えていたら、それも消す
sudo rm -rf /etc/caddy/banto.d /etc/caddy/cloudflare.env /etc/systemd/system/caddy.service.d/50-banto.conf
sudo sed -i '\#^import /etc/caddy/banto.d/\*.caddy$#d; /^# banto（install.sh が足した1行/d' /etc/caddy/Caddyfile
sudo systemctl daemon-reload && sudo systemctl restart caddy
# 3b. Docker の転送の drop-in（Docker が居たときだけ置いている）
sudo rm -f /etc/systemd/system/docker.service.d/incus-forward.conf /usr/local/sbin/incus-docker-forward.sh
sudo systemctl daemon-reload        # 今入っている DOCKER-USER の規則は Docker を起こし直すまで残る
# 4. banto の Project のコンテナ（banto を動かしていたユーザーで）
incus list --all-projects            # banto-* を確かめてから
incus delete --force <名前> …        # 要らなければ
# 5. コード・データ・設定（戻せない）
rm -rf ~/.local/share/banto-release ~/.local/share/banto-release.setup-backup ~/.local/share/banto ~/.config/banto ~/banto-host.log ~/banto-frontend.log
```

Incus・Caddy・Node（`/usr/local`）・sops（`/usr/local/bin/sops`）・Claude Code はほかでも使いうるので、ここでは消さない。消すなら
`sudo rm /usr/local/bin/sops`、
`sudo apt-get purge incus`（置き場 `banto` も消える）、`sudo systemctl disable --now caddy && sudo rm /usr/local/bin/caddy`
（apt の caddy でなければ `/etc/systemd/system/caddy.service` も）。Cloudflare の A レコードは Cloudflare の画面で消す。

## 困ったとき

| 出たもの | 見るところ |
|---|---|
| 「段「…」で止まりました」 | その下の「直し方」。直して同じコマンドを打ち直す |
| banto が起きない | `tail -50 ~/banto-host.log`・`systemctl status banto-host` |
| https が通らない | `journalctl -u caddy -n 50`（証明書の取得・Caddyfile の誤り） |
| 上げられなかった・前の版に戻った | 最後に出たログ（`~/.local/share/banto/update/<id>.log`）・`~/.local/share/banto/update/state.json`・画面の 設定 → 更新 の「ログを開く」 |
| Project の Module が繋がらない | `cd ~/.local/share/banto-release/current/banto && node packages/container/dist/doctor.js` |
| ログインのリンクが切れた | `cd ~/.local/share/banto-release/current/banto && node scripts/login-link.mjs` |

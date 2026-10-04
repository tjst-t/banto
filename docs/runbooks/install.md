# banto を新しいホストに入れる

**何をするか・なぜそうするか**は `docs/specs/v4-security.md` §1「ホストの前提」と「入れ方」。
ここは人が打つ手順だけを書く。

**対象**：Ubuntu 24.04・26.04（amd64・arm64）。**sudo できる普通のユーザーで打つ**——そのユーザーが banto を動かす
（root では断る）。

## 1. 入れる（1行）

```sh
curl -fsSL https://raw.githubusercontent.com/tjst-t/banto/release/install.sh | bash -s -- --domain banto.example.com
```

途中で sudo のパスワードを聞かれる。端末から打てば、Cloudflare の API トークンも聞かれる（Enter だけなら飛ばす）。
最後に次が出る：

- **開く URL**：`https://<名前>/`
- **ログインのリンク**（10 分・1回だけ）。開いて入ったら、**設定 → ログイン でパスキーを登録**する。切れたら
  `cd ~/.local/share/banto-release/banto && node scripts/login-link.mjs` で出し直す
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
| `--ip <IPv4>` | DNS のレコードの向け先（既定：既定経路のインターフェースの IPv4） |
| `--branch <名前>` / `--repo <URL\|パス>` | 取ってくるコード（既定 GitHub の `release`）。`file://`・ローカルのパス・git bundle も受ける |
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
- release に新しいコミットがあれば取り込み、build して、**動いているもの（会話・サブエージェントの仕事・Module の
  呼び出し）が無くなってから**起こし直す（`scripts/restart-when-idle.mjs`、最長 30 分待つ。待ちきれなければ
  起こし直さずに終わり、打つコマンドを出す）。設定や unit が変わったときも同じ
- 何も変わっていなければ起こし直さない

### 後から HTTPS（Let's Encrypt）にする

内部の CA で入れたあとでも、トークンを渡して打ち直せば替わる：

```sh
curl -fsSL https://raw.githubusercontent.com/tjst-t/banto/release/install.sh | bash -s -- --cloudflare-token -
```

DNS のレコードを作り、Caddy の設定を `dns cloudflare` に替えて起こし直し、Publish の基のドメインを書く。
各端末に入れた内部の CA は、もう要らなければ外してよい。

### 手で組んだ host（今の banto の host など）に流すとき（未試験）

install.sh は手で組んだ host の形に合わせて作ってあるが、**手で組んだ host に流したことはまだ無い**。流す前に：

- **`/etc/caddy/Caddyfile` から banto のサイト（`<名前>`・`sandbox.<名前>`・`*.<名前>`）を消す**——banto の設定は
  `/etc/caddy/banto.d/banto.caddy` に作るので、残っていると同じ名前のサイトが2つになり、Caddy が受け付けない
  （install.sh はそこで止まり、banto の設定を元に戻す）
- `banto-host.service`・`banto-frontend.service` は**作り直される**（手で足した行は消える。drop-in は残る）。
  画面は `127.0.0.1:4175` で待つようになるので、Caddy 以外から 4175 に来ていたものは届かなくなる
- 1回目は build し直して `restart-when-idle.mjs` で起こし直す。**build は動いている clone の中で行う**
  （`docs/runbooks/release.md` の B と同じ。版ごとの置き場は相談中）
- Cloudflare のトークンが `/etc/caddy/cloudflare.env` にあれば、それを使う（DNS のレコードも確かめ直す）

## 4. 入れ直す（動かすユーザーを替える等）

banto は1台に1つ（口 4737・4176・4175 が決まっている）。`/etc/banto/install.conf` の `user=` と違うユーザーで打つと断る。
替えるなら、前のユーザーの分を止めて（下の 5 の 1〜2）、`/etc/banto/install.conf` を消してから新しいユーザーで打つ。
データ（`~/.local/share/banto`）と設定（`~/.config/banto`）はユーザーのホームにあるので、引き継ぐなら写す。

## 5. アンインストール（手順だけ。install.sh は消す口を持たない）

**データを消す前に、要るものを写す**（Project のファイルは各 Project の根にあり、banto は消さない）。

```sh
# 1. banto を止めて unit を消す
sudo systemctl disable --now banto-host.service banto-frontend.service banto-firewall.service
sudo rm -f /etc/systemd/system/banto-host.service /etc/systemd/system/banto-frontend.service /etc/systemd/system/banto-firewall.service
sudo rm -rf /etc/systemd/system/banto-host.service.d /etc/systemd/system/banto-frontend.service.d
sudo rm -f /etc/systemd/system/system.slice.d/50-banto-protect.conf
sudo systemctl daemon-reload
# 2. ファイアウォールの表と覚えた値
sudo nft delete table inet banto 2>/dev/null; sudo rm -rf /etc/banto
# 3. Caddy の banto の設定（Caddyfile の import の1行も消す）
sudo rm -rf /etc/caddy/banto.d /etc/caddy/cloudflare.env
sudo sed -i '\#^import /etc/caddy/banto.d/\*.caddy$#d; /^# banto（install.sh が足した1行/d' /etc/caddy/Caddyfile
sudo systemctl restart caddy
# 4. banto の Project のコンテナ（banto を動かしていたユーザーで）
incus list --all-projects            # banto-* を確かめてから
incus delete --force <名前> …        # 要らなければ
# 5. コード・データ・設定（戻せない）
rm -rf ~/.local/share/banto-release ~/.local/share/banto ~/.config/banto ~/banto-host.log ~/banto-frontend.log
```

Incus・Caddy・Node（`/usr/local`）・Claude Code はほかでも使いうるので、ここでは消さない。消すなら
`sudo apt-get purge incus`（置き場 `banto` も消える）、`sudo systemctl disable --now caddy && sudo rm /usr/local/bin/caddy`
（apt の caddy でなければ `/etc/systemd/system/caddy.service` も）。Cloudflare の A レコードは Cloudflare の画面で消す。

## 困ったとき

| 出たもの | 見るところ |
|---|---|
| 「段「…」で止まりました」 | その下の「直し方」。直して同じコマンドを打ち直す |
| banto が起きない | `tail -50 ~/banto-host.log`・`systemctl status banto-host` |
| https が通らない | `journalctl -u caddy -n 50`（証明書の取得・Caddyfile の誤り） |
| Project の Module が繋がらない | `cd ~/.local/share/banto-release/banto && node packages/container/dist/doctor.js` |
| ログインのリンクが切れた | `cd ~/.local/share/banto-release/banto && node scripts/login-link.mjs` |

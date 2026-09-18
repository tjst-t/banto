# banto を https にした（2026-09-18）— OAuth の前提

OAuth を要る MCP サーバ（AccuWeather のような claude.ai コネクタ系）に繋ぐための
**前提の工事**。banto のコードは1バイトも変えていない——変えたのは Caddy と
`~/.config/banto/config.json` だけ。ここに残すのは、**次に触る人が「なぜ
`/usr/local/bin/caddy` が在るのか」を調べ直さずに済むように**。

## なぜ要ったか

OAuth 2.1 は**戻り先の URL（redirect URI）が https であること**を要求する
（例外は `127.0.0.1` だけ）。`banto.tjstkm.net` は平文の http だったので、
**戻り先が決められず、OAuth の設計そのものが始まらなかった**。

`127.0.0.1` の例外に逃げる案は採らなかった。banto と同じ機械のブラウザから
しか繋げず、**スマホや別 PC から触ったときだけ繋げない**という半端な状態が残る。

## どう張ったか

**DNS-01。** `banto.tjstkm.net` は **192.168.1.47（LAN の中）**で、公開 DNS が
そのプライベート IP を返している。つまり Let's Encrypt はこの機械に到達できず、
**HTTP-01 も TLS-ALPN-01 も使えない**。DNS-01 は TXT レコードを置くだけなので、
到達性が要らない。

- 権威 DNS は **Cloudflare**（`dig NS tjstkm.net` で確認）
- トークンは **Infisical CLI の `/banto` フォルダの `CLOUDFLARE_API_TOKEN`**
  （`infisical secrets get CLOUDFLARE_API_TOKEN --path=/banto --plain`）
- apt の `caddy 2.6.2` には `dns.providers` が**入っていない**。Go も xcaddy も
  この機械に無いので、**caddyserver.com の custom build**（`?p=github.com/caddy-dns/cloudflare`）
  を `/usr/local/bin/caddy` に置き、systemd の drop-in で差し替えた

> **`--environ` を外した。** apt のユニットは `caddy run --environ` で、これは
> **起動時に環境変数を全部ログへ出す**——`CLOUDFLARE_API_TOKEN` が journal に
> 残ってしまう。drop-in で外してある。

### 写しが1つできた（承知のうえ）

Caddy は banto の金庫を読めない（別プロセス・別ユーザー）ので、トークンは
`/etc/caddy/cloudflare.env`（`root:caddy` 0640）に**写し**として置いている。
**出所は Infisical で、ここに在るのは写し**——規則3 の意味でいつか食い違う。
入れ直す手順は Caddyfile のコメントに書いた。

## 壊さないようにしたこと

- **http を残した。** `http://banto.tjstkm.net` はそのまま 200 で、慣れた
  ブックマークが効く。https は**足しただけ**（`(banto_v4)` スニペットを
  両方から `import` するので、中身の写しは作っていない）
- **サンドボックスも同時に https にした。** https のページは http の iframe を
  埋め込めない（mixed content）。**片方だけ張ると Canvas が黙って出なくなる**
- `sandboxPublicUrl` は **https に倒した**。逆向き（http のページに https の
  iframe）は通るので、**http でも https でも Canvas が出る**

## 見たこと（規則1・規則13）

- `http` / `https` とも画面が 200。証明書は **Let's Encrypt**（`-k` 無しで通る）
- サンドボックスの CSP の `frame-ancestors` に **http と https の両方**が入っている
- **Canvas が https で実際に描画され、中身まで出た**（Playwright で
  `sandbox.banto.tjstkm.net/sandbox.html` の中に `github-token / 1 件`）

> **探索を1回間違えた。** `?section=vault-local` を推測して開いたら iframe が
> 0 で、一瞬「Canvas が壊れた」と思った。正しくは **`?section=module:vault-local`**
> で、**節の id を推測せず押して開く**のが正しかった（規則1——測る前に犯人を
> 決めない。http でも同じだったので、退行ではないとすぐ分かった）。

## ついでに見つけたもの（直していない・規則8）

会話の中の Canvas で 404 が2種類出ている。**いま触っている機能ではない**ので
直していないが、記録する：

- **`server=vault` を引いている**——`vault` は 2026-09-12 に `vault-local` へ
  改名した。**古い名前の参照がどこかに残っている**
- **`server=filesystem` が 404**——実機で `filesystem` が `connected=false`
  （立っていない）。立たない理由は追っていない

## 次にやること

- **OAuth の実装**（`OAuthClientProvider` を書く。中身はトークンの置き場＝Vault と、
  「ログインする」ボタン）。戻り先は **`https://banto.tjstkm.net/api/oauth/callback`**
  で固定できる
- **証明書の自動更新は Caddy がやる**が、**apt の caddy を上げてもこちらは
  上がらない**（`/usr/local/bin/caddy` は手で入れ直す）

---
title: HTTPS の設定
description: Cloudflare の API トークンの有無による、証明書と DNS の設定方法の違い。
---

banto の画面は HTTPS でのみ利用できます。証明書の用意には、次の2つの方法があります。

| | Cloudflare の API トークンを指定する | 指定しない |
|---|---|---|
| 証明書 | Let's Encrypt（`*.<ドメイン名>` のワイルドカード証明書と `<ドメイン名>`） | Caddy の内部 CA |
| DNS | `<ドメイン名>` と `*.<ドメイン名>` の A レコードを自動で作成（サーバーの LAN 側の IP アドレスを設定） | **手動で設定**（DNS サーバー、または各端末の hosts ファイルに `<IP アドレス> <ドメイン名> sandbox.<ドメイン名>` を追加） |
| 端末側の設定 | 不要 | **端末ごとに CA 証明書を信頼させる**（`http://<ドメイン名>/banto-ca.crt` からダウンロードしてインストール） |
| Publish（サービスの公開） | 利用可能 | 利用不可 |

API トークンの作成方法は [インストール](/docs/install/#cloudflare-の-api-トークンを作成する) を参照してください。トークンはサーバーの `/etc/caddy/cloudflare.env`（root と caddy ユーザーのみ読み取り可能）にのみ保存されます。

## 内部 CA から Let's Encrypt に切り替える

内部 CA でインストールしたあとでも、API トークンを指定してインストールコマンドを再実行すると切り替えられます。

```sh
curl -fsSL https://banto.tjst-t.dev/install.sh | bash -s -- --cloudflare-token -
```

各端末にインストールした内部 CA の証明書は、不要になれば削除して構いません。

## Cloudflare の利用をやめる

```sh
curl -fsSL https://banto.tjst-t.dev/install.sh | bash -s -- --no-cloudflare
```

保存されている API トークンを削除し、内部 CA に切り替えます。DNS レコードは名前解決に引き続き使えるため、削除しません。不要な場合は、Cloudflare のダッシュボードでレコードを削除し、API トークンも無効にしてください。

## ドメイン名を変更した場合

API トークンを使用している状態で `--domain` を変更すると、旧ドメイン名のレコードのうち、インストーラーが作成し、かつこのサーバーを指しているものだけが削除されます。それ以外のレコードは削除されず、完了時の画面に「残っている DNS のレコード」として表示されます。

---
title: HTTPS の2つの形
description: Cloudflare のトークンを渡すか渡さないかで、証明書と DNS の用意のしかたが変わります。
---

banto の画面は HTTPS でしか動きません。証明書の用意のしかたは2つあります。

| | Cloudflare のトークンを渡す | 渡さない |
|---|---|---|
| 証明書 | Let's Encrypt（`*.<名前>` の1枚と `<名前>`） | Caddy の内部の CA |
| DNS | `<名前>` と `*.<名前>` の A レコードを作る（向け先はこのマシンの LAN の IP） | **自分で用意する**（DNS か、各端末の hosts に `<IP> <名前> sandbox.<名前>`） |
| 端末 | そのまま使える | **端末ごとに CA を信頼させる**：`http://<名前>/banto-ca.crt` を開いて入れる |
| Publish（サーバの公開） | 使える | 使えない |

トークンの作り方は [入れる](/docs/install/#cloudflare-のトークンを作る) にあります。トークンが置かれるのはマシンの `/etc/caddy/cloudflare.env`（root と caddy だけが読める）だけです。

## 後から Let's Encrypt にする

内部の CA で入れたあとでも、トークンを渡して打ち直せば替わります。

```sh
curl -fsSL https://banto.tjst-t.dev/install.sh | bash -s -- --cloudflare-token -
```

各端末に入れた内部の CA は、要らなければ外してかまいません。

## Cloudflare をやめる

```sh
curl -fsSL https://banto.tjst-t.dev/install.sh | bash -s -- --no-cloudflare
```

保存したトークンを消し、内部の CA に戻します。DNS のレコードは消しません（名前を引くのに使えるため）。要らなければ Cloudflare の画面で消し、トークンも無効にしてください。

## 名前を替えたとき

トークンありの形で `--domain` を替えると、前の名前のレコードのうち、install.sh が作ったもので、このマシンを向いているものだけを消します。それ以外は消さずに、最後の画面に「残っている DNS のレコード」として出します。

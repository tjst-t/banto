---
title: 入れる
description: 新しいマシンに banto を入れる。1行のコマンドで済みます。
---

## 用意するもの

- **Ubuntu 24.04 か 26.04 のマシン**（amd64・arm64）。仮想マシンでもかまいません。
- **sudo できる普通のユーザー。** そのユーザーが banto を動かします（root では断ります）。
- **画面の名前**（例 `banto.example.com`）。`sandbox.<名前>` と `*.<名前>` も使います。
- **Claude のアカウント。** 会話に Claude Code のログインを使います。
- あれば **Cloudflare の API トークン**。名前のゾーンが Cloudflare にあれば、DNS のレコードと Let's Encrypt の証明書を自動で用意します。無くても入れられます（[HTTPS の2つの形](/docs/install/https/)）。

### Cloudflare のトークンを作る

次のリンクを開くと、要る2つの権限（**Zone → Zone → Read** と **Zone → DNS → Edit**）を選んだ状態でトークンの作成画面が開きます。

[Cloudflare でトークンを作る](https://dash.cloudflare.com/profile/api-tokens?permissionGroupKeys=%5B%7B%22key%22%3A%22zone%22%2C%22type%22%3A%22read%22%7D%2C%7B%22key%22%3A%22dns%22%2C%22type%22%3A%22edit%22%7D%5D&accountId=*&name=banto-install)

対象のゾーン（Zone Resources）は画面で、名前を含むゾーンだけを選んでください。「Continue to summary」→「Create Token」で作ると値が一度だけ表示されます。

## コマンドを打つ

```sh
curl -fsSL https://banto.tjst-t.dev/install.sh | bash -s -- --domain banto.example.com
```

端末から打てば、途中で Cloudflare のトークンを聞かれます（表示されません。Enter だけなら飛ばして、Caddy の内部の CA で HTTPS にします）。トークンを先に渡すこともできます：

```sh
# 端末から見えない形で聞かせる
curl -fsSL https://banto.tjst-t.dev/install.sh | bash -s -- --domain banto.example.com --cloudflare-token -

# 環境変数で渡す（シェルの履歴に残らないよう read で入れる）
read -rs CLOUDFLARE_API_TOKEN && export CLOUDFLARE_API_TOKEN
curl -fsSL https://banto.tjst-t.dev/install.sh | bash -s -- --domain banto.example.com
```

途中で sudo のパスワードを聞かれます。初めて入れるときは、最初の版を組み立てたあとにもう一度聞かれます（取ってきたコードの組み立てには root を使わせないため、その間は sudo の記憶を消しています）。

終わると次が出ます：

- **開く URL**：`https://<名前>/`
- **ログインのリンク**（10分だけ・1回だけ使える）
- HTTPS の状態と、次にやること

## 入って、パスキーを登録する

出たログインのリンクを開くと banto に入れます。入ったら **設定 → ログイン でパスキーを登録**してください。以後はパスキーで入ります。

別の端末（携帯など）を足すときは、入っている端末の **設定 → ログイン → 端末を追加** で QR コードとリンクを出し、足したい端末で開きます。

リンクが切れたら、banto を動かすユーザーで出し直せます：

```sh
cd ~/.local/share/banto-release/current/banto && node scripts/login-link.mjs
```

## Claude にログインする

入れるときに端末があれば、その場で Claude のログインが流れます。後からなら、banto を動かすユーザーで：

```sh
~/.local/bin/claude auth login
```

## オプション

| 引数 | 意味 |
|---|---|
| `--domain <名前>` | 画面の名前。初回は必須 |
| `--cloudflare-token <値>` / `-` | Cloudflare の API トークン。`-` なら端末から見えない形で聞く。環境変数 `CLOUDFLARE_API_TOKEN` でも渡せる |
| `--no-cloudflare` | Cloudflare をやめて Caddy の内部の CA に戻す |
| `--ip <IPv4>` | DNS のレコードの向け先（既定はこのマシンの既定経路の IPv4） |
| `--pool-size <N>GiB` | コンテナの置き場の大きさ（既定は空きの半分・最大 50GiB） |
| `--no-claude-login` | Claude のログインをその場で流さない（打つコマンドを出すだけ） |

決めた値は覚えておくので、打ち直すときは変えたいものだけ渡せば足ります（[更新する・打ち直す](/docs/install/update/)）。

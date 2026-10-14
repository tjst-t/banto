---
title: インストール
description: banto を新しいサーバーにインストールする手順。
---

## 必要なもの

- **Ubuntu 24.04 または 26.04 のサーバー**（amd64 / arm64）。仮想マシンでも構いません。
- **sudo 権限のある一般ユーザー**。このユーザーで banto が動作します（root ユーザーでは実行できません）。
- **banto に割り当てるドメイン名**（例：`banto.example.com`）。`sandbox.<ドメイン名>` と `*.<ドメイン名>` も使用します。
- **Claude のアカウント**。AI との会話に Claude Code を使用します。
- **Cloudflare の API トークン**（任意）。ドメインを Cloudflare で管理している場合、DNS レコードの作成と Let's Encrypt の証明書の取得を自動で行います。トークンがなくてもインストールできます（[HTTPS の設定](/docs/install/https/) を参照）。

### Cloudflare の API トークンを作成する

次のリンクを開くと、必要な2つの権限（**Zone → Zone → Read** と **Zone → DNS → Edit**）が選択された状態で、トークンの作成画面が表示されます。

[Cloudflare で API トークンを作成する](https://dash.cloudflare.com/profile/api-tokens?permissionGroupKeys=%5B%7B%22key%22%3A%22zone%22%2C%22type%22%3A%22read%22%7D%2C%7B%22key%22%3A%22dns%22%2C%22type%22%3A%22edit%22%7D%5D&accountId=*&name=banto-install)

「Zone Resources」で、使用するドメインを含むゾーンを選択してください。「Continue to summary」→「Create Token」の順に進むと、トークンが表示されます。トークンはこの画面でしか表示されないため、控えておいてください。

## インストールする

次のコマンドを実行します。

```sh
curl -fsSL https://banto.tjst-t.dev/install.sh | bash -s -- --domain banto.example.com
```

ターミナルから実行した場合は、途中で Cloudflare の API トークンの入力を求められます（入力内容は表示されません）。何も入力せずに Enter キーを押すと、Caddy の内部 CA で HTTPS を設定します。

トークンは、あらかじめ指定することもできます。

```sh
# 入力を求めるプロンプトを表示する
curl -fsSL https://banto.tjst-t.dev/install.sh | bash -s -- --domain banto.example.com --cloudflare-token -

# 環境変数で指定する（シェルの履歴に残らないよう read で読み込む）
read -rs CLOUDFLARE_API_TOKEN && export CLOUDFLARE_API_TOKEN
curl -fsSL https://banto.tjst-t.dev/install.sh | bash -s -- --domain banto.example.com
```

インストール中に sudo のパスワードを求められます。初回のインストールでは、banto のビルド後にもう一度求められます（ダウンロードしたコードのビルド中は root 権限を使わせないよう、sudo の認証情報をいったん破棄しているためです）。

インストールが完了すると、次の情報が表示されます。

- **アクセス先の URL**：`https://<ドメイン名>/`
- **ログイン用のリンク**（有効期限は10分、1回のみ使用可能）
- HTTPS の設定状況と、次に行う作業

## ログインしてパスキーを登録する

表示されたログイン用のリンクを開くと、banto にログインできます。ログインしたら、**「設定」→「ログイン」でパスキーを登録**してください。以降はパスキーでログインします。

スマートフォンなど別の端末を追加するには、ログイン済みの端末で **「設定」→「ログイン」→「端末を追加」** を選び、表示された QR コードまたはリンクを追加したい端末で開きます。

ログイン用のリンクの有効期限が切れた場合は、banto を動かしているユーザーで次のコマンドを実行すると再発行できます。

```sh
cd ~/.local/share/banto-release/current/banto && node scripts/login-link.mjs
```

## Claude にログインする

インストールをターミナルから実行した場合は、その場で Claude へのログインが始まります。あとからログインする場合は、banto を動かしているユーザーで次のコマンドを実行します。

```sh
~/.local/bin/claude auth login
```

## オプション

| オプション | 説明 |
|---|---|
| `--domain <ドメイン名>` | banto に割り当てるドメイン名。初回のインストールでは必須 |
| `--cloudflare-token <トークン>` / `-` | Cloudflare の API トークン。`-` を指定するとプロンプトで入力を求める。環境変数 `CLOUDFLARE_API_TOKEN` でも指定可能 |
| `--no-cloudflare` | Cloudflare の利用をやめ、Caddy の内部 CA に切り替える |
| `--ip <IPv4 アドレス>` | DNS レコードに設定する IP アドレス（既定値はデフォルトルートのインターフェースの IPv4 アドレス） |
| `--pool-size <N>GiB` | コンテナ用ストレージプールのサイズ（既定値は空き容量の半分、最大 50GiB） |
| `--no-claude-login` | Claude へのログインを実行せず、必要なコマンドの表示だけを行う |

指定した値はサーバーに保存されます。再実行するときは、変更したいオプションだけを指定してください（[アップデート](/docs/install/update/) を参照）。

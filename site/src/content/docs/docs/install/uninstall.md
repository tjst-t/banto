---
title: アンインストール
description: banto をサーバーから削除する手順。
---

インストーラーにはアンインストールの機能がないため、次のコマンドを手動で実行します。

:::caution
削除する前に、必要なデータをバックアップしてください。各プロジェクトのファイルはプロジェクトのルートディレクトリにあり、この手順では削除されません。
:::

```sh
# 1. banto を停止し、systemd のユニットを削除する
sudo systemctl disable --now banto-host.service banto-frontend.service banto-firewall.service
sudo systemctl stop banto-update.service 2>/dev/null
sudo rm -f /etc/systemd/system/banto-host.service /etc/systemd/system/banto-frontend.service /etc/systemd/system/banto-firewall.service \
  /etc/systemd/system/banto-update.service /etc/polkit-1/rules.d/50-banto-update.rules
sudo rm -rf /etc/systemd/system/banto-host.service.d /etc/systemd/system/banto-frontend.service.d
sudo rm -f /etc/systemd/system/system.slice.d/50-banto-protect.conf
sudo systemctl daemon-reload

# 2. ファイアウォールのルールとインストール時の設定を削除する
sudo nft delete table inet banto 2>/dev/null; sudo rm -rf /etc/banto

# 3. Caddy の banto 用の設定を削除する（Caddyfile に追加された import 行も削除）
sudo rm -rf /etc/caddy/banto.d /etc/caddy/cloudflare.env /etc/systemd/system/caddy.service.d/50-banto.conf
sudo sed -i '\#^import /etc/caddy/banto.d/\*.caddy$#d; /^# banto（install.sh が足した1行/d' /etc/caddy/Caddyfile
sudo systemctl daemon-reload && sudo systemctl restart caddy

# 3b. Docker 用の転送設定を削除する（Docker がある場合のみ作成されています）
sudo rm -f /etc/systemd/system/docker.service.d/incus-forward.conf /usr/local/sbin/incus-docker-forward.sh
sudo systemctl daemon-reload

# 4. プロジェクトのコンテナを削除する（banto を動かしていたユーザーで実行。banto-* を確認してから）
incus list --all-projects
incus delete --force <コンテナ名> …

# 5. プログラム・データ・設定を削除する（元に戻せません）
rm -rf ~/.local/share/banto-release ~/.local/share/banto-release.setup-backup ~/.local/share/banto ~/.config/banto ~/banto-host.log ~/banto-frontend.log
```

Incus、Caddy、Node.js、sops、Claude Code はほかの用途でも使われている可能性があるため、この手順では削除しません。Cloudflare の DNS レコードは、Cloudflare のダッシュボードで削除してください。

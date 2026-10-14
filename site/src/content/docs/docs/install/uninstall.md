---
title: アンインストール
description: banto を消す手順。install.sh は消す口を持たないので、手で打ちます。
---

:::caution
データを消す前に、要るものを写してください。Project のファイルは各 Project の root にあり、ここでは消しません。
:::

```sh
# 1. banto を止めて unit を消す
sudo systemctl disable --now banto-host.service banto-frontend.service banto-firewall.service
sudo systemctl stop banto-update.service 2>/dev/null
sudo rm -f /etc/systemd/system/banto-host.service /etc/systemd/system/banto-frontend.service /etc/systemd/system/banto-firewall.service \
  /etc/systemd/system/banto-update.service /etc/polkit-1/rules.d/50-banto-update.rules
sudo rm -rf /etc/systemd/system/banto-host.service.d /etc/systemd/system/banto-frontend.service.d
sudo rm -f /etc/systemd/system/system.slice.d/50-banto-protect.conf
sudo systemctl daemon-reload

# 2. ファイアウォールの表と覚えた値
sudo nft delete table inet banto 2>/dev/null; sudo rm -rf /etc/banto

# 3. Caddy の banto の設定（Caddyfile に足した import の1行も消す）
sudo rm -rf /etc/caddy/banto.d /etc/caddy/cloudflare.env /etc/systemd/system/caddy.service.d/50-banto.conf
sudo sed -i '\#^import /etc/caddy/banto.d/\*.caddy$#d; /^# banto（install.sh が足した1行/d' /etc/caddy/Caddyfile
sudo systemctl daemon-reload && sudo systemctl restart caddy

# 3b. Docker の転送の設定（Docker が居たときだけ置いている）
sudo rm -f /etc/systemd/system/docker.service.d/incus-forward.conf /usr/local/sbin/incus-docker-forward.sh
sudo systemctl daemon-reload

# 4. Project のコンテナ（banto を動かしていたユーザーで。banto-* を確かめてから）
incus list --all-projects
incus delete --force <名前> …

# 5. コード・データ・設定（戻せません）
rm -rf ~/.local/share/banto-release ~/.local/share/banto-release.setup-backup ~/.local/share/banto ~/.config/banto ~/banto-host.log ~/banto-frontend.log
```

Incus・Caddy・Node・sops・Claude Code はほかでも使うことがあるので、ここでは消しません。Cloudflare の DNS のレコードは Cloudflare の画面で消してください。

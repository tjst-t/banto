#!/usr/bin/env bash
# prototype/ を Caddy の配信先（/var/www/prototype）へ写す。
#
# Caddy は http://banto.tjstkm.net/prototype/* だけを静的配信し、それ以外は
# 番頭ホスト（127.0.0.1:4100）へ中継する（/etc/caddy/Caddyfile）。番頭ホストには触らない。
#
# --copy-links: redesign/impl/ は packages/banto-web/src/ への symlink なので、
#               公開先には実体を写す（web root から repo の外を辿らせない）。
set -euo pipefail

src="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/"
dst=/var/www/prototype/

sudo rsync -a --delete --copy-links \
  --exclude='publish.sh' \
  --exclude='test-results/' \
  "$src" "$dst"
sudo chown -R caddy:caddy "$dst"

echo "写しました: $src -> $dst"
echo "  http://banto.tjstkm.net/prototype/            （旧プロトタイプ）"
echo "  http://banto.tjstkm.net/prototype/redesign/   （意匠の提案・5案）"

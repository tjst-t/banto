#!/bin/sh
# PoC 10：Project の実行場所に VM を選べるか・コンテナにどこまで渡せるか を測る。
#
# **host で、banto を動かしているユーザー（incus グループ）で実行する**。Project のコンテナの中には incus が無い。
# 試しの VM とコンテナ（banto-probe-*）を作って測り、終わったら消す。区画は incus-user の制限つき区画
# （user-<uid>）——banto と同じ条件で測るため。
#
#   sh poc/10-project-vm/probe.sh 2>&1 | tee ~/banto-probe-$(date +%Y%m%d-%H%M).log
#
# 出力を丸ごと AI に渡せば読む。途中で失敗しても最後まで進み、後片付けする。

set -u
P=banto-probe
IMG=images:ubuntu/24.04
PROJ="user-$(id -u)"
# 制限つき区画はホームの下しか見せられない（PoC 09）
DIR=$(mktemp -d "$HOME/banto-probe.XXXXXX")

cleanup() {
  incus delete -f "$P-vm" </dev/null >/dev/null 2>&1
  incus delete -f "$P-ct" </dev/null >/dev/null 2>&1
  rm -rf "$DIR"
}
trap cleanup EXIT INT TERM

wait_exec() { # 中でコマンドが通るまで待つ（VM は incus-agent が起きるまで時間がかかる）
  i=0
  while [ $i -lt 90 ]; do
    incus exec "$1" -- true </dev/null >/dev/null 2>&1 && return 0
    i=$((i + 1)); sleep 2
  done
  echo "!! $1 で exec が 180 秒通らなかった"; return 1
}

step() { echo; echo "===== $*"; }

step "0. 前提"
incus version </dev/null
id
ls -l /dev/kvm 2>&1
cat /sys/module/kvm_amd/parameters/nested /sys/module/kvm_intel/parameters/nested 2>/dev/null

step "0b. 区画 $PROJ の制限（restricted.*）"
incus project show "$PROJ" </dev/null | grep -E 'restricted|features' || echo "（取れなかった）"

step "0c. ③の件：banto 開発の Project のコンテナが持つ disk デバイス"
for c in $(incus list -f csv -c n </dev/null | grep '^banto-'); do
  echo "--- $c"
  incus config device show "$c" </dev/null | grep -B1 -A4 'type: disk' | grep -E '^[a-z]|source|path|readonly'
done

step "1. VM を作れるか（制限つき区画で）"
if incus init "$IMG" "$P-vm" --vm -c limits.cpu=2 -c limits.memory=2GiB </dev/null; then
  touch "$DIR/from-host"
  # 起動前に足す（VM への disk の後付けに頼らない）
  incus config device add "$P-vm" probe disk source="$DIR" path=/mnt/probe </dev/null
  if incus start "$P-vm" </dev/null && wait_exec "$P-vm"; then
    incus exec "$P-vm" -- uname -r </dev/null

    step "2. VM の中で /dev/kvm が使えるか（入れ子の仮想化）"
    incus exec "$P-vm" -- sh -c 'ls -l /dev/kvm; grep -m1 -oE "\b(vmx|svm)\b" /proc/cpuinfo' </dev/null

    step "3. VM へのフォルダの受け渡し（何で繋がるか・持ち主がどう見えるか）"
    incus exec "$P-vm" -- sh -c 'grep /mnt/probe /proc/mounts; ls -ln /mnt/probe' </dev/null
    incus exec "$P-vm" -- sh -c 'touch /mnt/probe/from-vm-root && echo "root で書けた"' </dev/null
    incus exec "$P-vm" -- sh -c 'id ubuntu >/dev/null 2>&1 || useradd -u 1000 -m ubuntu; su ubuntu -c "touch /mnt/probe/from-vm-uid1000" && echo "uid 1000 で書けた"' </dev/null
    echo "--- host 側で見た持ち主"
    ls -ln "$DIR"
  else
    echo "!! VM が起動しなかった"
  fi
else
  echo "!! VM を作れなかった（区画の制限の可能性。0b を見る）"
fi

step "4. コンテナに /dev/kvm を渡せるか"
if incus init "$IMG" "$P-ct" </dev/null; then
  incus config device add "$P-ct" kvm unix-char source=/dev/kvm </dev/null || echo "!! 足せなかった"
  step "5. コンテナの入れ子を許せるか"
  incus config set "$P-ct" security.nesting=true </dev/null && echo "security.nesting=true を設定できた"
  if incus start "$P-ct" </dev/null && wait_exec "$P-ct"; then
    incus exec "$P-ct" -- ls -l /dev/kvm </dev/null
  else
    echo "!! コンテナが起動しなかった（/dev/kvm を足したせいか切り分けるため、次の行で外して起こす）"
    incus config device remove "$P-ct" kvm </dev/null && incus start "$P-ct" </dev/null && echo "外すと起動した"
  fi
else
  echo "!! コンテナを作れなかった"
fi

step "おわり（試しのものは後片付けで消す）"

#!/usr/bin/env bash
# 別のサーバを banto の「実行場所」にする前の下ごしらえ（使い方：docs/runbooks/runtime-setup.md、決まり：docs/specs/v4-security.md §1
# 「実行場所の下ごしらえのスクリプト」）。向こうのサーバで root として打つ：
#
#   curl -fsSL https://banto.tjst-t.dev/runtime-setup.sh | sudo bash -s -- --pubkey "ssh-ed25519 AAAA… banto"
#
# すること：banto 専用のユーザー（既定 banto）を作り、パスワード無しの sudo を許し、渡された公開鍵で SSH に入れるようにする。
# 前提の道具（git・curl・tar・tmux・rsync など）・sshd の転送の許可・linger を整え、`--mode containers`（既定）なら Incus を
# 入れて banto のユーザーを incus グループに入れる。区画の設定・置き場 banto などの残りは、banto の画面で登録するときに banto が
# sudo -n で整える（「足りないものは banto が入れる」）。
#
# 何度打っても壊れない：済んでいるものは確かめて飛ばす。公開鍵は足すだけで、ほかの鍵は消さない。
#
# 試験のための差し替え（人は使わない）：BANTO_SETUP_LIB=1（関数を読み込むだけで流さない）。

set -euo pipefail
set -o errtrace

# Zabbly（Incus の配布元）の鍵の指紋。**写し**：install.sh の ZABBLY_FPR・packages/core/src/runtime/containers-host.ts の ZABBLY_FPR
ZABBLY_FPR=4EFC590696CB15B87C73A3AD82CC8797C838DCFD
# banto の sshd の設定。**写し**：packages/core/src/runtime/host-autoprep.ts の SSHD_CONF・SSHD_LINES
SSHD_CONF=/etc/ssh/sshd_config.d/00-banto.conf
SSHD_LINES=("AllowTcpForwarding yes" "AllowStreamLocalForwarding yes" "MaxSessions 20")

USER_NAME=banto
MODE=containers
PUBKEYS=()

CURRENT_STEP="始める前"
STEP_NO=0
STEP_TOTAL=7

step() {
  STEP_NO=$((STEP_NO + 1))
  CURRENT_STEP=$1
  printf '\n\033[1m==> [%d/%d] %s\033[0m\n' "$STEP_NO" "$STEP_TOTAL" "$1"
}
say() { printf '    %s\n' "$*"; }
ok() { printf '    \033[32m✔\033[0m %s\n' "$*"; }
warn() { printf '    \033[33m!\033[0m %s\n' "$*" >&2; }
die() {
  printf '\n\033[31m✖ 段「%s」で止まりました。%s\033[0m\n' "$CURRENT_STEP" "$1" >&2
  printf '  直し方：%s\n' "${2:-上の出力に出ている原因を直してください}" >&2
  printf '  直したら同じコマンドを打ち直してください（済んだものは確かめて飛ばします）。\n' >&2
  exit 1
}
on_error() {
  printf '\n\033[31m✖ 段「%s」で、思っていなかった失敗で止まりました（runtime-setup.sh の %s 行目・終了コード %s）。\033[0m\n' "$CURRENT_STEP" "$2" "$1" >&2
  printf '  原因は上の出力にあります。直したら同じコマンドを打ち直してください。\n' >&2
}

usage() {
  cat <<'USAGE'
別のサーバを banto の実行場所にする前の下ごしらえ（Ubuntu 24.04・26.04。root で打つ）

  curl -fsSL https://banto.tjst-t.dev/runtime-setup.sh | sudo bash -s -- --pubkey "<公開鍵>" [オプション]

  --pubkey <公開鍵>       banto がこのサーバに入るときの SSH の公開鍵（ssh-ed25519 AAAA… の1行）。何度でも渡せる。
                          banto の設定「実行場所」で鍵を選ぶと、その公開鍵が出る
  --pubkey-file <ファイル> 公開鍵をファイルから読む（1行に1つ）
  --user <名前>           banto 専用のユーザーの名前（既定 banto）。無ければ作る
  --mode <動かし方>       containers（既定。Project ごとに Incus のコンテナを立てる。Incus を入れる）か
                          machine（サーバ丸ごとを 1 Project の箱にする。Incus は入れない）
  -h, --help              これを出す
USAGE
}

# 公開鍵の形（種類・base64・コメント）
valid_pubkey() {
  [[ $1 =~ ^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(256|384|521)|sk-ssh-ed25519@openssh\.com|sk-ecdsa-sha2-nistp256@openssh\.com)\ [A-Za-z0-9+/]+={0,3}(\ [^[:cntrl:]]*)?$ ]]
}

parse_args() {
  while [[ $# -gt 0 ]]; do
    case $1 in
      --pubkey) [[ $# -ge 2 ]] || die "--pubkey に値がありません" "--pubkey \"ssh-ed25519 AAAA…\" の形で渡してください"; PUBKEYS+=("$2"); shift 2 ;;
      --pubkey=*) PUBKEYS+=("${1#--pubkey=}"); shift ;;
      --pubkey-file)
        [[ $# -ge 2 && -r $2 ]] || die "--pubkey-file のファイルを読めません" "読めるファイルを渡してください"
        while IFS= read -r line || [[ -n $line ]]; do [[ -n ${line// /} && $line != \#* ]] && PUBKEYS+=("$line"); done <"$2"
        shift 2 ;;
      --user) [[ $# -ge 2 ]] || die "--user に値がありません"; USER_NAME=$2; shift 2 ;;
      --user=*) USER_NAME=${1#--user=}; shift ;;
      --mode) [[ $# -ge 2 ]] || die "--mode に値がありません"; MODE=$2; shift 2 ;;
      --mode=*) MODE=${1#--mode=}; shift ;;
      -h | --help) usage; exit 0 ;;
      *) usage >&2; die "知らないオプション $1 です" "上の使い方を見てください" ;;
    esac
  done
  [[ $MODE == containers || $MODE == machine ]] || die "--mode は containers か machine です（$MODE）"
  [[ $USER_NAME =~ ^[a-z_][a-z0-9_-]{0,31}$ ]] || die "ユーザーの名前 $USER_NAME は使えません" "英小文字で始まる 32 字までの名前にしてください"
  [[ $USER_NAME != root ]] || die "root では登録できません" "banto 専用のユーザーの名前を渡してください（既定 banto）"
  local k
  for k in "${PUBKEYS[@]}"; do
    valid_pubkey "$k" || die "公開鍵の形が違います：${k:0:40}…" "ssh-ed25519 AAAA… の1行（秘密鍵ではなく公開鍵）を渡してください"
  done
  if [[ ${#PUBKEYS[@]} -eq 0 ]]; then
    warn "公開鍵が渡されていません。ユーザーは作りますが、banto が SSH で入るには --pubkey を付けて打ち直してください"
  fi
}

apt_get() { DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=l apt-get -o DPkg::Lock::Timeout=300 -q "$@"; }

# ---------------------------------------------------------------------------
# 1. このサーバを確かめる
# ---------------------------------------------------------------------------

step_check() {
  step "このサーバを確かめる"
  [[ $(id -u) == 0 ]] || die "root で打たれていません" "curl … | sudo bash -s -- … の形で、sudo を付けて打ってください"
  [[ -r /etc/os-release ]] || die "/etc/os-release がありません（Ubuntu ではないようです）" "Ubuntu 24.04 か 26.04 で打ってください"
  local id version
  # shellcheck disable=SC1091 # 向こうのファイル
  read -r id version CODENAME < <(. /etc/os-release && echo "${ID:-?} ${VERSION_ID:-?} ${VERSION_CODENAME:-?}")
  [[ $id == ubuntu ]] || die "このサーバは $id です。対象は Ubuntu 24.04・26.04 だけです" "Ubuntu 24.04 か 26.04 で打ってください"
  case $version in
    24.04) INCUS_CHANNEL=lts-6.0 ;;
    26.04) INCUS_CHANNEL=stable ;; # lts-6.0 には resolute が無く、Ubuntu の 6.0.5 は banto の前提 6.0.6 に足りない
    *) die "Ubuntu $version です。対象は 24.04・26.04 だけです" "Incus（6.0.6 以降）を入れる道を確かめてあるのがこの2つだけのためです" ;;
  esac
  ARCH=$(dpkg --print-architecture)
  [[ $ARCH == amd64 || $ARCH == arm64 ]] || die "CPU の種類 $ARCH には対応していません" "amd64 か arm64 のサーバで打ってください"
  ok "Ubuntu $version（$ARCH）・動かし方 $MODE・ユーザー $USER_NAME"
  if command -v cloud-init >/dev/null 2>&1; then
    say "cloud-init が終わるのを待つ（apt を取り合わないため。最長 10 分）"
    timeout 600 cloud-init status --wait >/dev/null 2>&1 || true
  fi
}

# ---------------------------------------------------------------------------
# 2. 前提の道具
# ---------------------------------------------------------------------------

step_packages() {
  step "前提の道具を入れる"
  local want=(sudo openssh-server openssh-client git curl ca-certificates tar tmux rsync dbus-user-session gpg)
  [[ $MODE == containers ]] && want+=(btrfs-progs)
  local missing=() p
  for p in "${want[@]}"; do
    dpkg-query -W -f='${Status}' "$p" 2>/dev/null | grep -q 'install ok installed' || missing+=("$p")
  done
  if [[ ${#missing[@]} -eq 0 ]]; then
    ok "入っています（${want[*]}）"
    return
  fi
  say "入れる：${missing[*]}"
  apt_get update
  apt_get install -y --no-install-recommends "${missing[@]}"
  ok "入れました"
}

# ---------------------------------------------------------------------------
# 3. banto 専用のユーザーとパスワード無しの sudo
# ---------------------------------------------------------------------------

step_user() {
  step "banto 専用のユーザー（$USER_NAME）とパスワード無しの sudo"
  if id "$USER_NAME" >/dev/null 2>&1; then
    ok "ユーザー $USER_NAME はあります"
  else
    useradd -m -s /bin/bash -U "$USER_NAME"
    ok "ユーザー $USER_NAME を作りました（パスワードは設定しません。SSH の鍵だけで入ります）"
  fi
  local sudoers=/etc/sudoers.d/banto-$USER_NAME tmp
  tmp=$(mktemp)
  printf '# banto が登録・確かめ直しのときに sudo -n で準備する（runtime-setup.sh が書いた）\n%s ALL=(ALL) NOPASSWD:ALL\n' "$USER_NAME" >"$tmp"
  visudo -cf "$tmp" >/dev/null || { rm -f "$tmp"; die "sudoers の書式の確かめが通りません"; }
  if [[ -f $sudoers ]] && cmp -s "$tmp" "$sudoers"; then
    rm -f "$tmp"
    ok "パスワード無しの sudo は許してあります（$sudoers）"
  else
    install -m 0440 -o root -g root "$tmp" "$sudoers"
    rm -f "$tmp"
    ok "パスワード無しの sudo を許しました（$sudoers）"
  fi
}

# ---------------------------------------------------------------------------
# 4. 公開鍵
# ---------------------------------------------------------------------------

step_pubkey() {
  step "banto が SSH で入る公開鍵"
  if [[ ${#PUBKEYS[@]} -eq 0 ]]; then
    warn "公開鍵は渡されていないので飛ばします"
    return
  fi
  local home dir file k body added=0
  home=$(getent passwd "$USER_NAME" | cut -d: -f6)
  dir=$home/.ssh
  file=$dir/authorized_keys
  install -d -m 0700 -o "$USER_NAME" -g "$(id -gn "$USER_NAME")" "$dir"
  [[ -f $file ]] || install -m 0600 -o "$USER_NAME" -g "$(id -gn "$USER_NAME")" /dev/null "$file"
  for k in "${PUBKEYS[@]}"; do
    body=$(awk '{print $1" "$2}' <<<"$k")
    if grep -qF -- "$body" "$file"; then
      ok "入っています：${k:0:40}…"
    else
      printf '%s\n' "$k" >>"$file"
      added=$((added + 1))
      ok "足しました：${k:0:40}…"
    fi
  done
  chown "$USER_NAME:$(id -gn "$USER_NAME")" "$file"
  chmod 0600 "$file"
  [[ $added -eq 0 ]] || say "ほかの鍵は消していません"
}

# ---------------------------------------------------------------------------
# 5. sshd
# ---------------------------------------------------------------------------

step_sshd() {
  step "sshd の転送の許可（banto との行き来は SSH の転送を通る）"
  local want tmp had=0
  want=$(printf '%s\n' "${SSHD_LINES[@]}")
  if [[ -f $SSHD_CONF ]] && [[ $(cat "$SSHD_CONF") == "$want" ]]; then
    ok "書いてあります（$SSHD_CONF）"
  else
    tmp=$(mktemp)
    [[ -f $SSHD_CONF ]] && { cp -p "$SSHD_CONF" "$tmp"; had=1; }
    printf '%s\n' "$want" >"$SSHD_CONF"
    chmod 0644 "$SSHD_CONF"
    # 入れた直後は sshd がまだ一度も起きておらず（Ubuntu 24.04 はソケットで起こす）、sshd -t が要る /run/sshd が無い
    install -d -m 0755 /run/sshd
    if ! sshd -t; then
      if [[ $had == 1 ]]; then mv "$tmp" "$SSHD_CONF"; else rm -f "$SSHD_CONF" "$tmp"; fi
      die "sshd -t が通らないので元に戻しました" "sshd の設定（/etc/ssh/sshd_config と sshd_config.d）を確かめてください"
    fi
    rm -f "$tmp"
    ok "書きました（$SSHD_CONF：${SSHD_LINES[*]}）"
  fi
  systemctl enable --now ssh.service >/dev/null 2>&1 || systemctl enable --now ssh.socket >/dev/null 2>&1 || true
  systemctl reload ssh.service 2>/dev/null || systemctl reload sshd.service 2>/dev/null || true
}

# ---------------------------------------------------------------------------
# 6. linger とユーザーの systemd
# ---------------------------------------------------------------------------

step_linger() {
  step "SSH を閉じても動き続ける設定（linger）"
  if ! loginctl enable-linger "$USER_NAME" 2>/dev/null; then
    # コンテナの中などで logind が断ることがある——印のファイルを直に置く（banto の Project のコンテナと同じ手当て）
    mkdir -p /var/lib/systemd/linger && touch "/var/lib/systemd/linger/$USER_NAME"
    warn "loginctl enable-linger が断られたので、印のファイル /var/lib/systemd/linger/$USER_NAME を置きました"
  fi
  systemctl start "user@$(id -u "$USER_NAME").service" || warn "ユーザーの systemd（user@$(id -u "$USER_NAME")）を起こせませんでした"
  ok "linger を入れ、ユーザーの systemd を起こしました"
}

# ---------------------------------------------------------------------------
# 7. Incus（containers）
# ---------------------------------------------------------------------------

incus_version_ok() {
  local ver=${1%%[-~+]*} a b c
  IFS=. read -r a b c <<<"$ver"
  a=${a:-0} b=${b:-0} c=${c:-0}
  if [[ $a == 6 && $b == 0 ]]; then ((c >= 6)); else ((a > 6 || (a == 6 && b >= 19))); fi
}

zabbly_key_ok() {
  local colons pubs fpr
  colons=$(gpg --show-keys --with-colons "$1" 2>/dev/null) || return 1
  pubs=$(grep -c '^pub:' <<<"$colons" || true)
  fpr=$(awk -F: '$1 == "pub" { p = 1; next } p && $1 == "fpr" { print $10; exit }' <<<"$colons")
  [[ $pubs == 1 && $fpr == "$ZABBLY_FPR" ]]
}

step_incus() {
  step "Incus（Project ごとのコンテナ）"
  if [[ $MODE != containers ]]; then
    ok "machine なので入れません"
    return
  fi
  local version=""
  version=$(dpkg-query -W -f='${Version}' incus 2>/dev/null | sed 's/^[0-9]*://') || true
  if [[ -n $version ]] && incus_version_ok "$version"; then
    ok "Incus $version は入っています"
  else
    say "Incus を入れる（Zabbly の $INCUS_CHANNEL${version:+。いまは $version}）"
    local key
    key=$(mktemp)
    curl -fsSL https://pkgs.zabbly.com/key.asc -o "$key" || die "Zabbly の鍵を取ってこられませんでした" "https://pkgs.zabbly.com に届くか確かめてください"
    zabbly_key_ok "$key" || { rm -f "$key"; die "Zabbly の鍵が思っていたものと違います（公開鍵が1つで、指紋が $ZABBLY_FPR であること）" "鍵がすり替えられているおそれがあります。https://github.com/zabbly/incus の指紋と比べてください"; }
    install -d -m 0755 /etc/apt/keyrings
    install -m 0644 "$key" /etc/apt/keyrings/zabbly.asc
    rm -f "$key"
    cat >"/etc/apt/sources.list.d/zabbly-incus-$INCUS_CHANNEL.sources" <<EOF
Enabled: yes
Types: deb
URIs: https://pkgs.zabbly.com/incus/$INCUS_CHANNEL
Suites: $CODENAME
Components: main
Architectures: $ARCH
Signed-By: /etc/apt/keyrings/zabbly.asc
EOF
    apt_get update
    apt_get install -y --no-install-recommends incus
    version=$(dpkg-query -W -f='${Version}' incus | sed 's/^[0-9]*://')
    incus_version_ok "$version" || die "入った Incus $version は banto の前提（6.0.6 以降）に足りません" "apt-cache policy incus で Zabbly の版が選ばれているか確かめてください"
    ok "Incus $version を入れました"
  fi
  incus admin waitready --timeout 120 >/dev/null 2>&1 || true
  if ! incus profile device get default root pool </dev/null >/dev/null 2>&1; then
    incus admin init --minimal </dev/null
    ok "Incus を初期化しました（incus admin init --minimal）"
  fi
  # banto のユーザーは incus グループだけ（incus-admin に入っていると、制限の無い管理の口に繋がる）
  if id -nG "$USER_NAME" | tr ' ' '\n' | grep -qx incus-admin; then
    gpasswd -d "$USER_NAME" incus-admin >/dev/null
    ok "$USER_NAME を incus-admin から外しました"
  fi
  if ! id -nG "$USER_NAME" | tr ' ' '\n' | grep -qx incus; then
    usermod -aG incus "$USER_NAME"
    ok "$USER_NAME を incus グループに入れました"
  fi
  systemctl enable --now incus-user.socket >/dev/null 2>&1 || true
  # グループを替えたので、ユーザーの systemd を新しいグループで起こし直す（古いグループのまま残るため）
  systemctl restart "user@$(id -u "$USER_NAME").service" || true
  say "区画の設定（proxy device の許可・uid の対応）と置き場 banto は、banto の画面で登録するときに banto が整えます"
}

summary() {
  local addrs port fprs
  # 外へ出る経路のアドレス（Incus のブリッジ incusbr0 等のアドレスを出さない）
  addrs=$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{ for (i = 1; i < NF; i++) if ($i == "src") { print $(i + 1); exit } }') || true
  port=$(sshd -T 2>/dev/null | awk '$1 == "port" { print $2; exit }') || true
  fprs=$(for f in /etc/ssh/ssh_host_ed25519_key.pub /etc/ssh/ssh_host_ecdsa_key.pub; do [[ -r $f ]] && ssh-keygen -lf "$f"; done 2>/dev/null) || true
  printf '\n\033[1m下ごしらえが済みました。banto の設定「実行場所」の「別のサーバを登録」で次を入れてください：\033[0m\n'
  say "動かし方：$([[ $MODE == containers ]] && echo "Project ごとのコンテナ（containers）" || echo "サーバ丸ごと（machine）")"
  say "名前：$(hostname -s)（好きな名前で構いません）"
  say "ホスト：${addrs:-（このサーバの IP か名前）}"
  say "ユーザー：$USER_NAME"
  say "ポート：${port:-22}"
  say "SSH 鍵：--pubkey で渡した公開鍵の、banto の Vault の鍵"
  say "host 鍵の指紋（登録の画面に出るものと同じか見比べる）："
  while IFS= read -r l; do [[ -n $l ]] && say "  $l"; done <<<"$fprs"
}

main() {
  trap 'on_error $? $LINENO' ERR
  parse_args "$@"
  step_check
  step_packages
  step_user
  step_pubkey
  step_sshd
  step_linger
  step_incus
  summary
}

if [[ ${BANTO_SETUP_LIB:-} != 1 ]]; then
  main "$@"
fi

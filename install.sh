#!/usr/bin/env bash
# banto を新しいホストに入れる（使い方：docs/runbooks/install.md、何をするか：docs/specs/v4-security.md §1「入れ方」）。
#
#   curl -fsSL https://raw.githubusercontent.com/tjst-t/banto/release/install.sh | bash -s -- --domain <名前> [--cloudflare-token <トークン>]
#
# 何度打っても壊れない：済んだ段は確かめて飛ばす。2回目からは release の最新を取り込み、build して、
# 動いているものが無くなってから起こし直す。決めた値は /etc/banto/install.conf に覚える（秘密は覚えない）。
#
# **トークンをログ・画面・コマンド行に出さない**——set -x を使わない。Cloudflare の API は node から呼び、
# トークンは環境変数で渡す。保存するのは /etc/caddy/cloudflare.env（root:caddy 0640）だけ。
#
# **sudo の記憶を、取ってきたコードに使わせない**：root が要る段を先にまとめ、npm の依存・build・Claude の installer
# （ユーザーの権限で走る、外から取ってきたもの）を流す前に sudo の記憶を消し（sudo -K）、setsid で端末から切り離して
# 流す。build のあとに root が要る段（前提の確かめ・起こす・起こし直す）は、sudo を取り直してから行う。
#
# 試験のための差し替え（人は使わない）：BANTO_CLOUDFLARE_API（Cloudflare の API の基点）、
# BANTO_INSTALL_LIB=1（関数を読み込むだけで流さない——banto/scripts/install-test/ が使う）。

set -euo pipefail
set -o errtrace

# ---------------------------------------------------------------------------
# 固定の値
# ---------------------------------------------------------------------------

# Node：LTS 24 系を版で固定し、公式の SHASUMS256.txt の値と照合する（2026-10-04 時点の最新）
NODE_VERSION=24.21.0
# shellcheck disable=SC2034 # step_node が NODE_SHA256_$NODE_ARCH で引く
NODE_SHA256_x64=fd8e59d5a511510f6a298afb548f18c7d2b1be404d8b4a27d94fbe49f56cb2d6
# shellcheck disable=SC2034
NODE_SHA256_arm64=6ad1325edbdb5649c379b75a237147a666c95d4f9ae8d340fef2d1575d289ad2
# sops（同梱の vault-local が秘密を暗号化して置くのに使う。Ubuntu の apt に無いので公式の配布物を版で固定して照合）
SOPS_VERSION=3.13.3
# shellcheck disable=SC2034 # step_base_packages が SOPS_SHA256_$CADDY_ARCH で引く
SOPS_SHA256_amd64=e5bec3346a873ae91d871550f3e698c1aad962aff462a080e40f25fde17fef6b
# shellcheck disable=SC2034
SOPS_SHA256_arm64=53b0abacd38ef1b12a66d6c100956691b9cefce018d91f81e73ddf7438b94d77
# Zabbly（Incus の配布元）の鍵の指紋（https://github.com/zabbly/incus の README の値）
ZABBLY_FPR=4EFC590696CB15B87C73A3AD82CC8797C838DCFD
# Caddy：caddyserver.com の download API は版を選べない（version= を渡しても最新が来る。2026-10-04 に確かめた）。
# 版は固定できないので、取ってきた版を出し、banto が頼る機能（handle_response・headers の正規表現）のある版以上かだけ見る
CADDY_MIN_VERSION=2.5.0
# Cloudflare のレコードに付ける印（これが付いていて、このホストの IP を向くものだけを、名前を替えたときに消す）
CF_RECORD_MARK="banto install.sh"

DEFAULT_REPO=https://github.com/tjst-t/banto
# 取ってくるのは release だけ。**写し**：update.mjs の FETCH_REFSPEC・setup-update.sh の FETCH_REFSPEC・
# packages/core/src/self-update/self-update.ts の FETCH_REFSPEC（片方を変えたら全部）
FETCH_REFSPEC="+refs/heads/release:refs/remotes/origin/release"
# 打ち直しで「上げる」とき、動いているもの（会話・サブエージェントの仕事・Module の呼び出し）が無くなるのを待つ上限（分）。
# update.mjs 自身は待ち続ける（画面から人がやめられる）が、install.sh は端末の前の人が打つもので、終わらないと困るので切る。
# 切るときは update.mjs の「やめる印」（cancel）を置く——作りかけを消し、今の版のまま終わる（update.mjs の契約）
WAIT_LIMIT_MIN=30
INSTALL_CONF=/etc/banto/install.conf
CF_ENV=/etc/caddy/cloudflare.env
CADDY_BIN=/usr/local/bin/caddy
CADDY_UNIT=/etc/systemd/system/caddy.service
CADDY_DROPIN=/etc/systemd/system/caddy.service.d/50-banto.conf
BANTO_POOL=banto
# 口の既定。**真実は config.json**（port・sandboxPort・uiPort）——step_config が書いて読み戻し、Caddy・unit・nftables はそれを使う
PORT_HOST=4737
PORT_SANDBOX=4176
PORT_UI=4175

export PATH="/usr/local/bin:$PATH"

# ---------------------------------------------------------------------------
# 出力
# ---------------------------------------------------------------------------

CURRENT_STEP="始める前"
STEP_NO=0
STEP_TOTAL=15

step() {
  STEP_NO=$((STEP_NO + 1))
  CURRENT_STEP=$1
  printf '\n\033[1m==> [%d/%d] %s\033[0m\n' "$STEP_NO" "$STEP_TOTAL" "$1"
}
say() { printf '    %s\n' "$*"; }
ok() { printf '    \033[32m✔\033[0m %s\n' "$*"; }
warn() { printf '    \033[33m!\033[0m %s\n' "$*" >&2; }

# 何が足りないか（1つ目）と直し方（2つ目）を出して止まる
die() {
  printf '\n\033[31m✖ 段「%s」で止まりました。%s\033[0m\n' "$CURRENT_STEP" "$1" >&2
  printf '  直し方：%s\n' "${2:-上の出力に出ている原因を直してください}" >&2
  printf '  直したら同じコマンドを打ち直してください（済んだ段は確かめて飛ばします）。\n' >&2
  exit 1
}

on_error() {
  printf '\n\033[31m✖ 段「%s」で、思っていなかった失敗で止まりました（install.sh の %s 行目・終了コード %s）。\033[0m\n' "$CURRENT_STEP" "$2" "$1" >&2
  printf '  原因は上の出力にあります。直したら同じコマンドを打ち直してください（済んだ段は確かめて飛ばします）。\n' >&2
}

usage() {
  cat <<'USAGE'
banto を入れる（Ubuntu 24.04・26.04。sudo できる普通のユーザーで打つ。動かすのもそのユーザー）

  curl -fsSL https://raw.githubusercontent.com/tjst-t/banto/release/install.sh | bash -s -- --domain <名前> [オプション]

  --domain <名前>            画面の名前（例 banto.example.com）。初回は必須。sandbox.<名前>・*.<名前> も使う
  --cloudflare-token <値>    Cloudflare の API トークン（Zone:Read と DNS:Edit）。渡すと DNS のレコードを作り、
                             Let's Encrypt の証明書を取る。"-" なら端末から見えない形で聞く。
                             環境変数 CLOUDFLARE_API_TOKEN でも渡せる。無ければ Caddy の内部の CA で HTTPS にする
  --no-cloudflare            Cloudflare をやめて内部の CA に戻す（保存したトークンを消す。DNS のレコードは残す）
  --ip <IPv4>                DNS のレコードの向け先（既定：既定経路のインターフェースの IPv4）
  --repo <URL|パス>          取ってくるリポジトリ（既定 https://github.com/tjst-t/banto。file://・パス・bundle も可）。
                             取ってくるのはその release ブランチ（更新の本体 update.mjs が release 固定のため）
  --pool-size <N>GiB         Incus の置き場 banto の大きさ（/ が btrfs でないときのループファイル。既定：空きの半分、最大 50GiB）
  --no-claude-login          Claude のログインをその場で流さない（打つコマンドを出すだけ）
  --help                     これを出す

打ち直すと、渡した値だけが変わり、渡さなかった値は前のまま（/etc/banto/install.conf）。
USAGE
}

# ---------------------------------------------------------------------------
# 小さな道具
# ---------------------------------------------------------------------------

# 標準入力の中身を root のファイルに置く。中身・権限・持ち主が同じなら触らない。
# 変えたかどうかは FILE_CHANGED（1/0）に入れる——戻り値で返すと if の中で set -e が効かなくなるため。
# **パイプで流し込まない**（`… | put_root_file` は右側が別のシェルになり、FILE_CHANGED が消える——Caddy の設定を
# 変えても reload しなかった）。`< <(…)` か here-doc で渡す
FILE_CHANGED=0
put_root_file() {
  local path=$1 mode=$2 owner=${3:-root:root} tmp
  tmp=$(mktemp)
  cat >"$tmp"
  if sudo test -f "$path" && sudo cmp -s "$tmp" "$path" && [[ "$(sudo stat -c '%a %U:%G' "$path")" == "$mode $owner" ]]; then
    FILE_CHANGED=0
  else
    sudo install -D -m "$mode" -o "${owner%%:*}" -g "${owner#*:}" "$tmp" "$path"
    FILE_CHANGED=1
  fi
  rm -f "$tmp"
}

# **パイプの右に grep -q を置かない**：pipefail の下では、grep -q が先に終わると左が SIGPIPE で落ち、見つかったのに
# 偽になる（試験で1度落ちた）。grep … >/dev/null は入力を最後まで読む
pkg_installed() { dpkg-query -W -f='${Status}' "$1" 2>/dev/null | grep 'install ok installed' >/dev/null; }

APT_UPDATED=0
apt_update() {
  if [[ $APT_UPDATED == 0 ]]; then
    sudo env DEBIAN_FRONTEND=noninteractive apt-get -o DPkg::Lock::Timeout=300 update -q
    APT_UPDATED=1
  fi
}

# 入っていないものだけ入れる（推奨パッケージは入れない）
apt_install() {
  local missing=() p
  for p in "$@"; do pkg_installed "$p" || missing+=("$p"); done
  [[ ${#missing[@]} == 0 ]] && return 0
  say "apt で入れる：${missing[*]}"
  apt_update
  sudo env DEBIAN_FRONTEND=noninteractive apt-get -o DPkg::Lock::Timeout=300 install -y -q --no-install-recommends "${missing[@]}"
}

have_tty() { { : </dev/tty; } 2>/dev/null; }

unit_active() { systemctl is-active --quiet "$1"; }

# a.b.c が min 以上か
version_at_least() {
  local i
  local -a v m
  IFS=. read -ra v <<<"$1"
  IFS=. read -ra m <<<"$2"
  for i in 0 1 2; do
    ((${v[i]:-0} == ${m[i]:-0})) && continue
    ((${v[i]:-0} > ${m[i]:-0}))
    return
  done
}

# Incus の版が banto の前提（6.0.x なら 6.0.6 以降、それより上は 6.19 以降）を満たすか
# （banto/packages/container/src/prereqs.ts の versionHasNestingFix と同じ規則）
incus_version_ok() {
  local ver=${1%%[-~+]*}
  if [[ $ver == 6.0.* || $ver == 6.0 ]]; then version_at_least "$ver" 6.0.6; else version_at_least "$ver" 6.19.0; fi
}

# Zabbly の鍵の束：公開鍵が1つだけで、その指紋が決めた値のときだけ通す（束に別の鍵が混ざっていたら断る）
zabbly_key_ok() {
  local colons pubs fpr
  colons=$(gpg --show-keys --with-colons "$1" 2>/dev/null) || return 1
  pubs=$(grep -c '^pub:' <<<"$colons" || true)
  fpr=$(awk -F: '$1 == "pub" { p = 1; next } p && $1 == "fpr" { print $10; exit }' <<<"$colons")
  [[ $pubs == 1 && $fpr == "$ZABBLY_FPR" ]]
}

# caddy のユーザーのホーム（内部の CA の置き場の上）。無ければ止まる——空のまま組むと / の下を指してしまう
caddy_home() {
  local h
  h=$(getent passwd caddy | cut -d: -f6)
  [[ -n $h ]] || die "caddy のユーザーのホームが分かりません（getent passwd caddy が空）" "sudo usermod -d /var/lib/caddy caddy でホームを決めてから打ち直してください"
  printf '%s\n' "$h"
}

# --- sudo の記憶 ---
SUDO_KEEPALIVE=""
start_sudo_keepalive() {
  # 長い待ち（restart-when-idle の最長 30 分など）の間に記憶が切れないように
  (while kill -0 "$$" 2>/dev/null; do sudo -n true 2>/dev/null; sleep 50; done) >/dev/null 2>&1 &
  SUDO_KEEPALIVE=$!
}
stop_sudo_keepalive() {
  if [[ -n $SUDO_KEEPALIVE ]]; then
    kill "$SUDO_KEEPALIVE" 2>/dev/null || true
    wait "$SUDO_KEEPALIVE" 2>/dev/null || true
    SUDO_KEEPALIVE=""
  fi
}
# 取ってきたもの（npm の依存・build・Claude の installer）を流す前に、sudo の記憶を消す
drop_sudo() {
  stop_sudo_keepalive
  sudo -K
  say "sudo の記憶を消した（ここからはユーザー $USER_NAME の権限だけで、端末から切り離して流す：$1）"
}
# build のあとに root が要る段の前に取り直す。パスワードが要る人には、もう一度聞く
reacquire_sudo() {
  say "もう一度 sudo を使う（$1。パスワードを聞かれたら $USER_NAME のパスワード）"
  sudo true || die "sudo を取り直せませんでした（取ってきたコードを流す間は sudo の記憶を消すので、もう一度要ります）" \
    "端末から打つか、パスワード無しで sudo できるユーザーで打ってください"
  start_sudo_keepalive
}
# ユーザーの権限で、端末から切り離して流す（出力はパイプを通す——端末の装置を子に渡さない）
run_detached() {
  setsid --wait "$@" </dev/null 2>&1 | sed 's/^/      /'
}

# ---------------------------------------------------------------------------
# 引数と覚えた値
# ---------------------------------------------------------------------------

ARG_DOMAIN="" ARG_IP="" ARG_REPO="" ARG_POOL_SIZE="" ARG_TOKEN="" ARG_TOKEN_SET=0 NO_CLAUDE_LOGIN=0 NO_CLOUDFLARE=0

parse_args() {
  while [[ $# -gt 0 ]]; do
    local opt=$1 val=""
    case $opt in
      --help | -h) usage; exit 0 ;;
      --no-claude-login) NO_CLAUDE_LOGIN=1; shift; continue ;;
      --no-cloudflare) NO_CLOUDFLARE=1; shift; continue ;;
      --branch | --branch=*)
        die "--branch はやめました（取ってくるのは --repo の release ブランチだけ）" \
          "画面からの更新（update.mjs）が release を取ってくる形に決まっているため。別のブランチを試すなら、それを release という名前で持つリポジトリを --repo に渡してください" ;;
      --*=*) val=${opt#*=}; opt=${opt%%=*}; shift ;;
      --domain | --cloudflare-token | --ip | --repo | --pool-size)
        [[ $# -ge 2 ]] || die "$opt に値がありません" "install.sh --help を見てください"
        val=$2; shift 2 ;;
      *) die "知らない引数です：$opt" "install.sh --help を見てください" ;;
    esac
    case $opt in
      --domain) ARG_DOMAIN=$val ;;
      --cloudflare-token) ARG_TOKEN=$val; ARG_TOKEN_SET=1 ;;
      --ip) ARG_IP=$val ;;
      --repo) ARG_REPO=$val ;;
      --pool-size) ARG_POOL_SIZE=$val ;;
      *) die "知らない引数です：$opt" "install.sh --help を見てください" ;;
    esac
  done
  if [[ $NO_CLOUDFLARE == 1 && $ARG_TOKEN_SET == 1 ]]; then
    die "--no-cloudflare と --cloudflare-token は一緒に渡せません" "どちらか一方にしてください"
  fi
}

# install.conf は「キー=値」の行だけを読む（キーは英小文字と _、値は前後の空白を落とす）。source しない
# ——中身をコードとして流さない
declare -A CONF=()
read_install_conf() {
  [[ -f $INSTALL_CONF ]] || return 0
  local line key value
  while IFS= read -r line || [[ -n $line ]]; do
    [[ $line =~ ^([a-z_]+)=(.*)$ ]] || continue
    key=${BASH_REMATCH[1]}
    value=${BASH_REMATCH[2]}
    value=${value#"${value%%[![:space:]]*}"}
    value=${value%"${value##*[![:space:]]}"}
    CONF[$key]=$value
  done <"$INSTALL_CONF"
}

# **最後まで通るのを待たずに、値を決めた時点で覚える**——1回目が途中で止まっても、打ち直しで --domain 等を
# 渡し直さずに続けられるように。秘密（トークン）は入れない
write_install_conf() {
  put_root_file "$INSTALL_CONF" 644 < <(
    echo "# banto の install.sh が覚えた値（秘密は入れない）。打ち直しで引数を渡せば変わり、渡さなければこのまま"
    echo "user=$USER_NAME"
    echo "domain=$DOMAIN"
    echo "ip=$IP_FIXED"
    echo "pool_size=$POOL_SIZE"
    echo "tls_mode=$TLS_REMEMBER"
  )
}

valid_domain() { [[ $1 =~ ^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$ ]]; }
valid_ipv4() { [[ $1 =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]]; }

default_ip() {
  ip -4 route get 1.1.1.1 2>/dev/null | awk '{for (i = 1; i < NF; i++) if ($i == "src") { print $(i + 1); exit }}'
}

# ---------------------------------------------------------------------------
# 1. ホストを確かめる
# ---------------------------------------------------------------------------

step_check_host() {
  step "ホストを確かめる"
  [[ $(id -u) != 0 ]] || die "root で打たれました。banto は root では動かしません" \
    "sudo できる普通のユーザーで打ってください（そのユーザーが banto を動かします）。例：su - <ユーザー> してから同じコマンド"
  [[ -r /etc/os-release ]] || die "/etc/os-release がありません（Ubuntu ではないようです）" "Ubuntu 24.04 か 26.04 に入れてください"
  local id version codename
  # shellcheck disable=SC1091 # ホストのファイル
  read -r id version codename < <(. /etc/os-release && echo "${ID:-?} ${VERSION_ID:-?} ${VERSION_CODENAME:-?}")
  [[ $id == ubuntu ]] || die "このホストは $id です。対象は Ubuntu 24.04・26.04 だけです" \
    "Incus の配布元（Zabbly）と banto の試験が Ubuntu の LTS に合わせてあるためです。Ubuntu 24.04 か 26.04 に入れてください"
  case $version in
    24.04) INCUS_CHANNEL=lts-6.0 ;;
    26.04) INCUS_CHANNEL=stable ;; # lts-6.0 には resolute が無く、Ubuntu の 6.0.5 は前提の 6.0.6 に足りない
    *) die "Ubuntu $version です。対象は 24.04・26.04 だけです" \
      "banto が要る Incus（6.0.6 以降）を入れる道を確かめてあるのがこの2つだけのためです。24.04 か 26.04 に入れてください" ;;
  esac
  UBUNTU_VERSION=$version UBUNTU_CODENAME=$codename
  case $(dpkg --print-architecture) in
    amd64) NODE_ARCH=x64 CADDY_ARCH=amd64 ;;
    arm64) NODE_ARCH=arm64 CADDY_ARCH=arm64 ;;
    *) die "CPU の種類 $(dpkg --print-architecture) には対応していません" "amd64 か arm64 のホストに入れてください" ;;
  esac
  [[ -d /run/systemd/system ]] || die "systemd で起動していません" "banto は systemd の unit で動かします。systemd のホストに入れてください"

  USER_NAME=$(id -un)
  USER_UID=$(id -u)
  USER_HOME=$(getent passwd "$USER_NAME" | cut -d: -f6)
  [[ -n $USER_HOME && -d $USER_HOME ]] || die "ユーザー $USER_NAME のホームが見つかりません" "ホームのあるユーザーで打ってください"

  say "sudo を確かめる（パスワードを聞かれたら、$USER_NAME のパスワードを打ってください）"
  # sudo -v ではなく sudo true——-v は当てはまる規則が全部 NOPASSWD でないとパスワードを求める（sudo グループの規則に
  # 当たる、クラウドのイメージの NOPASSWD のユーザーで、端末が無いと止まった）
  sudo true || die "sudo できませんでした" "sudo できるユーザーで打ってください（例：sudo usermod -aG sudo $USER_NAME のあと、ログインし直す）"
  start_sudo_keepalive

  REL="$USER_HOME/.local/share/banto-release" # 既定。step_config で config.json の releaseDir に合わせる
  CONFIG_PATH="$USER_HOME/.config/banto/config.json"
  ok "Ubuntu $UBUNTU_VERSION（$UBUNTU_CODENAME）・$(dpkg --print-architecture)・ユーザー $USER_NAME（uid $USER_UID）"
}

# ---------------------------------------------------------------------------
# 2. 値を決める（引数 → 覚えた値 → 既定）
# ---------------------------------------------------------------------------

step_resolve_settings() {
  step "値を決める"
  read_install_conf
  if [[ -n ${CONF[user]:-} && ${CONF[user]} != "$USER_NAME" ]]; then
    die "banto はユーザー ${CONF[user]} で入っています（$INSTALL_CONF）" \
      "${CONF[user]} で打ってください。動かすユーザーを替えるなら docs/runbooks/install.md の「入れ直す」"
  fi

  DOMAIN=${ARG_DOMAIN:-${CONF[domain]:-}}
  DOMAIN=${DOMAIN,,}
  [[ -n $DOMAIN ]] || die "--domain がありません（初回は必須）" "例：bash -s -- --domain banto.example.com"
  valid_domain "$DOMAIN" || die "名前が不正です：$DOMAIN" "英小文字・数字・ハイフンとドットの名前にしてください（例 banto.example.com）"

  IP_FIXED=${ARG_IP:-${CONF[ip]:-}}
  if [[ -n $IP_FIXED ]]; then
    valid_ipv4 "$IP_FIXED" || die "--ip が IPv4 ではありません：$IP_FIXED" "例：--ip 192.168.1.10"
    IP=$IP_FIXED
  else
    IP=$(default_ip || true)
  fi

  # 取り込み元は覚えない——真実は repo.git の origin（update.mjs もそれを使う）。渡されたときだけ、それに替える
  REPO=$ARG_REPO
  # ローカルのパス（bundle を含む）は絶対パスにする
  if [[ -n $REPO && $REPO != *://* && $REPO != *@*:* && -e $REPO ]]; then REPO=$(realpath "$REPO"); fi

  POOL_SIZE=${ARG_POOL_SIZE:-${CONF[pool_size]:-}}
  if [[ -n $POOL_SIZE ]]; then
    [[ $POOL_SIZE =~ ^([0-9]+)(GiB|G|GB)?$ ]] || die "--pool-size が不正です：$POOL_SIZE" "例：--pool-size 30GiB"
    POOL_SIZE="${BASH_REMATCH[1]}GiB"
  fi

  # トークン：引数 → 環境変数 → 保存済み → 端末で聞く。環境変数は写したらすぐ消す（子に渡さない）
  TOKEN="" TOKEN_SOURCE=""
  local env_token=${CLOUDFLARE_API_TOKEN:-}
  unset CLOUDFLARE_API_TOKEN
  TLS_REMEMBER=${CONF[tls_mode]:-}
  if [[ $NO_CLOUDFLARE == 1 ]]; then
    TLS_REMEMBER=internal # これからは聞かない（トークンを渡して打ち直せば戻る）
  elif [[ $ARG_TOKEN_SET == 1 ]]; then
    if [[ $ARG_TOKEN == - ]]; then
      have_tty || die "--cloudflare-token - ですが、聞くための端末がありません" "環境変数 CLOUDFLARE_API_TOKEN で渡してください"
      printf '    Cloudflare の API トークン（表示されません）：' >/dev/tty
      IFS= read -rs TOKEN </dev/tty
      printf '\n' >/dev/tty
    else
      TOKEN=$ARG_TOKEN
    fi
    TOKEN_SOURCE=new
  elif [[ -n $env_token ]]; then
    TOKEN=$env_token TOKEN_SOURCE=new
  elif sudo test -f "$CF_ENV" && sudo grep -q '^CLOUDFLARE_API_TOKEN=.' "$CF_ENV"; then
    TOKEN_SOURCE=saved # 中身はここでは読まない（要るときに読む）
  elif [[ $TLS_REMEMBER != internal ]] && have_tty; then
    printf '    Cloudflare の API トークン（Enter だけなら Caddy の内部の CA で HTTPS にする。表示されません）：' >/dev/tty
    IFS= read -rs TOKEN </dev/tty || TOKEN=""
    printf '\n' >/dev/tty
    [[ -n $TOKEN ]] && TOKEN_SOURCE=new
  fi
  ARG_TOKEN="" env_token=""
  if [[ $TOKEN_SOURCE == new ]]; then
    [[ $TOKEN =~ ^[A-Za-z0-9_-]{20,200}$ ]] || die "Cloudflare のトークンの形が違います（英数字と _- で 20 文字以上）" "Cloudflare の画面で作った API トークンを渡してください"
    TLS_REMEMBER=""
  fi
  if [[ -n $TOKEN_SOURCE ]]; then TLS_MODE=cloudflare; else TLS_MODE=internal; fi
  if [[ $TLS_MODE == cloudflare && -z $IP ]]; then
    die "DNS のレコードの向け先（このホストの IPv4）が分かりません" "--ip <このホストの LAN の IPv4> を足してください"
  fi

  sudo mkdir -p /etc/banto
  write_install_conf
  say "名前：$DOMAIN（sandbox.$DOMAIN・*.$DOMAIN も使う）"
  say "このホストの IP：${IP:-（分からない）}${IP_FIXED:+（--ip で指定）}"
  [[ -n $REPO ]] && say "取り込み元：$REPO の release"
  if [[ $TLS_MODE == cloudflare ]]; then
    local which_token="保存済みのもの"
    [[ $TOKEN_SOURCE == new ]] && which_token="今回渡されたもの"
    say "HTTPS：Let's Encrypt（Cloudflare の DNS で証明。トークンは$which_token）"
  elif [[ $NO_CLOUDFLARE == 1 ]]; then
    say "HTTPS：Caddy の内部の CA に戻す（--no-cloudflare。保存したトークンを消す）"
  else
    say "HTTPS：Caddy の内部の CA（Cloudflare のトークンが無いため。後から --cloudflare-token で打ち直せば Let's Encrypt に替わる）"
  fi
  ok "覚えた：$INSTALL_CONF"
}

# ---------------------------------------------------------------------------
# 3. 基本の道具
# ---------------------------------------------------------------------------

step_base_packages() {
  step "基本の道具を入れる"
  # age・openssh-client・sops は同梱の vault-local（秘密の置き場）が host で使う（age-keygen・ssh-keygen・ssh-agent・sops）。
  # polkitd は画面からの更新（scripts/setup-update.sh が polkit の規則で banto の unit の再起動をユーザーに許す）のため
  apt_install ca-certificates curl git gnupg xz-utils nftables iproute2 age openssh-client polkitd
  if [[ "$(/usr/local/bin/sops --version 2>/dev/null | awk 'NR == 1 { print $2 }')" != "$SOPS_VERSION" ]]; then
    local tmp sha_var="SOPS_SHA256_$CADDY_ARCH"
    tmp=$(mktemp)
    say "sops $SOPS_VERSION を入れる"
    curl -fsSL "https://github.com/getsops/sops/releases/download/v$SOPS_VERSION/sops-v$SOPS_VERSION.linux.$CADDY_ARCH" -o "$tmp" ||
      die "sops を取ってこられませんでした" "github.com に届くか確かめてください"
    echo "${!sha_var}  $tmp" | sha256sum -c --quiet - ||
      die "sops の sha256 が合いません（壊れているか、すり替えられている）" "時間をおいて打ち直してください"
    sudo install -m 755 "$tmp" /usr/local/bin/sops
    rm -f "$tmp"
  fi
  ok "そろっている（sops $SOPS_VERSION を含む）"
}

# ---------------------------------------------------------------------------
# 4. Node（公式の tarball。コンテナの土台がホストの node・npm の一式を写すので、npm つきが要る）
# ---------------------------------------------------------------------------

step_node() {
  step "Node.js $NODE_VERSION を入れる"
  if [[ -x /usr/local/bin/node && "$(/usr/local/bin/node --version 2>/dev/null)" == "v$NODE_VERSION" && -x /usr/local/bin/npm && -d /usr/local/lib/node_modules/npm ]]; then
    ok "入っている（/usr/local/bin/node v$NODE_VERSION）"
    return
  fi
  local name="node-v$NODE_VERSION-linux-$NODE_ARCH" sha_var="NODE_SHA256_$NODE_ARCH" tmp
  tmp=$(mktemp -d)
  say "取ってくる：https://nodejs.org/dist/v$NODE_VERSION/$name.tar.xz"
  curl -fsSL "https://nodejs.org/dist/v$NODE_VERSION/$name.tar.xz" -o "$tmp/node.tar.xz" ||
    die "Node.js を取ってこられませんでした" "nodejs.org に届くか確かめてください"
  echo "${!sha_var}  $tmp/node.tar.xz" | sha256sum -c --quiet - ||
    die "Node.js の tarball の sha256 が合いません（壊れているか、すり替えられている）" "時間をおいて打ち直してください。続くなら install.sh の NODE_SHA256 を公式の SHASUMS256.txt と比べてください"
  sudo tar -C /usr/local --strip-components=1 --no-same-owner -xJf "$tmp/node.tar.xz" "$name/bin" "$name/lib" "$name/include" "$name/share"
  rm -rf "$tmp"
  [[ "$(/usr/local/bin/node --version)" == "v$NODE_VERSION" ]] || die "入れた node が v$NODE_VERSION になりません" "which -a node で別の node が先に無いか確かめてください"
  ok "入れた（/usr/local/bin/node v$NODE_VERSION・npm $(/usr/local/bin/npm --version)）"
}

# ---------------------------------------------------------------------------
# 5. banto の設定（config.json）と Publish の設定。口と置き場はここが真実
# ---------------------------------------------------------------------------

step_config() {
  step "banto の設定を書く"
  local result
  result=$(node --input-type=module - "$CONFIG_PATH" "$DOMAIN" "$TLS_MODE" "$NO_CLOUDFLARE" "$REL" <<'JS'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, isAbsolute, join } from "node:path";
import { homedir } from "node:os";
const [path, domain, tlsMode, noCloudflare, defaultRel] = process.argv.slice(2);
const out = [];
function writeJson(p, value, before) {
  const text = JSON.stringify(value, null, 2) + "\n";
  if (text === before) return false;
  mkdirSync(dirname(p), { recursive: true, mode: 0o700 });
  writeFileSync(`${p}.tmp`, text, { mode: 0o600 });
  renameSync(`${p}.tmp`, p);
  return true;
}
const port = (v, d, name) => {
  if (v === undefined) return d;
  if (!Number.isInteger(v) || v < 1 || v > 65535) throw new Error(`config.json の ${name} が口の番号ではありません：${JSON.stringify(v)}`);
  return v;
};
try {
  // 既にある設定は他の項目を残し、要る項目だけ直す。authToken は消さない（無ければ作る——無いと起動のたびに変わる）
  const before = existsSync(path) ? readFileSync(path, "utf8") : "";
  const raw = before ? JSON.parse(before) : {};
  if (!raw.authToken) raw.authToken = randomBytes(32).toString("base64url");
  const oldHost = raw.publicUrl ? new URL(raw.publicUrl).hostname : "";
  // 口と置き場は config.json を真実にする（書いてあればそれ、無ければ既定を書く）。Caddy・unit・nftables はこれを読む
  raw.port = port(raw.port, 4737, "port");
  raw.sandboxPort = port(raw.sandboxPort, 4176, "sandboxPort");
  raw.uiPort = port(raw.uiPort, 4175, "uiPort");
  raw.releaseDir ??= defaultRel;
  if (typeof raw.releaseDir !== "string" || !isAbsolute(raw.releaseDir)) throw new Error(`config.json の releaseDir が絶対パスではありません：${JSON.stringify(raw.releaseDir)}`);
  raw.publicUrl = `https://${domain}`;
  raw.sandboxPublicUrl = `https://sandbox.${domain}`;
  let origins = Array.isArray(raw.allowedEmbedderOrigins) ? raw.allowedEmbedderOrigins : ["http://127.0.0.1:4175", "http://localhost:4175"];
  if (oldHost && oldHost !== domain) origins = origins.filter((o) => o !== `https://${oldHost}`);
  if (!origins.includes(`https://${domain}`)) origins.push(`https://${domain}`);
  raw.allowedEmbedderOrigins = origins;
  out.push(writeJson(path, raw, before) ? "config=changed" : "config=same");
  const dataDirOut = raw.dataDir ?? join(process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"), "banto");
  out.push(`port=${raw.port}`, `sandboxPort=${raw.sandboxPort}`, `uiPort=${raw.uiPort}`, `releaseDir=${raw.releaseDir}`, `dataDir=${dataDirOut}`);
  if (raw.uiOrigin && new URL(raw.uiOrigin).origin !== `https://${domain}`) out.push(`warn=設定の uiOrigin（${raw.uiOrigin}）が画面の住所と違います。ログインが通らないので、要らなければ消してください`);
  // Publish（publish-caddy）の設定：置き場は <dataDir>/modules/<入れた名前>。目録から入れるときの既定の名前 publish-caddy に置く
  const dataDir = raw.dataDir ?? join(process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"), "banto");
  const sp = join(dataDir, "modules", "publish-caddy", "settings.json");
  const sBefore = existsSync(sp) ? readFileSync(sp, "utf8") : "";
  const s = sBefore ? JSON.parse(sBefore) : {};
  if (tlsMode === "cloudflare") {
    s.adminUrl ??= "http://127.0.0.1:2019";
    s.reach ??= "internet";
    s.baseDomain = domain;
    out.push(writeJson(sp, s, sBefore) ? `publish=changed:${sp}` : `publish=same:${sp}`);
  } else if (noCloudflare === "1" && s.baseDomain !== undefined && [domain, oldHost].includes(s.baseDomain)) {
    delete s.baseDomain; // 内部の CA に戻したら公開先の名前は引けないので、install.sh が書いた基のドメインを外す
    writeJson(sp, s, sBefore);
    out.push(`publish=removed:${sp}`);
  }
} catch (err) {
  out.push(`error=${err.message}`);
}
console.log(out.join("\n"));
JS
)
  local line
  while IFS= read -r line; do
    case $line in
      config=changed) ok "$CONFIG_PATH を直した（publicUrl=https://$DOMAIN）" ;;
      config=same) ok "$CONFIG_PATH はそのまま" ;;
      port=*) PORT_HOST=${line#port=} ;;
      sandboxPort=*) PORT_SANDBOX=${line#sandboxPort=} ;;
      uiPort=*) PORT_UI=${line#uiPort=} ;;
      releaseDir=*) REL=${line#releaseDir=} ;;
      dataDir=*) DATA_DIR=${line#dataDir=} ;;
      publish=changed:*) ok "Publish の基のドメインを $DOMAIN にした（${line#publish=changed:}）" ;;
      publish=same:*) ok "Publish の基のドメインは $DOMAIN のまま" ;;
      publish=removed:*) ok "Publish の基のドメインを外した（${line#publish=removed:}）" ;;
      warn=*) warn "${line#warn=}" ;;
      error=*) die "${line#error=}" "$CONFIG_PATH を直してから打ち直してください" ;;
    esac
  done <<<"$result"
  REL=${REL%/}
  say "口：host $PORT_HOST・サンドボックス $PORT_SANDBOX・画面 $PORT_UI／コードの置き場：$REL（config.json が真実）"
  LAYOUT=$(release_layout)
  case $LAYOUT in
    new) say "置き場：版ごとのフォルダの形（current → $(readlink "$REL/current")）" ;;
    old) say "置き場：古い形（$REL がそのまま clone）——このあと setup-update.sh で版ごとのフォルダの形に移す" ;;
    first | none) say "置き場：まだ無い——release を取ってきて最初の版を組み立てる" ;;
    *) die "$REL が、知っている形（版ごとのフォルダの形・古い clone の形・無い）のどれでもありません" \
      "中身を見て、要らなければ別の場所へ動かしてから打ち直してください（ls -la $REL）" ;;
  esac
  if [[ $TLS_MODE == internal ]]; then
    say "Publish は使えません（公開先 *.$DOMAIN の DNS と証明書が要る——Cloudflare のトークンを渡して打ち直すと使える）"
  fi
}

# ---------------------------------------------------------------------------
# 6. Incus（banto の Project のコンテナ）
# ---------------------------------------------------------------------------

step_incus() {
  step "Incus を入れて、banto の前提をそろえる"
  # 配布元（Zabbly）の鍵：公開鍵が1つで指紋が合うことを確かめてから置く
  local key
  key=$(mktemp)
  curl -fsSL https://pkgs.zabbly.com/key.asc -o "$key" || die "Zabbly の鍵を取ってこられませんでした" "https://pkgs.zabbly.com に届くか確かめてください"
  zabbly_key_ok "$key" || die "Zabbly の鍵が思っていたものと違います（公開鍵が1つで、指紋が $ZABBLY_FPR であること）" \
    "鍵がすり替えられているおそれがあります。gpg --show-keys で中身を見て、https://github.com/zabbly/incus の指紋と比べてください"
  put_root_file /etc/apt/keyrings/zabbly.asc 644 <"$key"
  local key_changed=$FILE_CHANGED
  rm -f "$key"
  put_root_file "/etc/apt/sources.list.d/zabbly-incus-$INCUS_CHANNEL.sources" 644 <<EOF
Enabled: yes
Types: deb
URIs: https://pkgs.zabbly.com/incus/$INCUS_CHANNEL
Suites: $UBUNTU_CODENAME
Components: main
Architectures: $(dpkg --print-architecture)
Signed-By: /etc/apt/keyrings/zabbly.asc
EOF
  if [[ $FILE_CHANGED == 1 || $key_changed == 1 ]]; then APT_UPDATED=0; fi

  local version=""
  pkg_installed incus && version=$(dpkg-query -W -f='${Version}' incus | sed 's/^[0-9]*://')
  if [[ -z $version ]] || ! incus_version_ok "$version"; then
    say "Incus を入れる（Zabbly の $INCUS_CHANNEL${version:+。いまは $version}）"
    apt_update
    sudo env DEBIAN_FRONTEND=noninteractive apt-get -o DPkg::Lock::Timeout=300 install -y -q --no-install-recommends incus
    version=$(dpkg-query -W -f='${Version}' incus | sed 's/^[0-9]*://')
    incus_version_ok "$version" || die "入った Incus $version は banto の前提（6.0.6 以降）に足りません" \
      "apt-cache policy incus で Zabbly（pkgs.zabbly.com）の版が選ばれているか確かめてください"
  fi
  apt_install btrfs-progs
  ok "Incus $version"

  # 初期化（まだのときだけ）。default のプロファイルに root のディスクがあれば済んでいる
  if ! sudo incus profile device get default root pool </dev/null >/dev/null 2>&1; then
    say "Incus を初期化する（incus admin init --minimal）"
    sudo incus admin init --minimal </dev/null
  fi

  if ! id -nG "$USER_NAME" | tr ' ' '\n' | grep -x incus >/dev/null; then
    sudo usermod -aG incus "$USER_NAME"
    say "$USER_NAME を incus グループに入れた（banto の unit は起動のたびにグループを引き直すので、ログインし直さなくてよい）"
  fi

  # ホストの uid をコンテナの同じ番号に対応させる許可（足したら Incus を起こし直す）
  local f restart_incus=0
  for f in /etc/subuid /etc/subgid; do
    if ! sudo awk -F: -v id="$USER_UID" '$1 == "root" && id >= $2 && id < $2 + $3 { found = 1 } END { exit !found }' "$f" 2>/dev/null; then
      echo "root:$USER_UID:1" | sudo tee -a "$f" >/dev/null
      say "$f に root:$USER_UID:1 を足した"
      restart_incus=1
    fi
  done
  if [[ $restart_incus == 1 ]]; then
    sudo systemctl restart incus.service
    sudo incus admin waitready --timeout 120 </dev/null
  fi

  # banto のコンテナの置き場（btrfs）
  if sudo incus storage show "$BANTO_POOL" </dev/null >/dev/null 2>&1; then
    ok "置き場 $BANTO_POOL はある"
  elif [[ $(findmnt -no FSTYPE --target /var/lib/incus) == btrfs ]]; then
    say "置き場 $BANTO_POOL を作る（/var/lib/incus が btrfs なので、その中のフォルダを使う）"
    sudo incus storage create "$BANTO_POOL" btrfs source="/var/lib/incus/storage-pools/$BANTO_POOL" </dev/null
  else
    local size=$POOL_SIZE
    if [[ -z $size ]]; then
      local avail
      avail=$(df -BG --output=avail /var/lib/incus | tail -1 | tr -dc 0-9)
      size=$((avail / 2))
      ((size > 50)) && size=50
      ((size >= 10)) || die "ディスクの空き（${avail}GiB）が少なく、置き場を作れません（10GiB 以上要る）" \
        "空きを作るか、--pool-size <N>GiB で大きさを決めてください"
      size="${size}GiB"
    fi
    say "置き場 $BANTO_POOL を作る（btrfs のループファイル $size。/var/lib/incus が btrfs でないため）"
    sudo incus storage create "$BANTO_POOL" btrfs size="$size" </dev/null
  fi

  # Docker が居ると、転送を既定で止めるので、Incus のブリッジを通す（Docker の起動のたびに足す）
  if [[ -n $(systemctl list-unit-files docker.service --no-legend 2>/dev/null) ]]; then
    put_root_file /usr/local/sbin/incus-docker-forward.sh 755 <<'EOF'
#!/bin/sh
# Docker は転送を既定で止めるので、Incus のブリッジ（incusbr で始まる全部）を DOCKER-USER で通す（banto の install.sh）。
# 何度流しても同じ結果。docs/notes/2026-09-25-dev-environment.md「外向き通信の許可を永続化する」
set -e
for t in iptables ip6tables; do
  command -v "$t" >/dev/null 2>&1 || continue
  "$t" -n -L DOCKER-USER >/dev/null 2>&1 || continue
  for dir in -i -o; do
    "$t" -C DOCKER-USER "$dir" incusbr+ -j ACCEPT 2>/dev/null || "$t" -I DOCKER-USER "$dir" incusbr+ -j ACCEPT
  done
done
EOF
    put_root_file /etc/systemd/system/docker.service.d/incus-forward.conf 644 <<'EOF'
# banto の install.sh が置いた：Docker の起動のたびに Incus のブリッジの転送を許す
[Service]
ExecStartPost=/usr/local/sbin/incus-docker-forward.sh
EOF
    sudo systemctl daemon-reload
    unit_active docker.service && sudo /usr/local/sbin/incus-docker-forward.sh
    ok "Docker が居るので、Incus のブリッジの転送を許した（Docker 本体は起こし直さない）"
  fi
}

# ---------------------------------------------------------------------------
# 7. Caddy（入口。HTTPS と、画面・API・サンドボックスへの振り分け）
# ---------------------------------------------------------------------------

step_caddy_install() {
  step "Caddy を入れる"
  if [[ -x $CADDY_BIN ]] && "$CADDY_BIN" list-modules 2>/dev/null | grep -x dns.providers.cloudflare >/dev/null; then
    ok "入っている（$("$CADDY_BIN" version | cut -d' ' -f1)、Cloudflare の DNS 入り。上げ方は docs/runbooks/install.md）"
  else
    local tmp got
    tmp=$(mktemp)
    say "caddyserver.com から Cloudflare の DNS 入りの版を取ってくる（版は選べず、その時の最新が来る）"
    curl -fsSL "https://caddyserver.com/api/download?os=linux&arch=$CADDY_ARCH&p=github.com%2Fcaddy-dns%2Fcloudflare" -o "$tmp" ||
      die "Caddy を取ってこられませんでした" "https://caddyserver.com に届くか確かめてください"
    chmod +x "$tmp"
    "$tmp" list-modules 2>/dev/null | grep -x dns.providers.cloudflare >/dev/null || die "取ってきた Caddy に Cloudflare の DNS が入っていません" "時間をおいて打ち直してください"
    got=$("$tmp" version | cut -d' ' -f1)
    version_at_least "${got#v}" "$CADDY_MIN_VERSION" || die "取ってきた Caddy $got は banto が要る $CADDY_MIN_VERSION より古い" "時間をおいて打ち直してください"
    sudo install -m 755 "$tmp" "$CADDY_BIN"
    rm -f "$tmp"
    ok "入れた（Caddy $got）"
  fi

  getent group caddy >/dev/null || sudo groupadd --system caddy
  if ! id caddy >/dev/null 2>&1; then
    sudo useradd --system --gid caddy --create-home --home-dir /var/lib/caddy --shell /usr/sbin/nologin --comment "Caddy web server" caddy
  fi

  # unit：既にある unit（apt の caddy 等）は drop-in で差し替え、無ければ作る。--environ は付けない（トークンが journal に出る）。
  # 判定は unit の本体の場所と drop-in の有無で行う——drop-in の印を見て「自分の unit」と取り違え、2回目に /etc に
  # 丸ごと書いて apt の unit を覆ってしまわないように
  local marker="# banto の install.sh が作った" frag
  frag=$(systemctl show -p FragmentPath --value caddy.service 2>/dev/null || true)
  if sudo test -f "$CADDY_DROPIN" || [[ -n $frag && $frag != "$CADDY_UNIT" ]] || { [[ $frag == "$CADDY_UNIT" ]] && ! sudo grep -qF "$marker" "$CADDY_UNIT"; }; then
    put_root_file "$CADDY_DROPIN" 644 <<EOF
$marker（Cloudflare の DNS 入りの $CADDY_BIN に差し替える）
[Service]
ExecStart=
ExecStart=$CADDY_BIN run --config /etc/caddy/Caddyfile
ExecReload=
ExecReload=$CADDY_BIN reload --config /etc/caddy/Caddyfile --force
EnvironmentFile=-$CF_ENV
EOF
  else
    put_root_file "$CADDY_UNIT" 644 <<EOF
$marker（Caddy の公式の unit から --environ を外し、Cloudflare のトークンを $CF_ENV から読む）
[Unit]
Description=Caddy
Documentation=https://caddyserver.com/docs/
After=network.target network-online.target
Requires=network-online.target

[Service]
Type=notify
User=caddy
Group=caddy
ExecStart=$CADDY_BIN run --config /etc/caddy/Caddyfile
ExecReload=$CADDY_BIN reload --config /etc/caddy/Caddyfile --force
EnvironmentFile=-$CF_ENV
TimeoutStopSec=5s
LimitNOFILE=1048576
PrivateTmp=true
ProtectSystem=full
AmbientCapabilities=CAP_NET_ADMIN CAP_NET_BIND_SERVICE

[Install]
WantedBy=multi-user.target
EOF
  fi
  [[ $FILE_CHANGED == 1 ]] && CADDY_NEEDS_RESTART=1
  sudo systemctl daemon-reload

  # 人の Caddyfile は書き換えない。無ければ最小のものを作り、banto の設定を読む1行だけを足す
  sudo mkdir -p /etc/caddy/banto.d
  if ! sudo test -f /etc/caddy/Caddyfile; then
    put_root_file /etc/caddy/Caddyfile 644 <<'EOF'
# banto の install.sh が作った最小の Caddyfile。ほかのサイトはこの下に足してよい
# （banto の設定は /etc/caddy/banto.d/ にあり、install.sh を打ち直すと作り直す）
import /etc/caddy/banto.d/*.caddy
EOF
  elif ! sudo grep -qE '^[[:space:]]*import[[:space:]]+/etc/caddy/banto\.d/\*\.caddy[[:space:]]*$' /etc/caddy/Caddyfile; then
    printf '\n# banto（install.sh が足した1行。banto の設定は /etc/caddy/banto.d/ にある）\nimport /etc/caddy/banto.d/*.caddy\n' |
      sudo tee -a /etc/caddy/Caddyfile >/dev/null
    say "/etc/caddy/Caddyfile に import の1行を足した"
  fi
  if sudo grep -qE '^[[:space:]]*admin[[:space:]]+off' /etc/caddy/Caddyfile; then
    warn "Caddyfile に admin off があります。Publish は Caddy の admin API（localhost:2019）を使うので、公開ができません"
  fi
}

# ---------------------------------------------------------------------------
# 8. HTTPS（Cloudflare の DNS か、Caddy の内部の CA）と Caddy の設定
# ---------------------------------------------------------------------------

# Cloudflare の API でゾーンを探し、<名前> と *.<名前> の A レコードを作る／直す（proxied: false。作るときは印を付ける）。
# 3つ目に前の名前を渡すと、前の名前のレコードのうち印が付いていてこのホストの IP を向くものだけを消し、
# ほかは「残っている：…」の行で知らせる。
# トークンは環境変数 CLOUDFLARE_API_TOKEN で受ける（コマンド行に出さない）。基点は BANTO_CLOUDFLARE_API で差し替えられる
cloudflare_upsert_records() {
  local domain=$1 ip=$2 old=${3:-}
  node --input-type=module - "$domain" "$ip" "$old" "$CF_RECORD_MARK" <<'JS'
const [domain, ip, old, mark] = process.argv.slice(2);
const base = (process.env.BANTO_CLOUDFLARE_API || "https://api.cloudflare.com/client/v4").replace(/\/+$/, "");
const token = process.env.CLOUDFLARE_API_TOKEN;
if (!token) { console.error("CLOUDFLARE_API_TOKEN がありません"); process.exit(2); }
async function cf(method, path, body) {
  let res;
  try {
    res = await fetch(base + path, {
      method,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  } catch (err) {
    throw new Error(`${method} ${path}：Cloudflare に届きません（${err.cause?.code ?? err.message}）`);
  }
  let json;
  try { json = await res.json(); } catch { throw new Error(`${method} ${path}：${res.status}（JSON ではない応答）`); }
  if (!res.ok || json.success !== true) {
    const why = (json.errors ?? []).map((e) => `${e.code} ${e.message}`).join("; ") || `HTTP ${res.status}`;
    throw new Error(`${method} ${path.split("?")[0]}：${why}`);
  }
  return json;
}
const records = async (zone, name) => (await cf("GET", `/zones/${zone.id}/dns_records?type=A&name=${encodeURIComponent(name)}`)).result;
try {
  const zones = [];
  for (let page = 1; ; page++) {
    const j = await cf("GET", `/zones?per_page=50&page=${page}`);
    zones.push(...j.result);
    if (page >= (j.result_info?.total_pages ?? 1)) break;
  }
  const zoneOf = (name) => zones.filter((z) => name === z.name || name.endsWith(`.${z.name}`)).sort((a, b) => b.name.length - a.name.length)[0];
  const zone = zoneOf(domain);
  if (!zone) {
    throw new Error(`トークンで見えるゾーンに ${domain} を含むものがありません（見えるゾーン：${zones.map((z) => z.name).join(", ") || "無し"}）。トークンに Zone:Read を付け、対象のゾーンを含めてください`);
  }
  console.log(`ゾーン：${zone.name}`);
  for (const name of [domain, `*.${domain}`]) {
    const found = await records(zone, name);
    if (found.length > 1) throw new Error(`${name} の A レコードが ${found.length} 個あります（${found.map((r) => r.content).join(", ")}）。banto はどれを直すか決められません——Cloudflare の画面で1つにしてください`);
    if (found.length === 0) {
      await cf("POST", `/zones/${zone.id}/dns_records`, { type: "A", name, content: ip, proxied: false, ttl: 1, comment: mark });
      console.log(`作った：${name} → ${ip}`);
    } else if (found[0].content === ip && found[0].proxied === false) {
      console.log(`そのまま：${name} → ${ip}`);
    } else {
      await cf("PATCH", `/zones/${zone.id}/dns_records/${found[0].id}`, { content: ip, proxied: false });
      console.log(`直した：${name} ${found[0].content}${found[0].proxied ? "（proxied）" : ""} → ${ip}`);
    }
  }
  if (old && old !== domain) {
    const oldZone = zoneOf(old);
    if (!oldZone) {
      console.log(`残っている：${old}・*.${old}（トークンで見えるゾーンに無いので確かめられない）`);
    } else {
      for (const name of [old, `*.${old}`]) {
        for (const r of await records(oldZone, name)) {
          if (r.comment === mark && r.content === ip) {
            await cf("DELETE", `/zones/${oldZone.id}/dns_records/${r.id}`);
            console.log(`消した：${name} → ${r.content}（前の名前。install.sh が作ったもの）`);
          } else {
            const why = r.comment !== mark ? "install.sh が作った印が無い" : `このホスト（${ip}）を向いていない`;
            console.log(`残っている：${name} → ${r.content}（${why}ので消さなかった）`);
          }
        }
      }
    }
  }
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
JS
}

# banto の Caddy の設定（/etc/caddy/banto.d/banto.caddy）を標準出力に出す
render_banto_caddy() {
  local domain=$1 mode=$2 tls ca_dir
  if [[ $mode == cloudflare ]]; then
    tls=$'\ttls {\n\t\tdns cloudflare {env.CLOUDFLARE_API_TOKEN}\n\t}'
  else
    tls=$'\ttls internal'
  fi
  cat <<EOF
# banto の install.sh が作る（打ち直すと作り直す。手で直さず、install.sh の引数で変える）
# 画面 https://$domain（/api/* は host）・Canvas のサンドボックス https://sandbox.$domain・Publish の公開先 *.$domain
# 口は banto の config.json（port・sandboxPort・uiPort）から

$domain {
$tls
	handle /api/* {
		reverse_proxy 127.0.0.1:$PORT_HOST
	}
	handle {
		reverse_proxy 127.0.0.1:$PORT_UI
	}
}

# 証明書は *.$domain の1枚。sandbox もこの中。Publish の道は publish-caddy が admin API でこの前に差し込む
*.$domain {
$tls
	@sandbox host sandbox.$domain
	handle @sandbox {
		reverse_proxy 127.0.0.1:$PORT_SANDBOX
	}
	handle {
		respond 404
	}
}

http://$domain, http://*.$domain {
EOF
  if [[ $mode == internal ]]; then
    ca_dir="$(caddy_home)/.local/share/caddy/pki/authorities/local"
    cat <<EOF
	# 内部の CA のルート証明書（公開してよいもの）。各端末で信頼する
	handle /banto-ca.crt {
		root * $ca_dir
		rewrite * /root.crt
		header Content-Type application/x-x509-ca-cert
		file_server
	}
EOF
  fi
  cat <<'EOF'
	handle {
		redir https://{host}{uri} 308
	}
}
EOF
}

# caddy のユーザーとして caddy を流す（トークンは環境変数で渡す——コマンド行に出さない）
caddy_as_caddy() {
  sudo -u caddy -H bash -c 'cd / && set -a && if [ -r "$1" ]; then . "$1"; fi && set +a && shift && exec "$@"' _ "$CF_ENV" "$CADDY_BIN" "$@"
}

# 動いている Caddy の設定が、Caddyfile を JSON にしたものと同じか（publish-caddy が admin API で足した道は除いて比べる）。
# 同じなら 0。比べられない（admin API が無い・unix ソケット等）ときも「違う」として読み直させる
# shellcheck disable=SC2016 # 中の JS のテンプレート文字列
caddy_running_matches() {
  local adapted
  adapted=$(caddy_as_caddy adapt --config /etc/caddy/Caddyfile --adapter caddyfile 2>/dev/null) || return 1
  node --input-type=module -e '
    const want = JSON.parse(process.argv[1]);
    const listen = want.admin?.listen ?? "localhost:2019";
    if (want.admin?.disabled || listen.startsWith("unix/")) process.exit(1);
    const res = await fetch(`http://${listen.replace(/^tcp\//, "")}/config/`).catch(() => null);
    if (!res?.ok) process.exit(1);
    const running = await res.json();
    // publish-caddy の道（@id が banto-publish- で始まる）を除く
    for (const s of Object.values(running?.apps?.http?.servers ?? {})) {
      if (Array.isArray(s.routes)) s.routes = s.routes.filter((r) => !String(r["@id"] ?? "").startsWith("banto-publish-"));
    }
    const canon = (v) => Array.isArray(v) ? v.map(canon) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])])) : v;
    process.exit(JSON.stringify(canon(running)) === JSON.stringify(canon(want)) ? 0 : 1);
  ' "$adapted"
}

step_https() {
  step "HTTPS と入口（Caddy）を設定する"
  local env_changed=0
  REMAINING_RECORDS=""
  # 前の名前は、いま入口（Caddy）に効いている banto の設定から引く。config.json からは引かない——名前を替える回が
  # DNS の段で止まると、config.json は新しい名前・入口は前の名前のままになり、次の回が前の名前を見失う
  OLD_DOMAIN=$(sudo sed -nE 's/^([a-z0-9.-]+) \{$/\1/p' /etc/caddy/banto.d/banto.caddy 2>/dev/null | head -1 || true)
  [[ $OLD_DOMAIN == "$DOMAIN" ]] && OLD_DOMAIN=""
  if [[ $TLS_MODE == cloudflare ]]; then
    if [[ $TOKEN_SOURCE == saved ]]; then
      TOKEN=$(sudo sed -n 's/^CLOUDFLARE_API_TOKEN=//p' "$CF_ENV" | head -1)
    fi
    say "Cloudflare の DNS に $DOMAIN と *.$DOMAIN（→ $IP）を作る／直す${OLD_DOMAIN:+。前の名前 $OLD_DOMAIN の分を片づける}"
    local out
    out=$(CLOUDFLARE_API_TOKEN=$TOKEN cloudflare_upsert_records "$DOMAIN" "$IP" "$OLD_DOMAIN" 2>&1) || {
      printf '%s\n' "$out" | sed 's/^/    /' >&2
      die "Cloudflare の DNS を直せませんでした（理由は上）" "トークンに Zone:Read と DNS:Edit が付いているか、名前がそのゾーンの中かを確かめてください"
    }
    printf '%s\n' "$out" | sed 's/^/    /'
    REMAINING_RECORDS=$(grep '^残っている：' <<<"$out" || true)
    # 一時ファイルを経ずに置く（トークンを残すのは cloudflare.env だけ）
    if [[ $TOKEN_SOURCE == new ]] && ! printf 'CLOUDFLARE_API_TOKEN=%s\n' "$TOKEN" | sudo cmp -s - "$CF_ENV" 2>/dev/null; then
      printf 'CLOUDFLARE_API_TOKEN=%s\n' "$TOKEN" |
        sudo sh -c 'umask 177 && cat >"$1.tmp" && chown root:caddy "$1.tmp" && chmod 640 "$1.tmp" && mv "$1.tmp" "$1"' _ "$CF_ENV"
      env_changed=1
      ok "トークンを $CF_ENV（root:caddy 0640）に置いた"
    fi
  elif [[ $NO_CLOUDFLARE == 1 ]] && sudo test -f "$CF_ENV"; then
    sudo rm -f "$CF_ENV"
    env_changed=1
    ok "保存していたトークン（$CF_ENV）を消した"
    REMAINING_RECORDS="残っている：Cloudflare の $DOMAIN・*.$DOMAIN の A レコード（内部の CA でも名前を引くのに使えるので消していない。要らなければ Cloudflare の画面で消す）"
  fi
  TOKEN="" # これより先では使わない

  # 置き換える前の中身を控え、Caddy が受け付けなければ戻す（壊れた設定を残さない）
  local conf=/etc/caddy/banto.d/banto.caddy backup
  backup=$(mktemp)
  if sudo test -f "$conf"; then sudo cat "$conf" | cat >"$backup"; fi
  put_root_file "$conf" 644 < <(render_banto_caddy "$DOMAIN" "$TLS_MODE")
  local vout
  if ! vout=$(caddy_as_caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile 2>&1); then
    if [[ -s $backup ]]; then put_root_file "$conf" 644 <"$backup"; else sudo rm -f "$conf"; fi
    rm -f "$backup"
    printf '%s\n' "$vout" | tail -5 | sed 's/^/    /' >&2
    local hint="上の Caddy のエラー（どのファイルの何行目か）を見て、/etc/caddy/Caddyfile の側を直してください（banto の設定は install.sh が作るので手で直さない）"
    if sudo grep -v '^[[:space:]]*#' /etc/caddy/Caddyfile | grep -F "$DOMAIN" >/dev/null; then
      hint="/etc/caddy/Caddyfile に $DOMAIN のサイトが既にあります。banto の設定は /etc/caddy/banto.d/banto.caddy に作るので、Caddyfile から $DOMAIN・sandbox.$DOMAIN・*.$DOMAIN のサイトを消してから打ち直してください"
    fi
    die "Caddy が設定を受け付けませんでした（banto の設定は元に戻した）" "$hint"
  fi
  rm -f "$backup"

  sudo systemctl enable --quiet caddy.service
  if ! unit_active caddy.service; then
    sudo systemctl start caddy.service
  elif [[ $env_changed == 1 || ${CADDY_NEEDS_RESTART:-0} == 1 ]]; then
    # 環境変数（トークン）と unit は reload では読み直されない。公開の道は publish-caddy が 15 秒ごとに張り直す
    sudo systemctl restart caddy.service
  elif ! caddy_running_matches; then
    # ファイルが変わったかではなく、動いている設定と比べる——前の回に reload し損ねていても直る
    say "動いている Caddy の設定が Caddyfile と違うので読み直す（公開の道は publish-caddy が 15 秒以内に張り直す）"
    sudo systemctl reload caddy.service
  fi
  unit_active caddy.service || die "Caddy が起きません" "journalctl -u caddy -n 50 で理由を見てください"
  ok "Caddy：https://$DOMAIN・https://sandbox.$DOMAIN（$([[ $TLS_MODE == cloudflare ]] && echo "Let's Encrypt" || echo "内部の CA")）"
}

# ---------------------------------------------------------------------------
# 9. systemd の unit と host の守り
# ---------------------------------------------------------------------------

step_units() {
  step "banto の unit を作る"
  local path_env="$USER_HOME/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
  # 起動元は current を通す。古い形の置き場だけは今の clone を指したまま書く——setup-update.sh が置き場を移すときに
  # 中の <置き場> を <置き場>/current に書き換える（その書き換えの結果と、ここで current の形で書くものは同じ中身になる）
  local code=$REL/current
  [[ $LAYOUT == old ]] && code=$REL
  put_root_file /etc/systemd/system/banto-host.service 644 <<EOF
# banto の install.sh が作った（打ち直すと作り直す）。置き場と口は banto の config.json から。docs/runbooks/release.md
[Unit]
Description=banto host (core)
After=network-online.target incus.socket incus.service
Wants=network-online.target
StartLimitIntervalSec=60
StartLimitBurst=5

[Service]
Type=simple
User=$USER_NAME
WorkingDirectory=$code/banto
Environment=NODE_ENV=production LANG=C.UTF-8 HOME=$USER_HOME PATH=$path_env
ExecStart=/usr/local/bin/node packages/core/dist/cli.js
KillMode=mixed
Restart=always
RestartSec=3
LimitNOFILE=1048576
StandardOutput=append:$USER_HOME/banto-host.log
StandardError=append:$USER_HOME/banto-host.log

[Install]
WantedBy=multi-user.target
EOF
  # 画面は 127.0.0.1 だけで待つ（外からは Caddy を通る）
  put_root_file /etc/systemd/system/banto-frontend.service 644 <<EOF
# banto の install.sh が作った（打ち直すと作り直す）。置き場と口は banto の config.json から。docs/runbooks/release.md
[Unit]
Description=banto frontend (Next.js)
After=network-online.target banto-host.service
Wants=network-online.target
StartLimitIntervalSec=60
StartLimitBurst=5

[Service]
Type=simple
User=$USER_NAME
WorkingDirectory=$code/banto/apps/frontend
Environment=NODE_ENV=production LANG=C.UTF-8 HOME=$USER_HOME PATH=$path_env
ExecStart=/usr/local/bin/node $code/banto/node_modules/next/dist/bin/next start -H 127.0.0.1 -p $PORT_UI
KillMode=mixed
Restart=always
RestartSec=3
LimitNOFILE=1048576
StandardOutput=append:$USER_HOME/banto-frontend.log
StandardError=append:$USER_HOME/banto-frontend.log

[Install]
WantedBy=multi-user.target
EOF

  # host の守り（docs/runbooks/host-resource-protection.md）：コンテナと取り合っても host のサービスが先に回る
  put_root_file /etc/systemd/system/system.slice.d/50-banto-protect.conf 644 <<'EOF'
# banto の install.sh が置いた（docs/runbooks/host-resource-protection.md）
[Slice]
CPUWeight=1000
MemoryLow=4G
EOF
  local u
  for u in banto-host banto-frontend; do
    put_root_file "/etc/systemd/system/$u.service.d/50-banto-oom.conf" 644 <<'EOF'
# banto の install.sh が置いた（docs/runbooks/host-resource-protection.md）
[Service]
OOMScoreAdjust=-800
EOF
  done
  sudo systemctl daemon-reload
  sudo systemctl enable --quiet banto-host.service banto-frontend.service
  ok "banto-host.service・banto-frontend.service（ユーザー $USER_NAME）・system.slice の守り"
}

# ---------------------------------------------------------------------------
# 10. 外から banto の口に直に届かせない（nftables の banto 専用の表）
# ---------------------------------------------------------------------------

# Incus が持つブリッジ（managed で type が bridge のもの。全区画）の名前。区画ごとのブリッジ（incus-user の
# incusbr-<uid>）も、default のプロファイルが別の名前のブリッジを使っている host も、これで拾う
incus_bridges() {
  local json
  json=$(sudo incus query '/1.0/networks?recursion=1&all-projects=true' </dev/null 2>/dev/null ||
    sudo incus query '/1.0/networks?recursion=1' </dev/null 2>/dev/null) || return 0
  node -e '
    const names = new Set(JSON.parse(process.argv[1]).filter((n) => n.managed && n.type === "bridge").map((n) => n.name));
    for (const n of names) if (/^[A-Za-z0-9_.-]{1,15}$/.test(n)) console.log(n);
  ' "$json"
}

# default のプロファイルの nic が、Incus の持つブリッジ以外（人が作った br0 等）に繋がっていれば、その名前
incus_unmanaged_nics() {
  local json
  json=$(sudo incus query /1.0/profiles/default </dev/null 2>/dev/null) || return 0
  node -e '
    const bridges = new Set((process.argv[2] ?? "").split(" ").filter(Boolean));
    for (const d of Object.values(JSON.parse(process.argv[1]).devices ?? {})) {
      if (d.type !== "nic") continue;
      const n = d.network ?? d.parent;
      if (n && !bridges.has(n)) console.log(n);
    }
  ' "$json" "${1:-}"
}

# 表を書いて入れる。何度呼んでも同じ結果（表が消えていれば入れ直す）
apply_firewall() {
  local -a bridges=()
  mapfile -t bridges < <(incus_bridges)
  local extra="" others="" b
  for b in "${bridges[@]}"; do
    [[ $b == incusbr* ]] && continue
    extra+=$'\t\t'"iifname \"$b\" accept"$'\n'
    others+="・$b"
  done
  # 表を作ってから消して作り直す——何度入れても同じ結果になる（nft -f は1つの処理として入る）
  put_root_file /etc/banto/nftables.conf 644 <<EOF
# banto の install.sh が作った。lo と Incus のブリッジ以外から banto の口（config.json の port・sandboxPort・uiPort）へ来たものを落とす
table inet banto
delete table inet banto
table inet banto {
	chain input {
		type filter hook input priority filter - 10; policy accept;
		iifname "lo" accept
		iifname "incusbr*" accept
${extra}		tcp dport { $PORT_UI, $PORT_SANDBOX, $PORT_HOST } drop
	}
}
EOF
  local conf_changed=$FILE_CHANGED
  put_root_file /etc/systemd/system/banto-firewall.service 644 <<'EOF'
# banto の install.sh が作った。起動のたびに /etc/banto/nftables.conf を入れる
[Unit]
Description=banto firewall (drop direct access to banto ports except from lo and Incus bridges)
Wants=network-pre.target
Before=network-pre.target banto-host.service banto-frontend.service
After=nftables.service

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/usr/sbin/nft -f /etc/banto/nftables.conf
ExecReload=/usr/sbin/nft -f /etc/banto/nftables.conf
ExecStop=/usr/sbin/nft delete table inet banto

[Install]
WantedBy=multi-user.target
EOF
  [[ $FILE_CHANGED == 1 ]] && sudo systemctl daemon-reload
  sudo systemctl enable --quiet banto-firewall.service
  if ! unit_active banto-firewall.service; then
    sudo systemctl start banto-firewall.service
  elif [[ $conf_changed == 1 ]] || ! sudo nft list table inet banto >/dev/null 2>&1; then
    # 設定が変わった・誰かが表を消した（nftables.service の flush ruleset 等）——入れ直す
    sudo systemctl reload banto-firewall.service
  fi
  sudo nft list table inet banto >/dev/null 2>&1 || die "nftables の表 banto が入っていません" "journalctl -u banto-firewall -n 20 で理由を見てください"
  FIREWALL_BRIDGES="lo・incusbr*$others"
  local nics
  nics=$(incus_unmanaged_nics "${bridges[*]}" | tr '\n' ' ')
  if [[ -n $nics ]]; then
    warn "Incus の default のプロファイルが、Incus の持つブリッジではないもの（$nics）に繋がっています。"
    warn "その先のコンテナは LAN 側から host の /relay に来るので、この表に落とされて Claude が使えません。"
    warn "直し方：banto の Project のコンテナは Incus のブリッジ（incus network create <名前>）に繋いでください"
  fi
}

step_firewall() {
  step "外から banto の口に直に届かないようにする"
  # core は 0.0.0.0 で待つ（Project のコンテナがブリッジ越しに /relay へ来る）。lo と Incus のブリッジ以外から落とす
  apply_firewall
  ok "$FIREWALL_BRIDGES 以外から $PORT_HOST・$PORT_SANDBOX・$PORT_UI へ来たものを落とす（banto-firewall.service）"
  if sudo ufw status 2>/dev/null | grep '^Status: active' >/dev/null; then
    warn "ufw が有効です。ufw は banto の表とは別に判断し、Incus のブリッジから host への DHCP・DNS・/relay を落とすことがあります。"
    warn "直し方（ブリッジごとに）：sudo ufw allow in on incusbr0 && sudo ufw route allow in on incusbr0 && sudo ufw route allow out on incusbr0"
    warn "（ブリッジの名前は incus network list で見る。banto のユーザーの区画のブリッジ incusbr-$USER_UID も同じように）"
  fi
}

# ---------------------------------------------------------------------------
# 11. banto のコード（版ごとのフォルダの形。docs/specs/v4-architecture.md §2.5「画面から banto を更新する」）
# ---------------------------------------------------------------------------
#
# 置き場（config.json の releaseDir）：repo.git（bare。origin の release を取ってくる）・versions/<commit の頭12>（worktree）・
# current → 動かす版・previous → 戻す先。取ってくる・組み立てる・待つ・起こし直す・確かめる・戻すは update.mjs の仕事で、
# install.sh は (1) 初めてのとき repo.git を作って取ってきた版の update.mjs を --first で流し、(2) setup-update.sh で
# 更新の unit と polkit の規則を置き（古い clone の形なら移してもらい）、(3) 打ち直しでは current の update.mjs を呼ぶ

# 置き場の形：new（版ごとのフォルダ）・old（古い形——置き場そのものが clone。setup-update.sh が途中で止まった形も含む）・
# first（repo.git はあるが current がまだ無い——前の回の --first が途中で止まった）・none（まだ無い）・unknown
release_layout() {
  if [[ -d $REL.tmp/.git || -d $REL/.git || -d $REL.setup-backup ]] && [[ ! -L $REL/current || -d $REL.tmp ]]; then
    echo old
  elif [[ -d $REL/repo.git && -L $REL/current ]]; then
    echo new
  elif [[ -d $REL/repo.git ]]; then
    echo first
  elif [[ ! -e $REL ]]; then
    echo none
  else
    echo unknown
  fi
}

# repo.git の取り込み元を --repo に替える（渡されたときだけ）
set_origin() {
  [[ -n $REPO && -d $REL/repo.git ]] || return 0
  if [[ "$(git --git-dir "$REL/repo.git" remote get-url origin)" != "$REPO" ]]; then
    git --git-dir "$REL/repo.git" remote set-url origin "$REPO"
    say "取り込み元を $REPO に替えた（repo.git の origin）"
  fi
}

# 初めて入れる：repo.git を作り、取ってきた版の update.mjs を置き場の外に写して --first で流す（組み立てて current を張る。
# 起こすのは install.sh）。組み立ては取ってきたコードを動かすので、sudo の記憶を消して流す
install_first_version() {
  local repo=$REL/repo.git tmpd
  mkdir -p "$REL"
  if [[ ! -d $repo ]]; then
    local origin=${REPO:-$DEFAULT_REPO}
    say "repo.git を作る（取り込み元 $origin の release）"
    rm -rf "$repo.tmp"
    git init -q --bare "$repo.tmp"
    git --git-dir "$repo.tmp" remote add origin "$origin"
    mv "$repo.tmp" "$repo"
  fi
  set_origin
  git --git-dir "$repo" fetch -q --no-tags origin "$FETCH_REFSPEC" ||
    die "release を取ってこられませんでした（取り込み元 $(git --git-dir "$repo" remote get-url origin)）" "--repo の場所と、そこに release ブランチがあるかを確かめてください"
  tmpd=$(mktemp -d)
  git --git-dir "$repo" show "refs/remotes/origin/release:banto/scripts/update.mjs" >"$tmpd/update.mjs" 2>/dev/null ||
    die "release に banto/scripts/update.mjs がありません（画面からの更新が入る前の版です）" "画面からの更新が入った版を release に置いてから打ち直してください"
  say "最初の版を組み立てる（取ってきた版の update.mjs --first。数分かかります）"
  drop_sudo "取ってきた版の update.mjs（npm の依存と build）"
  run_detached /usr/local/bin/node "$tmpd/update.mjs" --first ||
    die "最初の版を組み立てられませんでした（上の出力。ログは $DATA_DIR/update/ にも）" "コードの側の問題なら、直った版が release に来てから打ち直してください"
  rm -rf "$tmpd"
  [[ -L $REL/current ]] || die "update.mjs --first が終わったのに $REL/current がありません" "$DATA_DIR/update/state.json を見てください"
  reacquire_sudo "更新の準備（setup-update.sh）と、banto を起こすため"
  JUST_INSTALLED=1
  ok "最初の版：$(readlink "$REL/current")"
}

step_code() {
  step "banto のコードを用意する"
  case $LAYOUT in
    none | first) install_first_version ;;
    old) say "古い形の置き場は、次の段で setup-update.sh が版ごとのフォルダの形に移す（組み立て直さない）" ;;
    new)
      set_origin
      ok "置き場は版ごとのフォルダの形（current → $(readlink "$REL/current")）。最新にするのは最後の段（update.mjs）"
      ;;
  esac
}

# 画面からの更新の準備（setup-update.sh）が要るか：古い形・更新の unit か polkit の規則が無い・unit の中身が今の
# 画面の口・node・置き場と違う。要らなければ打たない（打つと必ず sudo を使う。中身が同じなら何も変えない作りだが、
# 聞かずに済むものは聞かない）
SETUP_REASON=""
update_setup_needed() {
  local unit=/etc/systemd/system/banto-update.service text
  [[ $LAYOUT == old ]] && { SETUP_REASON="置き場が古い形"; return 0; }
  sudo test -f /etc/polkit-1/rules.d/50-banto-update.rules || { SETUP_REASON="polkit の規則が無い"; return 0; }
  text=$(cat "$unit" 2>/dev/null) || { SETUP_REASON="banto-update.service が無い"; return 0; }
  [[ $text == *"BANTO_UPDATE_UI_URL=http://127.0.0.1:$PORT_UI/"* ]] || { SETUP_REASON="画面の口が変わった"; return 0; }
  [[ $text == *"ExecStart=$(readlink -f /usr/local/bin/node) $REL/current/banto/scripts/update.mjs --from-request"* ]] ||
    { SETUP_REASON="更新の unit の node か置き場が違う"; return 0; }
  return 1
}

# setup-update.sh を、置き場の外に写してから打つ（1回目は置き場そのものを動かすので——手順書 D）。どの版のものを使うか：
# 古い形なら今の clone のもの（途中で止まった回の続きなら、移した先のもの）、版ごとのフォルダの形なら current のもの
run_setup_update() {
  local src="" c tmpd
  for c in "$REL/current/banto" "$REL/banto" "$REL.tmp/banto" "$REL"/versions/*/banto; do
    [[ -f $c/scripts/setup-update.sh ]] && { src=$c/scripts/setup-update.sh; break; }
  done
  [[ -n $src ]] || die "setup-update.sh が見つかりません（$REL）" "画面からの更新が入った版にしてから打ち直してください（docs/runbooks/release.md B）"
  tmpd=$(mktemp -d)
  cp "$src" "$tmpd/setup-update.sh"
  say "画面からの更新の準備をする（$SETUP_REASON。setup-update.sh：更新の unit・polkit の規則・置き場の形）"
  (cd / && BANTO_UI_URL="http://127.0.0.1:$PORT_UI/" NODE_BIN=/usr/local/bin/node bash "$tmpd/setup-update.sh" 2>&1 | sed 's/^/      /') ||
    die "setup-update.sh が止まりました（上の出力）" "上の理由を直して、同じコマンドを打ち直してください（setup-update.sh は続きから行う）"
  rm -rf "$tmpd"
  LAYOUT=$(release_layout)
  [[ $LAYOUT == new ]] || die "setup-update.sh のあとも置き場が版ごとのフォルダの形になっていません（$LAYOUT）" "ls -la $REL を見てください"
  set_origin
}

# 動いている banto が、今の設定・unit より前に起きたか（起きた時刻とファイルの更新時刻を比べる）。
# 「この回に変えた」を覚えて起こし直す形だと、変えたあと起こし直す前に止まった回の変更を、次の回が「同じ」と見て
# 見落とす（名前を替える回が途中で止まり、打ち直しても前の名前のまま動いていた）。版が替わったときの起こし直しは
# update.mjs の仕事。起こし直す理由は RESTART_REASON に
RESTART_REASON=""
banto_restart_needed() {
  local u t started="" f
  for u in banto-host banto-frontend; do
    t=$(systemctl show -p ExecMainStartTimestamp --value "$u.service" 2>/dev/null || true)
    [[ -n $t && $t != n/a ]] || continue
    t=$(date -d "$t" +%s) || continue
    [[ -z $started || $t -lt $started ]] && started=$t
  done
  [[ -n $started ]] || return 1
  for f in "$CONFIG_PATH" /etc/systemd/system/banto-host.service /etc/systemd/system/banto-frontend.service \
    /etc/systemd/system/banto-host.service.d/50-banto-oom.conf /etc/systemd/system/banto-frontend.service.d/50-banto-oom.conf; do
    if [[ -e $f ]] && (($(stat -c %Y "$f") > started)); then
      RESTART_REASON=$f
      return 0
    fi
  done
  return 1
}

# update.mjs の state.json のうち、この回（started 以降）のもの：「段<TAB>結果<TAB>理由<TAB>ログ」
update_state() {
  node -e '
    try {
      const s = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
      if (Date.parse(s.startedAt) < Number(process.argv[2]) * 1000 - 2000) process.exit(0);
      process.stdout.write([s.phase, s.result ?? "", s.error ?? "", s.logFile ?? ""].map((v) => String(v).replace(/[\t\n]/g, " ")).join("\t"));
    } catch {}' "$DATA_DIR/update/state.json" "$1"
}

# **「上げる」段はこの関数に閉じ込める**：current の update.mjs（いつも今動いている版のもの——アーキ仕様 §2.5）で release の
# 最新にする。待つ形（動いているものが無くなってから起こし直す）。待ちが WAIT_LIMIT_MIN 分を越えたら「やめる印」を置く。
# 起こし直すのは update.mjs（polkit の規則で、sudo を使わない）。新しい版が起きなければ update.mjs が前の版に戻す
upgrade_banto() {
  local upd=$REL/current/banto/scripts/update.mjs started pid rc=0 wait_since="" st phase result err logf
  [[ -f $upd ]] || die "$upd がありません" "置き場（$REL）を見てください"
  started=$(date +%s)
  say "release の最新に上げる（$upd。新しい版があれば組み立て、動いているものが無くなるのを最長 ${WAIT_LIMIT_MIN} 分待って起こし直す）"
  run_detached /usr/local/bin/node "$upd" &
  pid=$!
  while kill -0 "$pid" 2>/dev/null; do
    st=$(update_state "$started")
    if [[ ${st%%$'\t'*} == wait ]]; then
      [[ -n $wait_since ]] || wait_since=$(date +%s)
      if (($(date +%s) - wait_since > WAIT_LIMIT_MIN * 60)) && [[ ! -e $DATA_DIR/update/cancel ]]; then
        warn "${WAIT_LIMIT_MIN} 分待っても空かないので、待つのをやめる（今の版のまま。組み立てた版は消える）"
        date -Is >"$DATA_DIR/update/cancel"
      fi
    fi
    sleep 3
  done
  wait "$pid" || rc=$?
  ((rc != 3)) || die "ほかの更新が走っています（画面の「更新」か、別の端末の update.mjs）" "終わってから打ち直してください（画面の 設定 → 更新 で進み具合を見られる）"
  IFS=$'\t' read -r phase result err logf <<<"$(update_state "$started")"
  case $phase in
    done) ok "${result:-上げた}" ;;
    cancelled)
      warn "上げていません：${result}"
      UPGRADE_PENDING=1
      ;;
    rolled-back) die "新しい版が起きなかったので、update.mjs が前の版に戻しました：$err" "ログ：$logf。release の版を直してから打ち直してください（今は前の版で動いています）" ;;
    failed) die "release の最新に上げられませんでした：$err" "ログ：${logf:-$DATA_DIR/update/}" ;;
    *) die "update.mjs が終わりましたが、この回の結果（$DATA_DIR/update/state.json）が読めません（終了コード $rc）" "上の出力を見てください" ;;
  esac

  # 版は同じでも、設定・unit が動いている banto より新しければ起こし直す（空くのを待ってから。polkit の規則で sudo を使わない）
  if unit_active banto-host.service && banto_restart_needed; then
    say "$RESTART_REASON が動いている banto より新しいので、起こし直す（動いているものが無くなるのを最長 ${WAIT_LIMIT_MIN} 分待つ）"
    if (cd "$REL/current/banto" && node scripts/restart-when-idle.mjs --timeout "$WAIT_LIMIT_MIN" --dry-run >/dev/null) &&
      systemctl restart banto-host.service banto-frontend.service; then
      ok "起こし直した"
    else
      warn "起こし直せませんでした。まだ前の設定で動いています"
      warn "空いたら：systemctl restart banto-host.service banto-frontend.service（このユーザーに polkit で許してある）"
      RESTART_PENDING=1
    fi
  fi
}

step_upgrade() {
  step "release の最新に上げる"
  if [[ ${JUST_INSTALLED:-0} == 1 ]]; then
    ok "いま入れた版が release の最新"
    return
  fi
  drop_sudo "current の update.mjs（新しい版の組み立て）"
  upgrade_banto
}

# ---------------------------------------------------------------------------
# 12. 前提を確かめて起こす
# ---------------------------------------------------------------------------

step_doctor_and_start() {
  step "画面からの更新の準備・コンテナの前提を確かめて、banto を起こす"
  if update_setup_needed; then run_setup_update; else ok "画面からの更新の準備は済んでいる（banto-update.service・polkit の規則）"; fi
  [[ -f $REL/current/banto/node_modules/next/dist/bin/next ]] || die "画面の起動に要る next が見つかりません（$REL/current/banto/node_modules/next）" "$DATA_DIR/update/ のログを見てください"
  # banto のユーザーとして、グループを引き直して確かめる（sudo -u はグループを引き直す。sg は主グループを変えるので使わない）
  (cd "$REL/current/banto" && sudo -u "$USER_NAME" -H /usr/local/bin/node packages/container/dist/doctor.js | sed 's/^/    /') ||
    die "コンテナの前提がそろっていません（上の ✖ と直し方）" "上に出た直し方のとおりに直してから打ち直してください"
  # doctor が banto のユーザーとして初めて Incus に繋ぐと、そのユーザーの区画（とブリッジ）ができる——表に入れ直す
  apply_firewall

  local u
  for u in banto-host banto-frontend; do
    unit_active "$u.service" || sudo systemctl start "$u.service"
  done
  say "起きるのを待つ"
  local i code_host="" code_ui=""
  for ((i = 0; i < 90; i++)); do
    code_host=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT_HOST/api/auth/me" || true)
    code_ui=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT_UI/" || true)
    [[ $code_host == 200 && $code_ui == 200 ]] && break
    sleep 2
  done
  [[ $code_host == 200 ]] || die "banto-host が応えません（$code_host）" "tail -50 $USER_HOME/banto-host.log と systemctl status banto-host で理由を見てください"
  [[ $code_ui == 200 ]] || die "画面（banto-frontend）が応えません（$code_ui）" "tail -50 $USER_HOME/banto-frontend.log で理由を見てください"
  ok "banto-host（$PORT_HOST）・画面（127.0.0.1:$PORT_UI）が応えた"

  # Caddy を通して確かめる（名前はこのホストに向けて引く）
  local ca=() code=""
  if [[ $TLS_MODE == internal ]]; then
    CA_ROOT="$(caddy_home)/.local/share/caddy/pki/authorities/local/root.crt"
    for ((i = 0; i < 30; i++)); do sudo test -f "$CA_ROOT" && break; sleep 1; done
    CA_COPY=$(mktemp)
    sudo cat "$CA_ROOT" 2>/dev/null | cat >"$CA_COPY" || true
    ca=(--cacert "$CA_COPY")
  fi
  for ((i = 0; i < 60; i++)); do
    code=$(curl -s -o /dev/null -w '%{http_code}' "${ca[@]}" --resolve "$DOMAIN:443:127.0.0.1" "https://$DOMAIN/api/auth/me" || true)
    [[ $code == 200 ]] && break
    sleep 2
  done
  if [[ $code == 200 ]]; then
    HTTPS_STATE=ok
    ok "https://$DOMAIN を Caddy を通して確かめた"
  else
    HTTPS_STATE=pending
    warn "https://$DOMAIN がまだ通りません（$code）。証明書を取っている途中かもしれません——journalctl -u caddy -n 50 で見てください"
  fi
}

# ---------------------------------------------------------------------------
# 13. Claude Code を入れてログインする（ここからは sudo を使わない）
# ---------------------------------------------------------------------------

CLAUDE_STATE=""
step_claude() {
  step "Claude Code を入れて、ログインする"
  drop_sudo "Claude Code の installer とログイン"
  local claude="$USER_HOME/.local/bin/claude"
  if ! command -v claude >/dev/null 2>&1 && [[ ! -x $claude ]]; then
    # 公式の入れ方（https://claude.ai/install.sh）をファイルに落としてから流す。この台本そのものの sha256・署名は
    # 公開されていない（2026-10-04 に確かめた）——台本は本体を同じ配布元（downloads.claude.ai）の manifest.json の
    # sha256 と照合して入れる
    local tmp
    tmp=$(mktemp)
    say "Claude Code を入れる（公式の入れ方：https://claude.ai/install.sh）"
    curl -fsSL https://claude.ai/install.sh -o "$tmp" || die "Claude Code の installer を取ってこられませんでした" "https://claude.ai に届くか確かめてください"
    run_detached bash "$tmp" || die "Claude Code を入れられませんでした（上の出力）" "https://downloads.claude.ai に届くか確かめてください"
    rm -f "$tmp"
  fi
  [[ -x $claude ]] || claude=$(command -v claude)
  # ログインしているかは CLI に聞く（auth status はログインしていなければ終了コード 1）
  if "$claude" auth status >/dev/null 2>&1; then
    CLAUDE_STATE=ok
    ok "ログイン済み（$USER_HOME/.claude）"
    return
  fi
  if [[ $NO_CLAUDE_LOGIN == 0 ]] && have_tty; then
    say "ブラウザでのログインを始めます（出た URL を開き、表示されたコードを貼る）"
    if "$claude" auth login </dev/tty >/dev/tty 2>&1 && "$claude" auth status >/dev/null 2>&1; then
      CLAUDE_STATE=ok
      ok "ログインした"
      return
    fi
    warn "ログインが済みませんでした"
  fi
  CLAUDE_STATE="todo:$claude auth login"
  say "あとで $USER_NAME で打つ：$claude auth login"
}

# ---------------------------------------------------------------------------
# 14. 最後の画面
# ---------------------------------------------------------------------------

step_finish() {
  step "ログインのリンクを出す"
  local link
  link=$(cd "$REL/current/banto" && node scripts/login-link.mjs | grep -oE 'https://[^ ]+#banto-login=[A-Za-z0-9_-]+' | head -1) ||
    die "ログインのリンクを出せませんでした" "cd $REL/current/banto && node scripts/login-link.mjs を打って理由を見てください"
  [[ -n $link ]] || die "ログインのリンクを出せませんでした" "cd $REL/current/banto && node scripts/login-link.mjs を打って理由を見てください"

  printf '\n\033[1m==== banto を入れました ====\033[0m\n\n'
  printf '  開く URL：https://%s/\n' "$DOMAIN"
  printf '  ログインのリンク（10分・1回だけ）：\n    %s\n' "$link"
  printf '    （切れたら：cd %s/current/banto && node scripts/login-link.mjs）\n' "$REL"
  local running
  running=$(git -C "$REL/current" log -1 --format='%h %s' 2>/dev/null || true)
  printf '  動いている版：%s（更新は画面の 設定 → 更新、または同じコマンドを打ち直す）\n' "${running:0:60}"
  if [[ $TLS_MODE == cloudflare ]]; then
    printf '  HTTPS：Let'"'"'s Encrypt（Cloudflare の DNS で証明、*.%s の1枚）%s\n' "$DOMAIN" "$([[ $HTTPS_STATE == ok ]] || echo '——まだ取得中。journalctl -u caddy で見る')"
  else
    printf '  HTTPS：Caddy の内部の CA（端末ごとに CA を信頼する必要がある）\n'
    printf '    CA のルート証明書：http://%s/banto-ca.crt（このホストでは %s）\n' "$DOMAIN" "$CA_ROOT"
  fi
  if [[ -n ${REMAINING_RECORDS:-} ]]; then
    printf '  残っている DNS のレコード：\n'
    printf '%s\n' "$REMAINING_RECORDS" | sed 's/^残っている：/    /'
  fi
  printf '\n  次にやること：\n'
  local n=1
  if [[ $TLS_MODE == internal ]]; then
    printf '   %d. 使う端末で名前を引けるようにする（DNS か hosts に「%s %s sandbox.%s」）\n' "$n" "${IP:-<このホストの IP>}" "$DOMAIN" "$DOMAIN"; n=$((n + 1))
    printf '   %d. 端末で CA を信頼する（上の banto-ca.crt を開いて入れる）\n' "$n"; n=$((n + 1))
  fi
  printf '   %d. 上のリンクを開いて入り、設定 → ログイン でパスキーを登録する\n' "$n"; n=$((n + 1))
  if [[ $CLAUDE_STATE == todo:* ]]; then
    printf '   %d. Claude にログインする：%s で %s\n' "$n" "$USER_NAME" "${CLAUDE_STATE#todo:}"; n=$((n + 1))
  fi
  if [[ ${UPGRADE_PENDING:-0} == 1 ]]; then
    printf '   %d. release の最新にはまだ上げていない：空いたら画面の 設定 → 更新、または同じコマンドを打ち直す\n' "$n"; n=$((n + 1))
  fi
  if [[ ${RESTART_PENDING:-0} == 1 ]]; then
    printf '   %d. 設定の変更はまだ効いていない：空いたら systemctl restart banto-host.service banto-frontend.service\n' "$n"; n=$((n + 1))
  fi
  if [[ $TLS_MODE == internal ]]; then
    printf '   %d. Let'"'"'s Encrypt にするとき：同じコマンドに --cloudflare-token - を足して打ち直す\n' "$n"
  fi
  printf '\n  使い方・打ち直し・入れ直し：docs/runbooks/install.md\n'
}

# ---------------------------------------------------------------------------

cleanup() {
  stop_sudo_keepalive
  [[ -n ${CA_COPY:-} ]] && rm -f "$CA_COPY"
  return 0
}

main() {
  trap 'on_error $? $LINENO' ERR
  trap cleanup EXIT
  parse_args "$@"
  # root が要る段
  step_check_host
  step_resolve_settings
  step_base_packages
  step_node
  step_config
  step_incus
  step_caddy_install
  step_https
  step_units
  step_firewall
  # 初めてのときの組み立てはユーザーの権限で、sudo の記憶を消してから（install_first_version の中）。そのあと取り直す
  step_code
  step_doctor_and_start
  # ここからは sudo を使わない。上げる・起こし直すは update.mjs と polkit の規則
  step_upgrade
  step_claude
  step_finish
}

# 全体を読み終えてから流す（curl | bash で途中までしか届かなかったときに半端に動かない）。
# 標準入力は閉じる——curl | bash では標準入力が台本そのもので、子が読むと台本を食べる。聞くときは /dev/tty
if [[ ${BANTO_INSTALL_LIB:-0} != 1 ]]; then
  main "$@" </dev/null
fi

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

DEFAULT_REPO=https://github.com/tjst-t/banto
DEFAULT_BRANCH=release
INSTALL_CONF=/etc/banto/install.conf
CF_ENV=/etc/caddy/cloudflare.env
CADDY_BIN=/usr/local/bin/caddy
BANTO_POOL=banto
PORT_HOST=4737
PORT_SANDBOX=4176
PORT_UI=4175

export PATH="/usr/local/bin:$PATH"

# ---------------------------------------------------------------------------
# 出力
# ---------------------------------------------------------------------------

CURRENT_STEP="始める前"
STEP_NO=0
STEP_TOTAL=14

step() {
  STEP_NO=$((STEP_NO + 1))
  CURRENT_STEP=$1
  printf '\n\033[1m==> [%d/%d] %s\033[0m\n' "$STEP_NO" "$STEP_TOTAL" "$1"
}
say() { printf '    %s\n' "$*"; }
ok() { printf '    \033[32m✔\033[0m %s\n' "$*"; }
warn() { printf '    \033[33m!\033[0m %s\n' "$*" >&2; }

# 何が足りないかと直し方を出して止まる
die() {
  printf '\n\033[31m✖ 段「%s」で止まりました：%s\033[0m\n' "$CURRENT_STEP" "$1" >&2
  if [[ -n ${2:-} ]]; then printf '  直し方：%s\n' "$2" >&2; fi
  printf '  直したら同じコマンドを打ち直してください（済んだ段は飛ばします）。\n' >&2
  exit 1
}

on_error() {
  printf '\n\033[31m✖ 段「%s」で止まりました（install.sh の %s 行目・終了コード %s）。\033[0m\n' "$CURRENT_STEP" "$2" "$1" >&2
  printf '  原因は上の出力にあります。直したら同じコマンドを打ち直してください（済んだ段は飛ばします）。\n' >&2
}

usage() {
  cat <<'USAGE'
banto を入れる（Ubuntu 24.04・26.04。sudo できる普通のユーザーで打つ。動かすのもそのユーザー）

  curl -fsSL https://raw.githubusercontent.com/tjst-t/banto/release/install.sh | bash -s -- --domain <名前> [オプション]

  --domain <名前>            画面の名前（例 banto.example.com）。初回は必須。sandbox.<名前>・*.<名前> も使う
  --cloudflare-token <値>    Cloudflare の API トークン（Zone:Read と DNS:Edit）。渡すと DNS のレコードを作り、
                             Let's Encrypt の証明書を取る。"-" なら端末から見えない形で聞く。
                             環境変数 CLOUDFLARE_API_TOKEN でも渡せる。無ければ Caddy の内部の CA で HTTPS にする
  --ip <IPv4>                DNS のレコードの向け先（既定：既定経路のインターフェースの IPv4）
  --branch <名前>            動かすブランチ（既定 release）
  --repo <URL|パス>          取ってくるリポジトリ（既定 https://github.com/tjst-t/banto。file://・パス・bundle も可）
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

pkg_installed() { dpkg-query -W -f='${Status}' "$1" 2>/dev/null | grep -q 'install ok installed'; }

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

# Incus の版が banto の前提（6.0.x なら 6.0.6 以降、それより上は 6.19 以降）を満たすか
# （banto/packages/container/src/prereqs.ts の versionHasNestingFix と同じ規則）
incus_version_ok() {
  local v=$1 a b c
  IFS=. read -r a b c <<<"${v%%[-~+]*}"
  a=${a:-0} b=${b:-0} c=${c:-0}
  if [[ $a == 6 && $b == 0 ]]; then ((c >= 6)); else ((a > 6 || (a == 6 && b >= 19))); fi
}

# ---------------------------------------------------------------------------
# 引数と覚えた値
# ---------------------------------------------------------------------------

ARG_DOMAIN="" ARG_IP="" ARG_BRANCH="" ARG_REPO="" ARG_POOL_SIZE="" ARG_TOKEN="" ARG_TOKEN_SET=0 NO_CLAUDE_LOGIN=0

parse_args() {
  while [[ $# -gt 0 ]]; do
    local opt=$1 val=""
    case $opt in
      --help | -h) usage; exit 0 ;;
      --no-claude-login) NO_CLAUDE_LOGIN=1; shift; continue ;;
      --*=*) val=${opt#*=}; opt=${opt%%=*}; shift ;;
      --domain | --cloudflare-token | --ip | --branch | --repo | --pool-size)
        [[ $# -ge 2 ]] || die "$opt に値がありません" "install.sh --help を見てください"
        val=$2; shift 2 ;;
      *) die "知らない引数です：$opt" "install.sh --help を見てください" ;;
    esac
    case $opt in
      --domain) ARG_DOMAIN=$val ;;
      --cloudflare-token) ARG_TOKEN=$val; ARG_TOKEN_SET=1 ;;
      --ip) ARG_IP=$val ;;
      --branch) ARG_BRANCH=$val ;;
      --repo) ARG_REPO=$val ;;
      --pool-size) ARG_POOL_SIZE=$val ;;
      *) die "知らない引数です：$opt" "install.sh --help を見てください" ;;
    esac
  done
}

# install.conf は「キー=値」の行だけ。source しない（中身をコードとして流さない）
declare -A CONF=()
read_install_conf() {
  [[ -f $INSTALL_CONF ]] || return 0
  local key value
  while IFS='=' read -r key value; do
    [[ -z $key || $key == \#* ]] && continue
    CONF[$key]=$value
  done <"$INSTALL_CONF"
}

write_install_conf() {
  put_root_file "$INSTALL_CONF" 644 < <(
    echo "# banto の install.sh が覚えた値（秘密は入れない）。打ち直しで引数を渡せば変わり、渡さなければこのまま"
    echo "user=$USER_NAME"
    echo "domain=$DOMAIN"
    echo "ip=$IP_FIXED"
    echo "branch=$BRANCH"
    echo "repo=$REPO"
    echo "pool_size=$POOL_SIZE"
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
  # 長い build の間に sudo の記憶が切れないように
  (while kill -0 "$$" 2>/dev/null; do sudo -n true 2>/dev/null; sleep 50; done) >/dev/null 2>&1 &
  SUDO_KEEPALIVE=$!

  REL="$USER_HOME/.local/share/banto-release"
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
      "${CONF[user]} で打ってください。動かすユーザーを替えるなら docs/runbooks/install.md の「入れ直し」"
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

  BRANCH=${ARG_BRANCH:-${CONF[branch]:-$DEFAULT_BRANCH}}
  REPO=${ARG_REPO:-${CONF[repo]:-$DEFAULT_REPO}}
  # ローカルのパス（bundle を含む）は絶対パスにして覚える
  if [[ $REPO != *://* && $REPO != *@*:* && -e $REPO ]]; then REPO=$(realpath "$REPO"); fi

  POOL_SIZE=${ARG_POOL_SIZE:-${CONF[pool_size]:-}}
  if [[ -n $POOL_SIZE ]]; then
    [[ $POOL_SIZE =~ ^([0-9]+)(GiB|G|GB)?$ ]] || die "--pool-size が不正です：$POOL_SIZE" "例：--pool-size 30GiB"
    POOL_SIZE="${BASH_REMATCH[1]}GiB"
  fi

  # トークン：引数 → 環境変数 → 保存済み → 端末で聞く
  TOKEN="" TOKEN_SOURCE=""
  if [[ $ARG_TOKEN_SET == 1 ]]; then
    if [[ $ARG_TOKEN == - ]]; then
      have_tty || die "--cloudflare-token - ですが、聞くための端末がありません" "環境変数 CLOUDFLARE_API_TOKEN で渡してください"
      printf '    Cloudflare の API トークン（表示されません）：' >/dev/tty
      IFS= read -rs TOKEN </dev/tty
      printf '\n' >/dev/tty
    else
      TOKEN=$ARG_TOKEN
    fi
    TOKEN_SOURCE=new
  elif [[ -n ${CLOUDFLARE_API_TOKEN:-} ]]; then
    TOKEN=$CLOUDFLARE_API_TOKEN TOKEN_SOURCE=new
  elif sudo test -f "$CF_ENV" && sudo grep -q '^CLOUDFLARE_API_TOKEN=.' "$CF_ENV"; then
    TOKEN_SOURCE=saved # 中身はここでは読まない（要るときに読む）
  elif have_tty; then
    printf '    Cloudflare の API トークン（Enter だけなら Caddy の内部の CA で HTTPS にする。表示されません）：' >/dev/tty
    IFS= read -rs TOKEN </dev/tty || TOKEN=""
    printf '\n' >/dev/tty
    [[ -n $TOKEN ]] && TOKEN_SOURCE=new
  fi
  if [[ $TOKEN_SOURCE == new ]]; then
    [[ $TOKEN =~ ^[A-Za-z0-9_-]{20,200}$ ]] || die "Cloudflare のトークンの形が違います（英数字と _- で 20 文字以上）" "Cloudflare の画面で作った API トークンを渡してください"
  fi
  if [[ -n $TOKEN_SOURCE ]]; then TLS_MODE=cloudflare; else TLS_MODE=internal; fi
  if [[ $TLS_MODE == cloudflare && -z $IP ]]; then
    die "DNS のレコードの向け先（このホストの IPv4）が分かりません" "--ip <このホストの LAN の IPv4> を足してください"
  fi

  sudo mkdir -p /etc/banto
  write_install_conf
  say "名前：$DOMAIN（sandbox.$DOMAIN・*.$DOMAIN も使う）"
  say "このホストの IP：${IP:-（分からない）}${IP_FIXED:+（--ip で指定）}"
  say "コード：$REPO の $BRANCH → $REL"
  if [[ $TLS_MODE == cloudflare ]]; then
    local which_token="保存済みのもの"
    [[ $TOKEN_SOURCE == new ]] && which_token="今回渡されたもの"
    say "HTTPS：Let's Encrypt（Cloudflare の DNS で証明。トークンは$which_token）"
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
  # age・openssh-client・sops は同梱の vault-local（秘密の置き場）が host で使う（age-keygen・ssh-keygen・ssh-agent・sops）
  apt_install ca-certificates curl git gnupg xz-utils nftables iproute2 age openssh-client
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
# 5. Incus（banto の Project のコンテナ）
# ---------------------------------------------------------------------------

step_incus() {
  step "Incus を入れて、banto の前提をそろえる"
  # 配布元（Zabbly）の鍵：指紋を照合してから置く
  local key fpr
  key=$(mktemp)
  curl -fsSL https://pkgs.zabbly.com/key.asc -o "$key" || die "Zabbly の鍵を取ってこられませんでした" "https://pkgs.zabbly.com に届くか確かめてください"
  fpr=$(gpg --show-keys --with-colons "$key" 2>/dev/null | awk -F: '$1 == "fpr" { print $10; exit }')
  [[ $fpr == "$ZABBLY_FPR" ]] || die "Zabbly の鍵の指紋が合いません（$fpr）" "鍵がすり替えられているおそれがあります。https://github.com/zabbly/incus の指紋と比べてください"
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

  if ! id -nG "$USER_NAME" | tr ' ' '\n' | grep -qx incus; then
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
# 6. Caddy（入口。HTTPS と、画面・API・サンドボックスへの振り分け）
# ---------------------------------------------------------------------------

step_caddy_install() {
  step "Caddy を入れる"
  if [[ -x $CADDY_BIN ]] && "$CADDY_BIN" list-modules 2>/dev/null | grep -qx dns.providers.cloudflare; then
    ok "入っている（$("$CADDY_BIN" version | cut -d' ' -f1)、Cloudflare の DNS 入り）"
  else
    local tmp
    tmp=$(mktemp)
    say "caddyserver.com から Cloudflare の DNS 入りの版を取ってくる"
    curl -fsSL "https://caddyserver.com/api/download?os=linux&arch=$CADDY_ARCH&p=github.com%2Fcaddy-dns%2Fcloudflare" -o "$tmp" ||
      die "Caddy を取ってこられませんでした" "https://caddyserver.com に届くか確かめてください"
    chmod +x "$tmp"
    "$tmp" list-modules 2>/dev/null | grep -qx dns.providers.cloudflare || die "取ってきた Caddy に Cloudflare の DNS が入っていません" "時間をおいて打ち直してください"
    sudo install -m 755 "$tmp" "$CADDY_BIN"
    rm -f "$tmp"
    ok "入れた（$("$CADDY_BIN" version | cut -d' ' -f1)）"
  fi

  getent group caddy >/dev/null || sudo groupadd --system caddy
  if ! id caddy >/dev/null 2>&1; then
    sudo useradd --system --gid caddy --create-home --home-dir /var/lib/caddy --shell /usr/sbin/nologin --comment "Caddy web server" caddy
  fi

  # unit：apt の caddy 等が既にあれば drop-in で差し替え、無ければ作る。--environ は付けない（トークンが journal に出る）
  local marker="# banto の install.sh が作った"
  if systemctl cat caddy.service >/dev/null 2>&1 && ! systemctl cat caddy.service 2>/dev/null | grep -qF "$marker"; then
    put_root_file /etc/systemd/system/caddy.service.d/50-banto.conf 644 <<EOF
$marker（Cloudflare の DNS 入りの $CADDY_BIN に差し替える）
[Service]
ExecStart=
ExecStart=$CADDY_BIN run --config /etc/caddy/Caddyfile
ExecReload=
ExecReload=$CADDY_BIN reload --config /etc/caddy/Caddyfile --force
EnvironmentFile=-$CF_ENV
EOF
  else
    put_root_file /etc/systemd/system/caddy.service 644 <<EOF
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
# 7. HTTPS（Cloudflare の DNS か、Caddy の内部の CA）と Caddy の設定
# ---------------------------------------------------------------------------

# Cloudflare の API でゾーンを探し、<名前> と *.<名前> の A レコードを作る／直す（proxied: false）。
# トークンは環境変数 CLOUDFLARE_API_TOKEN で受ける（コマンド行に出さない）。基点は BANTO_CLOUDFLARE_API で差し替えられる
cloudflare_upsert_records() {
  local domain=$1 ip=$2
  node --input-type=module - "$domain" "$ip" <<'JS'
const [domain, ip] = process.argv.slice(2);
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
try {
  const zones = [];
  for (let page = 1; ; page++) {
    const j = await cf("GET", `/zones?per_page=50&page=${page}`);
    zones.push(...j.result);
    if (page >= (j.result_info?.total_pages ?? 1)) break;
  }
  const zone = zones
    .filter((z) => domain === z.name || domain.endsWith(`.${z.name}`))
    .sort((a, b) => b.name.length - a.name.length)[0];
  if (!zone) {
    throw new Error(`トークンで見えるゾーンに ${domain} を含むものがありません（見えるゾーン：${zones.map((z) => z.name).join(", ") || "無し"}）。トークンに Zone:Read を付け、対象のゾーンを含めてください`);
  }
  console.log(`ゾーン：${zone.name}`);
  for (const name of [domain, `*.${domain}`]) {
    const found = (await cf("GET", `/zones/${zone.id}/dns_records?type=A&name=${encodeURIComponent(name)}`)).result;
    if (found.length > 1) throw new Error(`${name} の A レコードが ${found.length} 個あります（${found.map((r) => r.content).join(", ")}）。banto はどれを直すか決められません——Cloudflare の画面で1つにしてください`);
    if (found.length === 0) {
      await cf("POST", `/zones/${zone.id}/dns_records`, { type: "A", name, content: ip, proxied: false, ttl: 1 });
      console.log(`作った：${name} → ${ip}`);
    } else if (found[0].content === ip && found[0].proxied === false) {
      console.log(`そのまま：${name} → ${ip}`);
    } else {
      await cf("PATCH", `/zones/${zone.id}/dns_records/${found[0].id}`, { content: ip, proxied: false });
      console.log(`直した：${name} ${found[0].content}${found[0].proxied ? "（proxied）" : ""} → ${ip}`);
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
    ca_dir="$(getent passwd caddy | cut -d: -f6)/.local/share/caddy/pki/authorities/local"
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

# Caddy に Caddyfile を確かめさせる（トークンは環境変数で渡す）
caddy_validate() {
  sudo -u caddy -H bash -c 'cd / && set -a && if [ -r "$1" ]; then . "$1"; fi && exec "$2" validate --config /etc/caddy/Caddyfile --adapter caddyfile' _ "$CF_ENV" "$CADDY_BIN" 2>&1
}

step_https() {
  step "HTTPS と入口（Caddy）を設定する"
  local env_changed=0
  if [[ $TLS_MODE == cloudflare ]]; then
    if [[ $TOKEN_SOURCE == saved ]]; then
      TOKEN=$(sudo sed -n 's/^CLOUDFLARE_API_TOKEN=//p' "$CF_ENV" | head -1)
    fi
    say "Cloudflare の DNS に $DOMAIN と *.$DOMAIN（→ $IP）を作る／直す"
    CLOUDFLARE_API_TOKEN=$TOKEN cloudflare_upsert_records "$DOMAIN" "$IP" | sed 's/^/    /' ||
      die "Cloudflare の DNS を直せませんでした（理由は上）" "トークンに Zone:Read と DNS:Edit が付いているか、名前がそのゾーンの中かを確かめてください"
    # 一時ファイルを経ずに置く（トークンを残すのは cloudflare.env だけ）
    if [[ $TOKEN_SOURCE == new ]] && ! printf 'CLOUDFLARE_API_TOKEN=%s\n' "$TOKEN" | sudo cmp -s - "$CF_ENV" 2>/dev/null; then
      printf 'CLOUDFLARE_API_TOKEN=%s\n' "$TOKEN" |
        sudo sh -c 'umask 177 && cat >"$1.tmp" && chown root:caddy "$1.tmp" && chmod 640 "$1.tmp" && mv "$1.tmp" "$1"' _ "$CF_ENV"
      env_changed=1
      ok "トークンを $CF_ENV（root:caddy 0640）に置いた"
    fi
  fi
  TOKEN="" # これより先では使わない

  # 置き換える前の中身を控え、Caddy が受け付けなければ戻す（壊れた設定を残さない）
  local conf=/etc/caddy/banto.d/banto.caddy backup
  backup=$(mktemp)
  if sudo test -f "$conf"; then sudo cat "$conf" | cat >"$backup"; fi
  put_root_file "$conf" 644 < <(render_banto_caddy "$DOMAIN" "$TLS_MODE")
  local conf_changed=$FILE_CHANGED out
  if ! out=$(caddy_validate); then
    if [[ -s $backup ]]; then put_root_file "$conf" 644 <"$backup"; else sudo rm -f "$conf"; fi
    rm -f "$backup"
    printf '%s\n' "$out" | tail -5 | sed 's/^/    /' >&2
    local hint="上の Caddy のエラーを見てください"
    if sudo grep -v '^[[:space:]]*#' /etc/caddy/Caddyfile | grep -qF "$DOMAIN"; then
      hint="/etc/caddy/Caddyfile に $DOMAIN のサイトが既にあるようです。banto の設定は /etc/caddy/banto.d/ に作るので、Caddyfile の $DOMAIN の部分を消してから打ち直してください"
    fi
    die "Caddy が設定を受け付けませんでした（banto の設定は元に戻した）" "$hint"
  fi
  rm -f "$backup"

  sudo systemctl enable caddy.service >/dev/null 2>&1
  if ! unit_active caddy.service; then
    sudo systemctl start caddy.service
  elif [[ $env_changed == 1 || ${CADDY_NEEDS_RESTART:-0} == 1 ]]; then
    # 環境変数（トークン）と unit は reload では読み直されない。公開の道は publish-caddy が routes.json から張り直す
    sudo systemctl restart caddy.service
  elif [[ $conf_changed == 1 ]]; then
    sudo systemctl reload caddy.service
  fi
  unit_active caddy.service || die "Caddy が起きません" "journalctl -u caddy -n 50 で理由を見てください"
  ok "Caddy：https://$DOMAIN・https://sandbox.$DOMAIN（$([[ $TLS_MODE == cloudflare ]] && echo "Let's Encrypt" || echo "内部の CA")）"
}

# ---------------------------------------------------------------------------
# 8. banto の設定（config.json）と Publish の設定
# ---------------------------------------------------------------------------

step_config() {
  step "banto の設定を書く"
  local result
  result=$(node --input-type=module - "$CONFIG_PATH" "$DOMAIN" "$TLS_MODE" <<'JS'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
const [path, domain, tlsMode] = process.argv.slice(2);
const out = [];
function writeJson(p, value, before) {
  const text = JSON.stringify(value, null, 2) + "\n";
  if (text === before) return false;
  mkdirSync(dirname(p), { recursive: true, mode: 0o700 });
  writeFileSync(`${p}.tmp`, text, { mode: 0o600 });
  renameSync(`${p}.tmp`, p);
  return true;
}
// 既にある設定は他の項目を残し、要る項目だけ直す。authToken は消さない（無ければ作る——無いと起動のたびに変わる）
const before = existsSync(path) ? readFileSync(path, "utf8") : "";
const raw = before ? JSON.parse(before) : {};
if (!raw.authToken) raw.authToken = randomBytes(32).toString("base64url");
const oldHost = raw.publicUrl ? new URL(raw.publicUrl).hostname : undefined;
raw.publicUrl = `https://${domain}`;
raw.sandboxPublicUrl = `https://sandbox.${domain}`;
let origins = Array.isArray(raw.allowedEmbedderOrigins) ? raw.allowedEmbedderOrigins : ["http://127.0.0.1:4175", "http://localhost:4175"];
if (oldHost && oldHost !== domain) origins = origins.filter((o) => o !== `https://${oldHost}`);
if (!origins.includes(`https://${domain}`)) origins.push(`https://${domain}`);
raw.allowedEmbedderOrigins = origins;
out.push(writeJson(path, raw, before) ? "config=changed" : "config=same");
if (raw.uiOrigin && new URL(raw.uiOrigin).origin !== `https://${domain}`) out.push(`warn=設定の uiOrigin（${raw.uiOrigin}）が画面の住所と違います。ログインが通らないので、要らなければ消してください`);
// Publish（publish-caddy）の設定：置き場は <dataDir>/modules/<入れた名前>。目録から入れるときの既定の名前 publish-caddy に置く
if (tlsMode === "cloudflare") {
  const dataDir = raw.dataDir ?? join(process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"), "banto");
  const sp = join(dataDir, "modules", "publish-caddy", "settings.json");
  const sBefore = existsSync(sp) ? readFileSync(sp, "utf8") : "";
  const s = sBefore ? JSON.parse(sBefore) : {};
  s.adminUrl ??= "http://127.0.0.1:2019";
  s.reach ??= "internet";
  s.baseDomain = domain;
  out.push(writeJson(sp, s, sBefore) ? `publish=changed:${sp}` : `publish=same:${sp}`);
}
console.log(out.join("\n"));
JS
)
  local line
  while IFS= read -r line; do
    case $line in
      config=changed) BANTO_NEEDS_RESTART=1; ok "$CONFIG_PATH を直した（publicUrl=https://$DOMAIN）" ;;
      config=same) ok "$CONFIG_PATH はそのまま" ;;
      publish=changed:*) ok "Publish の基のドメインを $DOMAIN にした（${line#publish=changed:}）" ;;
      publish=same:*) ok "Publish の基のドメインは $DOMAIN のまま" ;;
      warn=*) warn "${line#warn=}" ;;
    esac
  done <<<"$result"
  if [[ $TLS_MODE == internal ]]; then
    say "Publish は使えません（公開先 *.$DOMAIN の DNS と証明書が要る——Cloudflare のトークンを渡して打ち直すと使える）"
  fi
}

# ---------------------------------------------------------------------------
# 9. systemd の unit と host の守り
# ---------------------------------------------------------------------------

step_units() {
  step "banto の unit を作る"
  local path_env="$USER_HOME/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" changed=0
  put_root_file /etc/systemd/system/banto-host.service 644 <<EOF
# banto の install.sh が作った（打ち直すと作り直す）。docs/runbooks/release.md
[Unit]
Description=banto host (core)
After=network-online.target incus.socket incus.service
Wants=network-online.target
StartLimitIntervalSec=60
StartLimitBurst=5

[Service]
Type=simple
User=$USER_NAME
WorkingDirectory=$REL/banto
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
  changed=$((changed | FILE_CHANGED))
  # 画面は 127.0.0.1 だけで待つ（外からは Caddy を通る）
  put_root_file /etc/systemd/system/banto-frontend.service 644 <<EOF
# banto の install.sh が作った（打ち直すと作り直す）。docs/runbooks/release.md
[Unit]
Description=banto frontend (Next.js)
After=network-online.target banto-host.service
Wants=network-online.target
StartLimitIntervalSec=60
StartLimitBurst=5

[Service]
Type=simple
User=$USER_NAME
WorkingDirectory=$REL/banto/apps/frontend
Environment=NODE_ENV=production LANG=C.UTF-8 HOME=$USER_HOME PATH=$path_env
ExecStart=/usr/local/bin/node $REL/banto/node_modules/next/dist/bin/next start -H 127.0.0.1 -p $PORT_UI
KillMode=mixed
Restart=always
RestartSec=3
LimitNOFILE=1048576
StandardOutput=append:$USER_HOME/banto-frontend.log
StandardError=append:$USER_HOME/banto-frontend.log

[Install]
WantedBy=multi-user.target
EOF
  changed=$((changed | FILE_CHANGED))

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
    changed=$((changed | FILE_CHANGED))
  done
  sudo systemctl daemon-reload
  [[ $changed == 1 ]] && BANTO_NEEDS_RESTART=1
  ok "banto-host.service・banto-frontend.service（ユーザー $USER_NAME）・system.slice の守り"
}

# ---------------------------------------------------------------------------
# 10. 外から banto の口に直に届かせない（nftables の banto 専用の表）
# ---------------------------------------------------------------------------

step_firewall() {
  step "外から banto の口に直に届かないようにする"
  # core は 0.0.0.0 で待つ（Project のコンテナがブリッジ越しに /relay へ来る）。lo と Incus のブリッジ以外から落とす。
  # 表を作ってから消して作り直す——何度入れても同じ結果になる（nft -f は1つの処理として入る）
  put_root_file /etc/banto/nftables.conf 644 <<EOF
# banto の install.sh が作った。lo と Incus のブリッジ（incusbr*）以外から banto の口へ来たものを落とす
table inet banto
delete table inet banto
table inet banto {
	chain input {
		type filter hook input priority filter - 10; policy accept;
		iifname "lo" accept
		iifname "incusbr*" accept
		tcp dport { $PORT_UI, $PORT_SANDBOX, $PORT_HOST } drop
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
  sudo systemctl daemon-reload
  sudo systemctl enable banto-firewall.service >/dev/null 2>&1
  if ! unit_active banto-firewall.service; then
    sudo systemctl start banto-firewall.service
  elif [[ $conf_changed == 1 ]]; then
    sudo systemctl reload banto-firewall.service
  fi
  sudo nft list table inet banto >/dev/null 2>&1 || die "nftables の表 banto が入っていません" "journalctl -u banto-firewall -n 20 で理由を見てください"
  ok "lo・incusbr* 以外から $PORT_HOST・$PORT_SANDBOX・$PORT_UI へ来たものを落とす（banto-firewall.service）"
}

# ---------------------------------------------------------------------------
# 11. 上げる（コードを取り込み、build し、動いていれば起こし直す）
# ---------------------------------------------------------------------------

# **「上げる」段はこの関数に閉じ込める**——稼働中の版の置き場（versions/<commit> と current の symlink、
# scripts/update.mjs）が決まったら、ここを差し替える（docs/notes/2026-10-04-installer.md）。
# 引数：1 なら、コードが変わっていなくても（設定・unit が変わったので）起こし直す
upgrade_banto() {
  local force_restart=${1:-0} code_changed=0 head built
  if [[ ! -d $REL/.git ]]; then
    [[ ! -e $REL ]] || die "$REL がありますが、git の clone ではありません" "中身を確かめて、別の場所へ動かしてから打ち直してください"
    say "取ってくる：$REPO（$BRANCH）→ $REL"
    mkdir -p "$(dirname "$REL")"
    git clone --quiet --branch "$BRANCH" "$REPO" "$REL" || die "コードを取ってこられませんでした" "--repo と --branch を確かめてください"
  else
    [[ -z $(git -C "$REL" status --porcelain) ]] || die "$REL に手を入れた跡があります（git status が空でない）" \
      "git -C $REL status で中身を見て、要らなければ git -C $REL checkout -- . && git -C $REL clean -fd"
    [[ "$(git -C "$REL" remote get-url origin)" == "$REPO" ]] || git -C "$REL" remote set-url origin "$REPO"
    git -C "$REL" fetch --quiet origin "+refs/heads/$BRANCH:refs/remotes/origin/$BRANCH" ||
      die "コードの最新を取ってこられませんでした" "--repo と --branch を確かめてください"
    if [[ "$(git -C "$REL" rev-parse --abbrev-ref HEAD)" != "$BRANCH" ]]; then
      say "ブランチを $BRANCH に替える"
      git -C "$REL" checkout --quiet -B "$BRANCH" "origin/$BRANCH"
    else
      git -C "$REL" merge --quiet --ff-only "origin/$BRANCH" ||
        die "$REL の $BRANCH が origin/$BRANCH から早送りできません（誰かが手を入れたか、release が書き換えられた）" \
          "git -C $REL log --oneline -3 origin/$BRANCH と見比べてください。release に合わせるなら git -C $REL reset --hard origin/$BRANCH"
    fi
  fi
  head=$(git -C "$REL" rev-parse HEAD)
  built=$(cat "$REL/.git/banto-built-commit" 2>/dev/null || true)
  if [[ $head != "$built" ]]; then
    local subject
    subject=$(git -C "$REL" log -1 --format='%h %s')
    say "build する（${subject:0:60}）。数分かかります" # cut -c は日本語をバイトで切る
    (cd "$REL/banto" && env -u NODE_ENV npm ci --include=dev --no-audit --no-fund && env -u NODE_ENV npm run build) ||
      die "build に失敗しました（上の出力）" "コードの側の問題なら、直った版が release に来てから打ち直してください"
    echo "$head" >"$REL/.git/banto-built-commit"
    code_changed=1
  else
    ok "コードは最新（$(git -C "$REL" log -1 --format='%h')）で build 済み"
  fi
  [[ -f $REL/banto/node_modules/next/dist/bin/next ]] || die "画面の起動に要る next が見つかりません（$REL/banto/node_modules/next）" "cd $REL/banto && npm ci --include=dev"

  if [[ $code_changed == 1 || $force_restart == 1 ]] && unit_active banto-host.service; then
    say "動いているもの（会話・サブエージェントの仕事・Module の呼び出し）が無くなるのを待って起こし直す（最長 30 分）"
    if ! (cd "$REL/banto" && node scripts/restart-when-idle.mjs --timeout 30); then
      warn "起こし直せませんでした。まだ前の版・前の設定で動いています"
      warn "空いたら：cd $REL/banto && node scripts/restart-when-idle.mjs"
      RESTART_PENDING=1
    fi
  fi
}

step_upgrade() {
  step "banto のコードを取り込んで build する"
  upgrade_banto "${BANTO_NEEDS_RESTART:-0}"
}

# ---------------------------------------------------------------------------
# 12. 前提を確かめて起こす
# ---------------------------------------------------------------------------

step_doctor_and_start() {
  step "コンテナの前提を確かめて、banto を起こす"
  # banto のユーザーとして、グループを引き直して確かめる（sudo -u はグループを引き直す。sg は主グループを変えるので使わない）
  (cd "$REL/banto" && sudo -u "$USER_NAME" -H /usr/local/bin/node packages/container/dist/doctor.js | sed 's/^/    /') ||
    die "コンテナの前提がそろっていません（上の ✖ と直し方）" "直してから打ち直してください"

  sudo systemctl enable banto-host.service banto-frontend.service >/dev/null 2>&1
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
    CA_ROOT="$(getent passwd caddy | cut -d: -f6)/.local/share/caddy/pki/authorities/local/root.crt"
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
# 13. Claude のログイン
# ---------------------------------------------------------------------------

CLAUDE_STATE=""
step_claude() {
  step "Claude Code を入れて、ログインする"
  local claude="$USER_HOME/.local/bin/claude"
  if ! command -v claude >/dev/null 2>&1 && [[ ! -x $claude ]]; then
    say "Claude Code を入れる（公式の入れ方：https://claude.ai/install.sh）"
    curl -fsSL https://claude.ai/install.sh | bash ||
      die "Claude Code を入れられませんでした" "https://claude.ai に届くか確かめてください"
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
  link=$(cd "$REL/banto" && node scripts/login-link.mjs | grep -oE 'https://[^ ]+#banto-login=[A-Za-z0-9_-]+' | head -1) ||
    die "ログインのリンクを出せませんでした" "cd $REL/banto && node scripts/login-link.mjs を打って理由を見てください"
  [[ -n $link ]] || die "ログインのリンクを出せませんでした" "cd $REL/banto && node scripts/login-link.mjs を打って理由を見てください"

  printf '\n\033[1m==== banto を入れました ====\033[0m\n\n'
  printf '  開く URL：https://%s/\n' "$DOMAIN"
  printf '  ログインのリンク（10分・1回だけ）：\n    %s\n' "$link"
  printf '    （切れたら：cd %s/banto && node scripts/login-link.mjs）\n' "$REL"
  if [[ $TLS_MODE == cloudflare ]]; then
    printf '  HTTPS：Let'"'"'s Encrypt（Cloudflare の DNS で証明、*.%s の1枚）%s\n' "$DOMAIN" "$([[ $HTTPS_STATE == ok ]] || echo '——まだ取得中。journalctl -u caddy で見る')"
  else
    printf '  HTTPS：Caddy の内部の CA（端末ごとに CA を信頼する必要がある）\n'
    printf '    CA のルート証明書：http://%s/banto-ca.crt（このホストでは %s）\n' "$DOMAIN" "$CA_ROOT"
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
  if [[ ${RESTART_PENDING:-0} == 1 ]]; then
    printf '   %d. 新しい版はまだ動いていない：空いたら cd %s/banto && node scripts/restart-when-idle.mjs\n' "$n" "$REL"; n=$((n + 1))
  fi
  if [[ $TLS_MODE == internal ]]; then
    printf '   %d. Let'"'"'s Encrypt にするとき：同じコマンドに --cloudflare-token - を足して打ち直す\n' "$n"
  fi
  printf '\n  使い方・打ち直し・入れ直し：docs/runbooks/install.md\n'
}

# ---------------------------------------------------------------------------

cleanup() {
  [[ -n ${SUDO_KEEPALIVE:-} ]] && kill "$SUDO_KEEPALIVE" 2>/dev/null
  [[ -n ${CA_COPY:-} ]] && rm -f "$CA_COPY"
  return 0
}

main() {
  trap 'on_error $? $LINENO' ERR
  trap cleanup EXIT
  parse_args "$@"
  step_check_host
  step_resolve_settings
  step_base_packages
  step_node
  step_incus
  step_caddy_install
  step_https
  step_config
  step_units
  step_firewall
  step_upgrade
  step_doctor_and_start
  step_claude
  step_finish
}

# 全体を読み終えてから流す（curl | bash で途中までしか届かなかったときに半端に動かない）。
# 標準入力は閉じる——curl | bash では標準入力が台本そのもので、子が読むと台本を食べる。聞くときは /dev/tty
if [[ ${BANTO_INSTALL_LIB:-0} != 1 ]]; then
  main "$@" </dev/null
fi

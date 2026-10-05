#!/usr/bin/env bash
# **本物の Cloudflare と Let's Encrypt で** install.sh の HTTPS を確かめる試験の場（run.sh の偽物の Cloudflare では届かない所）。
#
#   CLOUDFLARE_API_TOKEN=… banto/scripts/install-test/real-cloudflare.sh [--keep]
#
# 使う名前は install-test.tjstkm.net と install-test2.tjstkm.net だけ（tjstkm.net のほかのレコードには触らない——install.sh が
# 触るのは <名前>・*.<名前> と、名前を替えたときの前の名前の2つだけ）。流れ：
#   1. トークン無しで入れる（内部の CA）
#   2. トークンを渡して打ち直す（HTTPS 化：A レコードを作り、Let's Encrypt の証明書を DNS-01 で取る）
#   3. 名前を install-test2 に替えて打ち直す（印つきの前のレコードが消える・新しい名前で証明書を取る）
# 終わったら（落ちても）Cloudflare の install-test*.tjstkm.net のレコードを全部消し、消えたことを API で確かめ、試験の場を消す。
#
# **トークンをコマンド行・ログ・ファイルに出さない**：試験の場へは incus exec の標準入力で渡し、中のユーザーの 0600 の
# ファイルに置いて、install.sh を流す直前に環境変数へ読み込んですぐ消す。ログの中に無いことは、トークンをパターンとして
# 標準入力から grep に渡して確かめる（grep のコマンド行にも出さない）。
# Let's Encrypt の上限（同じ名前の組は週5回）に気をつけて、本番の ACME で取るのは 2 の名前と 3 の名前の1回ずつだけ。
# shellcheck disable=SC2015,SC2016,SC2024 # pass||fail の並び・中で展開する台本・自分のファイルへの書き出し
set -euo pipefail

if [[ -z ${INSTALL_TEST_COPY:-} ]]; then
  copy=$(mktemp /tmp/install-test-real-XXXX.sh)
  cp "$0" "$copy"
  INSTALL_TEST_COPY=1 INSTALL_TEST_HERE=$(cd "$(dirname "$0")" && pwd) exec bash "$copy" "$@"
fi
KEEP=0
[[ ${1:-} == --keep ]] && KEEP=1
[[ -n ${CLOUDFLARE_API_TOKEN:-} ]] || { echo "CLOUDFLARE_API_TOKEN がありません" >&2; exit 2; }

ZONE=tjstkm.net D1=install-test.tjstkm.net D2=install-test2.tjstkm.net TUSER=bantotester
here=$INSTALL_TEST_HERE
repo=$(git -C "$here" rev-parse --show-toplevel)
branch=$(git -C "$repo" rev-parse --abbrev-ref HEAD)
NAME="bt-install-cf-$(date +%H%M%S)"
LOG=$(mktemp -d "/tmp/install-test-$NAME-XXXX")
FAILS=0 PASSES=0
pass() { echo "PASS $*" | tee -a "$LOG/result.txt"; PASSES=$((PASSES + 1)); }
fail() { echo "FAIL $*" | tee -a "$LOG/result.txt"; FAILS=$((FAILS + 1)); }
note() { printf '\n\033[1m--- %s\033[0m\n' "$*"; }
I() { sudo incus "$@" </dev/null; }
X() { sudo incus exec "$NAME" --cwd /tmp -- "$@" </dev/null; }
U() { sudo incus exec "$NAME" --cwd /tmp -- sudo -u "$TUSER" -H "$@" </dev/null; }
# トークンを含むかを、トークンをコマンド行に出さずに見る（あれば 0）
has_token() { grep -qF -f <(printf '%s\n' "$CLOUDFLARE_API_TOKEN") "$@"; }

# Cloudflare の API（このホストから。トークンは環境変数のまま node に渡す）。install-test*.tjstkm.net だけを見る・消す
cf_records() {
  node --input-type=module -e '
    const t = process.env.CLOUDFLARE_API_TOKEN, base = "https://api.cloudflare.com/client/v4";
    const cf = async (m, p) => (await fetch(base + p, { method: m, headers: { authorization: `Bearer ${t}` } })).json();
    const zone = (await cf("GET", `/zones?name=${process.argv[1]}`)).result[0];
    const all = [];
    for (let page = 1; ; page++) {
      const r = await cf("GET", `/zones/${zone.id}/dns_records?per_page=100&page=${page}`);
      all.push(...r.result);
      if (page >= (r.result_info?.total_pages ?? 1)) break;
    }
    // 名前の最後が install-test*.tjstkm.net の部分に一致するものだけ（_acme-challenge.… も含む）
    const mine = all.filter((r) => /(^|\.)install-test2?\.tjstkm\.net$/.test(r.name));
    if (process.argv[2] === "delete") {
      for (const r of mine) {
        const d = await cf("DELETE", `/zones/${zone.id}/dns_records/${r.id}`);
        console.log(`消した：${r.type} ${r.name}（${d.success ? "ok" : JSON.stringify(d.errors)}）`);
      }
    } else for (const r of mine) console.log(JSON.stringify({ type: r.type, name: r.name, content: r.content, proxied: r.proxied, comment: r.comment ?? null }));
  ' "$ZONE" "${1:-list}"
}

cleanup() {
  set +e
  note "片づけ：Cloudflare の install-test*.tjstkm.net を消し、消えたことを確かめる"
  cf_records delete | tee -a "$LOG/cleanup.txt"
  left=$(cf_records list)
  if [[ -z $left ]]; then echo "PASS 片づけ：Cloudflare に install-test*.tjstkm.net のレコードは残っていない" | tee -a "$LOG/result.txt"; else echo "FAIL 片づけ：残っている：$left" | tee -a "$LOG/result.txt"; fi
  X rm -f "/home/$TUSER/.cf-token" 2>/dev/null
  if [[ $KEEP == 1 ]]; then echo "試験の場を残した：$NAME"; else I delete --force "$NAME" >/dev/null 2>&1; fi
  echo "ログ：$LOG"
}
# 始める前からあるものは、片づけで消してしまわないよう、罠を張る前に断る
[[ -z $(cf_records list) ]] || { echo "始める前から install-test*.tjstkm.net のレコードがあります。見てから消してください" >&2; exit 1; }
trap cleanup EXIT

note "試験の場を作る（ubuntu/24.04・$branch の $(git -C "$repo" rev-parse --short HEAD)）"
git clone -q --no-local "$repo" "$LOG/src" -b "$branch"
git -C "$LOG/src" branch -q -f release HEAD
git -C "$LOG/src" bundle create "$LOG/banto.bundle" release 2>/dev/null
I launch images:ubuntu/24.04 "$NAME" -c security.nesting=true -c security.syscalls.intercept.mknod=true \
  -c security.syscalls.intercept.setxattr=true -c limits.cpu=3 -c limits.memory=6GiB >/dev/null
X systemctl is-system-running --wait >/dev/null 2>&1 || true
for _ in $(seq 60); do X getent hosts pkgs.zabbly.com >/dev/null 2>&1 && break; sleep 2; done
X useradd -m -s /bin/bash -G sudo "$TUSER"
X sh -c "echo '$TUSER ALL=(ALL:ALL) NOPASSWD: ALL' > /etc/sudoers.d/90-$TUSER && chmod 0440 /etc/sudoers.d/90-$TUSER"
X mkdir -p /etc/systemd/system/incus.service.d /opt/banto-test
X sh -c 'printf "[Service]\nEnvironment=INCUS_SECURITY_APPARMOR=false\n" > /etc/systemd/system/incus.service.d/90-install-test-no-apparmor.conf'
git -C "$repo" show HEAD:install.sh >"$LOG/install.sh"
I file push -q "$LOG/install.sh" "$NAME/opt/banto-test/install.sh"
I file push -q "$LOG/banto.bundle" "$NAME/opt/banto-test/banto.bundle"
X chmod -R a+rX /opt/banto-test
IP=$(I list "$NAME" -c 4 -f csv | grep -oE '([0-9]+\.){3}[0-9]+ \(eth0\)' | cut -d' ' -f1 | head -1)
echo "試験の場：$NAME（eth0 $IP）ログ：$LOG"

# install.sh を `curl | bash` の形で流す。WITH_TOKEN=1 なら、中のユーザーのファイルに置いたトークンを環境変数に読み込んで
# すぐ消してから流す。流している間、中の ps を1秒おきに写す（コマンド行にトークンが出ないことを見る）
run_install() {
  local log=$1 rc=0 sampler; shift
  (while :; do X ps -eo args >>"$LOG/ps-$log.txt" 2>/dev/null; sleep 1; done) &
  sampler=$!
  if [[ ${WITH_TOKEN:-0} == 1 ]]; then
    sudo incus exec "$NAME" --cwd /tmp -- sudo -u "$TUSER" -H bash -c \
      'export CLOUDFLARE_API_TOKEN="$(cat ~/.cf-token)"; rm -f ~/.cf-token; cat /opt/banto-test/install.sh | bash -s -- "$@"' _ "$@" \
      </dev/null >"$LOG/$log.log" 2>&1 || rc=$?
  else
    sudo incus exec "$NAME" --cwd /tmp -- sudo -u "$TUSER" -H bash -c 'cat /opt/banto-test/install.sh | bash -s -- "$@"' _ "$@" \
      </dev/null >"$LOG/$log.log" 2>&1 || rc=$?
  fi
  kill "$sampler" 2>/dev/null; wait "$sampler" 2>/dev/null || true
  echo "$rc"
}
# トークンを、試験の場の中のユーザーの 0600 のファイルに置く（incus exec の標準入力で渡す——コマンド行に出さない）
put_token() {
  printf '%s\n' "$CLOUDFLARE_API_TOKEN" |
    sudo incus exec "$NAME" -- sh -c "umask 077 && cat > /home/$TUSER/.cf-token && chown $TUSER: /home/$TUSER/.cf-token"
}
# 試験の場の中から、本物の DNS で名前を引き、--cacert 無しで https を叩く。200 になるまで最長 secs 秒待つ
wait_https() {
  local url=$1 secs=$2 code="" i
  for ((i = 0; i < secs / 5; i++)); do
    code=$(X curl -s -o /dev/null -m 10 -w '%{http_code}' "$url" || true)
    [[ $code == 200 ]] && break
    sleep 5
  done
  echo "$code"
}
issuer_of() { X sh -c "echo | openssl s_client -connect $1:443 -servername $1 2>/dev/null | openssl x509 -noout -issuer -subject -ext subjectAltName 2>/dev/null" | tr '\n' ' '; }

# ---------------------------------------------------------------------------
note "1. トークン無しで入れる（内部の CA、$D1）"
start=$(date +%s)
rc=$(run_install run1 --domain "$D1" --repo /opt/banto-test/banto.bundle --no-claude-login)
[[ $rc == 0 ]] && grep -q 'Caddy の内部の CA' "$LOG/run1.log" && pass "1: トークン無しで通る（内部の CA、$(($(date +%s) - start)) 秒）" || { fail "1: rc=$rc"; tail -20 "$LOG/run1.log"; exit 1; }
[[ -z $(cf_records list) ]] && pass "1: トークン無しでは Cloudflare に何も作らない" || fail "1: レコードができた"

note "2. トークンを渡して打ち直す（HTTPS 化：内部の CA → Let's Encrypt）"
put_token
start=$(date +%s)
rc=$(WITH_TOKEN=1 run_install run2 --no-claude-login)
[[ $rc == 0 ]] && pass "2: トークンを渡して打ち直すと通る（$(($(date +%s) - start)) 秒）" || { fail "2: rc=$rc"; tail -25 "$LOG/run2.log"; exit 1; }
X test ! -e "/home/$TUSER/.cf-token" && pass "2: 渡すのに使ったファイルは消えている" || fail "2: トークンのファイルが残っている"
grep -aE '作った：|直した：|そのまま：|ゾーン：' "$LOG/run2.log" | sed 's/^/  /'
recs=$(cf_records list)
node -e '
  const rs = process.argv[1].split("\n").filter(Boolean).map(JSON.parse), d = process.argv[2], ip = process.argv[3];
  const ok = [d, `*.${d}`].every((n) => rs.some((r) => r.type === "A" && r.name === n && r.content === ip && r.proxied === false && r.comment === "banto install.sh"));
  process.exit(ok && rs.filter((r) => r.type === "A").length === 2 ? 0 : 1)' "$recs" "$D1" "$IP" &&
  pass "2: Cloudflare に $D1・*.$D1 の A レコード（印つき・→ $IP・proxied でない）ができた" || fail "2: レコード：$recs"
grep -q 'まだ取得中' "$LOG/run2.log" && echo "  INFO install.sh の終わりの時点では証明書がまだ取れていなかった（HTTPS_STATE=pending）" ||
  echo "  INFO install.sh の終わりの時点で Let's Encrypt の証明書で通っていた（HTTPS_STATE=ok）"
code=$(wait_https "https://$D1/api/auth/me" 600)
[[ $code == 200 ]] && pass "2: 試験の場の中から https://$D1/api/auth/me が 200（--cacert 無し・本物の DNS）" || fail "2: https://$D1 → $code"
iss=$(issuer_of "$D1")
[[ $iss == *"Let's Encrypt"* ]] && pass "2: $D1 の証明書は Let's Encrypt（$iss）" || fail "2: 証明書：$iss"
code=$(wait_https "https://$D1/" 60)
[[ $code == 200 ]] && pass "2: https://$D1/ が 200（画面）" || fail "2: 画面 → $code"
code=$(wait_https "https://sandbox.$D1/sandbox.html" 600)
iss=$(issuer_of "sandbox.$D1")
[[ $code == 200 && $iss == *"Let's Encrypt"* && $iss == *"*.$D1"* ]] && pass "2: https://sandbox.$D1/ が 200、証明書は *.$D1 のワイルドカード（Let's Encrypt）" || fail "2: sandbox → $code／$iss"
X grep -q "\"baseDomain\": \"$D1\"" "/home/$TUSER/.local/share/banto/modules/publish-caddy/settings.json" && pass "2: Publish の baseDomain=$D1" || fail "2: Publish の settings.json"
[[ $(X stat -c '%a %U:%G' /etc/caddy/cloudflare.env) == "640 root:caddy" ]] && pass "2: cloudflare.env は 0640 root:caddy" || fail "2: cloudflare.env：$(X stat -c '%a %U:%G' /etc/caddy/cloudflare.env)"

note "3. 名前を $D2 に替えて打ち直す（保存したトークン。印つきの前のレコードが消える）"
start=$(date +%s)
rc=$(run_install run3 --domain "$D2" --no-claude-login)
[[ $rc == 0 ]] && pass "3: 名前を替えて通る（$(($(date +%s) - start)) 秒）" || { fail "3: rc=$rc"; tail -25 "$LOG/run3.log"; }
grep -aE '作った：|消した：|残っている：' "$LOG/run3.log" | sed 's/^/  /'
recs=$(cf_records list)
node -e '
  const rs = process.argv[1].split("\n").filter(Boolean).map(JSON.parse).filter((r) => r.type === "A"), d1 = process.argv[2], d2 = process.argv[3], ip = process.argv[4];
  const has2 = [d2, `*.${d2}`].every((n) => rs.some((r) => r.name === n && r.content === ip && r.comment === "banto install.sh"));
  const gone1 = !rs.some((r) => r.name === d1 || r.name === `*.${d1}`);
  process.exit(has2 && gone1 ? 0 : 1)' "$recs" "$D1" "$D2" "$IP" &&
  pass "3: $D1 のレコードは消え、$D2・*.$D2 ができた" || fail "3: レコード：$recs"
code=$(wait_https "https://$D2/api/auth/me" 600)
iss=$(issuer_of "$D2")
[[ $code == 200 && $iss == *"Let's Encrypt"* ]] && pass "3: https://$D2/ が 200（Let's Encrypt）" || fail "3: $D2 → $code／$iss"
code=$(wait_https "https://sandbox.$D2/sandbox.html" 600)
[[ $code == 200 ]] && pass "3: https://sandbox.$D2/ が 200" || fail "3: sandbox.$D2 → $code"

note "トークンが出ていない（install のログ・ps・banto-host.log・Caddy の journal）"
X cat "/home/$TUSER/banto-host.log" >"$LOG/banto-host.log"
X journalctl -u caddy --no-pager >"$LOG/caddy-journal.log"
for f in "$LOG"/run*.log "$LOG"/banto-host.log "$LOG"/caddy-journal.log; do
  ! has_token "$f" && pass "秘密：$(basename "$f") にトークンが無い" || fail "秘密：$(basename "$f") にトークンがある"
done
cat "$LOG"/ps-*.txt >"$LOG/ps-all.txt"
[[ $(wc -l <"$LOG/ps-all.txt") -gt 50 ]] && ! has_token "$LOG/ps-all.txt" && pass "秘密：流している間の ps（$(wc -l <"$LOG/ps-all.txt") 行）のコマンド行にトークンが無い" || fail "秘密：ps"

echo
echo "PASS $PASSES・FAIL $FAILS（片づけの結果は下）"
[[ $FAILS == 0 ]]

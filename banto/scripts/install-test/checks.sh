#!/usr/bin/env bash
# 試験の場の中で、入れた banto をユーザーとして確かめる（run.sh が中に送って流す）。
# usage: checks.sh <名前> <ログインのリンク> [full|login|ui-update]
#   full      ：b（前提と unit）・c（Caddy を通る）・d（ログイン）・e（Project とコンテナ）・g の中の側（コンテナから /relay）
#   login     ：c と d だけ（名前を変えたあと）
#   ui-update ：リンクで入った人のセッションで、画面の「更新」と同じ口（POST /api/admin/update）を叩き、上がるまで見る
# 1行ずつ「PASS 何を」「FAIL 何を：なぜ」を出す。終了コードは FAIL の数
# shellcheck disable=SC2015,SC2016,SC2024,SC2181 # pass||fail の並び・中で展開する台本・自分のファイルへの書き出し
set -uo pipefail

D=$1 LINK=$2 MODE=${3:-full}
REL="$HOME/.local/share/banto-release"
FAILS=0
pass() { echo "PASS $*"; }
fail() { echo "FAIL $*"; FAILS=$((FAILS + 1)); }
info() { echo "INFO $*"; }
check() { # check <何を> <コマンド…>
  local what=$1; shift
  if "$@" >/dev/null 2>&1; then pass "$what"; else fail "$what"; fi
}

CA=$(mktemp)
sudo cat /var/lib/caddy/.local/share/caddy/pki/authorities/local/root.crt >"$CA"
H=(-H "X-Banto-Client: 1" -H "Origin: https://$D")
JAR=$(mktemp)
c() { curl -s --cacert "$CA" "$@"; }

if [[ $MODE == full ]]; then
  # ---- b. 前提と unit ----
  out=$(cd "$REL/current/banto" && node packages/container/dist/doctor.js 2>&1)
  if [[ $? == 0 ]]; then pass "b: doctor が通る（$out）"; else fail "b: doctor：$out"; fi
  for u in banto-host banto-frontend caddy banto-firewall; do
    check "b: $u が動いている" systemctl is-active --quiet "$u"
  done
  local4175=$(ss -ltnH 'sport = :4175' | awk '{print $4}' | sort -u | tr '\n' ' ')
  if [[ $local4175 == "127.0.0.1:4175 " ]]; then pass "b: 画面は 127.0.0.1:4175 だけで待つ"; else fail "b: 画面の待ち受け：$local4175"; fi
  check "b: core は 0.0.0.0:4737 で待つ" bash -c "ss -ltnH 'sport = :4737' | grep -q '0.0.0.0:4737'"
  check "b: system.slice の CPUWeight=1000" bash -c "systemctl show system.slice -p CPUWeight | grep -qx CPUWeight=1000"
  check "b: banto-host の OOMScoreAdjust=-800" bash -c "systemctl show banto-host -p OOMScoreAdjust | grep -qx OOMScoreAdjust=-800"
  check "b: banto-host の User が $(id -un)" bash -c "systemctl show banto-host -p User | grep -qx User=$(id -un)"
  check "b: nftables の表 banto" sudo nft list table inet banto
  # Cloudflare の形の Caddy の設定も Caddy が受け付け、JSON にすると DNS-01 の cloudflare になる（トークンは偽物——
  # validate・adapt は API を呼ばない）
  tmpd=$(mktemp -d)
  BANTO_INSTALL_LIB=1 bash -c 'source /opt/banto-test/install.sh && render_banto_caddy "$1" cloudflare' _ "$D" >"$tmpd/Caddyfile"
  out=$(cd "$tmpd" && CLOUDFLARE_API_TOKEN=fakefakefakefakefakefakefakefakefake1234 XDG_DATA_HOME=$tmpd XDG_CONFIG_HOME=$tmpd \
    caddy validate --adapter caddyfile --config "$tmpd/Caddyfile" 2>&1)
  vrc=$?
  adapted=$(cd "$tmpd" && caddy adapt --adapter caddyfile --config "$tmpd/Caddyfile" 2>/dev/null)
  if [[ $vrc == 0 ]] && node -e '
      const j = JSON.parse(process.argv[1]);
      const ok = (j.apps?.tls?.automation?.policies ?? []).some((p) => (p.issuers ?? []).some((i) => i.challenges?.dns?.provider?.name === "cloudflare" && i.challenges.dns.provider.api_token === "{env.CLOUDFLARE_API_TOKEN}"));
      process.exit(ok ? 0 : 1)' "$adapted"; then
    pass "b: Cloudflare の形の設定も Caddy が受け付け、DNS-01 の provider が cloudflare（トークンは環境変数の参照）"
  else
    fail "b: Cloudflare の形：$(echo "$out" | tail -2)"
  fi

  # 権限
  [[ $(stat -c %a "$HOME/.config/banto/config.json") == 600 ]] && pass "b: config.json は 0600" || fail "b: config.json は $(stat -c %a "$HOME/.config/banto/config.json")"
  [[ $(stat -c %a "$HOME/.config/banto") == 700 ]] && pass "b: ~/.config/banto は 0700" || fail "b: ~/.config/banto は $(stat -c %a "$HOME/.config/banto")"
  [[ $(stat -c '%a %U:%G' /etc/banto/install.conf) == "644 root:root" ]] && pass "b: install.conf は 0644 root:root（秘密を入れない）" || fail "b: install.conf は $(stat -c '%a %U:%G' /etc/banto/install.conf)"
  ! grep -qi 'token' /etc/banto/install.conf && pass "b: install.conf にトークンの項目が無い" || fail "b: install.conf：$(cat /etc/banto/install.conf)"
  # config.json の口と置き場（真実）を、unit・nftables・Caddy が使っている
  read -r cport cuport crel < <(node -e 'const c = require(process.argv[1]); console.log(c.port, c.uiPort, c.releaseDir)' "$HOME/.config/banto/config.json")
  # 出力を先に変数に取ってから見る（`… | grep -q` は grep が先に終わると左が SIGPIPE で落ち、pipefail で偽になる——
  # 4回目の試験で1度だけ落ちた）
  unit_text=$(systemctl cat banto-frontend)
  nft_text=$(sudo nft list table inet banto)
  if [[ $cport == 4737 && $cuport == 4175 && $crel == "$REL" && $unit_text == *"-p $cuport"* && $nft_text == *"$cport"* ]]; then
    pass "b: config.json に port・uiPort・releaseDir があり、unit と nftables がそれを使う"
  else
    fail "b: config.json の口と置き場：$cport $cuport $crel"
  fi

  # 壊す：Zabbly の鍵の束に別の鍵が混ざっていたら断る
  zk=$(mktemp -d)
  curl -fsSL https://pkgs.zabbly.com/key.asc -o "$zk/zabbly.asc"
  gpg --no-default-keyring --keyring /usr/share/keyrings/ubuntu-archive-keyring.gpg --export --armor 2>/dev/null >"$zk/ubuntu.asc"
  cat "$zk/zabbly.asc" "$zk/ubuntu.asc" >"$zk/both.asc"
  kr=$(BANTO_INSTALL_LIB=1 bash -c 'source /opt/banto-test/install.sh; for f in "$@"; do zabbly_key_ok "$f" && echo -n ok, || echo -n no,; done' _ "$zk/zabbly.asc" "$zk/both.asc" "$zk/ubuntu.asc")
  [[ $kr == "ok,no,no," ]] && pass "b: Zabbly の鍵は1つで指紋が合うときだけ通る（混ざった束・別の鍵は断る）" || fail "b: Zabbly の鍵の判定：$kr"
fi

# ---- c. Caddy の内部 CA で https が通る ----
code=$(c -o /tmp/ui.html -w '%{http_code}' "https://$D/")
if [[ $code == 200 ]] && grep -qi '<html' /tmp/ui.html; then pass "c: https://$D/ が 200（画面の HTML）"; else fail "c: https://$D/ → $code"; fi
body=$(c -w ' %{http_code}' "https://$D/api/auth/me")
if [[ $body == *'"authenticated":false'*' 200' ]]; then pass "c: https://$D/api/auth/me が host に届く（$body）"; else fail "c: /api/auth/me → $body"; fi
hdr=$(c -D - -o /dev/null "https://sandbox.$D/sandbox.html")
if [[ $hdr == *" 200"* && $hdr == *"frame-ancestors"*"https://$D"* ]]; then pass "c: https://sandbox.$D/sandbox.html が 200（frame-ancestors に https://$D）"; else fail "c: sandbox：$(echo "$hdr" | head -3 | tr '\r\n' '  ')"; fi
code=$(c -o /dev/null -w '%{http_code}' "https://nothing.$D/")
if [[ $code == 404 ]]; then pass "c: https://nothing.$D/ は 404（*.$D の受け皿）"; else fail "c: nothing.$D → $code"; fi
loc=$(curl -s -o /dev/null -w '%{http_code} %{redirect_url}' "http://$D/x?y=1")
if [[ $loc == "308 https://$D/x?y=1" ]]; then pass "c: http は https へ転送（$loc）"; else fail "c: http → $loc"; fi
if curl -s "http://$D/banto-ca.crt" | cmp -s - "$CA"; then pass "c: http://$D/banto-ca.crt で CA のルート証明書を配る"; else fail "c: banto-ca.crt が root.crt と違う"; fi

# ---- d. ログインのリンクで入る ----
code_in_link=${LINK##*#banto-login=}
if [[ $LINK == "https://$D/#banto-login="* ]]; then pass "d: リンクの形（https://$D/#banto-login=…）"; else fail "d: リンクの形：$LINK"; fi
r=$(c -c "$JAR" "${H[@]}" -H 'content-type: application/json' -w ' %{http_code}' -X POST "https://$D/api/auth/redeem" -d "{\"code\":\"$code_in_link\"}")
if [[ $r == *'"ok":true'*' 200' ]] && grep -q '__Host-banto-session' "$JAR"; then pass "d: redeem が 200 で __Host-banto-session を出す"; else fail "d: redeem → $r"; fi
r=$(c -b "$JAR" "${H[@]}" -w ' %{http_code}' "https://$D/api/auth/sessions")
if [[ $r == *' 200' ]]; then pass "d: Cookie で人のセッションだけの口（/api/auth/sessions）が通る"; else fail "d: sessions → $r"; fi
r=$(c "${H[@]}" -o /dev/null -w '%{http_code}' "https://$D/api/auth/sessions")
if [[ $r == 401 ]]; then pass "d: Cookie が無ければ 401"; else fail "d: Cookie なし → $r"; fi
r=$(c -b "$JAR" -o /dev/null -w '%{http_code}' "https://$D/api/auth/sessions")
if [[ $r == 401 ]]; then pass "d: Cookie があっても X-Banto-Client が無ければ通らない（401）"; else fail "d: ヘッダなし → $r"; fi
r=$(c "${H[@]}" -H 'content-type: application/json' -o /dev/null -w '%{http_code}' -X POST "https://$D/api/auth/redeem" -d "{\"code\":\"$code_in_link\"}")
if [[ $r == 401 ]]; then pass "d: 同じリンクは2回目は通らない（401）"; else fail "d: 2回目の redeem → $r"; fi

if [[ $MODE == ui-update ]]; then
  # ---- 画面の「更新」の道：POST /api/admin/update/check → GET /api/admin/update → POST /api/admin/update（step-up は
  # リンクで入った直後の 10 分で足りる——v4-security「人のログイン」）→ banto-update.service が update.mjs --from-request ----
  TOKEN=$(node -e 'console.log(require(process.argv[1]).authToken)' "$HOME/.config/banto/config.json")
  B=(-H "authorization: Bearer $TOKEN")
  r=$(c -b "$JAR" "${H[@]}" -X POST -w ' %{http_code}' "https://$D/api/admin/update/check")
  [[ $r == *' 200' ]] && pass "ui: 最新を確かめる（POST /api/admin/update/check）" || fail "ui: check → $r"
  st=$(c "${B[@]}" "https://$D/api/admin/update")
  read -r cur latest ready < <(node -e 'const s = JSON.parse(process.argv[1]); console.log(s.current?.commit ?? "-", s.latest?.commit ?? "-", (s.reasons ?? []).length === 0 ? "ready" : JSON.stringify(s.reasons))' "$st")
  info "ui: 今の版 $cur・最新 $latest・準備 $ready"
  [[ $ready == ready && $latest != - && $latest != "$cur" ]] && pass "ui: 準備が済んでいて、新しい版が見える" || fail "ui: 状態：$(echo "$st" | head -c 400)"
  r=$(c -b "$JAR" "${H[@]}" -H 'content-type: application/json' -X POST -w ' %{http_code}' "https://$D/api/admin/update" -d "{\"commit\":\"$latest\",\"mode\":\"now\"}")
  [[ $r == *' 202' ]] && pass "ui: 更新を頼む（POST /api/admin/update → 202）" || fail "ui: 頼む → $r"
  r=$(c "${B[@]}" -H 'content-type: application/json' -X POST -o /dev/null -w '%{http_code}' "https://$D/api/admin/update" -d "{\"commit\":\"$latest\",\"mode\":\"now\"}")
  [[ $r == 403 ]] && pass "ui: 機械の合言葉では頼めない（403）" || fail "ui: Bearer で頼む → $r"
  now_commit=""
  for _ in $(seq 300); do
    now_commit=$(c "${B[@]}" "https://$D/api/admin/update" 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.parse(s).current?.commit??"")}catch{console.log("")}})')
    [[ $now_commit == "$latest" ]] && break
    sleep 3
  done
  [[ $now_commit == "$latest" ]] && pass "ui: banto-update.service が上げ、host が新しい版（${latest:0:12}）で答える" || fail "ui: 上がらない（今 $now_commit）"
  phase=$(node -e 'console.log(require(process.argv[1]).phase)' "$HOME/.local/share/banto/update/state.json")
  [[ $phase == "done" ]] && pass "ui: state.json は done" || fail "ui: state.json：$phase"
  exit "$FAILS"
fi

[[ $MODE == full ]] || exit "$FAILS"

# ---- e. Project を作り、コンテナが起きて Shell が繋がる ----
root="$HOME/install-test-project"
mkdir -p "$root"
r=$(c -b "$JAR" "${H[@]}" -H 'content-type: application/json' -X POST "https://$D/api/projects" -d "{\"name\":\"install-test\",\"root\":\"$root\"}")
pid=$(node -e 'try { console.log(JSON.parse(process.argv[1]).id ?? "") } catch { console.log("") }' "$r")
if [[ -n $pid ]]; then pass "e: Project を作った（$pid）"; else fail "e: Project：$r"; exit "$FAILS"; fi
start=$(date +%s)
r=$(c -m 1200 -b "$JAR" "${H[@]}" -X POST "https://$D/api/projects/$pid/modules/prepare")
info "e: prepare（$(($(date +%s) - start)) 秒）：$r"
if [[ $r == *"\"shell\""* ]]; then pass "e: prepare で shell が繋がった"; else fail "e: prepare：$r"; fi
r=$(c -b "$JAR" "${H[@]}" "https://$D/api/projects/$pid/modules")
if node -e 'const m = JSON.parse(process.argv[1]).find((x) => x.name === "shell"); process.exit(m?.connected === true ? 0 : 1)' "$r" 2>/dev/null; then
  pass "e: /modules で shell が connected"
else
  fail "e: /modules：$(echo "$r" | head -c 600)"
fi
r=$(c -b "$JAR" "${H[@]}" "https://$D/api/projects/$pid/container")
cname=$(node -e 'const j = JSON.parse(process.argv[1]); console.log(j.container?.status === "Running" ? j.container.name : "")' "$r" 2>/dev/null)
if [[ -n $cname ]]; then pass "e: Project のコンテナ $cname が Running"; else fail "e: container：$r"; fi

# ---- g（中の側）. コンテナから host の /relay に届く ----
if [[ -n $cname ]]; then
  r=$(incus exec "$cname" -- sh -c 'gw=$(ip route | awk "/^default/ {print \$3; exit}"); echo "$gw $(curl -s -o /dev/null -m 10 -w "%{http_code}" "http://$gw:4737/relay")"' </dev/null 2>&1)
  if [[ $r =~ ^[0-9.]+\ [1-5][0-9][0-9]$ ]]; then pass "g: コンテナから http://<ブリッジの host 側>:4737/relay に届く（$r）"; else fail "g: コンテナから /relay：$r"; fi
  # Shell の Module のプロセスがコンテナの中で動いている
  r=$(incus exec "$cname" -- ps -eo args </dev/null 2>&1 | grep -c 'modules/shell' || true)
  if [[ $r -ge 1 ]]; then pass "e: コンテナの中で Shell の Module が動いている"; else fail "e: コンテナの中に Shell の Module のプロセスが無い"; fi
fi

exit "$FAILS"

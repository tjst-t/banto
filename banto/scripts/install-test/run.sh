#!/usr/bin/env bash
# install.sh を、まっさらな Ubuntu で本当に流して確かめる試験の場（docs/notes/2026-10-04-installer.md「試験の場」）。
#
# この Project のコンテナの中の Incus（sudo incus）に入れ子のシステムコンテナを立て、sudo できる普通のユーザーを作り、
# **この worktree の今のコミット**（git bundle で渡す。GitHub からは取らない）で install.sh を `curl | bash` と同じ形
# （標準入力から台本を読む）で流す。トークン無し（Caddy の内部の CA）の形を確かめ、トークンありの形は Cloudflare の API の
# 偽物（cloudflare-fake.mjs を中で立てる）に向けて流す——DNS のレコードは偽物に作られ、Let's Encrypt は本物の Cloudflare に
# 偽のトークンで問うので取れず、「まだ取得中」で終わる道を通る。
#
#   banto/scripts/install-test/run.sh [--image 24.04|26.04] [--user <名前>] [--keep] [--first-only]
#   banto/scripts/install-test/run.sh --migrate-from <前の版の commit> [--image …] [--user …] [--keep]
#
#   --keep          終わっても試験の場を消さない（中を見るとき。消すのは sudo incus delete --force <名前>）
#   --first-only    1回目を入れて確かめる（a〜e・g）だけにする。打ち直し（f）と壊す試験を飛ばす
#   --migrate-from  その commit の install.sh とコードで入れ（古い形：置き場そのものが clone）、今の install.sh を打って
#                   版ごとのフォルダの形に移ることを見る（ほかの試験はしない）
#
# 取り込み元は bundle。**release という名前のブランチで入れる**（update.mjs・setup-update.sh は release だけを取ってくる）。
# 新しい版は、bundle を同じ場所に入れ替えて作る（$LOG/src の release にコミットを足して bundle し直す）
#
# **3段目の手当ては、ここにだけ置く**（install.sh には入れない）：
#   - 中の Incus は AppArmor を使えない → install.sh を流す前に incus.service へ INCUS_SECURITY_APPARMOR=false の drop-in
#     （パッケージより先に置いておけば、入ったときから効く）
#   - banto のコンテナには raw.lxc の lxc.apparmor.profile=unchanged が要る → 1回目のあと（banto のユーザーの区画が
#     できてから、Project のコンテナを作るより前）に、admin でその区画に低い層を許し、区画の default のプロファイルに入れる
# shellcheck disable=SC2015,SC2016,SC2024,SC2317 # 試験：pass||fail の並び・中で展開する台本・自分のファイルへの書き出し・trap の関数
set -euo pipefail

# 走っている間に run.sh を書き換えても壊れないよう、写しから流す（bash は台本を少しずつ読むので、書き換えると
# 途中から別の行を読んで暴れる——2026-10-04 に踏んだ）
if [[ -z ${INSTALL_TEST_COPY:-} ]]; then
  copy=$(mktemp /tmp/install-test-run-XXXX.sh)
  cp "$0" "$copy"
  INSTALL_TEST_COPY=1 INSTALL_TEST_HERE=$(cd "$(dirname "$0")" && pwd) exec bash "$copy" "$@"
fi

IMAGE=24.04 TUSER=bantotester KEEP=0 FIRST_ONLY=0 MIGRATE_FROM=""
while [[ $# -gt 0 ]]; do
  case $1 in
    --image) IMAGE=$2; shift 2 ;;
    --user) TUSER=$2; shift 2 ;;
    --keep) KEEP=1; shift ;;
    --first-only) FIRST_ONLY=1; shift ;;
    --migrate-from) MIGRATE_FROM=$2; shift 2 ;;
    *) echo "知らない引数：$1" >&2; exit 2 ;;
  esac
done

D1=banto.test D2=banto2.test D3=banto.cf.test D4=banto2.cf.test
FAKE_TOKEN=fakeCloudflareToken0123456789abcdefXYZ
FAKE_API=http://127.0.0.1:8787
here=$INSTALL_TEST_HERE
repo=$(git -C "$here" rev-parse --show-toplevel)
branch=$(git -C "$repo" rev-parse --abbrev-ref HEAD)
[[ -z $MIGRATE_FROM ]] || MIGRATE_FROM=$(git -C "$repo" rev-parse "$MIGRATE_FROM^{commit}") # 頭12で比べるので、短い名前を伸ばす
NAME="bt-install-${IMAGE//./}-$(date +%H%M%S)"
LOG=$(mktemp -d "/tmp/install-test-$NAME-XXXX")
FAILS=0 PASSES=0

pass() { echo "PASS $*" | tee -a "$LOG/result.txt"; PASSES=$((PASSES + 1)); }
fail() { echo "FAIL $*" | tee -a "$LOG/result.txt"; FAILS=$((FAILS + 1)); }
count() { grep -c "$1" "$2" || true; }
note() { printf '\n\033[1m--- %s\033[0m\n' "$*"; }
I() { sudo incus "$@" </dev/null; }
X() { sudo incus exec "$NAME" --cwd /tmp -- "$@" </dev/null; } # 中で root
U() { sudo incus exec "$NAME" --cwd /tmp -- sudo -u "$TUSER" -H "$@" </dev/null; } # 中でユーザー（sudo -u はグループを引き直す）

cleanup() {
  if [[ $KEEP == 1 ]]; then
    echo "試験の場を残した：$NAME（消す：sudo incus delete --force $NAME）"
  else
    I delete --force "$NAME" >/dev/null 2>&1 || true
  fi
  echo "ログ：$LOG"
}
trap cleanup EXIT

# install.sh を `curl … | bash -s -- 引数` と同じ形（標準入力から台本）で流す。出力は LOG/<名前>.log
# RUN_ENV に「名前=値」を入れておくと、その環境で流す（偽の Cloudflare に向けるとき）
RUN_ENV=()
run_install() {
  local log=$1; shift
  local rc=0
  sudo incus exec "$NAME" --cwd /tmp -- sudo -u "$TUSER" -H env "${RUN_ENV[@]}" bash -c 'cat /opt/banto-test/install.sh | bash -s -- "$@"' _ "$@" \
    </dev/null >"$LOG/$log.log" 2>&1 || rc=$?
  echo "$rc"
}

# 試験の場の外から見えるアドレス（eth0）。中の Incus のブリッジ（incusbr0・incusbr-<uid>）のアドレスを拾わない
nested_ip() { I list "$NAME" -c 4 -f csv | grep -oE '([0-9]+\.){3}[0-9]+ \(eth0\)' | cut -d' ' -f1 | head -1; }

# ---------------------------------------------------------------------------
note "試験の場を作る（ubuntu/$IMAGE・ユーザー $TUSER・$branch の $(git -C "$repo" rev-parse --short HEAD)）"
[[ -z $(git -C "$repo" status --porcelain -- install.sh) ]] || echo "注意：install.sh にコミットしていない変更があります。試験に使うのはコミットしたものです" >&2
# 取り込み元：worktree の今のコミットを release という名前にした bundle（$LOG/src を元に作り直していく）
git clone -q --no-local "$repo" "$LOG/src" -b "$branch"
git -C "$LOG/src" branch -q -f release HEAD
git -C "$LOG/src" checkout -q release
NEW_HEAD=$(git -C "$LOG/src" rev-parse HEAD)
gitsrc() { git -C "$LOG/src" -c user.name=install-test -c user.email=install-test@example.invalid "$@"; }
make_bundle() { rm -f "$LOG/banto.bundle"; git -C "$LOG/src" bundle create "$LOG/banto.bundle" release 2>/dev/null; }
# release（$LOG/src で checkout している）を <commit> にして bundle し直し、試験の場の同じ場所に入れる
push_release() {
  git -C "$LOG/src" reset -q --hard "$1"
  make_bundle
  I file push -q "$LOG/banto.bundle" "$NAME/opt/banto-test/banto.bundle"
  X chmod a+r /opt/banto-test/banto.bundle
}
[[ -z $MIGRATE_FROM ]] || git -C "$LOG/src" reset -q --hard "$MIGRATE_FROM"
make_bundle
I launch "images:ubuntu/$IMAGE" "$NAME" \
  -c security.nesting=true -c security.syscalls.intercept.mknod=true -c security.syscalls.intercept.setxattr=true \
  -c limits.cpu=3 -c limits.memory=6GiB >/dev/null
X systemctl is-system-running --wait >/dev/null 2>&1 || true
for _ in $(seq 60); do X getent hosts pkgs.zabbly.com >/dev/null 2>&1 && break; sleep 2; done

X useradd -m -s /bin/bash -G sudo "$TUSER"
X sh -c "echo '$TUSER ALL=(ALL:ALL) NOPASSWD: ALL' > /etc/sudoers.d/90-$TUSER && chmod 0440 /etc/sudoers.d/90-$TUSER"
X mkdir -p /etc/systemd/system/incus.service.d /opt/banto-test
X sh -c 'printf "# 試験の場だけ：3段目の Incus は AppArmor を使えない\n[Service]\nEnvironment=INCUS_SECURITY_APPARMOR=false\n" > /etc/systemd/system/incus.service.d/90-install-test-no-apparmor.conf'
X sh -c "printf '127.0.0.1 $D1 sandbox.$D1 nothing.$D1 $D2 sandbox.$D2 nothing.$D2 $D3 sandbox.$D3 $D4 sandbox.$D4 nothing.$D4\n' >> /etc/hosts"
git -C "$repo" show "HEAD:install.sh" >"$LOG/install.sh"
[[ -z $MIGRATE_FROM ]] || git -C "$repo" show "$MIGRATE_FROM:install.sh" >"$LOG/install-old.sh"
I file push -q "$LOG/install.sh" "$NAME/opt/banto-test/install.sh"
I file push -q "$LOG/banto.bundle" "$NAME/opt/banto-test/banto.bundle"
I file push -q "$here/checks.sh" "$NAME/opt/banto-test/checks.sh"
I file push -q "$here/cloudflare-fake.mjs" "$NAME/opt/banto-test/cloudflare-fake.mjs"
I file push -q "$here/api.sh" "$NAME/opt/banto-test/api.sh"
X chmod -R a+rX /opt/banto-test
TUID=$(X id -u "$TUSER")
echo "試験の場：$NAME（uid $TUID）ログ：$LOG"
REL="/home/$TUSER/.local/share/banto-release"
mainpid() { X systemctl show -p MainPID --value banto-host; }
# host が答える版（GET /api/admin/update の current.commit。機械の合言葉で）
running_commit() {
  U bash /opt/banto-test/api.sh GET /api/admin/update 2>/dev/null |
    node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.parse(s).current?.commit??"")}catch{console.log("")}})'
}
X_link() { X readlink "$REL/$1" | sed 's#^versions/##'; }

# ---------------------------------------------------------------------------
if [[ -n $MIGRATE_FROM ]]; then
  note "古い形：${MIGRATE_FROM:0:12} の install.sh とコードで入れる（置き場そのものが clone）"
  I file push -q "$LOG/install-old.sh" "$NAME/opt/banto-test/install-old.sh"
  X chmod a+r /opt/banto-test/install-old.sh
  rc=0
  sudo incus exec "$NAME" --cwd /tmp -- sudo -u "$TUSER" -H bash -c 'cat /opt/banto-test/install-old.sh | bash -s -- --domain "$1" --repo /opt/banto-test/banto.bundle --branch release --no-claude-login' _ "$D1" \
    </dev/null >"$LOG/old.log" 2>&1 || rc=$?
  if [[ $rc == 0 ]] && grep -q 'banto を入れました' "$LOG/old.log"; then pass "移行：前の版の install.sh で入った"; else fail "移行：前の版の install.sh：rc=$rc"; tail -20 "$LOG/old.log"; exit 1; fi
  X test -d "$REL/.git" && pass "移行：置き場そのものが clone（古い形）" || fail "移行：古い形になっていない"

  note "今の install.sh を打つ（release は今のコミット ${NEW_HEAD:0:12}）"
  push_release "$NEW_HEAD"
  rc=$(run_install mig1 --no-claude-login)
  [[ $rc == 0 ]] && pass "移行：今の install.sh が通る" || { fail "移行：rc=$rc"; tail -30 "$LOG/mig1.log"; }
  grep -q 'setup-update.sh' "$LOG/mig1.log" && grep -q '置き場が古い形' "$LOG/mig1.log" && pass "移行：setup-update.sh に移させた" || fail "移行：setup-update.sh を打っていない"
  X test -L "$REL/current" && X test -d "$REL/repo.git" && X test ! -d "$REL/.git" && pass "移行：版ごとのフォルダの形（repo.git・current）" || fail "移行：形：$(X ls -la "$REL")"
  [[ $(X_link current) == "${NEW_HEAD:0:12}" && $(X_link previous) == "${MIGRATE_FROM:0:12}" ]] &&
    pass "移行：前の clone は versions/${MIGRATE_FROM:0:12} に入り（previous）、update.mjs が ${NEW_HEAD:0:12} に上げた（current）" ||
    fail "移行：current=$(X_link current) previous=$(X_link previous)"
  [[ $(running_commit) == "$NEW_HEAD" ]] && pass "移行：host が新しい版で答える" || fail "移行：host の版：$(running_commit)"
  unit=$(X systemctl cat banto-host banto-frontend)
  [[ $unit == *"$REL/current/banto"* && $unit != *"$REL/banto"* ]] && pass "移行：unit は current を通る" || fail "移行：unit：$(echo "$unit" | grep -m2 WorkingDirectory)"
  X test -f /etc/systemd/system/banto-update.service && X test -f /etc/polkit-1/rules.d/50-banto-update.rules && pass "移行：banto-update.service と polkit の規則がある" || fail "移行：更新の unit か規則が無い"
  LINKM=$(grep -oE "https://$D1/#banto-login=[A-Za-z0-9_-]+" "$LOG/mig1.log" | head -1)
  rc=0; U bash /opt/banto-test/checks.sh "$D1" "$LINKM" login >"$LOG/checks-mig.log" 2>&1 || rc=$?
  grep -E '^(PASS|FAIL|INFO)' "$LOG/checks-mig.log" | sed 's/^/  /' | tee -a "$LOG/result.txt"
  PASSES=$((PASSES + $(count '^PASS' "$LOG/checks-mig.log"))); FAILS=$((FAILS + $(count '^FAIL' "$LOG/checks-mig.log")))
  pid_before=$(mainpid)
  rc=$(run_install mig2 --no-claude-login)
  [[ $rc == 0 ]] && grep -q 'もうこの版で動いています' "$LOG/mig2.log" && grep -q '準備は済んでいる' "$LOG/mig2.log" && [[ $(mainpid) == "$pid_before" ]] &&
    pass "移行：もう一度打つと、何もせず（setup-update.sh も打たず、起こし直さず）通る" || fail "移行：2回目：rc=$rc"
  echo; echo "PASS $PASSES・FAIL $FAILS（--migrate-from）"; exit $((FAILS > 0))
fi

# ---------------------------------------------------------------------------
note "断る場合（root・--domain なし・知らない引数）"
rc=0; X bash -c 'cat /opt/banto-test/install.sh | bash -s -- --domain x.test' >"$LOG/neg-root.log" 2>&1 || rc=$?
if [[ $rc != 0 ]] && grep -q 'root で打たれました' "$LOG/neg-root.log"; then pass "root で打つと断る"; else fail "root：rc=$rc $(tail -3 "$LOG/neg-root.log")"; fi
rc=$(run_install neg-nodomain --no-claude-login)
if [[ $rc != 0 ]] && grep -q -- '--domain がありません' "$LOG/neg-nodomain.log"; then pass "初回に --domain が無ければ止まる"; else fail "--domain なし：rc=$rc"; fi
rc=$(run_install neg-arg --domain x.test --bogus)
if [[ $rc != 0 ]] && grep -q '知らない引数です：--bogus' "$LOG/neg-arg.log"; then pass "知らない引数で止まる"; else fail "知らない引数：rc=$rc"; fi
rc=$(run_install neg-branch --domain x.test --branch dev)
if [[ $rc != 0 ]] && grep -q -- '--branch はやめました' "$LOG/neg-branch.log"; then pass "--branch は理由を出して断る（release 固定）"; else fail "--branch：rc=$rc"; fi
X test ! -e /etc/banto/install.conf && pass "断ったときは何も覚えない" || fail "断ったのに install.conf ができた"

# ---------------------------------------------------------------------------
note "a. まっさらから1回流す（数十分かかる）"
start=$(date +%s)
rc=$(run_install run1 --domain "$D1" --repo /opt/banto-test/banto.bundle --no-claude-login)
echo "  $(($(date +%s) - start)) 秒・終了コード $rc"
if [[ $rc == 0 ]] && grep -q 'banto を入れました' "$LOG/run1.log"; then pass "a: まっさらから最後まで通る（$(($(date +%s) - start)) 秒）"; else
  fail "a: 1回目：rc=$rc"; tail -30 "$LOG/run1.log"; exit 1
fi
LINK1=$(grep -oE "https://$D1/#banto-login=[A-Za-z0-9_-]+" "$LOG/run1.log" | head -1)
X test -d "$REL/repo.git" && [[ $(X_link current) == "${NEW_HEAD:0:12}" ]] && X test ! -e "$REL/previous" && X test ! -d "$REL/.git" &&
  pass "a: 版ごとのフォルダの形（repo.git・current → versions/${NEW_HEAD:0:12}・previous は無い）" || fail "a: 置き場の形：$(X ls -la "$REL")"
[[ $(X git --git-dir "$REL/repo.git" remote get-url origin) == /opt/banto-test/banto.bundle ]] && pass "a: repo.git の origin は --repo" || fail "a: origin：$(X git --git-dir "$REL/repo.git" remote get-url origin)"
grep -q 'update.mjs --first' "$LOG/run1.log" && pass "a: 最初の版は取ってきた版の update.mjs --first が組み立てた" || fail "a: --first の跡が無い"
unit=$(X systemctl cat banto-host banto-frontend)
[[ $unit == *"WorkingDirectory=$REL/current/banto"* && $unit == *"$REL/current/banto/node_modules/next"* ]] && pass "a: unit は current を通る" || fail "a: unit：$(echo "$unit" | grep -m2 WorkingDirectory)"
X test -f /etc/systemd/system/banto-update.service && X test -f /etc/polkit-1/rules.d/50-banto-update.rules && pass "a: setup-update.sh が banto-update.service と polkit の規則を置いた" || fail "a: 更新の unit か規則が無い"
[[ $(running_commit) == "$NEW_HEAD" ]] && pass "a: host は ${NEW_HEAD:0:12} で答える（GET /api/admin/update）" || fail "a: host の版：$(running_commit)"

note "3段目の手当て（banto のユーザーの区画 user-$TUID に低い層を許す。試験の場だけ）"
X incus project set "user-$TUID" restricted.containers.lowlevel=allow
X incus profile set default raw.lxc 'lxc.apparmor.profile=unchanged' --project "user-$TUID"

note "b〜e・g（中の側）"
rc=0; U bash /opt/banto-test/checks.sh "$D1" "$LINK1" full >"$LOG/checks1.log" 2>&1 || rc=$?
grep -E '^(PASS|FAIL|INFO)' "$LOG/checks1.log" | tee -a "$LOG/result.txt" | sed 's/^/  /'
PASSES=$((PASSES + $(count '^PASS' "$LOG/checks1.log"))); FAILS=$((FAILS + $(count '^FAIL' "$LOG/checks1.log")))

note "g. 外（試験の場の外）から banto の口に直に届かない"
IP=$(nested_ip)
[[ -n $IP ]] || { fail "g: 試験の場の eth0 のアドレスが分からない"; IP=0.0.0.0; }
for p in 4737 4176 4175; do
  code=$(curl -s -o /dev/null -m 5 -w '%{http_code}' "http://$IP:$p/" || true)
  if [[ $code == 000 ]]; then pass "g: 外から $IP:$p に届かない"; else fail "g: 外から $IP:$p → $code"; fi
done
code=$(curl -sk -o /dev/null -m 10 -w '%{http_code}' --resolve "$D1:443:$IP" "https://$D1/api/auth/me" || true)
if [[ $code == 200 ]]; then pass "g: 外からでも Caddy（443）は通る（落としているのは banto の口だけ）"; else fail "g: 外から 443 → $code"; fi

if [[ $FIRST_ONLY == 1 ]]; then
  echo; echo "PASS $PASSES・FAIL $FAILS（--first-only）"; exit $((FAILS > 0))
fi

# ---------------------------------------------------------------------------
note "f-1. 何も渡さずに打ち直す：済んだ段が飛び、値が残り、起こし直さない"
pid_before=$(mainpid)
conf_before=$(X sha256sum "/home/$TUSER/.config/banto/config.json")
# 壊す：表を消すと外から届く → 打ち直すと入れ直されて届かない（表が効いていることと、打ち直しで直ることを一度に見る）
X nft delete table inet banto
code=$(curl -s -o /dev/null -m 5 -w '%{http_code}' "http://$IP:4737/api/auth/me" || true)
[[ $code == 200 ]] && pass "g: 表を消すと外から $IP:4737 に届く（$code）——落としているのは表" || fail "g: 表を消しても外から → $code"
rc=$(run_install run2 --no-claude-login)
code=$(curl -s -o /dev/null -m 5 -w '%{http_code}' "http://$IP:4737/api/auth/me" || true)
[[ $code == 000 ]] && pass "g: 打ち直すと表が入れ直され、外から届かなくなる" || fail "g: 打ち直しても外から → $code"
if [[ $rc == 0 ]]; then pass "f: 2回目が通る"; else fail "f: 2回目：rc=$rc"; tail -20 "$LOG/run2.log"; fi
grep -q 'もうこの版で動いています' "$LOG/run2.log" && ! grep -q '組み立てました' "$LOG/run2.log" && pass "f: 版が同じなので update.mjs は組み立てない" || fail "f: 2回目に組み立てた"
grep -q '準備は済んでいる' "$LOG/run2.log" && pass "f: setup-update.sh は打たない（準備が済んでいる）" || fail "f: 2回目に setup-update.sh を打った"
grep -q 'apt で入れる' "$LOG/run2.log" && fail "f: 2回目に apt で入れた" || pass "f: apt を飛ばす"
grep -q '入っている（/usr/local/bin/node' "$LOG/run2.log" && pass "f: Node を飛ばす" || fail "f: Node を入れ直した"
grep -q "名前：$D1" "$LOG/run2.log" && pass "f: 名前（$D1）が残る" || fail "f: 名前が残らない"
[[ $(mainpid) == "$pid_before" ]] && pass "f: 変わりが無ければ起こし直さない" || fail "f: 起こし直した（$pid_before → $(mainpid)）"
[[ $(X sha256sum "/home/$TUSER/.config/banto/config.json") == "$conf_before" ]] && pass "f: config.json はそのまま" || fail "f: config.json が変わった"

note "壊す試験：banto のユーザーを incus グループから外すと、doctor で止まる"
X gpasswd -d "$TUSER" incus >/dev/null
rc=0
U bash -c 'BANTO_INSTALL_LIB=1 source /opt/banto-test/install.sh; trap "on_error \$? \$LINENO" ERR; parse_args --no-claude-login; step_check_host; step_resolve_settings; step_node >/dev/null; step_config; step_doctor_and_start' \
  >"$LOG/break-group.log" 2>&1 || rc=$?
if [[ $rc != 0 ]] && grep -q 'コンテナの前提がそろっていません' "$LOG/break-group.log" && grep -q 'incus グループに入っていません' "$LOG/break-group.log"; then
  pass "壊す：doctor が落ちると、どの段で何が足りないかを出して止まる"
else
  fail "壊す：rc=$rc $(tail -5 "$LOG/break-group.log")"
fi

note "f-2. 新しいコミットと --domain $D2 で打ち直す：update.mjs が上げ（current・previous が替わる）・Caddy と config が替わる・グループも直る"
OLD12=${NEW_HEAD:0:12}
gitsrc commit -q --allow-empty -m "試験：2つ目のコミット"
GOOD=$(git -C "$LOG/src" rev-parse HEAD)
push_release "$GOOD"
pid_before=$(mainpid)
rc=$(run_install run3 --domain "$D2" --no-claude-login)
if [[ $rc == 0 ]]; then pass "f: --domain を変えて通る"; else fail "f: 3回目：rc=$rc"; tail -30 "$LOG/run3.log"; fi
grep -q '組み立てました' "$LOG/run3.log" && grep -q "${GOOD:0:12} に更新しました" "$LOG/run3.log" && pass "f: update.mjs が新しい版を組み立てて上げた" || fail "f: update.mjs で上がっていない"
[[ $(X_link current) == "${GOOD:0:12}" && $(X_link previous) == "$OLD12" ]] && pass "f: current → ${GOOD:0:12}・previous → $OLD12" || fail "f: current=$(X_link current) previous=$(X_link previous)"
[[ $(running_commit) == "$GOOD" ]] && pass "f: host が新しい版で答える" || fail "f: host の版：$(running_commit)"
[[ $(mainpid) != "$pid_before" ]] && pass "f: 起こし直した（update.mjs が polkit の規則で）" || fail "f: 起こし直していない"
! grep -q 'もう一度 sudo を使う' "$LOG/run3.log" && pass "f: 打ち直しでは sudo を取り直さない（起こし直しは polkit）" || fail "f: 打ち直しで sudo を取り直した"
grep -q "incus グループに入れた" "$LOG/run3.log" && pass "f: 外したグループを打ち直しで直した" || fail "f: グループを直していない"
# コンテナの Module が新しい版を見る：Module を起こし直すと（prepare）、banto の装置の source が新しい版になる
PROJ=$(grep -oE 'e: Project を作った（[0-9a-f-]+）' "$LOG/checks1.log" | grep -oE '[0-9a-f-]{36}')
U bash /opt/banto-test/api.sh POST "/api/projects/$PROJ/modules/prepare" >"$LOG/prepare2.json" || true
devs=$(X incus config show --expanded --project "user-$TUID" "banto-$PROJ" 2>/dev/null | grep 'source:' || true)
[[ $devs == *"versions/${GOOD:0:12}/banto"* && $devs != *"versions/$OLD12/banto"* ]] && pass "f: Project のコンテナの banto の装置の source が versions/${GOOD:0:12}/banto になった" || fail "f: 装置の source：$(echo "$devs" | tr '\n' ' ')"
caddy=$(X cat /etc/caddy/banto.d/banto.caddy)
if [[ $caddy == *"$D2 {"* && $caddy != *"$D1"* ]]; then pass "f: Caddy の設定が $D2 に替わった"; else fail "f: banto.caddy：$(echo "$caddy" | grep -m3 ' {')"; fi
cfg=$(X cat "/home/$TUSER/.config/banto/config.json")
if node -e '
  const c = JSON.parse(process.argv[1]), d1 = process.argv[2], d2 = process.argv[3];
  const ok = c.publicUrl === `https://${d2}` && c.sandboxPublicUrl === `https://sandbox.${d2}` &&
    c.allowedEmbedderOrigins.includes(`https://${d2}`) && !c.allowedEmbedderOrigins.includes(`https://${d1}`) && c.authToken;
  process.exit(ok ? 0 : 1)' "$cfg" "$D1" "$D2"; then pass "f: config.json が $D2 に替わり、authToken は残る"; else fail "f: config.json：$cfg"; fi
X grep -qx "domain=$D2" /etc/banto/install.conf && pass "f: 覚えた名前が $D2 に替わった" || fail "f: install.conf：$(X cat /etc/banto/install.conf)"
LINK2=$(grep -oE "https://$D2/#banto-login=[A-Za-z0-9_-]+" "$LOG/run3.log" | head -1)
rc=0; U bash /opt/banto-test/checks.sh "$D2" "$LINK2" login >"$LOG/checks2.log" 2>&1 || rc=$?
grep -E '^(PASS|FAIL|INFO)' "$LOG/checks2.log" | sed 's/^/  /' | tee -a "$LOG/result.txt"
PASSES=$((PASSES + $(count '^PASS' "$LOG/checks2.log"))); FAILS=$((FAILS + $(count '^FAIL' "$LOG/checks2.log")))
code=$(X curl -s --cacert /var/lib/caddy/.local/share/caddy/pki/authorities/local/root.crt -o /dev/null -w '%{http_code}' "https://$D1/" || true)
[[ $code == 000 ]] && pass "f: 前の名前 $D1 にはもう答えない" || fail "f: 前の名前 $D1 → $code"

# ---------------------------------------------------------------------------
note "壊す：起きない版（host が起動ですぐ落ちる）を release に置いて打ち直す → update.mjs が前の版に戻し、install.sh が理由を出して止まる"
printf '\nthrow new Error("試験：わざと起きない版");\n' >>"$LOG/src/banto/packages/core/src/cli.ts"
gitsrc commit -q -am "試験：起きない版"
BROKEN=$(git -C "$LOG/src" rev-parse HEAD)
push_release "$BROKEN"
rc=$(run_install run-broken --no-claude-login)
[[ $rc != 0 ]] && grep -q '新しい版が起きなかったので、update.mjs が前の版に戻しました' "$LOG/run-broken.log" && pass "壊す：起きない版は前の版に戻し、理由を出して止まる" || { fail "壊す：rc=$rc"; tail -15 "$LOG/run-broken.log"; }
[[ $(X_link current) == "${GOOD:0:12}" && $(running_commit) == "$GOOD" ]] && pass "壊す：current と host は前の版（${GOOD:0:12}）のまま" || fail "壊す：current=$(X_link current) host=$(running_commit)"
# release を起きる版に戻す（ここからの打ち直しが毎回起きない版を組み立てないように）
push_release "$GOOD"

note "画面の「更新」の道：人のセッションで POST /api/admin/update → banto-update.service が上げる"
gitsrc commit -q --allow-empty -m "試験：画面から上げる版"
GOOD2=$(git -C "$LOG/src" rev-parse HEAD)
push_release "$GOOD2"
LINKU=$(U bash -c "cd $REL/current/banto && node scripts/login-link.mjs" | grep -oE "https://$D2/#banto-login=[A-Za-z0-9_-]+" | head -1)
rc=0; U bash /opt/banto-test/checks.sh "$D2" "$LINKU" ui-update >"$LOG/checks-ui.log" 2>&1 || rc=$?
grep -E '^(PASS|FAIL|INFO)' "$LOG/checks-ui.log" | sed 's/^/  /' | tee -a "$LOG/result.txt"
PASSES=$((PASSES + $(count '^PASS' "$LOG/checks-ui.log"))); FAILS=$((FAILS + $(count '^FAIL' "$LOG/checks-ui.log")))
[[ $(X_link current) == "${GOOD2:0:12}" && $(X_link previous) == "${GOOD:0:12}" ]] && pass "ui: current → ${GOOD2:0:12}・previous → ${GOOD:0:12}" || fail "ui: current=$(X_link current) previous=$(X_link previous)"
# checks.sh は state.json が終わりの状態になるまで待っている。update.mjs は片づけを済ませてから終わりの状態を書き、
# すぐ lock を外す（その間に打たれた回は最大5秒待つ）ので、ここで unit の終わりを待たずに次の打ち直しへ進んでよい——
# 次の段（Caddy の unit）の打ち直しが「ほかの更新が走っています」で止まらないことが、その確かめになる
X journalctl -u banto-update.service --no-pager >"$LOG/banto-update-journal.log" 2>&1 || true
grep -q '更新を始めます' "$LOG/banto-update-journal.log" && grep -q '組み立てました' "$LOG/banto-update-journal.log" &&
  pass "ui: banto-update.service の中で update.mjs が始まり、組み立てた（journal。終わりは state.json で見ている）" || fail "ui: banto-update.service の journal：$(tail -3 "$LOG/banto-update-journal.log")"

note "Caddy の unit：既に別の場所に unit がある host（apt の caddy の形）では drop-in で差し替え、/etc に丸ごと書かない"
X sh -c 'mkdir -p /usr/lib/systemd/system && mv /etc/systemd/system/caddy.service /usr/lib/systemd/system/caddy.service && systemctl daemon-reload'
rc=$(run_install run4 --no-claude-login)
[[ $rc == 0 ]] && pass "caddy unit：通る" || { fail "caddy unit：rc=$rc"; tail -20 "$LOG/run4.log"; }
X test -f /etc/systemd/system/caddy.service.d/50-banto.conf && X test ! -e /etc/systemd/system/caddy.service &&
  pass "caddy unit：drop-in を置き、/etc に unit を書かない" || fail "caddy unit：$(X ls /etc/systemd/system/ | grep caddy)"
X systemctl is-active --quiet caddy && grep -q 'Caddy を通して確かめた' "$LOG/run4.log" && pass "caddy unit：drop-in の Caddy で https が通る" || fail "caddy unit：Caddy が動いていない"

# ---------------------------------------------------------------------------
note "トークンありの形（Cloudflare の API の偽物に向ける）：$D3"
X systemd-run --quiet --unit banto-test-cf-fake /usr/local/bin/node /opt/banto-test/cloudflare-fake.mjs --port 8787 --token "$FAKE_TOKEN" --zones cf.test \
  --seed "[{\"zoneName\":\"cf.test\",\"type\":\"A\",\"name\":\"*.$D3\",\"content\":\"10.9.9.9\",\"proxied\":false}]"
for _ in $(seq 20); do X curl -fs "$FAKE_API/__state" >/dev/null 2>&1 && break; sleep 0.5; done
cfstate() { X curl -fs "$FAKE_API/__state"; }
RUN_ENV=("BANTO_CLOUDFLARE_API=$FAKE_API" "CLOUDFLARE_API_TOKEN=$FAKE_TOKEN")
rc=$(run_install run5 --domain "$D3" --no-claude-login)
RUN_ENV=()
[[ $rc == 0 ]] && pass "token：通る（証明書が取れなくても止まらない）" || { fail "token：rc=$rc"; tail -30 "$LOG/run5.log"; }
grep -q 'まだ取得中' "$LOG/run5.log" && pass "token：Let's Encrypt が取れないので「まだ取得中」で終わる（HTTPS_STATE=pending）" || fail "token：まだ取得中が出ない"
st=$(cfstate)
node -e '
  const s = JSON.parse(process.argv[1]), d = process.argv[2];
  const mine = s.records.find((r) => r.name === d);
  const wild = s.records.find((r) => r.name === `*.${d}`);
  process.exit(mine?.comment === "banto install.sh" && mine.proxied === false && wild?.content === mine.content && !wild.comment ? 0 : 1)' "$st" "$D3" &&
  pass "token：$D3 を印つきで作り、人が作った *.$D3 は向け先だけ直した" || fail "token：偽物の状態：$st"
[[ $(X stat -c '%a %U:%G' /etc/caddy/cloudflare.env) == "640 root:caddy" ]] && pass "token：cloudflare.env は 0640 root:caddy" || fail "token：cloudflare.env：$(X stat -c '%a %U:%G' /etc/caddy/cloudflare.env)"
X grep -q 'dns cloudflare {env.CLOUDFLARE_API_TOKEN}' /etc/caddy/banto.d/banto.caddy && pass "token：Caddy の設定が dns cloudflare に替わった" || fail "token：banto.caddy に dns cloudflare が無い"
X grep -q "\"baseDomain\": \"$D3\"" "/home/$TUSER/.local/share/banto/modules/publish-caddy/settings.json" && pass "token：Publish の基のドメインを書いた" || fail "token：Publish の settings.json"
X test ! -e /etc/systemd/system/caddy.service && pass "token：2回目も /etc に Caddy の unit を書かない" || fail "token：/etc に Caddy の unit ができた"

note "壊す：名前を替える回が Cloudflare に届かず途中で止まる（設定は書いたが起こし直す前）→ 次の回が起こし直す"
pid_before=$(mainpid)
RUN_ENV=("BANTO_CLOUDFLARE_API=http://127.0.0.1:1")
rc=$(run_install run6a --domain "$D4" --no-claude-login)
[[ $rc != 0 ]] && grep -q 'Cloudflare の DNS を直せませんでした' "$LOG/run6a.log" && grep -q '届きません' "$LOG/run6a.log" &&
  pass "token：Cloudflare に届かなければ、理由を出して止まる" || fail "token：届かないときの rc=$rc"
[[ $(mainpid) == "$pid_before" ]] && pass "token：止まった回は起こし直していない（前の名前のまま動いている）" || fail "token：止まった回に起こし直した"

note "トークンありで名前を替える：$D3 → $D4（保存したトークンを使う。install.sh が作ったものだけ消し、ほかは「残っている」と出す）"
RUN_ENV=("BANTO_CLOUDFLARE_API=$FAKE_API")
rc=$(run_install run6 --domain "$D4" --no-claude-login)
RUN_ENV=()
grep -q 'config.json が動いている banto より新しいので、起こし直す' "$LOG/run6.log" && [[ $(mainpid) != "$pid_before" ]] &&
  pass "token：前の回に書いた設定が動いている banto より新しいので、この回が起こし直した" || fail "token：起こし直していない"
[[ $rc == 0 ]] && pass "token：名前を替えて通る（保存したトークンを使う）" || { fail "token：rc=$rc"; tail -30 "$LOG/run6.log"; }
st=$(cfstate)
node -e '
  const s = JSON.parse(process.argv[1]), d3 = process.argv[2], d4 = process.argv[3];
  const del = s.mutations.filter((m) => m[0] === "DELETE").map((m) => m[2]);
  const ok = del.length === 1 && del[0] === d3 && s.records.some((r) => r.name === `*.${d3}`) && s.records.some((r) => r.name === d4 && r.comment === "banto install.sh");
  process.exit(ok ? 0 : 1)' "$st" "$D3" "$D4" && pass "token：前の名前は印つきの $D3 だけ消した" || fail "token：偽物の状態：$st"
grep -A3 '残っている DNS のレコード' "$LOG/run6.log" | grep "\*\.$D3" >/dev/null && pass "token：最後の画面に残っている *.$D3 を出す" || fail "token：残っているレコードが出ない"

note "--no-cloudflare で内部の CA に戻す"
rc=$(run_install run7 --no-cloudflare --no-claude-login)
[[ $rc == 0 ]] && pass "no-cloudflare：通る" || { fail "no-cloudflare：rc=$rc"; tail -30 "$LOG/run7.log"; }
X test ! -e /etc/caddy/cloudflare.env && pass "no-cloudflare：cloudflare.env を消した" || fail "no-cloudflare：cloudflare.env が残っている"
X grep -q 'tls internal' /etc/caddy/banto.d/banto.caddy && pass "no-cloudflare：Caddy の設定が内部の CA に戻った" || fail "no-cloudflare：banto.caddy"
X grep -qx 'tls_mode=internal' /etc/banto/install.conf && pass "no-cloudflare：覚えた（次から聞かない）" || fail "no-cloudflare：install.conf"
! X grep -q baseDomain "/home/$TUSER/.local/share/banto/modules/publish-caddy/settings.json" && pass "no-cloudflare：Publish の基のドメインを外した" || fail "no-cloudflare：baseDomain が残っている"
LINK4=$(grep -oE "https://$D4/#banto-login=[A-Za-z0-9_-]+" "$LOG/run7.log" | head -1)
rc=0; U bash /opt/banto-test/checks.sh "$D4" "$LINK4" login >"$LOG/checks4.log" 2>&1 || rc=$?
grep -E '^(PASS|FAIL|INFO)' "$LOG/checks4.log" | sed 's/^/  /' | tee -a "$LOG/result.txt"
PASSES=$((PASSES + $(count '^PASS' "$LOG/checks4.log"))); FAILS=$((FAILS + $(count '^FAIL' "$LOG/checks4.log")))

# ---------------------------------------------------------------------------
note "秘密が出ていない（install.sh の出力・banto-host.log・Caddy の journal）"
token=$(X node -e 'console.log(require(process.argv[1]).authToken)' "/home/$TUSER/.config/banto/config.json")
X cat "/home/$TUSER/banto-host.log" >"$LOG/banto-host.log"
X journalctl -u caddy --no-pager >"$LOG/caddy-journal.log"
[[ ${#token} -ge 20 ]] || fail "秘密：authToken を読めない"
! grep -lF "$token" "$LOG"/*.log && pass "秘密：authToken の値がどのログにも無い" || fail "秘密：authToken の値がログにある"
! grep -lF "$FAKE_TOKEN" "$LOG"/*.log && pass "秘密：Cloudflare の（偽の）トークンがどのログにも無い（Caddy の journal を含む）" || fail "秘密：トークンがログにある"
! grep -qF '#banto-login=' "$LOG/banto-host.log" "$LOG/caddy-journal.log" && pass "秘密：ログインの札が banto-host.log・Caddy の journal に無い" || fail "秘密：ログインの札がログにある"

note "sudo の記憶を消す（パスワードの要る sudo のユーザーで）"
X useradd -m -s /bin/bash -G sudo pwuser
X sh -c 'echo "pwuser:pw-Test-1234" | chpasswd'
r=$(X sudo -u pwuser -H bash -c '
  echo pw-Test-1234 | sudo -S -p "" true 2>/dev/null || { echo seed=failed; exit; }
  sudo -n true 2>/dev/null && echo before=ok || echo before=no
  setsid --wait sudo -n true </dev/null 2>/dev/null && echo detached=ok || echo detached=no
  BANTO_INSTALL_LIB=1 source /opt/banto-test/install.sh; USER_NAME=pwuser; drop_sudo 試験 >/dev/null
  sudo -n true 2>/dev/null && echo after=ok || echo after=no
  run_detached sudo -n true >/dev/null 2>&1 && echo after_detached=ok || echo after_detached=no' | tr '\n' ' ')
echo "  INFO $r"
[[ $r == *"before=ok"* && $r == *"after=no"* && $r == *"after_detached=no"* ]] && pass "sudo：drop_sudo のあとは記憶が使えない（$r）" || fail "sudo：$r"

echo
echo "PASS $PASSES・FAIL $FAILS"
exit $((FAILS > 0))

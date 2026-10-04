#!/usr/bin/env bash
# install.sh を、まっさらな Ubuntu で本当に流して確かめる試験の場（docs/notes/2026-10-04-installer.md「試験の場」）。
#
# この Project のコンテナの中の Incus（sudo incus）に入れ子のシステムコンテナを立て、sudo できる普通のユーザーを作り、
# **この worktree の今のコミット**（git bundle で渡す。GitHub からは取らない）で install.sh を `curl | bash` と同じ形
# （標準入力から台本を読む）で流す。トークン無し（Caddy の内部の CA）の形だけを確かめる。
#
#   banto/scripts/install-test/run.sh [--image 24.04|26.04] [--user <名前>] [--keep] [--first-only]
#
#   --keep        終わっても試験の場を消さない（中を見るとき。消すのは sudo incus delete --force <名前>）
#   --first-only  1回目を入れて確かめる（a〜e・g）だけにする。打ち直し（f）と壊す試験を飛ばす
#
# **3段目の手当ては、ここにだけ置く**（install.sh には入れない）：
#   - 中の Incus は AppArmor を使えない → install.sh を流す前に incus.service へ INCUS_SECURITY_APPARMOR=false の drop-in
#     （パッケージより先に置いておけば、入ったときから効く）
#   - banto のコンテナには raw.lxc の lxc.apparmor.profile=unchanged が要る → 1回目のあと（banto のユーザーの区画が
#     できてから、Project のコンテナを作るより前）に、admin でその区画に低い層を許し、区画の default のプロファイルに入れる
# shellcheck disable=SC2015,SC2016,SC2024,SC2317 # 試験：pass||fail の並び・中で展開する台本・自分のファイルへの書き出し・trap の関数
set -euo pipefail

IMAGE=24.04 TUSER=bantotester KEEP=0 FIRST_ONLY=0
while [[ $# -gt 0 ]]; do
  case $1 in
    --image) IMAGE=$2; shift 2 ;;
    --user) TUSER=$2; shift 2 ;;
    --keep) KEEP=1; shift ;;
    --first-only) FIRST_ONLY=1; shift ;;
    *) echo "知らない引数：$1" >&2; exit 2 ;;
  esac
done

D1=banto.test D2=banto2.test
here=$(cd "$(dirname "$0")" && pwd)
repo=$(git -C "$here" rev-parse --show-toplevel)
branch=$(git -C "$repo" rev-parse --abbrev-ref HEAD)
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
run_install() {
  local log=$1; shift
  local rc=0
  sudo incus exec "$NAME" --cwd /tmp -- sudo -u "$TUSER" -H bash -c 'cat /opt/banto-test/install.sh | bash -s -- "$@"' _ "$@" \
    </dev/null >"$LOG/$log.log" 2>&1 || rc=$?
  echo "$rc"
}

nested_ip() { I list "$NAME" -c 4 -f csv | grep -oE '([0-9]+\.){3}[0-9]+' | head -1; }

# ---------------------------------------------------------------------------
note "試験の場を作る（ubuntu/$IMAGE・ユーザー $TUSER・$branch の $(git -C "$repo" rev-parse --short HEAD)）"
[[ -z $(git -C "$repo" status --porcelain -- install.sh) ]] || echo "注意：install.sh にコミットしていない変更があります。試験に使うのはコミットしたものです" >&2
git -C "$repo" bundle create "$LOG/banto.bundle" "$branch" 2>/dev/null
I launch "images:ubuntu/$IMAGE" "$NAME" \
  -c security.nesting=true -c security.syscalls.intercept.mknod=true -c security.syscalls.intercept.setxattr=true \
  -c limits.cpu=3 -c limits.memory=6GiB >/dev/null
X systemctl is-system-running --wait >/dev/null 2>&1 || true
for _ in $(seq 60); do X getent hosts pkgs.zabbly.com >/dev/null 2>&1 && break; sleep 2; done

X useradd -m -s /bin/bash -G sudo "$TUSER"
X sh -c "echo '$TUSER ALL=(ALL:ALL) NOPASSWD: ALL' > /etc/sudoers.d/90-$TUSER && chmod 0440 /etc/sudoers.d/90-$TUSER"
X mkdir -p /etc/systemd/system/incus.service.d /opt/banto-test
X sh -c 'printf "# 試験の場だけ：3段目の Incus は AppArmor を使えない\n[Service]\nEnvironment=INCUS_SECURITY_APPARMOR=false\n" > /etc/systemd/system/incus.service.d/90-install-test-no-apparmor.conf'
X sh -c "printf '127.0.0.1 $D1 sandbox.$D1 nothing.$D1 $D2 sandbox.$D2 nothing.$D2\n' >> /etc/hosts"
git -C "$repo" show "HEAD:install.sh" >"$LOG/install.sh"
I file push "$LOG/install.sh" "$NAME/opt/banto-test/install.sh"
I file push "$LOG/banto.bundle" "$NAME/opt/banto-test/banto.bundle"
I file push "$here/checks.sh" "$NAME/opt/banto-test/checks.sh"
X chmod -R a+rX /opt/banto-test
TUID=$(X id -u "$TUSER")
echo "試験の場：$NAME（uid $TUID）ログ：$LOG"

# ---------------------------------------------------------------------------
note "断る場合（root・--domain なし・知らない引数）"
rc=0; X bash -c 'cat /opt/banto-test/install.sh | bash -s -- --domain x.test' >"$LOG/neg-root.log" 2>&1 || rc=$?
if [[ $rc != 0 ]] && grep -q 'root で打たれました' "$LOG/neg-root.log"; then pass "root で打つと断る"; else fail "root：rc=$rc $(tail -3 "$LOG/neg-root.log")"; fi
rc=$(run_install neg-nodomain --no-claude-login)
if [[ $rc != 0 ]] && grep -q -- '--domain がありません' "$LOG/neg-nodomain.log"; then pass "初回に --domain が無ければ止まる"; else fail "--domain なし：rc=$rc"; fi
rc=$(run_install neg-arg --domain x.test --bogus)
if [[ $rc != 0 ]] && grep -q '知らない引数です：--bogus' "$LOG/neg-arg.log"; then pass "知らない引数で止まる"; else fail "知らない引数：rc=$rc"; fi
X test ! -e /etc/banto/install.conf && pass "断ったときは何も覚えない" || fail "断ったのに install.conf ができた"

# ---------------------------------------------------------------------------
note "a. まっさらから1回流す（数十分かかる）"
start=$(date +%s)
rc=$(run_install run1 --domain "$D1" --repo /opt/banto-test/banto.bundle --branch "$branch" --no-claude-login)
echo "  $(($(date +%s) - start)) 秒・終了コード $rc"
if [[ $rc == 0 ]] && grep -q 'banto を入れました' "$LOG/run1.log"; then pass "a: まっさらから最後まで通る（$(($(date +%s) - start)) 秒）"; else
  fail "a: 1回目：rc=$rc"; tail -30 "$LOG/run1.log"; exit 1
fi
LINK1=$(grep -oE "https://$D1/#banto-login=[A-Za-z0-9_-]+" "$LOG/run1.log" | head -1)

note "3段目の手当て（banto のユーザーの区画 user-$TUID に低い層を許す。試験の場だけ）"
X incus project set "user-$TUID" restricted.containers.lowlevel=allow
X incus profile set default raw.lxc 'lxc.apparmor.profile=unchanged' --project "user-$TUID"

note "b〜e・g（中の側）"
rc=0; U bash /opt/banto-test/checks.sh "$D1" "$LINK1" full >"$LOG/checks1.log" 2>&1 || rc=$?
grep -E '^(PASS|FAIL|INFO)' "$LOG/checks1.log" | tee -a "$LOG/result.txt" | sed 's/^/  /'
PASSES=$((PASSES + $(count '^PASS' "$LOG/checks1.log"))); FAILS=$((FAILS + $(count '^FAIL' "$LOG/checks1.log")))

note "g. 外（試験の場の外）から banto の口に直に届かない"
IP=$(nested_ip)
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
mainpid() { X systemctl show -p MainPID --value banto-host; }
pid_before=$(mainpid)
conf_before=$(X sha256sum "/home/$TUSER/.config/banto/config.json")
rc=$(run_install run2 --no-claude-login)
if [[ $rc == 0 ]]; then pass "f: 2回目が通る"; else fail "f: 2回目：rc=$rc"; tail -20 "$LOG/run2.log"; fi
grep -q 'build 済み' "$LOG/run2.log" && pass "f: build を飛ばす" || fail "f: 2回目に build した"
grep -q 'apt で入れる' "$LOG/run2.log" && fail "f: 2回目に apt で入れた" || pass "f: apt を飛ばす"
grep -q '入っている（/usr/local/bin/node' "$LOG/run2.log" && pass "f: Node を飛ばす" || fail "f: Node を入れ直した"
grep -q "名前：$D1" "$LOG/run2.log" && pass "f: 名前（$D1）が残る" || fail "f: 名前が残らない"
[[ $(mainpid) == "$pid_before" ]] && pass "f: 変わりが無ければ起こし直さない" || fail "f: 起こし直した（$pid_before → $(mainpid)）"
[[ $(X sha256sum "/home/$TUSER/.config/banto/config.json") == "$conf_before" ]] && pass "f: config.json はそのまま" || fail "f: config.json が変わった"

note "壊す試験：banto のユーザーを incus グループから外すと、doctor で止まる"
X gpasswd -d "$TUSER" incus >/dev/null
rc=0
U bash -c 'BANTO_INSTALL_LIB=1 source /opt/banto-test/install.sh; trap "on_error \$? \$LINENO" ERR; parse_args --no-claude-login; step_check_host; step_resolve_settings; step_doctor_and_start' \
  >"$LOG/break-group.log" 2>&1 || rc=$?
if [[ $rc != 0 ]] && grep -q 'コンテナの前提がそろっていません' "$LOG/break-group.log" && grep -q 'incus グループに入っていません' "$LOG/break-group.log"; then
  pass "壊す：doctor が落ちると、どの段で何が足りないかを出して止まる"
else
  fail "壊す：rc=$rc $(tail -5 "$LOG/break-group.log")"
fi

note "f-2. 新しいコミットと --domain $D2 で打ち直す：取り込み・build・起こし直し・Caddy と config が替わる・グループも直る"
git clone -q "$LOG/banto.bundle" -b "$branch" "$LOG/clone"
git -C "$LOG/clone" -c user.name=install-test -c user.email=install-test@example.invalid commit -q --allow-empty -m "試験：2つ目のコミット"
git -C "$LOG/clone" bundle create "$LOG/banto2.bundle" "$branch" 2>/dev/null
I file push "$LOG/banto2.bundle" "$NAME/opt/banto-test/banto.bundle"
X chmod a+r /opt/banto-test/banto.bundle
new_head=$(git -C "$LOG/clone" rev-parse HEAD)
pid_before=$(mainpid)
rc=$(run_install run3 --domain "$D2" --no-claude-login)
if [[ $rc == 0 ]]; then pass "f: --domain を変えて通る"; else fail "f: 3回目：rc=$rc"; tail -30 "$LOG/run3.log"; fi
[[ $(U git -C "/home/$TUSER/.local/share/banto-release" rev-parse HEAD) == "$new_head" ]] && pass "f: 新しいコミットを取り込んだ" || fail "f: 新しいコミットになっていない"
grep -q 'build する' "$LOG/run3.log" && pass "f: build した" || fail "f: build していない"
[[ $(mainpid) != "$pid_before" ]] && pass "f: 空くのを待って起こし直した" || fail "f: 起こし直していない"
grep -q "incus グループに入れた" "$LOG/run3.log" && pass "f: 外したグループを打ち直しで直した" || fail "f: グループを直していない"
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

echo
echo "PASS $PASSES・FAIL $FAILS"
exit $((FAILS > 0))

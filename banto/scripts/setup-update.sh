#!/usr/bin/env bash
# **画面から banto を更新できるように、host を整える**（決定・2026-10-04、手順書 `docs/runbooks/release.md` D・
# アーキ仕様 §2.5「画面から banto を更新する」）。何度打っても壊れない。`install.sh` も同じものを使う。
#
#   bash setup-update.sh --dry-run   # 何をするかを出すだけ（何も変えない）
#   bash setup-update.sh             # 行う（root の所は sudo で。最後に banto を起こし直す）
#
# 行うこと：
#   1. polkitd が無ければ入れる（apt）
#   2. 置き場（banto の設定の releaseDir、既定 ~/.local/share/banto-release）が古い形（それ自身が clone）なら、
#      <releaseDir>.tmp に移して versions/<commit の頭12> に入れ、repo.git を GitHub（今の clone の origin）から
#      bare で作り、今の clone をその worktree にして（組み立て直さない）、current を張る
#   3. banto-host.service・banto-frontend.service の定義を <releaseDir>/unit-backup/ に写してから、中の
#      <releaseDir> を <releaseDir>/current に置き換える（/etc/systemd/system/ の本体と drop-in）
#   4. /etc/systemd/system/banto-update.service（Type=oneshot、このユーザーで、Nice=10）を置く
#   5. /etc/polkit-1/rules.d/50-banto-update.rules：このユーザーに banto-update.service の start と、
#      banto-host.service・banto-frontend.service の restart だけを許す
#   6. daemon-reload と、変えたものがあれば banto を起こし直す
#
# 誰のために：打ったユーザー（sudo で root のときは SUDO_USER）。node は PATH の node か NODE_BIN。
set -euo pipefail

DRY=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY=1 ;;
    -h | --help)
      sed -n '2,20p' "$0"
      exit 0
      ;;
    *)
      echo "知らない引数です：$arg" >&2
      exit 2
      ;;
  esac
done

die() {
  echo "setup-update: $*" >&2
  exit 1
}
say() { echo "== $*"; }

# ───────────── 誰のために ─────────────

if [ "$(id -u)" -eq 0 ]; then
  [ -n "${SUDO_USER:-}" ] && [ "$SUDO_USER" != root ] ||
    die "root で直接打たないでください。banto を動かしているユーザーで打つか、そのユーザーから sudo で打ってください"
  RUN_USER=$SUDO_USER
else
  RUN_USER=$(id -un)
fi
RUN_HOME=$(getent passwd "$RUN_USER" | cut -d: -f6)
[ -n "$RUN_HOME" ] || die "$RUN_USER のホームが分かりません"

as_root() { if [ "$(id -u)" -eq 0 ]; then "$@"; else sudo "$@"; fi; }
as_user() { if [ "$(id -u)" -eq 0 ]; then sudo -u "$RUN_USER" -H -- "$@"; else "$@"; fi; }
# 変えるもの：--dry-run なら出すだけ
run_user() {
  if [ $DRY -eq 1 ]; then echo "   （予定）$*"; else as_user "$@"; fi
}
run_root() {
  if [ $DRY -eq 1 ]; then echo "   （予定・root）$*"; else as_root "$@"; fi
}

NODE_BIN=${NODE_BIN:-$(command -v node || true)}
[ -n "$NODE_BIN" ] && [ -x "$NODE_BIN" ] || die "node が見つかりません（NODE_BIN=/path/to/node で指せます）"
NODE_BIN=$(readlink -f "$NODE_BIN")

UNITS=(banto-host.service banto-frontend.service)
UPDATE_UNIT=banto-update.service
UPDATE_UNIT_PATH=/etc/systemd/system/$UPDATE_UNIT
POLKIT_RULE=/etc/polkit-1/rules.d/50-banto-update.rules

# banto-host の環境（設定・データの置き場を変えていれば、それに合わせる）
host_env() {
  systemctl show -p Environment --value banto-host.service 2>/dev/null | tr ' ' '\n' | sed -n "s/^$1=//p" | tail -1
}
HOST_CONFIG_PATH=$(host_env BANTO_CONFIG_PATH)
HOST_XDG_CONFIG=$(host_env XDG_CONFIG_HOME)
HOST_XDG_DATA=$(host_env XDG_DATA_HOME)
CONFIG_PATH=${BANTO_CONFIG_PATH:-${HOST_CONFIG_PATH:-${HOST_XDG_CONFIG:-$RUN_HOME/.config}/banto/config.json}}

REL=$(as_user "$NODE_BIN" -e '
  const fs = require("fs");
  try { process.stdout.write(JSON.parse(fs.readFileSync(process.argv[1], "utf8")).releaseDir ?? ""); }
  catch (e) { if (e.code !== "ENOENT") throw e; }' "$CONFIG_PATH")
REL=${REL:-${HOST_XDG_DATA:-$RUN_HOME/.local/share}/banto-release}
REL=${REL%/}

echo "ユーザー：$RUN_USER（$RUN_HOME）"
echo "設定：$CONFIG_PATH"
echo "置き場：$REL"
echo "node：$NODE_BIN"
[ $DRY -eq 1 ] && echo "（--dry-run：何も変えません）"
echo

# ───────────── 変える前に確かめる ─────────────

for u in "${UNITS[@]}"; do
  [ "$(systemctl show -p LoadState --value "$u")" = loaded ] || die "$u がありません（手順書 A で unit にしてから）"
  systemctl cat "$u" | grep -q -- "$REL" ||
    die "$u が $REL を指していません。先に手順書 A で、リリース用の clone から動かしてください"
done

# 今の版（古い形の clone）。途中で止まった回の続きも拾う
CLONE=""
if [ -d "$REL/.git" ]; then
  CLONE=$REL
elif [ -d "$REL.tmp/.git" ]; then
  CLONE=$REL.tmp
elif [ -d "$REL/versions" ]; then
  for d in "$REL"/versions/*/; do [ -d "$d.git" ] && CLONE=${d%/}; done
fi
[ -n "$CLONE" ] || [ -d "$REL/repo.git" ] || die "$REL に clone も repo.git もありません。先に手順書 A（または install.sh）"

SHA="" ORIGIN=""
if [ -n "$CLONE" ]; then
  SHA=$(as_user git -C "$CLONE" rev-parse HEAD)
  ORIGIN=$(as_user git -C "$CLONE" remote get-url origin)
  [ -f "$CLONE/banto/scripts/update.mjs" ] ||
    die "今の版（$SHA）に banto/scripts/update.mjs がありません。先に手順書 B でこの機能が入った版にしてください"
  [ -z "$(as_user git -C "$CLONE" status --porcelain --untracked-files=no)" ] ||
    die "$CLONE に手が入っています（git status）。片づけてから打ってください"
  say "今の版：$SHA（$CLONE、取り込み元 $ORIGIN）"
fi
TARGET=$REL/versions/${SHA:0:12}
LAYOUT_CHANGED=0

# ───────────── 1. polkit ─────────────

if [ -x /usr/lib/polkit-1/polkitd ] || command -v pkaction >/dev/null 2>&1; then
  say "polkit：入っています"
else
  say "polkit を入れます"
  command -v apt-get >/dev/null || die "polkitd を入れてください（apt-get がありません）"
  run_root env DEBIAN_FRONTEND=noninteractive apt-get install -y polkitd ||
    { run_root apt-get update && run_root env DEBIAN_FRONTEND=noninteractive apt-get install -y polkitd; }
fi

# ───────────── 2. 置き場の形 ─────────────

if [ "$CLONE" = "$REL" ]; then
  say "古い形の clone を $REL.tmp へ移します"
  run_user mv "$REL" "$REL.tmp"
  CLONE=$REL.tmp
  LAYOUT_CHANGED=1
fi
if [ "$CLONE" = "$REL.tmp" ]; then
  say "$REL.tmp を $TARGET に入れます"
  run_user mkdir -p "$REL/versions"
  run_user mv "$REL.tmp" "$TARGET"
  CLONE=$TARGET
  LAYOUT_CHANGED=1
fi
if [ ! -d "$REL/repo.git" ]; then
  [ -n "$ORIGIN" ] || die "repo.git を作る取り込み元が分かりません"
  say "$REL/repo.git を $ORIGIN から bare で作ります"
  run_user git init -q --bare "$REL/repo.git"
  run_user git --git-dir "$REL/repo.git" remote add origin "$ORIGIN"
  run_user git --git-dir "$REL/repo.git" fetch -q --no-tags origin "+refs/heads/release:refs/remotes/origin/release"
  LAYOUT_CHANGED=1
fi
if [ -n "$CLONE" ]; then
  # 今の版を repo.git の worktree にする（中の node_modules・dist はそのまま——組み立て直さない）
  say "$CLONE を repo.git の worktree にします（元の .git は $REL/setup-backup/ へ）"
  if [ $DRY -eq 0 ] && ! as_user git --git-dir "$REL/repo.git" cat-file -e "$SHA^{commit}" 2>/dev/null; then
    # release から消えた commit で動いている——今の clone から持ってくる
    as_user git --git-dir "$REL/repo.git" fetch -q "$CLONE" "+HEAD:refs/banto-setup/${SHA:0:12}"
  fi
  if [ -e "$REL/.setup" ]; then
    # 前の回がここで止まった——作りかけの worktree を消してからやり直す
    run_user rm -rf "$REL/.setup"
    run_user git --git-dir "$REL/repo.git" worktree prune
  fi
  run_user mkdir -p "$REL/setup-backup" "$REL/.setup"
  run_user git --git-dir "$REL/repo.git" worktree add -q --no-checkout --detach "$REL/.setup/${SHA:0:12}" "$SHA"
  run_user mv "$CLONE/.git" "$REL/setup-backup/clone-git-${SHA:0:12}"
  run_user mv "$REL/.setup/${SHA:0:12}/.git" "$CLONE/.git"
  run_user rmdir "$REL/.setup/${SHA:0:12}" "$REL/.setup"
  run_user git -C "$CLONE" worktree repair
  run_user git -C "$CLONE" reset -q
  if [ $DRY -eq 0 ]; then
    [ "$(as_user git -C "$CLONE" rev-parse HEAD)" = "$SHA" ] || die "$CLONE の HEAD が $SHA になっていません"
    [ -z "$(as_user git -C "$CLONE" status --porcelain --untracked-files=no)" ] ||
      die "$CLONE を worktree にしたら差分が出ました（git -C $CLONE status で見てください）"
  fi
  LAYOUT_CHANGED=1
fi
if [ ! -L "$REL/current" ]; then
  if [ -n "$SHA" ]; then
    LINK=versions/${SHA:0:12}
  else
    mapfile -t found < <(find "$REL/versions" -mindepth 1 -maxdepth 1 -type d -printf '%f\n' 2>/dev/null)
    [ "${#found[@]}" -eq 1 ] || die "$REL/current がありません。どの版を current にするか決められません（versions/ に ${#found[@]} 個）"
    LINK=versions/${found[0]}
  fi
  say "$REL/current → $LINK"
  run_user ln -sfn "$LINK" "$REL/current.tmp-$$"
  run_user mv -T "$REL/current.tmp-$$" "$REL/current"
  LAYOUT_CHANGED=1
else
  say "置き場：版ごとのフォルダの形です（current → $(readlink "$REL/current")）"
fi

# ───────────── 3. banto-host・banto-frontend の起動元 ─────────────

# 中の <REL>（と %h で書いたもの）を <REL>/current に。もう current を通っている所はそのまま
rewrite() {
  "$NODE_BIN" -e '
    const [rel, home] = process.argv.slice(1);
    const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const end = String.raw`(?=[/\s"'"'"';:=]|$)`;
    let text = require("fs").readFileSync(0, "utf8");
    const forms = [rel];
    if (rel.startsWith(home + "/")) forms.push("%h" + rel.slice(home.length));
    for (const f of forms) text = text.replace(new RegExp(esc(f) + end + "(?!/current" + end + ")", "gm"), f + "/current");
    process.stdout.write(text);' "$REL" "$RUN_HOME"
}

UNITS_CHANGED=0
# root のファイルを、中身が違うときだけ一時名→rename で置く。--dry-run なら差分を出す
# （/etc/polkit-1/rules.d はこのユーザーには読めないので、読めなければ root で読む）
read_root_file() {
  if [ -r "$1" ]; then cat "$1"; elif as_root test -f "$1"; then as_root cat "$1"; else return 1; fi
}
put_root_file() {
  local path=$1 content=$2 old
  if old=$(read_root_file "$path") && [ "$old" = "$content" ]; then
    echo "   変わりません：$path"
    return 1
  fi
  if [ $DRY -eq 1 ]; then
    echo "   （予定・root）$path を書く："
    diff -u --label "$path" --label "$path（新）" <(read_root_file "$path" || true) <(printf '%s\n' "$content") | sed 's/^/     /' || true
  else
    as_root mkdir -p "$(dirname "$path")"
    printf '%s\n' "$content" | as_root tee "$path.tmp-$$" >/dev/null
    as_root chmod 0644 "$path.tmp-$$"
    as_root mv -f "$path.tmp-$$" "$path"
    echo "   書きました：$path"
  fi
  return 0
}

for u in "${UNITS[@]}"; do
  frag=$(systemctl show -p FragmentPath --value "$u")
  read -r -a dropins <<<"$(systemctl show -p DropInPaths --value "$u")"
  backup=$REL/unit-backup
  if [ ! -e "$backup/$u" ]; then
    say "$u の定義を $backup/ に写します"
    run_user mkdir -p "$backup/$u.d"
    if [ $DRY -eq 1 ]; then
      echo "   （予定）systemctl cat $u と、定義のファイル（$frag ${dropins[*]}）を写す"
    else
      systemctl cat "$u" | as_user tee "$backup/$u.cat.txt" >/dev/null
      as_user cp "$frag" "$backup/$u"
      for d in "${dropins[@]}"; do as_user cp "$d" "$backup/$u.d/"; done
    fi
  fi
  say "$u：起動元を $REL/current に"
  for f in "$frag" "${dropins[@]}"; do
    new=$(rewrite <"$f")
    if [ "$new" = "$(cat "$f")" ]; then
      echo "   変わりません：$f"
      continue
    fi
    case "$f" in
      /etc/systemd/system/*) dest=$f ;;
      "$frag") dest=/etc/systemd/system/$u ;;
      *) dest=/etc/systemd/system/$u.d/$(basename "$f") ;;
    esac
    if put_root_file "$dest" "$new"; then UNITS_CHANGED=1; fi
  done
done

# ───────────── 4. banto-update.service ─────────────

say "$UPDATE_UNIT"
env_lines="Environment=HOME=$RUN_HOME"
[ -n "${BANTO_CONFIG_PATH:-$HOST_CONFIG_PATH}" ] && env_lines+=$'\n'"Environment=BANTO_CONFIG_PATH=${BANTO_CONFIG_PATH:-$HOST_CONFIG_PATH}"
[ -n "$HOST_XDG_CONFIG" ] && env_lines+=$'\n'"Environment=XDG_CONFIG_HOME=$HOST_XDG_CONFIG"
[ -n "$HOST_XDG_DATA" ] && env_lines+=$'\n'"Environment=XDG_DATA_HOME=$HOST_XDG_DATA"
update_unit="# banto：画面から頼まれた更新（setup-update.sh が書く。手順書 docs/runbooks/release.md D）
[Unit]
Description=banto update (fetch, build, wait, restart)

[Service]
Type=oneshot
User=$RUN_USER
Nice=10
TimeoutStartSec=infinity
$env_lines
ExecStart=$NODE_BIN $REL/current/banto/scripts/update.mjs"
if put_root_file "$UPDATE_UNIT_PATH" "$update_unit"; then UNITS_CHANGED=1; fi

# ───────────── 5. polkit の規則 ─────────────

say "polkit の規則"
rule="// banto：画面からの更新（setup-update.sh が書く。手順書 docs/runbooks/release.md D）。
// $RUN_USER に、$UPDATE_UNIT の start と、${UNITS[*]} の restart だけを許す
polkit.addRule(function(action, subject) {
  if (action.id !== \"org.freedesktop.systemd1.manage-units\") return;
  if (subject.user !== \"$RUN_USER\") return;
  var unit = action.lookup(\"unit\"), verb = action.lookup(\"verb\");
  if (unit === \"$UPDATE_UNIT\" && verb === \"start\") return polkit.Result.YES;
  if ([\"${UNITS[0]}\", \"${UNITS[1]}\"].indexOf(unit) >= 0 && verb === \"restart\") return polkit.Result.YES;
});"
put_root_file "$POLKIT_RULE" "$rule" || true

# ───────────── 6. 読み直して起こし直す ─────────────

if [ $UNITS_CHANGED -eq 1 ]; then
  say "systemd に読み直させます"
  run_root systemctl daemon-reload
fi
if [ $DRY -eq 0 ]; then
  # 書き換えた起動元が実在するか（手順書 A-5 と同じ確かめ）
  missing=$(systemctl cat "${UNITS[@]}" | grep -o -- "$REL/current[^ \"';:]*" | sort -u | while read -r p; do [ -e "$p" ] || echo "$p"; done)
  [ -z "$missing" ] || die "unit が指すパスがありません：$missing（元の定義は $REL/unit-backup/）"
fi
if [ $LAYOUT_CHANGED -eq 1 ] || [ $UNITS_CHANGED -eq 1 ]; then
  say "banto を起こし直します（${UNITS[*]}）"
  run_root systemctl restart "${UNITS[@]}"
  if [ $DRY -eq 0 ]; then
    for u in "${UNITS[@]}"; do
      [ "$(systemctl is-active "$u")" = active ] || die "$u が起きません（journalctl -u $u。元の定義は $REL/unit-backup/）"
    done
  fi
else
  say "変えたものが無いので、起こし直しません"
fi
echo
if [ $DRY -eq 1 ]; then
  echo "--dry-run なので、何も変えていません"
else
  echo "済みました。画面の 設定 → 更新 に今の版が出て、「準備が済んでいません」が出ないことを確かめてください"
  [ -d "$REL/setup-backup" ] && echo "元の clone の .git は $REL/setup-backup/ にあります"
fi

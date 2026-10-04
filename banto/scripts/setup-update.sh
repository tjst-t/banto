#!/usr/bin/env bash
# **画面から banto を更新できるように、host を整える**（決定・2026-10-04、手順書 `docs/runbooks/release.md` D・
# アーキ仕様 §2.5「画面から banto を更新する」）。何度打っても壊れない。途中で止まったら、banto を触らずに同じものを打ち直す。
#
#   bash setup-update.sh --dry-run   # 何をするかを出すだけ（何も変えない）
#   bash setup-update.sh             # 行う（root の所は sudo で。最後に banto を起こし直す）
#
# 行うこと（**root の要る段（1〜5）を、置き場を動かす（6）より前に済ませる**——sudo で止まっても、動いている clone は
# 元の場所のまま）：
#   1. polkitd が無ければ入れる（apt）
#   2. banto-host.service・banto-frontend.service の定義を <releaseDir>.setup-backup/units/ に写してから、中の
#      <releaseDir> を <releaseDir>/current に置き換える（/etc/systemd/system/ の本体と drop-in。読み直すのは 7）
#   3. /etc/systemd/system/banto-update.service（Type=oneshot、このユーザーで、`--from-request`）を置く。画面の口
#      （BANTO_UPDATE_UI_URL）は banto-frontend.service の起動の仕方から読む
#   4. /etc/polkit-1/rules.d/50-banto-update.rules：このユーザーに banto-update.service の start・stop と、
#      banto-host.service・banto-frontend.service の restart だけを許す
#   5. その規則が効いているかを pkcheck で確かめる（効かなければ止まる——polkit が古く JS の規則を読まない等）
#   6. 置き場（banto の設定の releaseDir、既定 ~/.local/share/banto-release）が古い形（それ自身が clone）なら、
#      <releaseDir>.tmp に移して versions/<commit の頭12> に入れ、repo.git を GitHub（今の clone の origin）から
#      bare で作り、今の clone をその worktree にして（組み立て直さない）、current を張る
#   7. daemon-reload と、変えたものがあれば banto を起こし直す
#
# 誰のために：打ったユーザー（sudo で root のときは SUDO_USER）。node は PATH の node か NODE_BIN。
# 画面の口が banto-frontend.service から読めないときは BANTO_UI_URL=http://127.0.0.1:<port>/ で指す。
set -euo pipefail

DRY=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY=1 ;;
    -h | --help)
      sed -n '2,26p' "$0"
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

# 写し：unit 名は update.mjs の UPDATE_UNIT・--units の既定と、core の self-update.ts の UPDATE_UNIT
UNITS=(banto-host.service banto-frontend.service)
UPDATE_UNIT=banto-update.service
UPDATE_UNIT_PATH=/etc/systemd/system/$UPDATE_UNIT
POLKIT_RULE=/etc/polkit-1/rules.d/50-banto-update.rules
# 写し：update.mjs の FETCH_REFSPEC・core の self-update.ts の FETCH_REFSPEC
FETCH_REFSPEC="+refs/heads/release:refs/remotes/origin/release"

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
# 置き場の外（置き場を動かしても一緒に動かない所）。unit の元の定義と、元の clone の .git
BACKUP=$REL.setup-backup

echo "ユーザー：$RUN_USER（$RUN_HOME）"
echo "設定：$CONFIG_PATH"
echo "置き場：$REL"
echo "node：$NODE_BIN"
[ $DRY -eq 1 ] && echo "（--dry-run：何も変えません）"
echo

# ───────────── 変える前に確かめる ─────────────

for u in "${UNITS[@]}"; do
  [ "$(systemctl show -p LoadState --value "$u")" = loaded ] || die "$u がありません（手順書 A で unit にしてから）"
  # 読み切ってから見る（`systemctl cat | grep -q` は grep が先に終わると SIGPIPE で落ち、pipefail で「無い」になる）
  grep -q -- "$REL" <<<"$(systemctl cat "$u" 2>/dev/null)" ||
    die "$u が $REL を指していません。先に手順書 A で、リリース用の clone から動かしてください"
done

# 今の版（古い形の clone）。途中で止まった回の続きも拾う
CLONE=""
if [ -d "$REL/.git" ]; then
  CLONE=$REL
elif [ -d "$REL.tmp/.git" ]; then
  CLONE=$REL.tmp
elif [ -d "$REL/versions" ]; then
  # .git が「ディレクトリ」なのは、まだ repo.git の worktree になっていない clone（worktree の .git はファイル）。
  # .git.new があるのは、前の回が .git を入れ替える途中で止まったもの
  for d in "$REL"/versions/*/; do [ -d "$d.git" ] || [ -e "$d.git.new" ] && CLONE=${d%/}; done
fi
[ -n "$CLONE" ] || [ -d "$REL/repo.git" ] || die "$REL に clone も repo.git もありません。先に手順書 A（または install.sh）"

SHA="" ORIGIN=""
if [ -n "$CLONE" ] && [ ! -d "$CLONE/.git" ]; then
  # .git を入れ替える途中で止まった回の続き（元の .git は退避済み、新しいものは .git.new）——6 で入れ替えを終える
  SHA=$(basename "$CLONE")
  RESUME_SWAP=1
  say "前の回が $CLONE の .git を入れ替える途中で止まっています。続きから行います"
elif [ -n "$CLONE" ]; then
  RESUME_SWAP=0
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

# 画面の口：banto-frontend.service の起動の仕方（ExecStart の -p／--port、npm の start なら package.json の
# scripts.start の -p、無ければ Environment の PORT）から読む。読めなければ止まる（推測しない）
ui_url() {
  local frontend=${UNITS[1]}
  "$NODE_BIN" -e '
    const fs = require("fs"), path = require("path");
    const [execStart, env, cwdRaw, rel] = process.argv.slice(1);
    // 引用符は外して語に分ける（`bash -lc "cd … && npm run start >> log"` の形も読めるように）
    const argv = (/argv\[\]=([^;]*)/.exec(execStart)?.[1] ?? "")
      .trim()
      .split(/\s+/)
      .map((w) => w.replace(/^["\x27]+|["\x27]+$/g, ""))
      .filter(Boolean);
    const cwd = cwdRaw.replace(/^[-!]+/, "");
    const portOf = (args) => {
      for (let i = 0; i < args.length; i++) {
        const a = args[i];
        if (a === "-p" || a === "--port") return args[i + 1];
        const m = /^(?:--port=|-p)(\d+)$/.exec(a);
        if (m) return m[1];
      }
    };
    const hostOf = (args) => {
      for (let i = 0; i < args.length; i++) {
        if (args[i] === "-H" || args[i] === "--hostname") return args[i + 1];
        const m = /^--hostname=(.+)$/.exec(args[i]);
        if (m) return m[1];
      }
    };
    let port = portOf(argv), host = hostOf(argv), from = "ExecStart";
    const npm = argv.findIndex((a) => path.basename(a) === "npm");
    const rest = npm >= 0 ? argv.slice(npm + 1) : [];
    const run = rest.indexOf("run");
    const isStart = rest.includes("start") && (run < 0 || rest[run + 1] === "start");
    if (!port && isStart) {
      // npm start／npm run start [-w <ws>|--prefix <dir>]（前に cd があればそこ）：その package.json の scripts.start
      let dir = cwd;
      const cd = argv.lastIndexOf("cd", npm);
      if (cd >= 0 && argv[cd + 1]) dir = path.resolve(dir || "/", argv[cd + 1]);
      for (let i = 0; i < rest.length; i++) {
        if (rest[i] === "-w" || rest[i] === "--workspace") dir = path.join(dir, rest[i + 1]);
        if (rest[i] === "--prefix") dir = path.resolve(dir, rest[i + 1]);
      }
      // 前の回が置き場を動かす途中で止まっていると、systemd が読んでいる定義はまだ動かす前のパスを指し、その場所は
      // <rel>.tmp/・versions/<commit>/・current/ のどれかに移っている（どれでも中身は同じ版）
      if (dir && !fs.existsSync(dir) && dir.startsWith(rel + "/")) {
        const rest = dir.slice(rel.length + 1).replace(/^current\//, "");
        const versions = fs.existsSync(path.join(rel, "versions")) ? fs.readdirSync(path.join(rel, "versions")) : [];
        const candidates = [path.join(rel, "current", rest), path.join(rel + ".tmp", rest), ...versions.map((v) => path.join(rel, "versions", v, rest))];
        dir = candidates.find((c) => fs.existsSync(c)) ?? dir;
      }
      if (dir) {
        try {
          const script = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")).scripts?.start ?? "";
          const words = script.split(/\s+/);
          port = portOf(words);
          host = host ?? hostOf(words);
          from = `${path.join(dir, "package.json")} の scripts.start（${script}）`;
        } catch {}
      }
    }
    if (!port) {
      port = /(?:^|\s)PORT=(\d+)/.exec(env)?.[1];
      from = "Environment の PORT";
    }
    if (!port || !/^\d+$/.test(port)) process.exit(0);
    if (!host || ["0.0.0.0", "::", "localhost"].includes(host)) host = "127.0.0.1";
    process.stdout.write(`http://${host.includes(":") ? `[${host}]` : host}:${port}/\t${from}`);
  ' "$(systemctl show -p ExecStart --value "$frontend")" "$(systemctl show -p Environment --value "$frontend")" \
    "$(systemctl show -p WorkingDirectory --value "$frontend")" "$REL"
}
if [ -n "${BANTO_UI_URL:-}" ]; then
  UI_URL=$BANTO_UI_URL
  say "画面の口：$UI_URL（BANTO_UI_URL）"
else
  found=$(ui_url)
  [ -n "$found" ] ||
    die "${UNITS[1]} から画面のポートが読めません（ExecStart：$(systemctl show -p ExecStart --value "${UNITS[1]}" | sed -n 's/.*argv\[\]=\([^;]*\);.*/\1/p')）。BANTO_UI_URL=http://127.0.0.1:<port>/ を付けて打ち直してください"
  UI_URL=${found%%$'\t'*}
  say "画面の口：$UI_URL（${UNITS[1]} の ${found#*$'\t'} から）"
fi

# sudo のパスワードは最初に聞く（置き場を動かしてから聞かれて止まらない）。`sudo -v` ではなく1つ打つ——NOPASSWD の
# 規則と、パスワードの要る規則（%sudo 等）の両方に当たるユーザーでは、-v だけがパスワードを求める（2026-10-04 に踏んだ）
if [ $DRY -eq 0 ] && [ "$(id -u)" -ne 0 ]; then sudo true || die "sudo が通りません。何も変えていません"; fi

# ───────────── 1. polkit ─────────────

if [ -x /usr/lib/polkit-1/polkitd ] || command -v pkaction >/dev/null 2>&1; then
  say "polkit：入っています"
else
  say "polkit を入れます"
  command -v apt-get >/dev/null || die "polkitd を入れてください（apt-get がありません）"
  run_root env DEBIAN_FRONTEND=noninteractive apt-get install -y polkitd ||
    { run_root apt-get update && run_root env DEBIAN_FRONTEND=noninteractive apt-get install -y polkitd; }
fi

# ───────────── 2. banto-host・banto-frontend の起動元 ─────────────

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
  backup=$BACKUP/units
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
  say "$u：起動元を $REL/current に（読み直すのは置き場を整えたあと）"
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

# 前の回が書いたあと（読み直す前）に止まっていれば、ファイルは「変わりません」でも systemd はまだ古い定義のまま
for u in "${UNITS[@]}"; do
  [ "$(systemctl show -p NeedDaemonReload --value "$u")" = yes ] && UNITS_CHANGED=1
done

# ───────────── 3. banto-update.service ─────────────

say "$UPDATE_UNIT"
env_lines="Environment=HOME=$RUN_HOME"
env_lines+=$'\n'"Environment=BANTO_UPDATE_UI_URL=$UI_URL"
[ -n "${BANTO_CONFIG_PATH:-$HOST_CONFIG_PATH}" ] && env_lines+=$'\n'"Environment=BANTO_CONFIG_PATH=${BANTO_CONFIG_PATH:-$HOST_CONFIG_PATH}"
[ -n "$HOST_XDG_CONFIG" ] && env_lines+=$'\n'"Environment=XDG_CONFIG_HOME=$HOST_XDG_CONFIG"
[ -n "$HOST_XDG_DATA" ] && env_lines+=$'\n'"Environment=XDG_DATA_HOME=$HOST_XDG_DATA"
# --from-request：画面からの頼み（request.json）が無ければ何もしない（人が一覧を見ていない版を入れない）
update_unit="# banto：画面から頼まれた更新（setup-update.sh が書く。手順書 docs/runbooks/release.md D）
[Unit]
Description=banto update (fetch, build, wait, restart)

[Service]
Type=oneshot
User=$RUN_USER
Nice=10
IOSchedulingClass=idle
CPUWeight=20
TimeoutStartSec=infinity
$env_lines
ExecStart=$NODE_BIN $REL/current/banto/scripts/update.mjs --from-request"
# banto-update.service だけが変わったときは、読み直すだけ（banto は起こし直さない）
RELOAD=$UNITS_CHANGED
if put_root_file "$UPDATE_UNIT_PATH" "$update_unit" ||
  [ "$(systemctl show -p NeedDaemonReload --value "$UPDATE_UNIT")" = yes ]; then RELOAD=1; fi

# ───────────── 4. polkit の規則 ─────────────

say "polkit の規則"
rule="// banto：画面からの更新（setup-update.sh が書く。手順書 docs/runbooks/release.md D）。
// $RUN_USER に、$UPDATE_UNIT の start・stop（詰まった更新を止める）と、${UNITS[*]} の restart だけを許す
polkit.addRule(function(action, subject) {
  if (action.id !== \"org.freedesktop.systemd1.manage-units\") return;
  if (subject.user !== \"$RUN_USER\") return;
  var unit = action.lookup(\"unit\"), verb = action.lookup(\"verb\");
  if (unit === \"$UPDATE_UNIT\" && (verb === \"start\" || verb === \"stop\")) return polkit.Result.YES;
  if ([\"${UNITS[0]}\", \"${UNITS[1]}\"].indexOf(unit) >= 0 && verb === \"restart\") return polkit.Result.YES;
});"
put_root_file "$POLKIT_RULE" "$rule" || true

# ───────────── 5. 規則が効いているか ─────────────

# このユーザーのプロセスを主語にして、polkit に聞く。0 が「許す」。断られる・パスワードを求められる（polkit が古く
# JS の規則を読まない、規則が読み込まれていない等）なら止まる——画面から押してから気づかない。
# pkcheck は root で打つ：--detail（どの unit・どの操作か）を付けて聞けるのは root か action の持ち主だけ
# （ほかのユーザーが打つと NotAuthorized。2026-10-04 に polkit 124 で確かめた）
if [ "$(id -u)" -ne 0 ]; then
  PK_SUBJECT=$$ # この打っているシェル（RUN_USER のプロセス）
else
  PK_SUBJECT=$(systemctl show -p MainPID --value "${UNITS[0]}")
  [ "${PK_SUBJECT:-0}" != 0 ] && [ "$(stat -c %U "/proc/$PK_SUBJECT" 2>/dev/null)" = "$RUN_USER" ] ||
    die "polkit に聞くための $RUN_USER のプロセスが見つかりません（${UNITS[0]} が動いていません）。$RUN_USER で打ってください"
fi
pk_allowed() {
  as_root pkcheck --action-id org.freedesktop.systemd1.manage-units --process "$PK_SUBJECT" \
    --detail unit "$1" --detail verb "$2" >/dev/null 2>&1
}
if [ $DRY -eq 1 ]; then
  say "polkit の規則が効いているか：（予定）pkcheck で確かめる"
else
  say "polkit の規則が効いているか（pkcheck）"
  command -v pkcheck >/dev/null || die "pkcheck がありません（polkitd を入れてください）"
  for check in "$UPDATE_UNIT start" "$UPDATE_UNIT stop" "${UNITS[0]} restart" "${UNITS[1]} restart"; do
    # shellcheck disable=SC2086
    if pk_allowed $check; then
      echo "   許されます：$check"
    else
      die "$RUN_USER に「$check」が許されていません（$POLKIT_RULE が効いていません。polkit：$(pkaction --version 2>/dev/null || echo 不明)——JS の規則を読むのは 0.106 以降）。置き場はまだ動かしていません"
    fi
  done
  # 許しすぎていないか（規則の外の操作は断られる）
  if pk_allowed "${UNITS[0]}" stop; then die "$RUN_USER に「${UNITS[0]} stop」まで許されています。$POLKIT_RULE のほかに広い規則がないか見てください"; fi
  echo "   断られます：${UNITS[0]} stop（規則の外）"
fi

# ───────────── 6. 置き場の形 ─────────────

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
  # 途中で止まった回の作りかけ（init だけ済んだ等）は作り直す
  run_user rm -rf "$REL/repo.git.tmp"
  run_user git init -q --bare "$REL/repo.git.tmp"
  run_user git --git-dir "$REL/repo.git.tmp" remote add origin "$ORIGIN"
  run_user git --git-dir "$REL/repo.git.tmp" fetch -q --no-tags origin "$FETCH_REFSPEC"
  run_user mv "$REL/repo.git.tmp" "$REL/repo.git"
  LAYOUT_CHANGED=1
fi
if [ -n "$CLONE" ]; then
  # 今の版を repo.git の worktree にする（中の node_modules・dist はそのまま——組み立て直さない）。
  # 途中で止まっても打ち直せるように：新しい .git を .git.new として置いてから、元の .git を退避して入れ替える
  say "$CLONE を repo.git の worktree にします（元の .git は $BACKUP/ へ）"
  if [ "$RESUME_SWAP" -eq 0 ]; then
    if [ $DRY -eq 0 ] && ! as_user git --git-dir "$REL/repo.git" cat-file -e "$SHA^{commit}" 2>/dev/null; then
      # release から消えた commit で動いている——今の clone から持ってくる
      as_user git --git-dir "$REL/repo.git" fetch -q "$CLONE" "+HEAD:refs/banto-setup/${SHA:0:12}"
    fi
    # 前の回が worktree を作るところで止まった——作りかけを消してからやり直す
    run_user rm -rf "$REL/.setup"
    run_user git --git-dir "$REL/repo.git" worktree prune
    run_user mkdir -p "$BACKUP" "$REL/.setup"
    run_user git --git-dir "$REL/repo.git" worktree add -q --no-checkout --detach "$REL/.setup/${SHA:0:12}" "$SHA"
    run_user mv "$REL/.setup/${SHA:0:12}/.git" "$CLONE/.git.new"
    run_user rmdir "$REL/.setup/${SHA:0:12}" "$REL/.setup"
  fi
  if [ $DRY -eq 1 ] || [ -d "$CLONE/.git" ]; then run_user mv "$CLONE/.git" "$BACKUP/clone-git-${SHA:0:12}"; fi
  run_user mv "$CLONE/.git.new" "$CLONE/.git"
  LAYOUT_CHANGED=1
fi
# worktree の .git と、repo.git の中の登録を結び直し、index が無ければ（--no-checkout で作ったまま）HEAD から作る
# （何度打ってもよい。入れ替えたあとで止まった回の続きもここで直る。作業ツリーのファイルには触らない）
for d in "$REL"/versions/*/; do
  [ -f "$d.git" ] || continue
  run_user git -C "${d%/}" worktree repair
  if [ $DRY -eq 0 ] && [ ! -e "$(as_user git -C "${d%/}" rev-parse --path-format=absolute --git-path index)" ]; then
    run_user git -C "${d%/}" reset -q
    [ -z "$(as_user git -C "${d%/}" status --porcelain --untracked-files=no)" ] ||
      die "${d%/} を worktree にしたら差分が出ました（git -C ${d%/} status で見てください）"
  fi
done
[ $DRY -eq 1 ] && [ -n "$CLONE" ] && run_user git -C "$CLONE" reset -q
if [ -n "$CLONE" ] && [ $DRY -eq 0 ]; then
  [ "$(as_user git -C "$CLONE" rev-parse HEAD)" = "$(as_user git --git-dir "$REL/repo.git" rev-parse "${SHA}^{commit}")" ] ||
    die "$CLONE の HEAD が $SHA になっていません"
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

# ───────────── 7. 読み直して起こし直す ─────────────

if [ $RELOAD -eq 1 ] || [ $UNITS_CHANGED -eq 1 ]; then
  say "systemd に読み直させます"
  run_root systemctl daemon-reload
fi
if [ $DRY -eq 0 ]; then
  # 書き換えた起動元が実在するか（手順書 A-5 と同じ確かめ）
  missing=$(systemctl cat "${UNITS[@]}" "$UPDATE_UNIT" 2>/dev/null | grep -o -- "$REL/current[^ \"';:]*" | sort -u | while read -r p; do [ -e "$p" ] || echo "$p"; done)
  [ -z "$missing" ] || die "unit が指すパスがありません：$missing（元の定義は $BACKUP/units/）"
fi
if [ $LAYOUT_CHANGED -eq 1 ] || [ $UNITS_CHANGED -eq 1 ]; then
  say "banto を起こし直します（${UNITS[*]}）"
  run_root systemctl restart "${UNITS[@]}"
  if [ $DRY -eq 0 ]; then
    for u in "${UNITS[@]}"; do
      [ "$(systemctl is-active "$u")" = active ] || die "$u が起きません（journalctl -u $u。元の定義は $BACKUP/units/）"
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
  ls "$BACKUP"/clone-git-* >/dev/null 2>&1 && echo "元の clone の .git は $BACKUP/ にあります"
fi
true

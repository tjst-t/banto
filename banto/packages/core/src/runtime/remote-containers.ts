// **別のサーバの中の、Project ごとのコンテナ**（決定・2026-10-17、`docs/specs/v4-security.md` §1「別のサーバの中のコンテナ
// ——1台に Project を複数置く」、Backlog #368）。
//
// この機械の `ProjectContainers` を、Incus の呼び方（`RunIncus`）を SSH 越しに差し替えて使う。違うところだけをここに置く：
//   - Incus は VM の SSH ユーザー（制限された区画 `user-<uid>`）として呼ぶ。中から host に届くアドレスは VM のインターフェース
//     から読む（host のを読まない）。上限は VM の資源で計算する
//   - VM の SSH ユーザーの uid/gid（U/G）を中の同じ番号 U/G に対応させる（`raw.idmap` の `uid U U`・`gid G G`。#457——#368 で中の
//     1000 に対応させて作ったコンテナは、次に止めるときに1回だけ付け替える。それまでは前の番号で使う）
//   - **見せたフォルダに書く・中身を解釈するものは `incus exec <c> --user <中の番号>` で中から**（条件3）。VM のユーザーがしてよいのは
//     symlink を辿らずに読むことと、まだ見せていないフォルダを作ることだけ
//
// **道**（#369、v4-security.md §1「道」）はどれも proxy device（転送役は作らない）。VM の側の端は**コンテナに見せていない VM だけの
// 場所**（`/run/user/<U>/banto/p-<Project>/`）に置き、名前は Module から来た文字列から組み立てない（条件4）。
//   - 中から banto へ：中の `127.0.0.1:<INSIDE_RELAY_PORT>` → その Project のトンネルのソケット（`t.sock`）→ host の中継の待ち受け
//   - 鍵の窓口：中の `/run/banto-a-<印>.sock` → VM の `a-<印>.sock`（host の Vault の窓口から `-R` で転送したもの）

import { CONTAINER_USER_NAME, type HostInterfaces, type HostResources, type ProxyRoute, type RunIncus } from "@banto/container";
import { createHash } from "node:crypto";
import { shq, type SshResult } from "./ssh.js";

/**
 * **前の中の番号**（#368 で作ったコンテナは VM の SSH ユーザーを中の 1000 に対応させていた）。札 `user.banto.inside` の無い
 * コンテナはこれで作ったものとして扱い、次に止めるときに U に付け替える（#457）。新しいコンテナには使わない
 */
export const LEGACY_INSIDE_IDS = { uid: 1000, gid: 1000 } as const;

/** 中の番号（いまそのコンテナで使うもの） */
export interface InsideIds {
  uid: number;
  gid: number;
}
/** 中のユーザーのホーム */
export const INSIDE_HOME = `/home/${CONTAINER_USER_NAME}`;

/**
 * **中から banto へ届く、コンテナの中の口のポート**（決定・2026-10-20、実装者。v4-security.md §1「道」の「決めたポート」）。
 * コンテナはそれぞれ自分のネットワーク名前空間を持つので、全コンテナで同じ番号でよい（中の 127.0.0.1 にしか出ない——ほかの
 * コンテナからは届かない）。中のサービスがこの番号で待ち受けるとぶつかるので、よく使われる番号と一時のポートの範囲（32768〜）を避けた
 */
export const INSIDE_RELAY_PORT = 29839;
/** 中から banto への道の装置の名前 */
export const RELAY_DEVICE = "banto-relay";
/** 鍵の窓口の装置の名前の頭（窓口ができたときに足し、閉じたら外す） */
export const AGENT_DEVICE_PREFIX = "banto-a-";

/** VM のユーザーの、コンテナに見せていない場所の既定（ユーザーの systemd の実行時の置き場。linger で VM の起動から在る） */
export function vmUserRunDir(uid: number): string {
  return `/run/user/${uid}`;
}

/**
 * **Project ごとの VM だけの場所**（`<実行時の置き場>/banto/p-<Project>`。v4-security.md §1 の条件4）。Project の id は core が
 * 作るもの（UUID）——パスに使える字だけでなければ断る（Module から来た文字列は混ぜない）
 */
export function vmProjectRunDir(runDir: string, projectId: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(projectId)) throw new Error(`Project の id（${projectId}）から VM の置き場を作れません`);
  return `${runDir}/banto/p-${projectId}`;
}

/** 中から banto への道：中の 127.0.0.1 の決めたポートで待ち受け、その Project のトンネルのソケットへ繋ぐ */
export function relayRoute(tunnelSocket: string): ProxyRoute {
  return { bind: "instance", listen: `tcp:127.0.0.1:${INSIDE_RELAY_PORT}`, connect: `unix:${tunnelSocket}` };
}

/**
 * 鍵の窓口の、中のパス。**`/run` の直下に置く**——forkproxy は待ち受けの親のフォルダを作らず、コンテナを起こし直すと `/run` は
 * 空になる（`/run/banto/` だと、残った装置がコンテナを起こすときに待ち受けられない）
 */
export function agentInsidePath(mark: string): string {
  return `/run/banto-a-${mark}.sock`;
}

/** VM で台本を流す口（多重化した接続の上。`stdin` を渡すと台本は `sh -c` で、標準入力はそれに流す） */
export type VmShell = (script: string, opts?: { stdin?: NodeJS.ReadableStream; timeoutMs?: number }) => Promise<SshResult>;

/** VM の SSH ユーザーとして `incus` を呼ぶ口 */
export function vmIncus(shell: VmShell): RunIncus {
  return (args, opts) => shell(`exec incus ${args.map(shq).join(" ")}\n`, { timeoutMs: opts?.timeoutMs ?? 60_000 });
}

/** `ip -o -4 addr show` の出力 → インターフェース名 → IPv4（loopback は除く） */
export function parseIpAddr(out: string): Record<string, string[]> {
  const result: Record<string, string[]> = {};
  for (const line of out.split("\n")) {
    const m = /^\d+:\s+([^\s:@]+)\S*\s+inet\s+(\d+\.\d+\.\d+\.\d+)\//.exec(line.trim());
    if (!m || m[2]!.startsWith("127.")) continue;
    (result[m[1]!] ??= []).push(m[2]!);
  }
  return result;
}

/** VM のインターフェース（ブリッジは VM のもの） */
export function vmInterfaces(shell: VmShell): HostInterfaces {
  return async () => {
    const r = await shell("exec ip -o -4 addr show\n", { timeoutMs: 15_000 });
    if (r.code !== 0) throw new Error(`VM のインターフェースを読めませんでした：${r.stderr.trim() || `終了コード ${r.code}`}`);
    return parseIpAddr(r.stdout);
  };
}

/** VM の資源（上限の既定はこれで計算する） */
export async function vmResources(shell: VmShell): Promise<HostResources> {
  const r = await shell("nproc\ngrep '^MemTotal:' /proc/meminfo\n", { timeoutMs: 15_000 });
  const cpus = Number(/^(\d+)$/m.exec(r.stdout)?.[1]);
  const kib = Number(/^MemTotal:\s+(\d+)\s+kB/m.exec(r.stdout)?.[1]);
  if (r.code !== 0 || !Number.isFinite(cpus) || !Number.isFinite(kib) || cpus <= 0 || kib <= 0) {
    throw new Error(`VM の資源（CPU・メモリ）を読めませんでした：${r.stderr.trim() || r.stdout.trim().slice(0, 200) || `終了コード ${r.code}`}`);
  }
  return { cpus, memoryBytes: kib * 1024 };
}

/**
 * **札から中の番号を読んで中のユーザーとして流す台本**（VM で流す。コンテナの番号を core がまだ知らないところ——移す前に動いている
 * ものを数える等）。札 `user.banto.inside`（`<uid>:<gid>`）が無ければ前の番号（まだ付け替えていない）。中のユーザーの systemd の
 * バスは台本の側で `id -u` から組む
 */
export function insideCommandByLabel(container: string, argv: readonly string[]): string {
  const words = ["incus", "exec", container, "--user", "$u", "--group", "$g"];
  return [
    `ids=$(incus config get ${shq(container)} user.banto.inside) || exit 5`,
    `case "$ids" in *:*) u=\${ids%%:*} g=\${ids#*:} ;; *) u=${LEGACY_INSIDE_IDS.uid} g=${LEGACY_INSIDE_IDS.gid} ;; esac`,
    `case "$u:$g" in :*|*:|*:*:*|*[!0-9:]*) echo "札 user.banto.inside の形が違います：$ids" >&2; exit 5 ;; esac`,
    `exec ${words.map((w) => (w.startsWith("$") ? `"${w}"` : shq(w))).join(" ")} --env USER=${CONTAINER_USER_NAME} --env LOGNAME=${CONTAINER_USER_NAME} --env HOME=${INSIDE_HOME} -- ${argv.map(shq).join(" ")}`,
  ].join("\n");
}

/**
 * **コンテナの中のユーザーとして流すコマンド行**（VM の上で打つもの）。env は `--env` で渡る（VM の `ps` には載るが、VM の
 * ユーザーは core だけが使う——条件1）。秘密を載せるときは標準入力で渡す（起動役の最初の1行）
 */
export function insideCommand(container: string, ids: InsideIds, argv: readonly string[], env: Readonly<Record<string, string>> = {}): string {
  const envArgs = Object.entries({ USER: CONTAINER_USER_NAME, LOGNAME: CONTAINER_USER_NAME, HOME: INSIDE_HOME, ...env }).flatMap(([k, v]) => [
    "--env",
    `${k}=${v}`,
  ]);
  const words = ["incus", "exec", container, "--user", String(ids.uid), "--group", String(ids.gid), ...envArgs, "--", ...argv];
  return `exec ${words.map(shq).join(" ")}`;
}

/** 中のユーザーの systemd のバス（単位を止めるとき） */
export function insideBusEnv(uid: number): Record<string, string> {
  return { XDG_RUNTIME_DIR: `/run/user/${uid}`, DBUS_SESSION_BUS_ADDRESS: `unix:path=/run/user/${uid}/bus` };
}

/**
 * **まだ見せていないフォルダを VM のユーザーで作る**（コンテナに見せる disk device は元が要る）。あれば触らない
 * （中身・権限を変えるのは中から）。**symlink は辿らない**：根から1段ずつ見て、symlink かフォルダでないものに当たれば断る
 * （終了コード 3）。`mkdir -p` は途中の symlink を辿って先に作ってしまうので使わない
 */
export function createOnlyDirScript(path: string): string {
  if (!path.startsWith("/") || path.split("/").includes("..")) throw new Error(`作るフォルダのパスがおかしいので作りません：${path}`);
  return [
    "set -f",
    `p=${shq(path)}`,
    'cur=""',
    "IFS=/",
    'for part in $p; do',
    '  [ -n "$part" ] || continue',
    '  cur="$cur/$part"',
    `  if [ -L "$cur" ]; then printf '%s は symlink なので使いません（%s）\\n' "$cur" "$p" >&2; exit 3; fi`,
    '  if [ -e "$cur" ]; then',
    `    [ -d "$cur" ] || { printf '%s はフォルダではありません\\n' "$cur" >&2; exit 3; }`,
    '  else',
    '    mkdir -m 700 -- "$cur" || exit 1',
    "  fi",
    "done",
    "",
  ].join("\n");
}

/**
 * **Shell のホームを中で展開するコマンド**（条件3）。前に送ったもの（`.banto-shell-home.json` の一覧）を中の node で消してから、
 * 標準入力の tar を中のユーザーとして展開する——中の AI が置いた symlink を辿るのも、中の権限だけ
 */
export function insideShellHomeCommand(container: string, ids: InsideIds, home: string, nodePath: string, removeOldScript: string): string {
  return insideCommand(container, ids, [
    "/bin/sh",
    "-c",
    'mkdir -p -- "$1" && chmod 700 -- "$1" && "$2" -e "$3" "$1" && tar -C "$1" --no-same-owner -xf -',
    "banto-shell-home",
    home,
    nodePath,
    removeOldScript,
  ]);
}

/** 中で落とした Module の単位を止めるコマンド */
export function insideStopUnitCommand(container: string, ids: InsideIds, unit: string): string {
  return insideCommand(container, ids, ["systemctl", "--user", "stop", `${unit}.service`], insideBusEnv(ids.uid));
}

/** VM の上の、根の重なりを見るのに要る場所（どれも VM で正規化したもの） */
export interface ContainersRootFacts {
  /** VM の SSH ユーザーの home（disk device で見せられるのはこの下だけ） */
  home: string;
  /** 実行場所の置き場の根（banto のコード・Module の置き場がここに入る） */
  dataRoot: string;
  /** 同じ実行場所の、ほかの Project の根（閉じたものも・移してくる途中のものも） */
  others: ReadonlyArray<{ name: string; root: string }>;
}

/** どちらかがもう一方を含む（同じも含む） */
function overlaps(a: string, b: string): boolean {
  if (a === "/" || b === "/") return true;
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

/**
 * **containers の Project の根が重なっていないか**（v4-security.md §1「置き場と見せ方」、Fable の S6。containers では注意でなく
 * 断る）。作る・再開するときに見る。重なると、コードの塗りや他の Project が、その Project の AI から書ける形で見える。
 * 根は home の下（home そのものでない）でなければならない——disk device は home の下しか見せられない
 */
export function containersRootProblem(root: string, facts: ContainersRootFacts): string | undefined {
  if (root === facts.home) return `根 ${root} が home そのものです——home の下のフォルダを選んでください（置き場や他の Project が見えてしまう）`;
  if (!root.startsWith(`${facts.home}/`)) return `根 ${root} が home（${facts.home}）の下にありません——コンテナに見せられるのは home の下だけです`;
  if (overlaps(root, facts.dataRoot)) return `根 ${root} が banto の置き場（${facts.dataRoot}）と重なります`;
  const other = facts.others.find((o) => overlaps(root, o.root));
  if (other) return `根 ${root} が Project「${other.name}」の根（${other.root}）と重なります（閉じた Project も含む）`;
  return undefined;
}

/** Module の置き場を見せる装置の名前（パスの hash。Module から来た文字列をそのまま装置の名前にしない） */
export function moduleDiskName(dir: string): string {
  return `m-${createHash("sha256").update(dir).digest("hex").slice(0, 16)}`;
}

/**
 * **見せたフォルダが中から見えているか**を見る台本（VM で流す）。フォルダごとに VM と中（中の root）の inode を1行
 * `<番号>=<VM>:<中>` で出す。中で引けなければ「中」は空——装置が付いていない（中の rootfs に同じパスが無い）か、コンテナが
 * 動いていない。VM の側は symlink を辿らずに読むだけ（`stat` は最後の段の symlink を辿らない——`-L` を付けない）
 */
export function inodePairsScript(container: string, dirs: readonly string[]): string {
  return [
    ...dirs.map(
      (dir, i) =>
        `printf '${i}=%s:%s\\n' "$(stat -c %i -- ${shq(dir)} 2>/dev/null)" "$(incus exec ${shq(container)} -- stat -c %i -- ${shq(dir)} 2>/dev/null)"`,
    ),
    "",
  ].join("\n");
}

/** `inodePairsScript` の出力を読む（フォルダの順に。読めない行は両方 undefined） */
export function parseInodePairs(stdout: string, count: number): Array<{ vm?: string; inside?: string }> {
  const out: Array<{ vm?: string; inside?: string }> = [];
  for (let i = 0; i < count; i++) {
    const m = new RegExp(`^${i}=(\\d*):(\\d*)$`, "m").exec(stdout);
    out.push({ ...(m?.[1] ? { vm: m[1] } : {}), ...(m?.[2] ? { inside: m[2] } : {}) });
  }
  return out;
}

/**
 * **中の root で台本を流すコマンド行**（VM の上で打つもの。`--user` を付けない）。移す元の `containers` のコンテナから読むとき
 * ——中の root が作った 0600 のもの等も読め、辿るのはコンテナの中だけ（条件3に触れない。v4-security.md §1「`containers` との間で
 * 移す」）
 */
export function insideRootCommand(container: string, script: string): string {
  return `exec incus exec ${shq(container)} -- /bin/sh -c ${shq(script)}`;
}

/**
 * **移す先のコンテナを片づける台本**（VM で流す。v4-security.md §1「`containers` との間で移す」の片づけ）。その banto の札
 * （`user.banto.owner`）が付いたコンテナだけに触る：`remove` なら消す、`stop` なら止めて残す（穏やかに止め、上限を過ぎたら強制停止）。
 * 無い・札が違う（ほかの banto・人が作った）なら何もしない。出すのは何をしたか（`ct=removed|stopped|none|foreign`）
 */
export function cleanupContainerScript(container: string, owner: string, action: "remove" | "stop", stopSec = 20): string {
  const c = shq(container);
  return [
    `st=$(incus list ${shq(`^${container}$`)} -c s -f csv) || exit 5`,
    `[ -n "$st" ] || { echo ct=none; exit 0; }`,
    `o=$(incus config get ${c} user.banto.owner) || exit 5`,
    `[ "$o" = ${shq(owner)} ] || { echo ct=foreign; exit 0; }`,
    action === "remove"
      ? `incus delete ${c} --force || exit 5\necho ct=removed`
      : `if [ "$st" = RUNNING ]; then incus stop ${c} --timeout ${stopSec} || incus stop ${c} --force || exit 5; fi\necho ct=stopped`,
    "",
  ].join("\n");
}

/**
 * **コンテナの中に rsync が無ければ入れる台本**（VM で流す。前に居た場所へ戻すとき——rsync の受け手・送り手は中で動く）。中は
 * sudo 可なので中の root で `apt-get install`。土台のイメージには入れない（入れると全部の土台を作り直す）。入れられなければ
 * 終了コード 4（外へ出られない等）
 */
export function ensureRsyncInsideScript(container: string): string {
  return insideRootCommand(
    container,
    [
      "command -v rsync >/dev/null 2>&1 && { echo rsync=present; exit 0; }",
      "export DEBIAN_FRONTEND=noninteractive",
      "{ apt-get update -q && apt-get install -y -q --no-install-recommends rsync; } >&2 || exit 4",
      "command -v rsync >/dev/null 2>&1 || exit 4",
      "echo rsync=installed",
    ].join("\n"),
  );
}

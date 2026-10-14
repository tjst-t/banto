// **Project を別の実行場所へ移す**（決定・2026-10-11、ユーザー。`docs/specs/v4-security.md` §1「Project を別の実行場所へ移す」、
// Backlog `runtime-move-core`）。
//
// **写して切り替える**——元のフォルダ・Module の置き場・元のコンテナは消さない。流れ（仕様の番号）：
//   2. 移す先を確かめる（選べる実行場所か・根はまだ無いか空か。banto が作り、正規化し、重なりを断る）
//   4. `project.runtime_move_started` を積む（この間、ターンは 409・届いたものは留める・移す先は押さえる）
//   5. Service を止めておく（元の unit を disable）→ Module を畳む → 根と Module の置き場を写す → 件数と大きさで確かめる →
//      `git worktree repair` → Claude の会話の記録を写す（要るとき）→ `project.runtime_moved` → 合言葉を替える → 留めたものを積む
//   6. 途中で失敗したら、移す先の banto が作ったものだけを消して `project.runtime_move_failed`。起き直したとき started だけが
//      残っていれば同じく片づける（`recoverInterrupted`）
//   7. 各 Thread に「移した」を届ける（ターンは起こさない）
//
// **写し方**：tar を流す。この機械の側は host のフォルダを直接読む・書く、別のサーバの側は SSH の上で。別のサーバどうしは
// host を経由する（向こうどうしを繋がない）。流れは必ず host のこの process を通る——写した量を数える（進み具合）。
//
// **前に居た場所へ戻す**（追加・2026-10-13、v4-security.md §1「前に居た場所へ戻す——差分で写す」）：移す先がその Project の
// `previousLocations` の1つなら、空でなくても受け付け、rsync で今の場所と同じ中身にそろえる（`-a --delete`）。rsync は host の
// この process が起こし、別のサーバの側へは `-e` に同じ SSH の引数を渡す（tar を流すときと同じ道——ControlMaster は使って
// いない。このファイルの SSH はどれも1回ずつ繋ぐ）。別のサーバどうしは host の一時の置き場を経由して2回
//
// **動いているものの数え方**：host が知っているもの（ターン・返事待ちの札・Module の呼び出し）は host が数え、Service の unit・
// 待たないコマンドの unit・Terminal の tmux は実行場所で直接引く。Module だけが知っているもの（Factory の件・Shell の待たない
// コマンド）は、どちらも返事待ちの札を持つので札で数える——Module に tool で聞く口は作っていない（2026-10-11。札を持たない
// 仕事を抱える Module が出たら足す）

import { spawnSync } from "node:child_process";
import { spawn, type ChildProcess } from "node:child_process";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
} from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";
import { Transform, type TransformCallback } from "node:stream";
import { isRemoteProject, type ProjectThreadStore } from "../project-thread/store.js";
import type { ProjectLocation, ProjectState, RuntimeMoveCreated } from "../project-thread/types.js";
import { RemoteRuntimeError, remoteNameOf, type RemoteRuntimes } from "./remote-runtimes.js";
import { HOST_CONTAINER_RUNTIME } from "./remote-store.js";
import { remoteOwnerDirName } from "./remote-ssh.js";
import { remotePathExpr, shq, sshArgs, sshEnv, SshCommandError, type SshResult } from "./ssh.js";

/** 画面に返す失敗（状態番号つき）。`RemoteRuntimeError` の仲間——SSH の接続の中から投げても状態番号が保たれる */
export class RuntimeMoveError extends RemoteRuntimeError {}

export interface MoveTarget {
  runtime: string;
  root: string;
  /** 前に居た場所へ戻すとき、移したあとに変わったファイルを上書きしてよいと人が承知した（見積もりの `returning.overwritten`） */
  acknowledgeOverwrite?: boolean;
}

/** 前に居た場所へ戻すとき、上書きされる・消えるファイル（そこから移したあとに変わった・足されたもの） */
export interface OverwrittenFiles {
  count: number;
  /** 頭の 20 件（移す先の側のパス） */
  head: string[];
}

/** 動いているもの1件（あれば移さない） */
export interface RunningItem {
  kind: "turn" | "reply" | "moduleReply" | "call" | "service" | "command" | "terminal";
  label: string;
}

/** 押す前の見積もり（仕様の流れ 3） */
export interface MoveEstimate {
  from: ProjectLocation & { label: string };
  to: { runtime: string; label: string; root: string };
  /** 写す大きさ（根と Module の置き場。除くもの——Shell と Terminal のホーム・ソケット——は数えない） */
  size: { bytes: number; files: number };
  /** 移らないもの */
  notMoved: string[];
  /** 作り直しが要るかもしれないもの（絶対パスを持つもの） */
  rebuild: string[];
  /** 動いているもの（あれば押せない） */
  running: RunningItem[];
  /** Claude の会話の記録を写すか（作業ディレクトリが変わるとき） */
  copiesClaudeRecords: boolean;
  /** 写す Claude の会話の記録の件数（写さないなら 0） */
  claudeRecords: number;
  /** この機械のコンテナから別のサーバへ移すときの注意（§「閉じ込め」） */
  confinementNote?: string;
  /** **前に居た場所へ戻す**（差分で写す）。無ければふつうに写す */
  returning?: {
    /** 前にそこから移した時刻 */
    movedAt?: string;
    /** 差分（rsync の `--dry-run`）。別のサーバどうし・rsync が無いときは測らない */
    diff?: { files: number; bytes: number; deleted: number };
    /** 上書きされる・消えるファイル。1件でもあれば、承知（`acknowledgeOverwrite`）が要る */
    overwritten: OverwrittenFiles;
  };
  /** 押せない理由（無ければ押せる） */
  blockers: string[];
}

/** 進み具合（画面が読む） */
export interface MoveProgress {
  phase: "preparing" | "stopping" | "copying" | "verifying" | "finishing" | "done" | "failed";
  /** 写した量（バイト。tar の流れの量なので、見積もりの大きさより少し多い） */
  copiedBytes: number;
  totalBytes: number;
  /** いま写しているもの */
  current?: string;
  startedAt: string;
  endedAt?: string;
  reason?: string;
}

/**
 * **移している Project を画面に見せる形**（追加・2026-10-12、Backlog #270 runtime-move-visible）。会話の面の帯と
 * サイドバーの印に使う。進み具合（`phase` 以下）は host が起き直したあとは無い
 */
export interface RuntimeMoveView {
  projectId: string;
  from: { runtime: string; root: string; label: string };
  to: { runtime: string; root: string; label: string };
  phase?: MoveProgress["phase"];
  copiedBytes?: number;
  totalBytes?: number;
}

/**
 * **移す状況が変わった**（画面への知らせ）。`move` があれば移している途中（丸ごと置き換える）。無ければ終わった
 * ——`failed` があれば移せなかった（受信箱の知らせと同じ文）。`done` があれば移し終えた（どこからどこへ。画面が
 * 「移しました：root は…、元は…に残っています」を出す。追加・2026-10-14、Backlog #293）
 */
export interface RuntimeMoveChange {
  projectId: string;
  move?: RuntimeMoveView;
  failed?: { title: string; reason: string; from: { runtime: string; root: string; label: string } };
  done?: { from: { runtime: string; root: string; label: string }; to: { runtime: string; root: string; label: string } };
}

export interface ProjectMoveDeps {
  dataDir: string;
  /** banto のコードの置き場（移す先の根と重なれば断る） */
  monorepoRoot: string;
  /** Runner（Claude の CLI）の記録の置き場（`CLAUDE_CONFIG_DIR`。無ければ `~/.claude`） */
  claudeConfigDir: string;
  projectThread: ProjectThreadStore;
  remoteRuntimes: RemoteRuntimes;
  /** この機械のコンテナ（中で数える・止める） */
  hostContainers: {
    runInside(projectId: string, script: string): Promise<SshResult | undefined>;
    stopProjectContainer(projectId: string): Promise<void>;
  };
  /** host が知っている動いているもの（ターン・返事待ちの札・Module の呼び出し） */
  hostActivity(projectId: string): RunningItem[];
  /** 元の実行場所の Service を全件「止めておきたい」にし、自動起動から外す。Service の Module が無ければ空。外したものの名前 */
  disableServices(projectId: string): Promise<string[]>;
  /** その Project の Module を畳む */
  releaseModules(projectId: string): Promise<void>;
  /** Claude のログインの合言葉を替える（元に残した環境ファイルの合言葉を効かなくする） */
  revokeClaudeLogin(projectId: string): void;
  /** その Thread に機械からのメッセージを届ける（起こさない・受信箱に出さない） */
  deliver(threadId: string, title: string, text: string): Promise<void>;
  /** 留めていた届いたもので起こす */
  kick(threadId: string): void;
  /** 受信箱へ */
  notify(n: { projectId: string; dedupeKey: string; title: string; detail: string }): Promise<void>;
  /** 移す状況が変わった（画面への知らせ。写している間は1秒に1回まで） */
  onChange?: (change: RuntimeMoveChange) => void;
  log?: (line: string) => void;
  /** 写す速さの上限（バイト／秒。E2E だけが、写す途中で banto を落とすために使う） */
  throttleBytesPerSec?: number;
}

/** 片側（移す元・移す先）。パスはその側のもの */
interface Side {
  runtime: string;
  label: string;
  /** その側の banto のデータの置き場（この機械：データの置き場。別のサーバ：向こうの置き場） */
  dataBase: string;
  modulesDir: string;
  run(script: string, timeoutMs?: number): Promise<SshResult>;
  /** 流すためのプロセス（標準入出力をつなぐ） */
  spawn(script: string): ChildProcess;
  /** 別のサーバなら、rsync の `-e` に渡す SSH の命令と宛先。この機械なら無い */
  rsyncRemote?: { shell: string; host: string };
}

const NOT_MOVED = [
  "入れた道具（apt で入れたもの・Shell と Terminal のホームに入れたもの）",
  "Docker のイメージ",
  "コンテナや向こうの機械の状態（動いていたプロセス・設定）",
  "Shell と Terminal のホーム（移った先で作り直し、人が選んだ設定を送り直す）",
];

const MARKER = ".banto-moved.json";

/** Service の unit・待たないコマンドの unit・Terminal の tmux を引く台本（実行場所で、その人として流す） */
const RUNNING_SCRIPT = [
  `u=$(id -u)`,
  `export XDG_RUNTIME_DIR="\${XDG_RUNTIME_DIR:-/run/user/$u}" DBUS_SESSION_BUS_ADDRESS="\${DBUS_SESSION_BUS_ADDRESS:-unix:path=/run/user/$u/bus}"`,
  `if command -v systemctl >/dev/null 2>&1 && [ -S "/run/user/$u/bus" ]; then`,
  `  systemctl --user list-units --type=service --state=active,activating,reloading,deactivating --plain --no-legend --no-pager 'banto-*' | awk '{print "unit=" $1}' || exit 4`,
  `fi`,
  `if command -v tmux >/dev/null 2>&1; then tmux -L banto-terminal ls -F '#{session_name}' 2>/dev/null | sed 's/^/tmux=/'; fi`,
  `exit 0`,
  "",
].join("\n");

export function parseRunning(stdout: string): RunningItem[] {
  const items: RunningItem[] = [];
  for (const line of stdout.split("\n")) {
    const unit = /^unit=(banto-.+)\.service$/.exec(line.trim())?.[1];
    if (unit) {
      // banto-mod-*：別のサーバで Module を包む単位（畳めば止まる）。banto-shell-*：Shell の待たないコマンド
      if (unit.startsWith("banto-mod-")) continue;
      if (unit.startsWith("banto-shell-")) items.push({ kind: "command", label: `Shell の待たないコマンド（${unit}）` });
      else items.push({ kind: "service", label: `Service「${unit.slice("banto-".length)}」が動いています` });
      continue;
    }
    const session = /^tmux=(.+)$/.exec(line.trim())?.[1];
    if (session) items.push({ kind: "terminal", label: `Terminal のセッション「${session}」が開いています` });
  }
  return items;
}

/** どちらかがもう一方を含む（同じも含む） */
export function pathsOverlap(a: string, b: string): boolean {
  if (a === "/" || b === "/") return true;
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

/** `outer` が `inner` を含む（同じも含む） */
export function pathContains(outer: string, inner: string): boolean {
  return outer === "/" || outer === inner || inner.startsWith(`${outer}/`);
}

/** CLI の記録の置き場のフォルダ名（作業ディレクトリの英数字以外を `-` に）。200 字を超えると CLI は名前を縮めるので扱わない */
export function claudeProjectDirName(cwd: string): string | undefined {
  const name = cwd.replace(/[^a-zA-Z0-9]/g, "-");
  return name.length <= 200 ? name : undefined;
}

/** その Project の Thread が使った会話の id（全 Thread の全 resume-point——過去から分けた Fork・閉じた Thread・Clear 前のものも） */
export function sessionIdsOf(threads: ReadonlyArray<ProjectStateThreadLike>): string[] {
  const ids = new Set<string>();
  for (const t of threads) {
    for (const r of t.resumePoints ?? []) ids.add(r.sessionId);
    if (t.resumePoint) ids.add(t.resumePoint);
    if (t.lastTurn?.knownSessionId) ids.add(t.lastTurn.knownSessionId);
    if (t.lastTurn?.assignedSessionId) ids.add(t.lastTurn.assignedSessionId);
  }
  // 会話の id は CLI のファイル名になる——外へ出る名前は使わない
  return [...ids].filter((id) => /^[A-Za-z0-9._-]+$/.test(id) && id !== "." && id !== "..");
}

interface ProjectStateThreadLike {
  resumePoints?: Array<{ sessionId: string }>;
  resumePoint?: string;
  lastTurn?: { knownSessionId?: string; assignedSessionId?: string };
}

/** 写す1つ（根か、Module の置き場1つ） */
interface CopyUnit {
  what: string;
  from: string;
  to: string;
  /** Module の置き場なら、除くもの（`s`・ソケット・ホーム） */
  module?: { excludeHome: boolean };
}

/** tar と find に同じ除き方を渡す */
function excludesFor(unit: Pick<CopyUnit, "module">): { tar: string; find: string } {
  if (!unit.module) return { tar: "", find: "" };
  const anchored = ["./s", ...(unit.module.excludeHome ? ["./home"] : [])];
  return {
    tar: `--anchored ${anchored.map((p) => `--exclude=${shq(p)}`).join(" ")} --no-anchored --exclude='*.sock' --exclude=${shq(MARKER)}`,
    find: `\\( ${anchored.map((p) => `-path ${shq(p)}`).join(" -o ")} -o -name '*.sock' -o -name ${shq(MARKER)} \\) -prune -o`,
  };
}

/** rsync に同じ除き方を渡す（除いたものは移す先でも消さない——`--delete` は除いたものに触らない） */
function rsyncExcludes(unit: Pick<CopyUnit, "module">): string[] {
  if (!unit.module) return [];
  return ["--exclude=/s", ...(unit.module.excludeHome ? ["--exclude=/home"] : []), "--exclude=*.sock", `--exclude=${MARKER}`];
}

/** rsync の `-e` の1語（rsync は空白で区切り、引用符でくくった空白は保つ。バックスラッシュは効かない） */
export function rsyncShellWord(word: string): string {
  if (/^[A-Za-z0-9_./=,:@+%-]+$/.test(word)) return word;
  if (!word.includes("'")) return `'${word}'`;
  if (!word.includes('"')) return `"${word}"`;
  throw new Error(`rsync に渡せない文字を含む SSH の引数です：${word}`);
}

/** rsync の `--stats` を読む（数は桁区切りつきで出る） */
export function parseRsyncStats(stdout: string): { files: number; bytes: number; deleted: number } {
  const num = (re: RegExp): number => {
    const m = re.exec(stdout);
    if (!m) throw new Error(`rsync の数を読めませんでした：${stdout.trim().slice(-300)}`);
    return Number(m[1]!.replace(/[^\d]/g, ""));
  };
  return {
    files: num(/^Number of regular files transferred: ([\d,.]+)/m),
    bytes: num(/^Total transferred file size: ([\d,.]+)/m),
    deleted: /^Number of deleted files: ([\d,.]+)/m.test(stdout) ? num(/^Number of deleted files: ([\d,.]+)/m) : 0,
  };
}

/** そのフォルダで、`since`（秒）より後に変わったファイルとリンク（件数と頭の 20 件。パスはフォルダからの相対） */
function newerScript(dir: string, unit: Pick<CopyUnit, "module">, since: number): string {
  const { find } = excludesFor(unit);
  return (
    `cd -- ${shq(dir)} 2>/dev/null || { echo n=0; exit 0; }\n` +
    `find . ${find} \\( -type f -o -type l \\) -newermt @${since} -printf '%P\\n' | awk 'NR<=20 {print "f=" $0} END {print "n=" NR+0}'\n`
  );
}

/** 退かせる名前に付ける日時（`.before-<日時>`） */
function stampNow(): string {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\..*$/, "");
}

/** 2つのファイル・フォルダの中身が同じか（リンクはリンク先の文字列で比べる） */
function sameTree(a: string, b: string): boolean {
  const sa = lstatSync(a);
  const sb = lstatSync(b);
  if (sa.isSymbolicLink() || sb.isSymbolicLink()) return sa.isSymbolicLink() && sb.isSymbolicLink() && readlinkSync(a) === readlinkSync(b);
  if (sa.isDirectory() || sb.isDirectory()) {
    if (!sa.isDirectory() || !sb.isDirectory()) return false;
    const na = readdirSync(a).sort();
    const nb = readdirSync(b).sort();
    return na.length === nb.length && na.every((n, i) => n === nb[i] && sameTree(join(a, n), join(b, n)));
  }
  return sa.size === sb.size && readFileSync(a).equals(readFileSync(b));
}

/**
 * **Claude の会話の記録を写す**（`<id>.jsonl` と付属のフォルダ `<id>/`）。写す先に同じ名前があり中身が違えば、写す先の古いものを
 * `<id>.jsonl.before-<日時>`（フォルダは `<id>.before-<日時>`）に退かせてから写す。同じなら何もしない（決定・2026-10-13、
 * v4-security.md §1「前に居た場所へ戻す」——以前は写す先にあれば上書きせず、同じ根へ戻すと移す前の古い記録が勝った）
 */
export function copyClaudeRecordFiles(src: string, dst: string, ids: readonly string[], stamp = stampNow()): { copied: number; setAside: number } {
  let copied = 0;
  let setAside = 0;
  for (const id of ids) {
    for (const [name, aside] of [[`${id}.jsonl`, `${id}.jsonl.before-${stamp}`], [id, `${id}.before-${stamp}`]] as const) {
      const from = join(src, name);
      if (!existsSync(from)) continue;
      const to = join(dst, name);
      mkdirSync(dst, { recursive: true, mode: 0o700 });
      if (existsSync(to) || isLink(to)) {
        if (sameTree(from, to)) continue;
        renameSync(to, join(dst, aside));
        setAside++;
      }
      cpSync(from, to, { recursive: true, verbatimSymlinks: true });
      if (name.endsWith(".jsonl")) copied++;
    }
  }
  return { copied, setAside };
}

/** そのフォルダの、写すものの件数と大きさ（ファイルとリンクの件数・ファイルの大きさの和）。無ければ 0 */
function measureScript(dir: string, unit: Pick<CopyUnit, "module">): string {
  const { find } = excludesFor(unit);
  return (
    `cd -- ${shq(dir)} 2>/dev/null || { printf 'files=0 bytes=0\\n'; exit 0; }\n` +
    `find . ${find} \\( -type f -o -type l \\) -printf '%y %s\\n' | awk '{n++; if ($1=="f") b+=$2} END {printf "files=%d bytes=%.0f\\n", n, b}'\n`
  );
}

function parseMeasure(stdout: string): { files: number; bytes: number } {
  const m = /files=(\d+) bytes=(\d+)/.exec(stdout);
  if (!m) throw new Error(`件数と大きさを読めませんでした：${stdout.trim().slice(-200)}`);
  return { files: Number(m[1]), bytes: Number(m[2]) };
}

/** 流した量を数える（と、E2E のときだけ速さを抑える） */
class CountingStream extends Transform {
  private bytes = 0;
  private readonly started = Date.now();

  constructor(
    private readonly onBytes: (n: number) => void,
    private readonly limit: number | undefined,
  ) {
    super();
  }

  override _transform(chunk: Buffer, _enc: BufferEncoding, done: TransformCallback): void {
    this.bytes += chunk.length;
    this.onBytes(chunk.length);
    if (!this.limit) return done(null, chunk);
    const due = (this.bytes / this.limit) * 1000 - (Date.now() - this.started);
    if (due <= 0) return done(null, chunk);
    setTimeout(() => done(null, chunk), due);
  }
}

function collect(child: ChildProcess): Promise<SshResult> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (c: Buffer) => (stdout += String(c)));
    child.stderr?.on("data", (c: Buffer) => (stderr = (stderr + String(c)).slice(-4000)));
    child.on("error", (err) => (stderr += err.message));
    child.on("close", (code) => resolve({ code: code ?? 255, stdout, stderr }));
  });
}

function hostLabel(runtime: string): string {
  const name = remoteNameOf(runtime);
  return name ? `別のサーバ「${name}」` : "この機械のコンテナ";
}

export class ProjectMover {
  private readonly progress = new Map<string, MoveProgress>();
  /** 画面へ最後に知らせた時刻（写している間の知らせを1秒に1回までにする） */
  private readonly lastChange = new Map<string, number>();
  /** Module を起こしてよい間（Service を止めておくために、移している途中でも Service の Module だけは起こす） */
  private readonly modulesAllowed = new Set<string>();
  private readonly log: (line: string) => void;

  constructor(private readonly deps: ProjectMoveDeps) {
    this.log = deps.log ?? ((line) => console.log(line));
  }

  /** 移している途中でも Module を起こしてよいか（Service を止めておく間だけ） */
  allowsModuleStart(projectId: string): boolean {
    return this.modulesAllowed.has(projectId);
  }

  /** 進み具合（起き直したあとは、記録の move だけ——写した量は分からない） */
  status(projectId: string): { move?: ProjectState["move"]; progress?: MoveProgress } {
    const project = this.deps.projectThread.getProject(projectId);
    if (!project) throw new RuntimeMoveError(404, "Project がありません");
    const progress = this.progress.get(projectId);
    return { ...(project.move ? { move: project.move } : {}), ...(progress ? { progress } : {}) };
  }

  /** いま移している Project（画面の hello に載せる） */
  moving(): RuntimeMoveView[] {
    return this.deps.projectThread
      .listProjects()
      .filter((p) => p.move)
      .map((p) => this.viewOf(p.id, p.move!));
  }

  private viewOf(projectId: string, move: NonNullable<ProjectState["move"]>): RuntimeMoveView {
    const progress = this.progress.get(projectId);
    const live = progress && progress.phase !== "done" && progress.phase !== "failed";
    return {
      projectId,
      from: { ...move.from, label: hostLabel(move.from.runtime) },
      to: { ...move.to, label: hostLabel(move.to.runtime) },
      ...(live ? { phase: progress.phase, copiedBytes: progress.copiedBytes, totalBytes: progress.totalBytes } : {}),
    };
  }

  /** 移している途中の様子を画面へ（記録の move が無ければ何もしない） */
  private changed(projectId: string): void {
    if (!this.deps.onChange) return;
    const move = this.deps.projectThread.getProject(projectId)?.move;
    if (!move) return;
    this.lastChange.set(projectId, Date.now());
    this.emit({ projectId, move: this.viewOf(projectId, move) });
  }

  private emit(change: RuntimeMoveChange): void {
    if (!change.move) this.lastChange.delete(change.projectId);
    try {
      this.deps.onChange?.(change);
    } catch (err) {
      this.log(`[host] 移す状況を画面へ知らせられませんでした: ${String(err)}`);
    }
  }

  // ── 見積もり ───────────────────────────────────────────────────────────

  async estimate(projectId: string, target: MoveTarget): Promise<MoveEstimate> {
    const project = this.mustGetProject(projectId);
    const from = this.locationOf(project);
    const blockers: string[] = [];
    const targetProblem = this.targetRuntimeProblem(project, target.runtime);
    if (targetProblem) blockers.push(targetProblem);
    if (project.move) blockers.push("いま別の実行場所へ移しています");

    const running = await this.running(project);
    if (running.length > 0) blockers.push("動いているものがあります（止めてから移してください）");

    let size = { bytes: 0, files: 0 };
    let rebuild: string[] = [];
    await this.withSide(from.runtime, async (side) => {
      for (const unit of await this.copyUnits(project, side, undefined, "")) {
        const m = parseMeasure((await this.mustRun(side, "大きさを測れ", measureScript(unit.from, unit), 300_000)).stdout);
        size = { bytes: size.bytes + m.bytes, files: size.files + m.files };
      }
      rebuild = await this.rebuildCandidates(side, from.root);
    });
    let returning: MoveEstimate["returning"];
    if (!targetProblem) {
      const checked = await this.withSide(target.runtime, (side) => this.checkTargetRoot(project, side, target.root));
      if (checked.problem) blockers.push(checked.problem);
      if (checked.back) {
        const back = checked.back;
        returning = await this.withSide(from.runtime, (src) =>
          this.withSide(back.runtime, async (dst) => {
            const missing = await this.rsyncMissing([src, dst]);
            blockers.push(...missing);
            const units = await this.copyUnits(project, src, dst, back.root);
            const overwritten = await this.overwrittenFiles(dst, units, back.movedAt);
            const diff = missing.length === 0 && (!src.rsyncRemote || !dst.rsyncRemote) ? await this.dryRun(src, dst, units) : undefined;
            return { ...(back.movedAt ? { movedAt: back.movedAt } : {}), ...(diff ? { diff } : {}), overwritten };
          }),
        );
      }
    }
    return {
      from: { ...from, label: hostLabel(from.runtime) },
      to: { runtime: target.runtime, label: hostLabel(target.runtime), root: target.root },
      size,
      notMoved: NOT_MOVED,
      rebuild,
      running,
      copiesClaudeRecords: this.runnerCwdChanges(from.runtime, target.runtime),
      claudeRecords: this.claudeRecordCount(project, from, target.runtime),
      ...(!isRemoteProject({ runtime: from.runtime }) && remoteNameOf(target.runtime)
        ? {
            confinementNote:
              "別のサーバでは、AI はその人のユーザーの権限で動きます（コンテナの閉じ込めはありません）。向こうのそのユーザーが読める" +
              "ものは AI も読めます",
          }
        : {}),
      ...(returning ? { returning } : {}),
      blockers,
    };
  }

  // ── 移す ─────────────────────────────────────────────────────────────────

  /**
   * **移し始める**。確かめて started を積むところまでを待ち、写すのは裏で進める（進み具合は `status`）。断るときは
   * `RuntimeMoveError`（状態番号つき）
   */
  async start(projectId: string, target: MoveTarget): Promise<ProjectState> {
    const project = this.mustGetProject(projectId);
    if (project.move) throw new RuntimeMoveError(409, "いま別の実行場所へ移しています");
    const problem = this.targetRuntimeProblem(project, target.runtime);
    if (problem) throw new RuntimeMoveError(409, problem);
    const running = await this.running(project);
    if (running.length > 0) {
      throw new RuntimeMoveError(409, `動いているものがあるので移せません：${running.map((r) => r.label).join("／")}`, { running });
    }
    const from = this.locationOf(project);
    const begin = async (): Promise<ProjectState> => {
      // 押さえたあとでもう一度（その間に別の Project が作られた・ほかの移す先になった）
      const again = this.targetRuntimeProblem(this.mustGetProject(projectId), target.runtime);
      if (again) throw new RuntimeMoveError(409, again);
      const { to, created } = await this.prepareTarget(project, from, target);
      try {
        return await this.deps.projectThread.startRuntimeMove(projectId, { from, to, created });
      } catch (err) {
        await this.cleanupTarget(to, created).catch((e: unknown) => this.log(`[host] 移す先を片づけられませんでした: ${String(e)}`));
        throw err;
      }
    };
    const remote = remoteNameOf(target.runtime);
    const started = remote ? await this.deps.remoteRuntimes.exclusive(remote, begin) : await begin();
    this.progress.set(projectId, { phase: "preparing", copiedBytes: 0, totalBytes: 0, startedAt: new Date().toISOString() });
    this.changed(projectId);
    void this.run(projectId).catch((err: unknown) => this.log(`[host] Project ${projectId} を移す途中で投げました: ${String(err)}`));
    return started;
  }

  /** **起き直したとき**：started だけが残っている Project を片づけて failed を積み、受信箱に知らせる */
  async recoverInterrupted(): Promise<void> {
    for (const project of this.deps.projectThread.listProjects()) {
      if (!project.move) continue;
      const move = project.move;
      let cleanup = "移す先の banto が作ったものは消しました";
      try {
        await this.cleanupTarget(move.to, move.created);
      } catch (err) {
        cleanup = `移す先の banto が作ったものを消せませんでした（${err instanceof Error ? err.message : String(err)}）。` +
          `残っているかもしれないもの：${this.createdPaths(move.to, move.created).join("・")}`;
      }
      const reason = `banto が移している途中で止まりました。切り替えていません（元の場所のまま）。${cleanup}`;
      await this.deps.projectThread.failRuntimeMove(project.id, reason);
      this.log(`[host] Project ${project.id} の移し替えは途中で止まっていました: ${reason}`);
      await this.afterEnd(project.id);
      const title = `「${project.name}」を${hostLabel(move.to.runtime)}へ移せませんでした`;
      this.emit({ projectId: project.id, failed: { title, reason, from: { ...move.from, label: hostLabel(move.from.runtime) } } });
      await this.deps
        .notify({
          projectId: project.id,
          dedupeKey: `runtime-move-failed:${project.id}:${move.startedAt}`,
          title,
          detail: reason,
        })
        .catch((err: unknown) => this.log(`[host] 受信箱に出せませんでした: ${String(err)}`));
    }
  }

  private async run(projectId: string): Promise<void> {
    const project = this.mustGetProject(projectId);
    const move = project.move!;
    const progress = this.progress.get(projectId)!;
    let disabled: string[] = [];
    try {
      // 押さえたあとに始まったもの（止まっていた並びのターン等）があれば、移さない
      const hostRunning = this.deps.hostActivity(projectId);
      if (hostRunning.length > 0) throw new Error(`動いているものがあります：${hostRunning.map((r) => r.label).join("／")}`);

      // 5. 元の Service を止めておく（Module を畳む前に。止まっていても enable のままだと、元の場所の起こし直しで起きる）→ 畳む
      progress.phase = "stopping";
      this.changed(projectId);
      // 閉じている間に元の実行場所を別の Project が使い始めていたら、そこで Module を起こさない——この Project の Service の
      // Module が起きると、相手の Service の unit を自分の孤児と見なして止めて消す。この Project の Service は閉じたときに
      // 止めて自動起動から外してある（v4-security.md §1「閉じた Project は数えない」）
      if (!this.sourceTakenBy(project)) {
        this.modulesAllowed.add(projectId);
        try {
          disabled = await this.deps.disableServices(projectId);
        } finally {
          this.modulesAllowed.delete(projectId);
        }
      }
      await this.deps.releaseModules(projectId);
      if (!isRemoteProject({ runtime: move.from.runtime })) await this.deps.hostContainers.stopProjectContainer(projectId);

      // 写す
      progress.phase = "copying";
      this.changed(projectId);
      let rebuild: string[] = [];
      await this.withSide(move.from.runtime, async (src) => {
        await this.withSide(move.to.runtime, async (dst) => {
          const units = await this.copyUnits(project, src, dst, move.to.root);
          const expected: Array<{ unit: CopyUnit; files: number; bytes: number }> = [];
          for (const unit of units) {
            expected.push({ unit, ...parseMeasure((await this.mustRun(src, "大きさを測れ", measureScript(unit.from, unit), 300_000)).stdout) });
          }
          // 前に居た場所へ戻すときは差分だけ送る——量は rsync の `--dry-run` で（別のサーバどうしは host を経由して全部送る）
          const sync = move.created.syncedPrevious === true;
          const direct = !src.rsyncRemote || !dst.rsyncRemote;
          progress.totalBytes = sync && direct ? (await this.dryRun(src, dst, units)).bytes : expected.reduce((a, e) => a + e.bytes, 0);
          if (sync && !direct) progress.totalBytes *= 2;
          this.changed(projectId);
          rebuild = await this.rebuildCandidates(src, move.from.root);
          for (const unit of units) {
            progress.current = unit.what;
            const onBytes = () => {
              if (Date.now() - (this.lastChange.get(projectId) ?? 0) >= 1000) this.changed(projectId);
            };
            if (sync) await this.sync(src, dst, unit, progress, onBytes);
            else await this.copy(src, dst, unit, progress, onBytes);
          }
          // 件数と大きさで確かめる
          progress.phase = "verifying";
          this.changed(projectId);
          progress.current = undefined;
          for (const e of expected) {
            const got = parseMeasure((await this.mustRun(dst, "写したものを確かめられ", measureScript(e.unit.to, e.unit), 300_000)).stdout);
            if (got.files !== e.files || got.bytes !== e.bytes) {
              throw new Error(
                `${e.unit.what}を写した先の中身が元と合いません（元 ${e.files} 件・${e.bytes} バイト、先 ${got.files} 件・${got.bytes} バイト）`,
              );
            }
          }
          // Service に「移した」を知らせる印（Service の Module は起きたときにこれを見て、登録を全件「止めておきたい」にする）
          const marker = JSON.stringify({ from: move.from, to: move.to, at: new Date().toISOString() });
          for (const e of expected.filter((x) => x.unit.module)) {
            await this.mustRun(dst, "移した印を置け", `printf '%s\\n' ${shq(marker)} > ${shq(`${e.unit.to}/${MARKER}`)}\n`);
          }
          await this.repairWorktrees(dst, move.from.root, move.to.root);
        });
      });

      // Claude の会話の記録（作業ディレクトリが変わるときだけ。host の側）
      progress.phase = "finishing";
      this.changed(projectId);
      const records = this.copyClaudeRecords(project, move.from, move.to);

      // 切り替える
      await this.deps.projectThread.finishRuntimeMove(projectId, { from: move.from, to: move.to });
      this.deps.revokeClaudeLogin(projectId);
      progress.phase = "done";
      progress.endedAt = new Date().toISOString();
      this.emit({
        projectId,
        done: { from: { ...move.from, label: hostLabel(move.from.runtime) }, to: { ...move.to, label: hostLabel(move.to.runtime) } },
      });
      this.log(
        `[host] Project ${projectId} を ${hostLabel(move.from.runtime)}（${move.from.root}）から ${hostLabel(move.to.runtime)}（${move.to.root}）へ移しました` +
          `（${progress.copiedBytes} バイト・会話の記録 ${records.copied} 件、うち写す先の古いものを退かせた ${records.setAside} 件）`,
      );

      // 7. 各 Thread に知らせる（ターンは起こさない——次のターンの頭に積む）。起こすのは、移している間に留めていたものが
      // ある Thread だけ（知らせを積んだあとに数えると、知らせだけで起こしてしまう）
      const held = this.heldThreads(projectId);
      const text = this.movedNotice(move.from, move.to, rebuild, records.note);
      for (const t of this.deps.projectThread.listThreadsForProject(projectId)) {
        if (t.status === "closed") continue;
        await this.deps.deliver(t.id, "Project を別の実行場所へ移しました", text);
      }
      for (const id of held) this.deps.kick(id);
      await this.deps
        .notify({
          projectId,
          dedupeKey: `runtime-moved:${projectId}:${move.startedAt}`,
          title: `「${project.name}」を${hostLabel(move.to.runtime)}へ移しました`,
          detail: `root は ${move.to.root} です。元の場所（${hostLabel(move.from.runtime)}の ${move.from.root}）と Module の置き場は残してあります——要らなければ消してください`,
        })
        .catch((err: unknown) => this.log(`[host] 受信箱に出せませんでした: ${String(err)}`));
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err);
      let cleanup = "移す先の banto が作ったものは消しました";
      try {
        await this.cleanupTarget(move.to, move.created);
      } catch (cleanupErr) {
        cleanup = `移す先の banto が作ったものを消せませんでした（${cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)}）。` +
          `残っているかもしれないもの：${this.createdPaths(move.to, move.created).join("・")}`;
      }
      const servicesNote = disabled.length > 0 ? `Service（${disabled.join("・")}）は止めたままです。` : "";
      const syncNote = move.created.syncedPrevious ? `前に居た場所 ${move.to.root} は途中までそろえた形のままです。` : "";
      const reason = `${why}。切り替えていません（元の場所のまま）。${cleanup}。${syncNote}${servicesNote}`;
      progress.phase = "failed";
      progress.reason = reason;
      progress.endedAt = new Date().toISOString();
      this.log(`[host] Project ${projectId} を移せませんでした: ${reason}`);
      // 切り替えていない記録（started）のままにしない——ここで積めなければ、起き直したときに片づける
      if (this.deps.projectThread.getProject(projectId)?.move) await this.deps.projectThread.failRuntimeMove(projectId, reason);
      await this.afterEnd(projectId);
      const title = `「${project.name}」を${hostLabel(move.to.runtime)}へ移せませんでした`;
      this.emit({ projectId, failed: { title, reason, from: { ...move.from, label: hostLabel(move.from.runtime) } } });
      await this.deps
        .notify({
          projectId,
          dedupeKey: `runtime-move-failed:${projectId}:${move.startedAt}`,
          title,
          detail: reason,
        })
        .catch((e: unknown) => this.log(`[host] 受信箱に出せませんでした: ${String(e)}`));
    }
  }

  /** 届いたものを留めている、開いた Thread */
  private heldThreads(projectId: string): string[] {
    return this.deps.projectThread
      .listThreadsForProject(projectId)
      .filter((t) => t.status !== "closed" && (t.deliveries?.length ?? 0) > 0)
      .map((t) => t.id);
  }

  /** やめたら、留めていた届いたもので起こす */
  private async afterEnd(projectId: string): Promise<void> {
    for (const id of this.heldThreads(projectId)) this.deps.kick(id);
  }

  private movedNotice(from: ProjectLocation, to: ProjectLocation, rebuild: string[], recordsNote: string | undefined): string {
    return [
      `Project を${hostLabel(from.runtime)}（root：${from.root}）から${hostLabel(to.runtime)}へ移しました。root は ${to.root} になりました。` +
        `会話の記録や控えに残っている ${from.root} は、${to.root} に読み替えてください。`,
      `移っていないもの：${NOT_MOVED.join("・")}。`,
      `作り直しが要るかもしれないもの（絶対パスを持つもの）：${rebuild.length > 0 ? rebuild.join("・") : "見つかりませんでした"}。`,
      "Service は止めてあります（要るものは startService で起こしてください）。",
      ...(recordsNote ? [recordsNote] : []),
    ].join("\n");
  }

  // ── 移す先 ─────────────────────────────────────────────────────────────

  /** 移す先の実行場所として選べない理由（選べるなら undefined） */
  private targetRuntimeProblem(project: ProjectState, runtime: string): string | undefined {
    const from = project.runtime ?? HOST_CONTAINER_RUNTIME;
    if (runtime === from) return "いまと同じ実行場所です";
    if (runtime === HOST_CONTAINER_RUNTIME) return undefined;
    const name = remoteNameOf(runtime);
    if (!name) return "実行場所は host-container か remote:<名前> で渡してください";
    const r = this.deps.remoteRuntimes.get(name);
    if (!r) return `実行場所「${name}」はありません`;
    return r.unavailableReason ? `実行場所「${name}」は選べません：${r.unavailableReason}` : undefined;
  }

  /**
   * **移す先の根を作らずに確かめる**（見積もりで使う）：まだ無いか空か、前に居た場所か。前に居た場所なら `back`
   * （記録の場所）。正規化したあとの重なりもここで見る
   */
  private async checkTargetRoot(project: ProjectState, side: Side, root: string): Promise<{ problem?: string; back?: ProjectLocation }> {
    if (!side.runtime.startsWith("remote:")) {
      const problem = this.hostRootShapeProblem(root.trim());
      if (problem) return { problem };
    }
    const r = await side.run(
      [
        `p=${remotePathExpr(root.trim())}`,
        `if [ -e "$p" ] || [ -L "$p" ]; then`,
        `  [ -d "$p" ] || { echo state=notdir; exit 0; }`,
        `  if [ -z "$(ls -A -- "$p")" ]; then echo state=empty; else echo state=nonempty; fi`,
        `  printf 'root=%s\\n' "$(cd -P -- "$p" && pwd -P)"`,
        `else echo state=missing; fi`,
        "",
      ].join("\n"),
    );
    if (r.code !== 0) throw new SshCommandError(`${side.label}の移す先を確かめられませんでした`, r);
    const state = /^state=(\w+)$/m.exec(r.stdout)?.[1];
    if (state === "notdir") return { problem: `移す先 ${root} はフォルダではありません` };
    const resolved = /^root=(\/.*)$/m.exec(r.stdout)?.[1];
    if (!resolved) return {};
    const back = this.previousLocationAt(project, side.runtime, resolved);
    if (state === "nonempty" && !back) return { problem: notEmptyProblem(root) };
    const overlap = this.overlapProblem(project, side, resolved);
    if (overlap) return { problem: overlap };
    return back ? { back } : {};
  }

  /** その Project が前に居た場所のうち、実行場所と正規化した根が一致するもの */
  private previousLocationAt(project: ProjectState, runtime: string, resolvedRoot: string): ProjectLocation | undefined {
    return (project.previousLocations ?? []).find((l) => l.runtime === runtime && l.root === resolvedRoot);
  }

  /** rsync が無い側（前に居た場所へ戻すときは両側に要る）。理由と入れ方 */
  private async rsyncMissing(sides: Side[]): Promise<string[]> {
    const out: string[] = [];
    // rsync は banto 本体（この機械）でも走る——別のサーバどうしは host の一時の置き場を経由し、この機械の側は host のフォルダを
    // 直接読み書きする。host に無いと、Service を止めたあとの写す途中で ENOENT で落ちるので先に断る（#289 のレビュー）
    if (!hostHasRsync()) {
      out.push("この機械（banto 本体）に rsync がありません。前に居た場所へ戻すときは差分で写すので要ります（入れ方：sudo apt install rsync）");
    }
    for (const side of sides) {
      const r = await side.run(`command -v rsync >/dev/null 2>&1 && echo rsync=1 || echo rsync=0\n`);
      if (r.code !== 0) throw new SshCommandError(`${side.label}で rsync があるかを確かめられませんでした`, r);
      if (/^rsync=0$/m.test(r.stdout)) {
        out.push(
          `${side.label}に rsync がありません。前に居た場所へ戻すときは差分で写すので、両側に要ります（入れ方：sudo apt install rsync）`,
        );
      }
    }
    return out;
  }

  /**
   * **上書きされる・消えるファイル**：移す先のうち、前にそこから移した時刻より後に変わった・足されたファイル（除くもの——
   * Module の置き場の `s`・ホーム・ソケット——は数えない）。時刻が分からなければ全部を数える
   */
  private async overwrittenFiles(dst: Side, units: CopyUnit[], movedAt: string | undefined): Promise<OverwrittenFiles> {
    const since = movedAt ? Math.floor(Date.parse(movedAt) / 1000) : 0;
    let count = 0;
    const head: string[] = [];
    for (const unit of units) {
      const r = await this.mustRun(dst, "移したあとに変わったファイルを探せ", newerScript(unit.to, unit, since), 300_000);
      count += Number(/^n=(\d+)$/m.exec(r.stdout)?.[1] ?? "0");
      for (const line of r.stdout.split("\n")) {
        if (line.startsWith("f=") && head.length < 20) head.push(`${unit.to}/${line.slice(2)}`);
      }
    }
    return { count, head };
  }

  private hostRootShapeProblem(root: string): string | undefined {
    if (!root.startsWith("/")) return "この機械のコンテナへ移すときの根は絶対パスで書いてください";
    const home = userInfo().homedir;
    // コンテナに見せられるのはホームの下だけ（Incus の制限つきの区画——v4-security.md §1「まだ決まっていないこと」）
    if (root !== home && !root.startsWith(`${home}/`)) return `この機械のコンテナへ移すときの根は、ホーム（${home}）の下にしてください`;
    return undefined;
  }

  /**
   * **移す先を用意する**（仕様の流れ 2）。根：まだ無いか空のフォルダ、または前に居た場所だけ。banto が作り（作ったことを
   * 記録する）→ 正規化 → 元の根・banto のデータの置き場・ほかの Project の根・banto のコードの置き場と重なれば断る。
   * Module の置き場：残っていれば `.before-<日時>` に退かせる（`s` しか無ければ空と見なす）。**前に居た場所へ戻すとき**は
   * 退かせない（差分でそろえる）——rsync が両側に要り、移したあとに変わったファイルがあれば人の承知が要る
   */
  private async prepareTarget(
    project: ProjectState,
    from: ProjectLocation,
    target: MoveTarget,
  ): Promise<{ to: ProjectLocation; created: RuntimeMoveCreated }> {
    // 写す Module の置き場の名前は、移す元で引いておく
    const names = await this.withSide(from.runtime, (src) => this.moduleDirNames(project.id, src));
    return this.withSide(target.runtime, async (side) => {
      let resolved: string;
      let rootCreated: boolean;
      let nonEmpty = false;
      if (!side.runtime.startsWith("remote:")) {
        const problem = this.hostRootShapeProblem(target.root.trim());
        if (problem) throw new RuntimeMoveError(400, problem);
        const root = target.root.trim();
        if (existsSync(root) || isLink(root)) {
          if (!lstatSync(root).isDirectory()) throw new RuntimeMoveError(409, `移す先 ${root} はフォルダではありません`);
          nonEmpty = readdirSync(root).length > 0;
          rootCreated = false;
        } else {
          mkdirSync(root, { recursive: true, mode: 0o755 });
          rootCreated = true;
        }
        resolved = realpathSync(root);
      } else {
        const r = await side.run(
          [
            `p=${remotePathExpr(target.root.trim())}`,
            `case "$p" in /*) ;; *) echo '根は絶対パスか ~ で始めてください' >&2; exit 3 ;; esac`,
            `if [ -e "$p" ] || [ -L "$p" ]; then`,
            `  [ -d "$p" ] || { printf '移す先 %s はフォルダではありません\\n' "$p" >&2; exit 3; }`,
            `  [ -z "$(ls -A -- "$p")" ] || echo nonempty=1`,
            `  created=0`,
            `else`,
            `  mkdir -p -- "$p" || { printf '移す先 %s を作れませんでした\\n' "$p" >&2; exit 3; }`,
            `  created=1`,
            `fi`,
            `printf 'created=%s\\n' "$created"`,
            `printf 'root=%s\\n' "$(cd -P -- "$p" && pwd -P)"`,
            "",
          ].join("\n"),
        );
        if (r.code === 3) throw new RuntimeMoveError(409, r.stderr.trim().split("\n").pop() ?? "移す先を用意できませんでした");
        if (r.code !== 0) throw new SshCommandError(`${side.label}に移す先を用意できませんでした`, r);
        rootCreated = /^created=1$/m.test(r.stdout);
        nonEmpty = /^nonempty=1$/m.test(r.stdout);
        const root = /^root=(\/.*)$/m.exec(r.stdout)?.[1];
        if (!root) throw new Error(`${side.label}の移す先の場所を読めませんでした`);
        resolved = root;
      }
      const to: ProjectLocation = { runtime: target.runtime, root: resolved };
      // 前に居た場所（正規化した根で比べる）。空でも、前に居た場所なら差分でそろえる（Module の置き場が残っている）
      const back = rootCreated ? undefined : this.previousLocationAt(project, target.runtime, resolved);
      if (nonEmpty && !back) throw new RuntimeMoveError(409, notEmptyProblem(target.root.trim()));
      const createdRoot: RuntimeMoveCreated = { rootCreated, moduleDirs: [], movedAside: [], ...(back ? { syncedPrevious: true } : {}) };
      try {
        const overlap = this.overlapProblem(project, side, resolved);
        if (overlap) throw new RuntimeMoveError(409, overlap);
        if (back) {
          const missing = await this.withSide(from.runtime, (src) => this.rsyncMissing([src, side]));
          if (missing.length > 0) throw new RuntimeMoveError(409, missing.join("／"));
          const units = [
            { what: "Project のフォルダ", from: "", to: resolved },
            ...names.map((n) => ({ what: n, from: "", to: `${side.modulesDir}/${n}`, module: { excludeHome: /^(shell|terminal)-/.test(n) } })),
          ];
          const overwritten = await this.overwrittenFiles(side, units, back.movedAt);
          if (overwritten.count > 0 && target.acknowledgeOverwrite !== true) {
            throw new RuntimeMoveError(
              409,
              `前に居た場所 ${resolved} は、そこから移したあとに変わったファイルが ${overwritten.count} 件あります。移すと上書きされるか消えます` +
                `（承知するなら acknowledgeOverwrite: true）：${overwritten.head.slice(0, 5).join("・")}${overwritten.count > 5 ? " ほか" : ""}`,
              { code: "overwrite-not-acknowledged", overwritten },
            );
          }
        }
        // Module の置き場：残っていれば退かせる（前に居た場所へ戻すときは、残っているものへ差分でそろえる）
        const stamp = stampNow();
        const script = [
          `m=${shq(side.modulesDir)}`,
          `mkdir -p -- "$m" && chmod 700 "$m" || exit 3`,
          ...names.map((n) =>
            back
              ? `d="$m"/${shq(n)}; if [ -d "$d" ]; then echo ${shq(`${n}=keep`)}; else echo ${shq(`${n}=new`)}; fi`
              : `d="$m"/${shq(n)}; if [ -d "$d" ]; then if [ -z "$(ls -A -- "$d" | grep -vx s)" ]; then echo ${shq(`${n}=merge`)}; ` +
                `else mv -- "$d" "$d".${shq(`before-${stamp}`)} && echo ${shq(`${n}=aside`)} || exit 3; fi; else echo ${shq(`${n}=new`)}; fi`,
          ),
          "",
        ].join("\n");
        const r = await side.run(script);
        if (r.code !== 0) throw new SshCommandError(`${side.label}の Module の置き場を用意できませんでした`, r);
        for (const n of names) {
          const how = new RegExp(`^${n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}=(merge|aside|new|keep)$`, "m").exec(r.stdout)?.[1];
          const path = `${side.modulesDir}/${n}`;
          // もとから有って差分でそろえる置き場は、banto が作ったものではない（片づけで触らない）
          if (how === "keep") continue;
          if (how === "aside") createdRoot.movedAside.push({ from: path, to: `${path}.before-${stamp}` });
          createdRoot.moduleDirs.push(path);
          if (how === "merge") createdRoot.mergedModuleDirs = [...(createdRoot.mergedModuleDirs ?? []), path];
        }
        return { to, created: createdRoot };
      } catch (err) {
        await this.cleanupTarget(to, createdRoot).catch((e: unknown) => this.log(`[host] 移す先を片づけられませんでした: ${String(e)}`));
        throw err;
      }
    });
  }

  /** 移す先の根が、その側の banto の置き場・ほかの Project の根・banto のコードと重なるか */
  private overlapProblem(project: ProjectState, side: Side, root: string): string | undefined {
    // `onlyContaining`：**閉じた Project の根は、移す先がそれと同じか、それを含むときだけ断る**（決定・2026-10-14、ユーザー——
    // 閉じた Project の根の中へ移すのは通す。根そのもの・その上へは rsync --delete や写しで閉じた Project のフォルダを壊すので断る）
    const against: Array<{ path: string; what: string; onlyContaining?: boolean }> = [{ path: side.dataBase, what: "banto のデータの置き場" }];
    if (side.runtime.startsWith("remote:")) {
      // 同じ別のサーバの、ほかの Project の根（閉じた Project は、その根を含むときだけ——前に居た場所へ戻すときに、ほかの Project の根を上書きしない）
      for (const p of this.deps.projectThread.listProjects()) {
        if (p.id === project.id) continue;
        if (p.runtime === side.runtime) against.push({ path: p.root, what: `Project「${p.name}」の根`, onlyContaining: p.status === "closed" });
        if (p.move?.to.runtime === side.runtime) against.push({ path: p.move.to.root, what: `Project「${p.name}」の移す先` });
      }
    } else {
      against.push({ path: realOrSelf(this.deps.dataDir), what: "banto のデータの置き場" });
      against.push({ path: realOrSelf(this.deps.monorepoRoot), what: "banto のコードの置き場" });
      for (const p of this.deps.projectThread.listProjects()) {
        if (p.id === project.id) continue;
        if (!isRemoteProject(p)) against.push({ path: p.root, what: `Project「${p.name}」の根`, onlyContaining: p.status === "closed" });
        if (p.move && !isRemoteProject({ runtime: p.move.to.runtime })) against.push({ path: p.move.to.root, what: `Project「${p.name}」の移す先` });
      }
      if (!isRemoteProject(project)) against.push({ path: project.root, what: "元の根" });
    }
    const hit = against.find((a) => (a.onlyContaining ? pathContains(root, a.path) : pathsOverlap(root, a.path)));
    return hit ? `移す先 ${root} が${hit.what}（${hit.path}）と重なります` : undefined;
  }

  /** 移す先の banto が作ったもの（片づけで消すもの・人に見せるもの） */
  private createdPaths(to: ProjectLocation, created: RuntimeMoveCreated): string[] {
    if (created.syncedPrevious) return created.moduleDirs;
    return [created.rootCreated ? to.root : `${to.root} の中身`, ...created.moduleDirs];
  }

  /**
   * **移す先の banto が作ったものだけを消す**。退かせた置き場は戻す。元には触らない。前に居た場所へ戻すとき（差分でそろえる）は、
   * 根ともとから有った Module の置き場には触らない——途中までそろえた形のまま残る（どちらも元の写しで、元はそのまま）
   */
  private async cleanupTarget(to: ProjectLocation, created: RuntimeMoveCreated): Promise<void> {
    const safe = (p: string) => {
      if (!p.startsWith("/") || p === "/" || p.split("/").includes("..")) throw new Error(`消す場所 ${p} がおかしいので消しません`);
      return shq(p);
    };
    const merged = new Set(created.mergedModuleDirs ?? []);
    const script = [
      created.syncedPrevious
        ? ":"
        : created.rootCreated
          ? `rm -rf -- ${safe(to.root)} || exit 3`
          : `[ -d ${safe(to.root)} ] && { find ${safe(to.root)} -mindepth 1 -maxdepth 1 -exec rm -rf -- {} + || exit 3; }`,
      // `s` しか無かった置き場（写す前から有った）は `s` を残す
      ...created.moduleDirs.map((d) =>
        merged.has(d)
          ? `[ -d ${safe(d)} ] && { find ${safe(d)} -mindepth 1 -maxdepth 1 ! -name s -exec rm -rf -- {} + || exit 3; }`
          : `rm -rf -- ${safe(d)} || exit 3`,
      ),
      ...created.movedAside.map((a) => `[ -d ${safe(a.to)} ] && { mv -- ${safe(a.to)} ${safe(a.from)} || exit 3; }`),
      "exit 0",
      "",
    ].join("\n");
    await this.withSide(to.runtime, async (side) => {
      const r = await side.run(script, 300_000);
      if (r.code !== 0) throw new SshCommandError(`${side.label}の移す先を片づけられませんでした`, r);
    });
  }

  // ── 写す ─────────────────────────────────────────────────────────────────

  /** 写すもの：根と、その Project の Module の置き場（`<接続名>` が `-<Project の id>` で終わるもの） */
  private async copyUnits(project: ProjectState, src: Side, dst: Side | undefined, toRoot: string): Promise<CopyUnit[]> {
    const units: CopyUnit[] = [{ what: "Project のフォルダ", from: project.root, to: toRoot }];
    for (const n of await this.moduleDirNames(project.id, src)) {
      units.push({
        what: `Module の置き場（${n}）`,
        from: `${src.modulesDir}/${n}`,
        to: dst ? `${dst.modulesDir}/${n}` : "",
        // Shell と Terminal のホームは写さない（移った先で今どおり作り、設定を送り込む）
        module: { excludeHome: /^(shell|terminal)-/.test(n) },
      });
    }
    return units;
  }

  private async moduleDirNames(projectId: string, side: Side): Promise<string[]> {
    const r = await side.run(`ls -1A -- ${shq(side.modulesDir)} 2>/dev/null; exit 0\n`);
    if (r.code !== 0) throw new SshCommandError(`${side.label}の Module の置き場を読めませんでした`, r);
    return r.stdout
      .split("\n")
      .map((l) => l.trim())
      .filter((n) => n.endsWith(`-${projectId}`) && !n.includes("/") && !n.includes(".before-"));
  }

  /** 1つを tar で流して写す（流れは host のこの process を通る——量を数える） */
  private async copy(src: Side, dst: Side, unit: CopyUnit, progress: MoveProgress, onBytes: () => void): Promise<void> {
    const { tar } = excludesFor(unit);
    const reader = src.spawn(`cd -- ${shq(unit.from)} && exec tar --warning=no-file-ignored ${tar} -cf - .`);
    const writer = dst.spawn(`mkdir -p -- ${shq(unit.to)} && cd -- ${shq(unit.to)} && exec tar --no-same-owner -xpf -`);
    const counter = new CountingStream((n) => {
      progress.copiedBytes += n;
      onBytes();
    }, this.deps.throttleBytesPerSec);
    writer.stdin!.on("error", () => undefined);
    reader.stdout!.pipe(counter).pipe(writer.stdin!);
    const [r, w] = await Promise.all([collect(reader), collect(writer)]);
    if (r.code !== 0) throw new Error(`${unit.what}を${src.label}で読み出せませんでした（tar の終了コード ${r.code}）：${r.stderr.trim().slice(-500)}`);
    if (w.code !== 0) throw new Error(`${unit.what}を${dst.label}に書けませんでした（tar の終了コード ${w.code}）：${w.stderr.trim().slice(-500)}`);
  }

  /** rsync の共通の引数（今の場所と同じ中身にそろえる。持ち主は移す先のユーザー・リンクはリンクのまま・ソケットは写さない） */
  private rsyncBaseArgs(unit: CopyUnit): string[] {
    return ["-a", "--delete", "--no-owner", "--no-group", "--no-devices", "--no-specials", "--protect-args", ...rsyncExcludes(unit)];
  }

  /** rsync を host で起こす（片側が別のサーバなら、その側の SSH を `-e` で）。両側とも別のサーバなのは呼ぶ側が分ける */
  private spawnRsync(src: Side, from: string, dst: Side, to: string, args: string[]): ChildProcess {
    const remote = src.rsyncRemote ?? dst.rsyncRemote;
    if (src.rsyncRemote && dst.rsyncRemote) throw new Error("別のサーバどうしを rsync で直接繋がない（host を経由する）");
    const at = (side: Side, path: string) => {
      const r = side.rsyncRemote;
      return r ? `${r.host.includes(":") ? `[${r.host}]` : r.host}:${path}/` : `${path}/`;
    };
    return spawn("rsync", [...args, ...(remote ? ["-e", remote.shell] : []), "--", at(src, from), at(dst, to)], {
      stdio: ["ignore", "pipe", "pipe"],
      env: sshEnv(),
    });
  }

  /** 差分の件数と大きさ（`--dry-run`。何も変えない） */
  private async dryRun(src: Side, dst: Side, units: CopyUnit[]): Promise<{ files: number; bytes: number; deleted: number }> {
    const sum = { files: 0, bytes: 0, deleted: 0 };
    for (const unit of units) {
      const r = await collect(this.spawnRsync(src, unit.from, dst, unit.to, [...this.rsyncBaseArgs(unit), "--dry-run", "--stats"]));
      if (r.code !== 0) throw new Error(`${unit.what}の差分を測れませんでした（rsync の終了コード ${r.code}）：${r.stderr.trim().slice(-500)}`);
      const got = parseRsyncStats(r.stdout);
      sum.files += got.files;
      sum.bytes += got.bytes;
      sum.deleted += got.deleted;
    }
    return sum;
  }

  /**
   * **前に居た場所へ差分で写す**（rsync `-a --delete`）。別のサーバどうしは host の一時の置き場を経由して2回（終わったら消す）。
   * 送ったファイルの大きさを進み具合に足す
   */
  private async sync(src: Side, dst: Side, unit: CopyUnit, progress: MoveProgress, onBytes: () => void): Promise<void> {
    const args = [
      ...this.rsyncBaseArgs(unit),
      "--out-format=%i %l",
      ...(this.deps.throttleBytesPerSec ? [`--bwlimit=${Math.max(1, Math.floor(this.deps.throttleBytesPerSec / 1024))}`] : []),
    ];
    const once = async (a: Side, from: string, b: Side, to: string) => {
      const child = this.spawnRsync(a, from, b, to, args);
      let rest = "";
      child.stdout!.on("data", (c: Buffer) => {
        const lines = (rest + String(c)).split("\n");
        rest = lines.pop() ?? "";
        for (const line of lines) {
          const m = /^[<>]f\S* (\d+)$/.exec(line.trim());
          if (!m) continue;
          progress.copiedBytes += Number(m[1]);
          onBytes();
        }
      });
      const r = await collect(child);
      if (r.code !== 0) throw new Error(`${unit.what}を差分で写せませんでした（rsync の終了コード ${r.code}）：${r.stderr.trim().slice(-500)}`);
    };
    if (!src.rsyncRemote || !dst.rsyncRemote) return once(src, unit.from, dst, unit.to);
    const tmpBase = join(this.deps.dataDir, "tmp");
    mkdirSync(tmpBase, { recursive: true, mode: 0o700 });
    const tmp = mkdtempSync(join(tmpBase, "runtime-move-"));
    try {
      await once(src, unit.from, this.hostSide(), tmp);
      await once(this.hostSide(), tmp, dst, unit.to);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }

  /**
   * **`git worktree repair`**（Factory の `.worktrees/*` などは元の根の絶対パスを持つ）。根の中にある worktree だけを、
   * 新しい根のパスで名指して直す
   */
  private async repairWorktrees(dst: Side, oldRoot: string, newRoot: string): Promise<void> {
    const r = await dst.run(
      [
        `cd -- ${shq(newRoot)} || exit 3`,
        `[ -d .git ] || exit 0`,
        `command -v git >/dev/null 2>&1 || { echo 'git がありません' >&2; exit 3; }`,
        `old=${shq(oldRoot)}; new=${shq(newRoot)}`,
        `set --`,
        `for f in .git/worktrees/*/gitdir; do`,
        `  [ -f "$f" ] || continue`,
        `  p=$(cat "$f")`,
        `  case "$p" in "$old"/*) n="$new\${p#"$old"}"; d=$(dirname "$n"); [ -d "$d" ] && set -- "$@" "$d" ;; esac`,
        `done`,
        `git worktree repair "$@"`,
        "",
      ].join("\n"),
      300_000,
    );
    if (r.code !== 0) throw new SshCommandError(`${dst.label}で git worktree repair が通りませんでした`, r);
  }

  /** 絶対パスを持つもの（venv・node_modules）を、元の根の浅いところから探す（作り直しが要るかもしれないもの） */
  private async rebuildCandidates(side: Side, root: string): Promise<string[]> {
    const r = await side.run(
      `cd -- ${shq(root)} 2>/dev/null || exit 0\n` +
        `find . -maxdepth 4 \\( -name .git -o -name node_modules \\) -prune -o -name pyvenv.cfg -print 2>/dev/null | head -n 10 | sed 's/^/venv=/'\n` +
        `find . -maxdepth 3 -name .git -prune -o -type d -name node_modules -prune -print 2>/dev/null | head -n 10 | sed 's/^/node=/'\nexit 0\n`,
      120_000,
    );
    const out: string[] = [];
    for (const line of r.stdout.split("\n")) {
      const venv = /^venv=\.\/(.+)\/pyvenv\.cfg$/.exec(line)?.[1];
      if (venv) out.push(`Python の venv（${venv}）`);
      const node = /^node=\.\/(.+)$/.exec(line)?.[1];
      if (node) out.push(`node_modules（${node}）`);
    }
    return out;
  }

  // ── Claude の会話の記録 ──────────────────────────────────────────────────

  /** Runner の作業ディレクトリが変わるか（この機械のコンテナが関わるときだけ） */
  private runnerCwdChanges(from: string, to: string): boolean {
    return !isRemoteProject({ runtime: from }) || !isRemoteProject({ runtime: to });
  }

  /** 写すことになる Claude の会話の記録の件数（見積もり。写さないなら 0） */
  private claudeRecordCount(project: ProjectState, from: ProjectLocation, toRuntime: string): number {
    if (!this.runnerCwdChanges(from.runtime, toRuntime)) return 0;
    const oldName = claudeProjectDirName(this.deps.projectThread.runnerCwd({ id: project.id, root: from.root, runtime: from.runtime }));
    if (!oldName) return 0;
    const src = join(this.deps.claudeConfigDir, "projects", oldName);
    return sessionIdsOf(this.deps.projectThread.listThreadsForProject(project.id)).filter((id) => existsSync(join(src, `${id}.jsonl`))).length;
  }

  /**
   * **全 Thread の全 resume-point の `<id>.jsonl` と `<id>/` を新しい作業ディレクトリのフォルダへ写す**（元は残す。
   * フォルダ丸ごとは写さない——この機械の Project の根は人のフォルダなので、人自身の会話まで写る）。写す先に違う中身が
   * あれば退かせてから写す（`copyClaudeRecordFiles`）
   */
  private copyClaudeRecords(
    project: ProjectState,
    from: ProjectLocation,
    to: ProjectLocation,
  ): { copied: number; setAside: number; note?: string } {
    if (!this.runnerCwdChanges(from.runtime, to.runtime)) return { copied: 0, setAside: 0 };
    const oldCwd = this.deps.projectThread.runnerCwd({ id: project.id, root: from.root, runtime: from.runtime });
    const newCwd = this.deps.projectThread.runnerCwd({ id: project.id, root: to.root, runtime: to.runtime });
    const oldName = claudeProjectDirName(oldCwd);
    const newName = claudeProjectDirName(newCwd);
    if (!oldName || !newName) {
      return {
        copied: 0,
        setAside: 0,
        note: "（作業ディレクトリのパスが長いので、Claude の会話の記録は写していません。続かなければ Clear してください）",
      };
    }
    return copyClaudeRecordFiles(
      join(this.deps.claudeConfigDir, "projects", oldName),
      join(this.deps.claudeConfigDir, "projects", newName),
      sessionIdsOf(this.deps.projectThread.listThreadsForProject(project.id)),
    );
  }

  // ── 動いているもの ─────────────────────────────────────────────────────

  private async running(project: ProjectState): Promise<RunningItem[]> {
    const items = [...this.deps.hostActivity(project.id)];
    const from = project.runtime ?? HOST_CONTAINER_RUNTIME;
    // 元の実行場所を別の Project が使っている（閉じている間に来た）なら、そこで動いているものはその Project のもの——
    // この Project の Service は閉じたときに止めてある。向こうでは引かない
    if (this.sourceTakenBy(project)) return items;
    let r: SshResult | undefined;
    if (!isRemoteProject(project)) r = await this.deps.hostContainers.runInside(project.id, RUNNING_SCRIPT);
    else r = await this.withSide(from, (side) => side.run(RUNNING_SCRIPT));
    if (r && r.code !== 0) throw new SshCommandError(`${hostLabel(from)}で動いているものを確かめられませんでした`, r);
    if (r) items.push(...parseRunning(r.stdout));
    return items;
  }

  /**
   * **閉じた Project の元の実行場所を、別の Project が使っているか**（閉じたら実行場所は空く——v4-security.md §1「閉じた
   * Project は数えない」）。使っていればその Project を返す。この機械のコンテナは Project ごとなので関係しない
   */
  private sourceTakenBy(project: ProjectState): { id: string; name: string } | undefined {
    const name = remoteNameOf(project.runtime);
    if (!name || project.status !== "closed") return undefined;
    return this.deps.remoteRuntimes.get(name)?.usedBy.find((p) => p.id !== project.id);
  }

  // ── 片側 ─────────────────────────────────────────────────────────────────

  private locationOf(project: ProjectState): ProjectLocation {
    return { runtime: project.runtime ?? HOST_CONTAINER_RUNTIME, root: project.root };
  }

  private mustGetProject(projectId: string): ProjectState {
    const project = this.deps.projectThread.getProject(projectId);
    if (!project) throw new RuntimeMoveError(404, "Project がありません");
    return project;
  }

  private async mustRun(side: Side, what: string, script: string, timeoutMs?: number): Promise<SshResult> {
    const r = await side.run(script, timeoutMs);
    if (r.code !== 0) throw new SshCommandError(`${side.label}で${what}ませんでした`, r);
    return r;
  }

  /** 片側を開いて `fn` を呼ぶ（別のサーバなら、その間だけ繋ぐ） */
  private async withSide<T>(runtime: string, fn: (side: Side) => Promise<T>): Promise<T> {
    const name = remoteNameOf(runtime);
    if (!name) return fn(this.hostSide());
    return this.deps.remoteRuntimes.withConnection(name, async (r, files) => {
      const args = sshArgs(r, files, r.hostKey.type);
      const run = (script: string, timeoutMs = 120_000): Promise<SshResult> => {
        const child = spawn("ssh", [...args, "--", r.host, "sh -s"], { stdio: ["pipe", "pipe", "pipe"], env: sshEnv() });
        const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
        child.stdin.on("error", () => undefined);
        child.stdin.end(script);
        return collect(child).then((res) => {
          clearTimeout(timer);
          return res;
        });
      };
      const based = await run(
        `set -e\nb=${remotePathExpr(r.dataRoot)}/${remoteOwnerDirName(this.deps.dataDir)}\nmkdir -p "$b" && chmod 700 "$b" && cd -P -- "$b" && printf 'base=%s\\n' "$(pwd -P)"\n`,
      );
      const base = /^base=(\/.*)$/m.exec(based.stdout)?.[1];
      if (based.code !== 0 || !base) throw new SshCommandError(`別のサーバ「${name}」の置き場を読めませんでした`, based);
      return fn({
        runtime,
        label: `別のサーバ「${name}」`,
        dataBase: base,
        modulesDir: `${base}/modules`,
        run,
        spawn: (script) => spawn("ssh", [...args, "--", r.host, `sh -c ${shq(script)}`], { stdio: ["pipe", "pipe", "pipe"], env: sshEnv() }),
        rsyncRemote: { shell: ["ssh", ...args].map(rsyncShellWord).join(" "), host: r.host },
      });
    });
  }

  private hostSide(): Side {
    const dataDir = this.deps.dataDir;
    const run = (script: string, timeoutMs = 120_000): Promise<SshResult> => {
      const child = spawn("sh", ["-c", script], { stdio: ["ignore", "pipe", "pipe"] });
      const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
      return collect(child).then((res) => {
        clearTimeout(timer);
        return res;
      });
    };
    return {
      runtime: HOST_CONTAINER_RUNTIME,
      label: "この機械",
      dataBase: realOrSelf(dataDir),
      modulesDir: join(dataDir, "modules"),
      run,
      spawn: (script) => spawn("sh", ["-c", script], { stdio: ["pipe", "pipe", "pipe"] }),
    };
  }
}

function notEmptyProblem(root: string): string {
  return `移す先のフォルダ ${root} は空ではありません（まだ無いか空のフォルダか、この Project が前に居た場所を選んでください）`;
}

function isLink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

function realOrSelf(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/** banto 本体（この機械）に rsync があるか。試験で差し替えられるよう、環境変数 BANTO_RSYNC_BIN があればそれを見る */
function hostHasRsync(): boolean {
  const r = spawnSync(process.env["BANTO_RSYNC_BIN"] ?? "rsync", ["--version"], { stdio: "ignore", timeout: 10_000 });
  return !r.error && r.status === 0;
}

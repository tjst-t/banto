// **同じ機械で E2E を同時にいくつ流してもよい**（改訂・2026-10-18、ユーザー。開発 VM が 16 コア・62GB になったため）。
//
// 以前（2026-10-08）は機械全体のロック `/tmp/banto-e2e.lock` で一度に1回にしていた——incusd と CPU を取り合って、
// 隣の回のせいでコンテナの起動が遅れて落ちたため。機械が強くなったのでそれはやめ、**回どうしで本当にぶつかるものだけ**
// をここで分ける：
//
//   1. **port の枠**（`claimPortSlot`）。回ごとの port は `config.ts` が枠（4740 から 25 ずつ、8 枠）から作る。以前は
//      「pid を 8 で割った余り」で枠を選んでいたので、2つの回が同時に走ると 1/8 でぶつかった。いまは**空いている枠を
//      札で取る**——`/tmp/banto-e2e-slots/<枠>` に持ち主を書いたファイルを置けた回がその枠を使う。持ち主が居なければ
//      奪う。さらに、その枠の port を誰かが待ち受けていないかを /proc/net/tcp で確かめる（前の回の core がまだ
//      止まり切っていない・E2E と関係の無いものが居る）。8 枠とも塞がっていれば空くまで待つ
//   2. **同じ作業ツリーの回**（`acquireWorktreeLock`）。画面の組み立ての置き場 `.next-e2e` は作業ツリーに1つ
//      （`config.ts` の FRONTEND_DIST_DIR——絶対パスにも回ごとの名前にもできない理由はそこに書いた）。同じ作業ツリーで
//      2回が重なると、片方が組み立て直している間にもう片方の `next start` が読む中身が替わって壊れる。なので**同じ
//      作業ツリーの回だけは1回ずつ**（待つ）。作業ツリーが違えば（worktree・Factory・毎晩の点検）並んで走る
//
// どちらも Playwright の主プロセスが1回だけ取り、worker と webServer の子は env の印を見て何もしない。回の終わり
// （成功・失敗・Ctrl-C）で外す——主プロセスの `exit`。SIGKILL なら残るが、次の回が pid と起動時刻で見抜いて奪う。
//
// Node に flock は無いので、**中身を書き終えた一時ファイルを link(2) で置く**——link は置き場に既にあれば失敗し、
// 置けたときには中身が揃っている（O_EXCL で作ってから書くと、読んだ側が空のファイルを見る隙がある）。
import { createHash } from "node:crypto";
import { chmodSync, linkSync, mkdirSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { isAlive, sleepSync } from "./containers.ts";

/** 置き場は HOME に依らない固定の場所（人の Shell と Factory・サブエージェントは HOME が違う） */
const LOCK_DIR = "/tmp";
const SLOT_DIR = "/tmp/banto-e2e-slots";
/** port の枠の数（`config.ts` の枠の数と同じ） */
export const PORT_SLOTS = 8;
const WORKTREE_HELD_ENV = "BANTO_E2E_WORKTREE_LOCK_HELD";
/** 取った枠の番号。worker と webServer の子はこれを読む（`config.ts`） */
export const PORT_SLOT_ENV = "BANTO_E2E_PORT_SLOT";
/** 待つ上限。フル E2E 1回（約1時間）の3倍——これを超えて待つなら、前の回が止まっているのを疑う */
const MAX_WAIT_MS = 3 * 60 * 60 * 1000;
const REPORT_EVERY_MS = 30_000;
const POLL_MS = 2_000;

interface Owner {
  pid: number;
  /** /proc/<pid>/stat の起動時刻（clock tick）。pid の使い回しを見抜く */
  startTime: string | null;
  worktree: string;
  startedAt: string;
  host: string;
}

function procStartTime(pid: number): string | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    // 2つ目のコマンド名は括弧つきで空白を含みうるので、閉じ括弧の後ろから数える（22番目が starttime）
    return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19] ?? null;
  } catch {
    return null;
  }
}

function readOwner(path: string): Owner | null | "unreadable" {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    return "unreadable";
  }
  try {
    return JSON.parse(text) as Owner;
  } catch {
    return "unreadable";
  }
}

function ownerAlive(owner: Owner): boolean {
  if (!isAlive(owner.pid)) return false;
  // 読めない（他人のプロセス等）なら生きている扱い——奪いすぎるより待ちすぎるほうが安全
  const now = procStartTime(owner.pid);
  return owner.startTime === null || now === null || now === owner.startTime;
}

function describe(owner: Owner | "unreadable", path: string): string {
  return owner === "unreadable" ? `${path} が読めない` : `pid ${owner.pid}・作業ツリー ${owner.worktree}・始めた時刻 ${owner.startedAt}`;
}

/** 持ち主の死んだ札を外す。外す前に横へ退けて、退けたものが見た持ち主のままかを確かめる（別の回が奪い直した後のを消さない） */
function removeStale(path: string, stale: Owner): void {
  const aside = `${path}.stale-${process.pid}-${Date.now()}`;
  try {
    renameSync(path, aside);
  } catch {
    return; // 別の回が先に外した
  }
  const moved = (() => {
    try {
      return JSON.parse(readFileSync(aside, "utf8")) as Owner;
    } catch {
      return null;
    }
  })();
  if (moved && (moved.pid !== stale.pid || moved.startedAt !== stale.startedAt)) {
    // 退けたのは、読んでから退けるまでの間に別の回が置いた生きた札——戻す（もう誰かが置いていれば、そちらが持ち主）
    try {
      linkSync(aside, path);
    } catch {
      // 置けなかった：その間にさらに別の回が取った。どちらか一方だけが持つ形は崩れない
    }
  }
  try {
    unlinkSync(aside);
  } catch {
    // もう無い
  }
}

function me(worktree: string): Owner {
  return { pid: process.pid, startTime: procStartTime(process.pid), worktree, startedAt: new Date().toISOString(), host: hostname() };
}

type TryResult = "taken" | { busy: Owner | "unreadable" };

/** 札を1回だけ置いてみる。持ち主が居なければ外して置き直す */
function tryTake(path: string, tmp: string): TryResult {
  for (;;) {
    try {
      linkSync(tmp, path);
      return "taken";
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
        throw new Error(`[e2e] 札（${path}）を置けません：${(err as Error).message}`);
      }
    }
    const owner = readOwner(path);
    if (owner === null) continue; // 読む間に外れた——すぐ置き直す
    if (owner !== "unreadable" && !ownerAlive(owner)) {
      console.log(`[e2e] 前の E2E（${describe(owner, path)}）は居ないので、残った札 ${path} を外す`);
      removeStale(path, owner);
      continue;
    }
    return { busy: owner };
  }
}

/** 回の終わりで、自分の札だけを外す */
function releaseOnExit(path: string): void {
  process.on("exit", () => releaseIfMine(path));
}

function releaseIfMine(path: string): void {
  const owner = readOwner(path);
  if (owner && owner !== "unreadable" && owner.pid === process.pid) {
    try {
      unlinkSync(path);
    } catch {
      // もう無い
    }
  }
}

function writeTmp(tmp: string, worktree: string): void {
  writeFileSync(tmp, JSON.stringify(me(worktree)), { mode: 0o666 });
}

function removeTmp(tmp: string): void {
  try {
    unlinkSync(tmp);
  } catch {
    // もう無い
  }
}

function worktreeLockPath(worktree: string): string {
  let real = worktree;
  try {
    real = realpathSync(worktree);
  } catch {
    // 無いはずは無いが、無ければ渡された形のまま
  }
  const h = createHash("sha256").update(real).digest("hex").slice(0, 12);
  return `${LOCK_DIR}/banto-e2e-worktree-${h}.lock`;
}

/**
 * **同じ作業ツリーの E2E は1回ずつ**（待つ）。作業ツリーが違えば何もしない。主プロセスで1回だけ取り、子は印を見て
 * 何もしない。上限を超えたら理由つきで投げる（黙って並走しない）
 */
export function acquireWorktreeLock(worktree: string): void {
  if (process.env[WORKTREE_HELD_ENV]) return; // 主プロセスが取っている（worker・webServer の子）
  const path = worktreeLockPath(worktree);
  const tmp = `${path}.${process.pid}`;
  writeTmp(tmp, worktree);
  const started = Date.now();
  let lastReport = 0;
  try {
    for (;;) {
      const r = tryTake(path, tmp);
      if (r === "taken") break;
      const waited = Date.now() - started;
      if (waited > MAX_WAIT_MS) {
        throw new Error(
          `[e2e] 同じ作業ツリーの別の E2E が ${Math.round(waited / 60000)} 分たっても終わらないので止めます（${describe(r.busy, path)}）。` +
            `止まっているなら、その回を止めるか ${path} を消してください`,
        );
      }
      if (Date.now() - lastReport >= REPORT_EVERY_MS) {
        lastReport = Date.now();
        console.log(
          `[e2e] 同じ作業ツリーの別の E2E（${describe(r.busy, path)}）が終わるのを待っています（${Math.round(waited / 1000)} 秒）。` +
            `同時に流したいなら別の worktree から流してください——画面の組み立ての置き場 .next-e2e を取り合うため`,
        );
      }
      sleepSync(POLL_MS);
    }
  } finally {
    removeTmp(tmp);
  }
  if (Date.now() - started > POLL_MS) console.log(`[e2e] 作業ツリーのロックを取った（${Math.round((Date.now() - started) / 1000)} 秒待った）`);
  process.env[WORKTREE_HELD_ENV] = String(process.pid);
  releaseOnExit(path);
}

/** /proc/net/tcp と tcp6 で待ち受けている（LISTEN＝0A）port の一覧 */
export function listeningPorts(): Set<number> {
  const ports = new Set<number>();
  for (const file of ["/proc/net/tcp", "/proc/net/tcp6"]) {
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    for (const line of text.split("\n").slice(1)) {
      const cols = line.trim().split(/\s+/);
      if (cols.length < 4 || cols[3] !== "0A") continue;
      const port = Number.parseInt(cols[1]!.split(":").pop() ?? "", 16);
      if (Number.isInteger(port)) ports.add(port);
    }
  }
  return ports;
}

/**
 * **空いている port の枠を取る**。`portsOf(枠)` はその枠で回が待ち受ける port の全部（`config.ts` が渡す）。
 * 探し始めは pid で散らす（同時に始めた回が同じ枠を取り合わない）。8 枠とも塞がっていれば空くまで待つ。
 * 取った枠は回の終わりで外す
 */
export function claimPortSlot(worktree: string, portsOf: (slot: number) => number[]): number {
  try {
    mkdirSync(SLOT_DIR, { recursive: true, mode: 0o1777 });
    chmodSync(SLOT_DIR, 0o1777); // 別のユーザーの回（人の Shell・サブエージェント）も置けるように。持ち主でなければ投げる——構わない
  } catch {
    // 先に誰かが作っていれば chmod は断られる。置けるかは下で分かる
  }
  const tmp = `${SLOT_DIR}/.tmp-${process.pid}`;
  writeTmp(tmp, worktree);
  const started = Date.now();
  let lastReport = 0;
  try {
    for (;;) {
      const busy: string[] = [];
      for (let k = 0; k < PORT_SLOTS; k++) {
        const slot = (process.pid + k) % PORT_SLOTS;
        const path = `${SLOT_DIR}/${slot}`;
        const r = tryTake(path, tmp);
        if (r !== "taken") {
          busy.push(`枠 ${slot}：${describe(r.busy, path)}`);
          continue;
        }
        const listening = listeningPorts();
        const taken = portsOf(slot).filter((p) => listening.has(p));
        if (taken.length > 0) {
          // 札は取れたが、port を誰かが待ち受けている（前の回の core がまだ止まり切っていない・E2E と関係の無いもの）
          releaseIfMine(path);
          busy.push(`枠 ${slot}：port ${taken.slice(0, 3).join("・")} を待ち受けているものがある`);
          continue;
        }
        if (Date.now() - started > POLL_MS) console.log(`[e2e] port の枠 ${slot} を取った（${Math.round((Date.now() - started) / 1000)} 秒待った）`);
        releaseOnExit(path);
        return slot;
      }
      const waited = Date.now() - started;
      if (waited > MAX_WAIT_MS) {
        throw new Error(`[e2e] port の枠が ${Math.round(waited / 60000)} 分たっても空かないので止めます：\n  ${busy.join("\n  ")}`);
      }
      if (Date.now() - lastReport >= REPORT_EVERY_MS) {
        lastReport = Date.now();
        console.log(`[e2e] port の枠（${PORT_SLOTS} 個）が全部塞がっているので空くのを待っています（${Math.round(waited / 1000)} 秒）：\n  ${busy.join("\n  ")}`);
      }
      sleepSync(POLL_MS);
    }
  } finally {
    removeTmp(tmp);
  }
}

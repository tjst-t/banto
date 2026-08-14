/**
 * ホスト再起動後の職人の復帰（task-0057 / imp-0017 / inc-0018・0019）。
 *
 * **復帰させるのは「ホストが落ちたときに生きていた職人」だけ。**
 * 畳んだ職人（closed）は畳んだままにする——番頭が意図して閉じたものを、
 * 再起動のたびに起こし直すのは意図に反する。
 *
 * 状態は台帳から導かれる（pool.ts）:
 *   closed  … `worker_closed` がある。番頭かアイドル期限が畳んだ
 *   exited  … `worker_closed` が無く、プロセスが居ない
 *   running … プロセスが生きている
 *   waiting … 生きているが答え待ち
 *
 * ホストが落ちると、その配下の職人は cgroup ごと落とされる。畳んだ記録は
 * 残らないので、**再起動後に `exited` として現れるものが「生きていた職人」**。
 * これが復帰の対象。
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { WorkerPool } from "./pool.js";

/** 復帰1件の結果。呼び出し側が起動ログに出せる形で返す。 */
export interface ResumeOutcome {
  sessionId: string;
  taskId: string;
  ok: boolean;
  /** 復帰したか、なぜ見送ったか。 */
  detail: string;
}

export interface ResumeOptions {
  pool: WorkerPool;
  /** 前回の起動時刻を置く場所。再起動ループの検知に使う。 */
  stateDir: string;
  /**
   * 前回の起動からこの時間内に起き直したら、復帰を丸ごと見送る（既定60秒）。
   *
   * 復帰した職人がホスト自身を再起動すると、起こす→落ちる→また起こす、の
   * 無限ループになる（inc-0018）。**ループの周期はホストの起動間隔に出る**ので、
   * そこで断つのが確実。taskId で弾く方法は、テストの中から `system.restart` が
   * 呼ばれる経路（imp-0017 の実際の原因）を捕まえられない。
   */
  restartLoopWindowMs?: number;
  log?: (message: string) => void;
}

const DEFAULT_LOOP_WINDOW_MS = 60_000;
const LAST_START_FILE = "last-start.json";

/**
 * その職人が「自力で終わった」か。
 *
 * 終了コード0・シグナル無しは、仕事を終えて自分で抜けた形。起こし直す理由が無い。
 * ホストごと落とされた職人は、シグナル付き（SIGTERM/SIGKILL）か、
 * そもそも終了イベントが記録されない（ホストが記録する側なので）。
 */
function finishedOnItsOwn(exit: { exitCode: number | null; signal: string | null } | undefined): boolean {
  if (!exit) return false;
  return exit.signal === null && (exit.exitCode ?? 0) === 0;
}

/** ホスト自身を再起動しうるタスクは復帰させない（task-0057）。 */
function isTaskSafe(taskId: string): boolean {
  return ![/-restart$/i, /reboot$/i, /systemctl/i].some((p) => p.test(taskId));
}

/** 実在しないワークツリーでは wake がどのみち失敗するので、事前に弾く。 */
function worktreeExists(worktree: string): boolean {
  return fs.existsSync(worktree);
}

/**
 * 前回の起動時刻を読み、今回の時刻を書く。
 *
 * D3: 導出できる値は持たない——ここで持つのは「前回いつ起動したか」だけで、
 * ループ中かどうかはその差から毎回導く。
 */
function rotateLastStart(stateDir: string, now: number): number | undefined {
  const file = path.join(stateDir, LAST_START_FILE);
  let previous: number | undefined;
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf-8")) as { at?: number };
    if (typeof raw.at === "number") previous = raw.at;
  } catch {
    // 初回、または壊れている。前回不明として扱う（復帰は行う）
  }
  try {
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ at: now }) + "\n", "utf-8");
  } catch (err) {
    // 書けなくても復帰そのものは進める。ただし次回ループを検知できないので黙らせない
    console.error(`[worker-pool] 起動時刻を記録できませんでした: ${String(err)}`);
  }
  return previous;
}

/**
 * ホスト起動時に、落ちる前に生きていた職人を起こし直す。
 *
 * @returns 1件ずつの結果。見送ったものも理由つきで含める——「復帰した数」だけでは
 *          黙って落としたのか対象が無かったのか区別できない（I2）
 */
export async function resumeWorkers(options: ResumeOptions): Promise<ResumeOutcome[]> {
  const { pool, stateDir } = options;
  const log = options.log ?? ((m: string) => console.log(`[worker-pool] ${m}`));
  const windowMs = options.restartLoopWindowMs ?? DEFAULT_LOOP_WINDOW_MS;

  const now = Date.now();
  const previousStart = rotateLastStart(stateDir, now);

  // 前回の起動から間もない＝再起動ループの中にいる。ここで餌をやらない
  if (previousStart !== undefined && now - previousStart < windowMs) {
    const sec = Math.round((now - previousStart) / 1000);
    log(
      `前回の起動から ${sec} 秒しか経っていないため、職人の復帰を丸ごと見送ります` +
        `（再起動ループの疑い。inc-0018）`
    );
    return [];
  }

  // 落ちる前に生きていた職人 = 畳んだ記録が無く、いまプロセスが居ないもの
  const candidates = pool
    .list({ includeClosed: true })
    .filter((w) => w.state === "exited");

  log(`落ちる前に生きていた職人: ${candidates.length} 件`);

  const results: ResumeOutcome[] = [];
  for (const worker of candidates) {
    const base = { sessionId: worker.sessionId, taskId: worker.taskId };

    if (finishedOnItsOwn(worker.exit)) {
      results.push({ ...base, ok: true, detail: "見送り: 自力で終わっている" });
      continue;
    }
    if (!isTaskSafe(worker.taskId)) {
      results.push({ ...base, ok: true, detail: "見送り: ホストを再起動しうるタスク" });
      continue;
    }
    if (!worktreeExists(worker.worktree)) {
      results.push({ ...base, ok: true, detail: "見送り: ワークツリーが存在しない" });
      continue;
    }

    try {
      await pool.wake(worker.sessionId, `再開します (task: ${worker.taskId})`);
      results.push({ ...base, ok: true, detail: "復帰" });
    } catch (err) {
      // I2: 1人の失敗で残りを止めない。ただし失敗として残す
      results.push({ ...base, ok: false, detail: `失敗: ${String(err)}` });
    }
  }

  for (const r of results) {
    log(`${r.detail}（task: ${r.taskId}, session: ${r.sessionId}）`);
  }
  return results;
}

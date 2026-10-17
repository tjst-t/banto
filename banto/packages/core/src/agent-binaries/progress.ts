// **取ってくる・送る間の進み具合**（アーキ仕様 §4.1「待つ間」）。進んでいれば5秒ごと、止まっていても15秒ごとに知らせる
// ——呼び元の Module が中継の上限（60秒）で切られないように。**120秒のあいだ1バイトも進まなければやめる**。
// 同時に頼まれたものは1本だけ走らせ、待っている呼び元みんなに同じ進み具合を流す

export type ProgressListener = (message: string) => void;

export interface ProgressTiming {
  /** 進み具合を見る間隔 */
  tickMs: number;
  /** 進んでいるときに知らせる間隔 */
  movingMs: number;
  /** 止まっているときに知らせる間隔 */
  stalledMs: number;
  /** これだけ1バイトも進まなければやめる */
  giveUpMs: number;
}

export const DEFAULT_PROGRESS_TIMING: ProgressTiming = { tickMs: 1_000, movingMs: 5_000, stalledMs: 15_000, giveUpMs: 120_000 };

/** MB（整数。人に出す大きさ） */
export function mb(bytes: number): string {
  return String(Math.round(bytes / 1e6));
}

/**
 * 進み具合を間引いて知らせ、進まなければ `giveUp` を呼んで見張りをやめる。始めたときに1回知らせる。止めるのは `stop`
 */
export function watchProgress(opts: {
  timing: ProgressTiming;
  bytes: () => number;
  describe: (bytes: number) => string;
  report: ProgressListener;
  giveUp: (stalledSeconds: number) => void;
}): { stop(): void } {
  const { timing } = opts;
  let lastBytes = opts.bytes();
  let movedAt = performance.now();
  let reportedAt = performance.now();
  let bytesAtReport = lastBytes;
  opts.report(opts.describe(lastBytes));
  const timer = setInterval(() => {
    const now = performance.now();
    const b = opts.bytes();
    if (b !== lastBytes) {
      lastBytes = b;
      movedAt = now;
    }
    const stalled = now - movedAt;
    if (stalled >= timing.giveUpMs) {
      clearInterval(timer);
      opts.giveUp(Math.round(stalled / 1000));
      return;
    }
    const since = now - reportedAt;
    if (b !== bytesAtReport && since >= timing.movingMs) {
      opts.report(opts.describe(b));
    } else if (since >= timing.stalledMs) {
      opts.report(b === bytesAtReport ? `${opts.describe(b)}——進んでいません（${Math.round(stalled / 1000)}秒）` : opts.describe(b));
    } else return;
    reportedAt = now;
    bytesAtReport = b;
  }, timing.tickMs);
  timer.unref();
  return { stop: () => clearInterval(timer) };
}

/**
 * **同じ鍵の仕事は1本だけ**走らせ、あとから来た呼び元はそれを待つ（single-flight、`modules/single-flight.ts` と同じ形）。
 * 違うのは、待っている呼び元**みんなに進み具合を流す**こと——待つ側も中継の上限で切られないように。あとから来た
 * 呼び元には、最後に流れた文をすぐ渡す
 */
export class SharedProgressTasks<T> {
  private readonly tasks = new Map<string, { promise: Promise<T>; listeners: Set<ProgressListener>; last?: string }>();

  run(key: string, work: (emit: ProgressListener) => Promise<T>, onProgress?: ProgressListener): Promise<T> {
    let task = this.tasks.get(key);
    if (task) {
      if (onProgress && task.last !== undefined) onProgress(task.last);
    } else {
      const listeners = new Set<ProgressListener>();
      const entry: { promise: Promise<T>; listeners: Set<ProgressListener>; last?: string } = { promise: undefined as never, listeners };
      const emit: ProgressListener = (message) => {
        entry.last = message;
        for (const l of listeners) l(message);
      };
      // 最初の呼び元は始める前に聞き手に入れる（始めた直後の1回目を取りこぼさない）
      if (onProgress) listeners.add(onProgress);
      // work() は同期的に呼ぶ——ここに await を挟むと、同時の2本目が同じ判定を通る
      entry.promise = work(emit).finally(() => this.tasks.delete(key));
      this.tasks.set(key, entry);
      task = entry;
    }
    if (!onProgress) return task.promise;
    const listeners = task.listeners;
    listeners.add(onProgress);
    return task.promise.finally(() => listeners.delete(onProgress));
  }
}

// **人がターンを止める口**（決定・2026-10-01、ユーザー要望。v4-frontend.md §6.31）。
//
// 以前は画面の停止ボタンが「この画面が読むのをやめる」だけで、host のターンは最後まで走り続けていた
// （しかも画面は次のイベントが届くまで止まらなかった）。ここは、Thread ごとに「いま走っている・順番を
// 待っているターン」を覚え、止めてと言われたら合図を立て、そのターンが片づくまで待って結果を返す。
//
// 合図を受けて CLI を止め、発言を取り消すかを決めるのは `turn-runner.ts`（`settleStoppedTurn`）。

import type { WithdrawnMessage } from "./turn-runner.js";

/** 止めた結果。`stopped: false` はそのとき止めるターンが無かった（もう終わっていた） */
export interface StopOutcome {
  stopped: boolean;
  /** AI がまだ何も出していなかったので、発言ごと取り消した——画面はこれを入力欄へ戻す */
  withdrawn?: WithdrawnMessage;
}

interface Entry {
  threadId: string;
  /** 画面が付けた、そのターンの名前（あれば）。順番待ちのターンを取り違えずに止めるため */
  turnId?: string;
  controller: AbortController;
  /** 順番の鍵を取って走り始めたか */
  running: boolean;
  outcome: StopOutcome;
  done: Promise<void>;
  finish(): void;
}

/** 止めてから、そのターンが片づくのを待つ上限。越えたら「止めた」とだけ答える */
const STOP_WAIT_MS = 15_000;

export interface TurnStopHandle {
  readonly signal: AbortSignal;
  /** 順番の鍵を取って走り始めた */
  markRunning(): void;
  /** そのターンが「止めた」で終わった（取り消したなら中身も） */
  markStopped(withdrawn?: WithdrawnMessage): void;
  /** どう終わっても呼ぶ */
  finish(): void;
}

export class TurnStops {
  private readonly entries = new Set<Entry>();

  /** ターンを1本覚える（順番を待つ前に呼ぶ）。終わったら `finish()` */
  open(threadId: string, turnId?: string): TurnStopHandle {
    let resolveDone!: () => void;
    const entry: Entry = {
      threadId,
      ...(turnId ? { turnId } : {}),
      controller: new AbortController(),
      running: false,
      outcome: { stopped: false },
      done: new Promise<void>((resolve) => (resolveDone = resolve)),
      finish: () => {
        this.entries.delete(entry);
        resolveDone();
      },
    };
    this.entries.add(entry);
    return {
      signal: entry.controller.signal,
      markRunning: () => {
        entry.running = true;
      },
      markStopped: (withdrawn) => {
        entry.outcome = { stopped: true, ...(withdrawn ? { withdrawn } : {}) };
      },
      finish: entry.finish,
    };
  }

  /**
   * **止める**。`turnId` があればそのターン（順番待ちでもよい）、無ければその Thread でいま走っているターン。
   * そのターンが片づくまで待って結果を返す
   */
  async stop(threadId: string, turnId?: string): Promise<StopOutcome> {
    const candidates = [...this.entries].filter((e) => e.threadId === threadId);
    const entry = turnId
      ? candidates.find((e) => e.turnId === turnId)
      : (candidates.find((e) => e.running) ?? (candidates.length === 1 ? candidates[0] : undefined));
    if (!entry) return { stopped: false };
    entry.controller.abort();
    const settled = await Promise.race([
      entry.done.then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), STOP_WAIT_MS)),
    ]);
    if (!settled) {
      console.warn(`[host] ${threadId} のターンを止めましたが、${STOP_WAIT_MS / 1000} 秒たっても片づきません`);
      return { stopped: true };
    }
    return entry.outcome;
  }
}

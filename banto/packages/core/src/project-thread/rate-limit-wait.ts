// **上限の待ち**（追加・2026-10-18、v4-security.md §2「Claude のアカウントを複数持つ」の 9.）。
//
// Claude の使用量の上限で終わったターン（`turn.ended` の `reason: "rate_limit"`）を、リセットのあと人を待たずに続ける。
// 待ちは Event Store から導く——別の台帳は持たない（規則3）。**待ちが生きている**＝その Thread の最後のターンが上限で
// 終わって続ける時刻を持ち、その後に `turn.started`（最後のターンが替わる）・`turn.continuation_cancelled`・Clear・閉じが無い。
// 起こし直しても fold が同じ待ちを作り直す。

import type { ThreadState } from "./types.js";

/** 生きている上限の待ち1件 */
export interface RateLimitWait {
  /** 上限で終わったターン（続けるターン） */
  turnId: string;
  /** 自動で続ける時刻（ISO） */
  continueAt: string;
  /**
   * そのターンまでに上限で続けて続けた回数（上限で止まったターンの続きなら `attempt`、それ以外は 0）。次に続けるターンは
   * これ＋1 回目
   */
  continued: number;
  /** 続きの届いたものに付ける、そのターンの会話の始まり（続きの続きなら最初のターンの始まり） */
  fromSeq: number;
  /** そのターンのホップ（人が送ったターンは 0、届いたもので起こしたなら積んだものの最大）。続きも同じホップで起こす */
  hop: number;
}

/** **その Thread の生きている上限の待ち**。無ければ undefined */
export function rateLimitWaitOf(
  thread: (Pick<ThreadState, "lastTurn" | "messages"> & Partial<Pick<ThreadState, "status">>) | undefined,
): RateLimitWait | undefined {
  const turn = thread?.lastTurn;
  const continueAt = turn?.rateLimit?.continueAt;
  if (!thread || !turn || continueAt === undefined) return undefined;
  if (turn.continuationCancelled !== undefined || turn.abandonedBy !== undefined || thread.status === "closed") return undefined;
  return { turnId: turn.turnId, continueAt, ...continuationOf(thread) };
}

/**
 * **最後のターンの続きに付けるもの**：続けた回数・会話の始まり・ホップ（`rateLimitWaitOf` と、待たずに受信箱で聞くときの
 * 続きの両方が使う）
 */
export function continuationOf(
  thread: Pick<ThreadState, "lastTurn" | "messages">,
): Pick<RateLimitWait, "continued" | "fromSeq" | "hop"> {
  const turn = thread.lastTurn!;
  const stacked = thread.messages.filter((m) => m.role === "user" && m.seq > turn.startedSeq);
  return {
    continued: rateLimitContinuedOf(turn),
    fromSeq: turn.continuesFromSeq ?? turn.startedSeq,
    hop: turn.cause === "human" ? 0 : Math.max(0, ...stacked.map((m) => m.origin?.hop ?? 0)),
  };
}

/** そのターンまでに上限で続けた回数（上限で止まったターンの続きの `attempt`。ほかは 0） */
export function rateLimitContinuedOf(turn: Pick<NonNullable<ThreadState["lastTurn"]>, "continuesReason" | "attempt">): number {
  return turn.continuesReason === "rate_limit" ? turn.attempt : 0;
}

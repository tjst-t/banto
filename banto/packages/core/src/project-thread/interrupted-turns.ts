// **起こし直しで切れたターンを見分ける**（追加・2026-10-05、アーキ仕様 §2.5「起こし直しをまたいで続ける」の
// 「1. Thread のターンを続ける」）。ここは見分けるだけ——続ける処理は別に置く。

import type { ThreadId, ThreadState, TurnCause, TurnRecord } from "./types.js";

/**
 * 切れたターン1件。続けるのに要るもの。
 *
 * **Fork の最初のターン**かは、その Thread の `ownsSession === false` から分かる（まだ自分の会話を持っていない——
 * 続けるときも resume-point から分けて始める）。ここには写さない
 */
export interface InterruptedTurn {
  threadId: ThreadId;
  turnId: string;
  /** そのターンの `turn.started` の seq。このターンで積んだ発言は、これより後ろの seq を持つ */
  startedSeq: number;
  /**
   * **このターンで会話に積んだ発言の数**（人の発言・届いたもの。`startedSeq` より後ろの user の発言）。
   * **0 なら続けない**——発言を積む前に切れた。AI にはまだ何も渡っておらず、届いたものは待ち行列に残っているので
   * 起動したときに `resumeAll` が起こす（人の発言は HTTP の要求の中にしか無かったので、どちらにしても残っていない）
   */
  stackedMessages: number;
  startedAt: string;
  cause: TurnCause;
  /** 切れたターンが何回目の続きだったか（ふつうのターンは0） */
  attempt: number;
  /**
   * 続ける会話の id。`system/init` で分かったもの、無ければ host が先に決めて渡したもの（新しい会話・Fork の最初の
   * ターン）。どちらも無いのは、続いている会話が `system/init` の前に切れたとき（resume-point の会話のまま）。
   * **Fork の最初のターンが会話を書く前に切れたら、この id では続けられない**——CLI は中身の無い記録を残すので、
   * 同じ id で分け直すと「already in use」、resume すると「No conversation found」になる（実測 F1、経緯ノート）
   */
  sessionId?: string;
  /** 始めたときに渡した resume-point と巻き戻しの位置（`resumeSessionAt`）。続けるときも同じものを保つ（実測 M1） */
  resumePoint?: string;
  rewindTo?: string;
  /**
   * そのターンのホップ（追加・2026-10-05）。人が送ったターンは 0（届いたものも一緒に積んでいても）、届いたもので
   * 起こしたターンは積んだ届いたもののホップの最大（`ThreadTurns` が鍵に持つ値と同じ）。続きのターンも同じホップで起こす
   */
  hop: number;
  /**
   * 切れたターンの会話が記録のどこから始まったか（追加・2026-10-05）。ふつうは `startedSeq`、続きのターンがまた
   * 切れたなら最初に切れたターンの始まり（`TurnRecord.continuesFromSeq`）
   */
  fromSeq: number;
  /**
   * 切れたターンが続きを引き継いだターンなら、その続きが続けていたターン（`TurnRecord.continuesTurnId`）。続きを
   * 積む前に切れたとき、待ち行列に残った続きを見つけるのに使う
   */
  continuesTurnId?: string;
}

/**
 * **そのターンは切れたものか**——`turn.started` があって：
 *  - `turn.ended` が無い
 *  - 始めたより後に resume-point の更新が無い（書いたあとに落ちたターンは、CLI の側では終わっている）
 *  - 始めたより後に Clear・Thread を閉じた・Project を閉じた、が無い（人がやめたものは続けない）
 *
 * 切れたなら理由は無し（`undefined`）、切れていなければその理由。見分けと、切れた印を足す口（`noteInterruptedTurn`）で
 * 同じ条件を使う
 */
export function notInterruptedReason(turn: TurnRecord): string | undefined {
  if (turn.outcome !== undefined) return `終わりが書かれている（${turn.outcome}）`;
  if (turn.resumePointUpdated) return "resume-point が書かれている（CLI の側では終わっている）";
  if (turn.abandonedBy !== undefined) return `人がやめた（${turn.abandonedBy}）`;
  return undefined;
}

/** **最後のターンが切れたまま（`notInterruptedReason` が無い）の Thread**を返す */
export function findInterruptedTurns(threads: Iterable<ThreadState>): InterruptedTurn[] {
  const found: InterruptedTurn[] = [];
  for (const thread of threads) {
    const turn = thread.lastTurn;
    if (!turn || notInterruptedReason(turn) !== undefined) continue;
    found.push(lastTurnOf(thread, turn));
  }
  return found;
}

/**
 * **最後のターンを、続けるのに要る形で**（`InterruptedTurn`）。切れたかは見ない（見るのは `findInterruptedTurns`）
 */
function lastTurnOf(thread: ThreadState, turn: TurnRecord): InterruptedTurn {
  const sessionId = turn.knownSessionId ?? turn.assignedSessionId;
  const stacked = thread.messages.filter((m) => m.role === "user" && m.seq > turn.startedSeq);
  return {
    threadId: thread.id,
    turnId: turn.turnId,
    startedSeq: turn.startedSeq,
    stackedMessages: stacked.length,
    startedAt: turn.startedAt,
    cause: turn.cause,
    attempt: turn.attempt,
    ...(sessionId !== undefined ? { sessionId } : {}),
    ...(turn.resumePoint !== undefined ? { resumePoint: turn.resumePoint } : {}),
    ...(turn.rewindTo !== undefined ? { rewindTo: turn.rewindTo } : {}),
    hop: turn.cause === "human" ? 0 : Math.max(0, ...stacked.map((m) => m.origin?.hop ?? 0)),
    fromSeq: turn.continuesFromSeq ?? turn.startedSeq,
    ...(turn.continuesTurnId !== undefined ? { continuesTurnId: turn.continuesTurnId } : {}),
  };
}

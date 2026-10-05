// **起こし直しで切れたターンを見分ける**（追加・2026-10-05、アーキ仕様 §2.5「起こし直しをまたいで続ける」の
// 「1. Thread のターンを続ける」）。ここは見分けるだけ——続ける処理は別に置く。

import type { ThreadId, ThreadState, TurnCause } from "./types.js";

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
}

/**
 * **最後のターンが始まったまま終わっていない Thread**を返す。切れたと見るのは、`turn.started` があって——
 *  - `turn.ended` が無い
 *  - 始めたより後に resume-point の更新が無い（書いたあとに落ちたターンは、CLI の側では終わっている）
 *  - 始めたより後に Clear・Thread を閉じた・Project を閉じた、が無い（人がやめたものは続けない）
 */
export function findInterruptedTurns(threads: Iterable<ThreadState>): InterruptedTurn[] {
  const found: InterruptedTurn[] = [];
  for (const thread of threads) {
    const turn = thread.lastTurn;
    if (!turn || turn.outcome !== undefined || turn.resumePointUpdated || turn.abandonedBy !== undefined) continue;
    const sessionId = turn.knownSessionId ?? turn.assignedSessionId;
    found.push({
      threadId: thread.id,
      turnId: turn.turnId,
      startedSeq: turn.startedSeq,
      stackedMessages: thread.messages.filter((m) => m.role === "user" && m.seq > turn.startedSeq).length,
      startedAt: turn.startedAt,
      cause: turn.cause,
      attempt: turn.attempt,
      ...(sessionId !== undefined ? { sessionId } : {}),
      ...(turn.resumePoint !== undefined ? { resumePoint: turn.resumePoint } : {}),
      ...(turn.rewindTo !== undefined ? { rewindTo: turn.rewindTo } : {}),
    });
  }
  return found;
}

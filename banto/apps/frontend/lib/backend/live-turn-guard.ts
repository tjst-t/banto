// **走行中のターンに、もう1本ぶら下げない**（`frontend-interaction-hardening`、
// 2026-09-10）。
//
// 実 Thread の1ターンは host との SSE 1本で、このブラウザはそれを
// `run()` から読み進める。assistant-ui は同じ `run()` を**2つの理由で**呼ぶ：
//
//  1. **再開**——判断待ちに答えた後（`addResult`）。同じターンの続きを読む
//  2. **新しい発言**——人が composer から送った
//
// 見分けを「最後の発言の文面」で付けていたが、**同じ文面をもう一度送ると
// 1 と区別できない**——新しい発言が「再開」として扱われ、走行中のイテレータを
// 2つの run が食い合い、送ったプロンプトは host に届かないまま消えていた
// （`docs/notes/2026-09-06-tool-approval-review.md` §2）。
//
// 文面ではなく**発言の数**と**いま誰かが読んでいるか**で見分ける。

export type RunDecision =
  /** 走行中のターンが無い——host に新しいターンを起こす */
  | "start"
  /** 同じターンの続きを読む（判断待ちに答えた後の呼び直し） */
  | "resume"
  /** 走行中なので受け取れない——黙って落とさず、その旨を出す（規則2） */
  | "refuse";

export interface LiveTurnState {
  /** そのターンを起こした時点での、人の発言の数 */
  userMessageCount: number;
  /** いま `run()` がこのターンのイテレータを読んでいるか */
  consuming: boolean;
}

export function decideRun(
  live: LiveTurnState | undefined,
  userMessageCount: number,
): RunDecision {
  if (!live) return "start";
  // 2つの run が同じ1本を食い合う（片方にしかイベントが届かない）
  if (live.consuming) return "refuse";
  // 走行中に人の発言が積まれた＝新しい送信。**文面が同じでも新しい送信**
  if (userMessageCount > live.userMessageCount) return "refuse";
  return "resume";
}

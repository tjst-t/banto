// **自動化の回の受信箱**（追加・2026-10-15、アーキ仕様 §4.3「受信箱」）。
//
// - 自動化の回のターンも、ほかと同じくレビュー待ちの決まり（`reviewDueAfterTurn`）に乗る。そのうえで「受信箱に出さない」を
//   選んだ自動化は、完了した回を出さない。判断待ち・決めること・失敗・途中で切れた回は選択に依らず出す
// - どの回のターンかは Thread の記録から読む（最後の人の発言と自動化の届けもののうち新しいほう）——自動化の層が結末を
//   書く順番に頼らない
// - 同じ Thread で前の未確認を残すか置き換えるかは `InboxStore.raiseAutomationReview`
import type { Automation, AutomationRun } from "../automation/fold.js";
import type { ThreadState } from "../project-thread/types.js";
import { reviewTurnOf } from "./review-turn.js";
import type { ReviewAttention, ReviewAutomation, ReviewItem } from "./types.js";

/**
 * **このターンが自動化の回のものか**。最後の人の発言と自動化の届けもののうち、新しいほうが自動化の届けものならその回
 * ——同じ回の続きのターン（裏の仕事の結果が届いて起きた）も、その回に数える。人がその後で送っていれば人のターン
 */
export function automationRunOfLastTurn(thread: Pick<ThreadState, "messages">): { id: string; runId: string } | undefined {
  for (let i = thread.messages.length - 1; i >= 0; i--) {
    const m = thread.messages[i]!;
    if (m.role !== "user") continue;
    if (!m.origin) return undefined;
    if (m.origin.automation) return m.origin.automation;
  }
  return undefined;
}

/**
 * **ターンが始まったとき、その Thread のレビュー待ちを「見た」にするか**。人が送ったターン（ホップ 0）は人がそこにいる
 * ので「見た」にする。自動化の届けもので起きるターンもホップ 0 だが人はいない——前の回のカードを消さない
 */
export function acknowledgesReviewsOnStart(thread: Pick<ThreadState, "deliveries"> | undefined, hop: number): boolean {
  if (hop !== 0) return false;
  return !thread?.deliveries?.some((d) => d.automation);
}

/** 人が見ないといけない回か。失敗（止めた・切れたも）・判断待ち・決めることの順に見る */
export function reviewAttentionOf(
  thread: Pick<ThreadState, "lastTurn" | "messages">,
  hasLiveJudgment: boolean,
): ReviewAttention | undefined {
  const turn = reviewTurnOf(thread, { running: false });
  if (turn.outcome !== undefined && turn.outcome !== "completed") return "failed";
  if (hasLiveJudgment) return "waiting";
  const decisions = turn.summary?.decisions;
  if (Array.isArray(decisions) && decisions.length > 0) return "decisions";
  return undefined;
}

export type AutomationReviewPlan =
  /** 自動化の回ではない——ふつうのレビュー待ち */
  | { kind: "plain" }
  /** 「受信箱に出さない」自動化の、何も無く完了した回 */
  | { kind: "skip" }
  | { kind: "automation"; automation: Omit<ReviewAutomation, "raisedSeq"> };

/**
 * **ターンが終わってレビュー待ちを出すと決まったあと**（`reviewDueAfterTurn`）、自動化の回としてどう出すか。自動化が
 * 消えていれば「出す」の側に倒す（既定は出す）
 */
export function planAutomationReview(
  thread: Pick<ThreadState, "lastTurn" | "messages">,
  deps: { automation(id: string): Pick<Automation, "reviewOnDone" | "runs"> | undefined; hasLiveJudgment: boolean },
): AutomationReviewPlan {
  const run = automationRunOfLastTurn(thread);
  const turn = thread.lastTurn;
  if (!run || !turn) return { kind: "plain" };
  const automation = deps.automation(run.id);
  const attention = reviewAttentionOf(thread, deps.hasLiveJudgment);
  if (automation && !automation.reviewOnDone && !attention) return { kind: "skip" };
  const outcome = reviewTurnOf(thread, { running: false }).outcome;
  return {
    kind: "automation",
    automation: {
      id: run.id,
      runId: run.runId,
      ...(attention ? { attention } : {}),
      startedSeq: turn.startedSeq,
      ...(outcome ? { outcome } : {}),
      since: automation?.runs.find((r) => r.runId === run.runId)?.at ?? turn.startedAt,
    },
  };
}

/** 終わった回（飛ばした・断った・走っている回は数えない） */
const FINISHED: ReadonlySet<AutomationRun["result"]> = new Set(["done", "failed", "waiting"]);

/**
 * **この会話の、まだ見ていない回の数**（カードの「この会話には、まだ見ていない回が n 回あります」）。カードの数え始め
 * 以降にこの Thread で終わった回。台帳に残る直近の回（`AUTOMATION_RUNS_KEPT`）の中で数える
 */
export function unseenRunsOf(review: Pick<ReviewItem, "threadId" | "automation">, automation: Pick<Automation, "runs"> | undefined): number | undefined {
  if (!review.automation || !automation) return undefined;
  const since = review.automation.since;
  return automation.runs.filter((r) => r.threadId === review.threadId && FINISHED.has(r.result) && r.at >= since).length;
}

// docs/specs/v4-architecture.md §4.3「判断は届ける口の手前に置く」——**前の回が終わっていない**かを見る。
// 届け先の Thread で、ターンが走っている・届いたものが残っている・裏の仕事の返事待ちがある・生きた判断待ちがある、のどれか。

import type { ThreadState } from "../project-thread/types.js";
import type { JudgmentItem } from "../inbox/types.js";

export interface BusyProbe {
  isRunning(threadId: string): boolean;
  listJudgmentsForThread(threadId: string): JudgmentItem[];
}

/** 終わっていなければ、その理由（人が読める文）。届け先がまだ無い（専用の Fork を立てる前）なら終わっている */
export function previousRunUnfinished(thread: ThreadState | undefined, probe: BusyProbe): string | undefined {
  if (!thread) return undefined;
  if (probe.isRunning(thread.id)) return "前の回のターンがまだ走っています";
  if ((thread.deliveries ?? []).length > 0) return "届け先にまだ会話に積んでいない届けものがあります";
  if ((thread.awaitingReplies ?? []).length > 0) return "前の回が裏の仕事の返事を待っています";
  if (probe.listJudgmentsForThread(thread.id).some((j) => j.liveness === "live")) {
    return "前の回が人の判断を待っています";
  }
  return undefined;
}


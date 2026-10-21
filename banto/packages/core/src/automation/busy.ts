// docs/specs/v4-architecture.md §4.3「判断は届ける口の手前に置く」——**前の回が終わっていない**かを見る。
// 届け先の Thread で、ターンが走っている・届いたものが残っている・裏の仕事の返事待ちがある・生きた判断待ちがある、のどれか。
// 番頭の Fork は、Factory の返事待ちと、回に一緒に積む Module の知らせを見ない（下）。

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
  // **番頭の Fork**（アーキ仕様 §4.5、Backlog #509）：回は毎回まっさらで、前の回が流した Factory の返事待ち（札）と、その知らせ（回で
  // 一緒に積む——`supervisorHoldReason`）は前の回が終わっていないことにしない。見ると、Factory が走っている間は番頭の回が1つも起きない
  const supervisor = thread.restriction === "supervisor";
  if ((thread.deliveries ?? []).some((d) => !supervisor || d.automation || d.continues)) return "届け先にまだ会話に積んでいない届けものがあります";
  if (!supervisor && (thread.awaitingReplies ?? []).length > 0) return "前の回が裏の仕事の返事を待っています";
  if (probe.listJudgmentsForThread(thread.id).some((j) => j.liveness === "live")) {
    return "前の回が人の判断を待っています";
  }
  return undefined;
}


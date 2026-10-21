// **番頭が止まった会話を進める**（決定・2026-10-21、ユーザー。アーキ仕様 §4.5「番頭の tool」「守り」）。
//
// - `list_stalled_threads`（読むだけ）：その Project の止まっている会話を理由ごとに。返すのは id・題・理由・最後のまとめだけ
//   （会話の中身は読ませない、§4.2）
// - `instruct_thread`：決まった手順を頼んで起こす。**送る文は host が行い（`action`）から組む**——番頭の自由な文は `note`（500字）だけで、
//   データとして別の囲みに入れる。外から来たものを届けられた回は `note` を付けられない
// - 断る：任せていない行い・`minor-design`（選ぶための種類で、頼む行いではない）・人に回す種類・答えていない決めることがある会話
//   （受信箱のカード）・Project の外・閉じた会話・番頭自身や自動化の専用の Fork・任務が止まった会話（枠を延ばすのは人）・連鎖の上限・
//   回数（同じ会話の同じ止まった理由に 2 回、会話ごとに1日 5 回）
// - 回数は番頭の記録（`automation.supervisor_acted` の `instructed`）から数える——数えを別に持たない（規則3）
// - 届けた指示が始まる前に人が発言した・宛先のターンが決めることを人に聞いて終わった、なら捨てて記録に残す（`screen`）

import { randomUUID } from "node:crypto";
import type { ProjectThreadStore } from "../project-thread/store.js";
import type { MessageEntry, PendingDelivery, ThreadState } from "../project-thread/types.js";
import { DELIVERY_LIMITS, type ThreadDeliveries } from "../delivery/thread-deliveries.js";
import type { ThreadTurns } from "../delivery/thread-turns.js";
import type { InboxStore } from "../inbox/store.js";
import type { ReviewItem, ReviewJudge } from "../inbox/types.js";
import { automationRunOfLastTurn } from "../inbox/automation-review.js";
import type { Automation, SupervisorAct } from "../automation/fold.js";
import type { AutomationStore } from "../automation/store.js";
import { decisionsOf, movedOnReason, readExternalOf, summaryMessageOfLastTurn } from "../automation/turn-decisions.js";
import {
  ACTION_TITLES,
  HUMAN_ONLY_KINDS,
  isDecisionKind,
  supervisorMayAnswer,
  type SupervisorAction,
  type SupervisorPolicy,
} from "./policy.js";
import { INSTRUCT_THREAD_TOOL_NAME, LIST_STALLED_THREADS_TOOL_NAME, supervisorActsOf } from "./supervisors.js";

export { INSTRUCT_THREAD_TOOL_NAME, LIST_STALLED_THREADS_TOOL_NAME };

/** `note` の長さの上限 */
export const INSTRUCT_NOTE_MAX_CHARS = 500;

/** host が数える指示の上限（アーキ仕様 §4.5「ホップ」） */
export const INSTRUCT_LIMITS = {
  /** 同じ会話・同じ止まった理由への指示（宛先に新しいまとめが出たら数え直す） */
  sameReason: 2,
  /** 会話ごとの1日の指示（`supervisor.timeZone` の日付で数える） */
  perThreadPerDay: 5,
} as const;

/** 頼める行い（`minor-design` は選択肢を選ぶための種類で、頼む行いではない） */
export type InstructAction = Exclude<SupervisorAction, "minor-design">;

/** **行いごとの決まった頼みの文**（送る文は host が組む——番頭の自由な文で手順を広げさせない） */
export const ACTION_REQUESTS: Readonly<Record<InstructAction, string>> = {
  continue: "前のターンのまとめの残り（確かめていないこと・次に頼めること）を、今の仕様の範囲で進めてください。",
  "retry-turn": "前のターンは失敗したか途中で切れました。同じ頼みをやり直してください（終わっていた部分は確かめてから続けてください）。",
  "rerun-tests": "試験を流し直し、結果を確かめてください。",
  "fix-tests":
    "落ちた試験を直してください。試験を消す・弱める・仕様を変える直しはしないでください——それが要るなら、まとめの決めることで人に聞いてください。",
  merge: "作業ブランチを、この Project の決まり（Memory）どおりに main に取り込んでください。",
  push: "この Project 自身のリポジトリへ push してください。公開のリポジトリ・ほかの Project のリポジトリへは push しないでください。",
  release: "この Project の決まり（Memory）どおりの載せ方と試験で、release に反映してください。",
  backlog: "Backlog の状態を、実際の進み具合に合わせて更新してください。",
};

/**
 * **止まった理由**（`list_stalled_threads`）。`failed-turn`＝失敗した・途中で切れたターンで終わった／`mission-stopped`＝任務が止まった・
 * 枠を使い切った（人に回すもの）／`decision-missed`＝番頭が答えられる種類の決めることで人を待っているが、番頭の回に出来事が届いて
 * いない（番頭は答えられない——人が答えるか次の出来事を待つ）／`idle`＝最後のまとめから `supervisor.idleHours` 動きが無く、
 * 確かめていないこと・次に頼めることが残っている
 */
export type StalledReason = "failed-turn" | "mission-stopped" | "decision-missed" | "idle";

const STALLED_HINTS: Readonly<Record<StalledReason, string>> = {
  "failed-turn": "失敗した・途中で切れたターンで終わっています。retry-turn で頼めます",
  "mission-stopped": "任務が止まった・枠を使い切りました。枠を延ばす・止めるのは人なので、番頭は頼めません（人に回すもの）",
  "decision-missed":
    "番頭が答えられる種類の決めることで人を待っていますが、この回に出来事が届いていないので answer_decision では答えられず、instruct_thread も断られます。何もせず、人が答えるか次の出来事を待ってください",
  idle: "最後のまとめから動きが無く、確かめていないこと・次に頼めることが残っています。continue か、まとめに合う行いで頼めます",
};

/** `list_stalled_threads` が返す1件。会話の中身は返さない */
export interface StalledThread {
  threadId: string;
  title: string;
  reason: StalledReason;
  hint: string;
  /** 最後のまとめ（あれば） */
  summary?: {
    request?: string;
    headline?: string;
    decisions: Array<{ question: string; kind?: string; options: string[] }>;
    notVerified: string[];
  };
}

/** 番頭の回（呼んだ会話）の手がかり */
interface SupervisorTurn {
  supervisorId: string;
  projectId: string;
  /** その回を届けた番頭の自動化 */
  automation: Pick<Automation, "id" | "name">;
  runId: string;
  /** その回の届けものに外から来たもの（出来事の本文・別の会話からのメッセージ）がある */
  readExternal: boolean;
}

export interface InstructInput {
  threadId: string;
  action: string;
  note?: string;
  reason: string;
}

export interface SupervisorInstructionsDeps {
  projectThread: ProjectThreadStore;
  automations: Pick<AutomationStore, "get" | "list" | "listAll" | "recordSupervisorAct">;
  deliveries: Pick<ThreadDeliveries, "deliver">;
  turns: Pick<ThreadTurns, "isRunning" | "queued">;
  inbox: Pick<InboxStore, "listOpen" | "judgeReviews">;
  /** その Project の方針（回のたびに引く） */
  policy(projectId: string): SupervisorPolicy;
  /** 方針にタイムゾーンが無いときの既定。無ければ banto が動いている場所のもの */
  defaultTimeZone?: string;
  now?: () => Date;
  log?: (message: string) => void;
}

type Reply = { ok: boolean; text: string };

export class SupervisorInstructions {
  constructor(private readonly deps: SupervisorInstructionsDeps) {}

  /** **`list_stalled_threads` の本体**。`callerThreadId` は呼んだ会話（番頭の会話） */
  listStalled(callerThreadId: string): Reply {
    const turn = this.supervisorTurn(callerThreadId);
    if (!turn) return { ok: false, text: "番頭の回ではないので使えません。" };
    const policy = this.deps.policy(turn.projectId);
    const acts = supervisorActsOf(this.deps.automations, turn.supervisorId, Number.POSITIVE_INFINITY);
    const stalled: StalledThread[] = [];
    for (const thread of this.deps.projectThread.listThreadsForProject(turn.projectId)) {
      if (this.targetProblem(thread, turn, callerThreadId)) continue;
      const reason = this.stalledReasonOf(thread, policy, acts);
      if (reason) stalled.push(stalledView(thread, reason));
    }
    if (stalled.length === 0) return { ok: true, text: "止まっている会話はありません。" };
    return { ok: true, text: JSON.stringify(stalled, null, 2) };
  }

  /** **`instruct_thread` の本体**。断ったら理由を返し、番頭の記録に `refused` を残す */
  async instruct(callerThreadId: string, input: InstructInput): Promise<Reply> {
    const turn = this.supervisorTurn(callerThreadId);
    if (!turn) return { ok: false, text: "番頭の回ではないので使えません。" };
    const refuse = async (why: string, extra: Partial<SupervisorAct> = {}): Promise<Reply> => {
      await this.record(turn, {
        kind: "refused",
        threadId: input.threadId,
        reason: why,
        ...(isDecisionKind(input.action) ? { action: input.action } : {}),
        ...extra,
      });
      return { ok: false, text: `頼めません：${why}（何も届けていません）。` };
    };
    const reason = input.reason.trim();
    if (reason === "") return refuse("理由（reason）が空です");

    // **行い**：その Project で任せる行いだけ。人に回す種類・選ぶための種類は頼めない
    const policy = this.deps.policy(turn.projectId);
    const action = input.action;
    if (!isDecisionKind(action)) return refuse(`知らない行い「${action}」です`);
    if ((HUMAN_ONLY_KINDS as readonly string[]).includes(action)) return refuse(`${ACTION_TITLES[action]}は人が決めます。人に回してください`);
    if (action === "minor-design") return refuse("minor-design は決めることの選択肢を選ぶための種類で、頼む行いではありません");
    if (!policy.delegate.includes(action as SupervisorAction)) return refuse(`この Project では「${ACTION_TITLES[action]}」を任されていません。人に回してください`);
    const act = action as InstructAction;

    // **note**：500字まで。外から来たものを届けられた回は付けられない（外の文を指示の側へ運ばせない）
    const note = input.note?.trim() ?? "";
    if (note.length > INSTRUCT_NOTE_MAX_CHARS) return refuse(`note は ${INSTRUCT_NOTE_MAX_CHARS} 字までです（${note.length} 字）`);
    if (note !== "" && turn.readExternal) {
      return refuse("この回には外から来たもの（出来事の本文・別の会話のメッセージ）が届いているので、note は付けられません。note を外して頼んでください");
    }

    // **宛先**：その Project の、ふつうの開いている会話だけ
    const target = this.deps.projectThread.getThread(input.threadId);
    const problem = this.targetProblem(target, turn, callerThreadId);
    if (problem || !target) return refuse(problem ?? "その会話が見つかりません");
    // 数えの鍵にする止まった理由は、宛先が動いている（前の指示が積まれている・走っている）ことに依らずに見る
    const stalled = this.stalledReasonOf(target, policy, supervisorActsOf(this.deps.automations, turn.supervisorId, Number.POSITIVE_INFINITY), {
      ignoreBusy: true,
    });
    if (stalled === "mission-stopped") return refuse("任務が止まった・枠を使い切った会話です。枠を延ばす・止めるのは人なので、人に回してください");
    // **答えていない決めることがある会話には送れない**（問いの種類の断りを instruct でくぐらせない）
    if (this.hasOpenDecisions(target)) {
      return refuse("その会話には、まだ答えていない決めることがあります。決めることは answer_decision（届いた出来事）か人が答えます");
    }
    // **ホップ**：宛先の最後のターン＋2（番頭の回が出来事で＋1、指示で＋1）。上限を超えるなら自動では起こさない——届けずに断る
    const hop = lastTurnHop(target) + 2;
    if (hop > DELIVERY_LIMITS.maxHop) {
      return refuse(`連鎖の上限（${DELIVERY_LIMITS.maxHop}）を超えるので、自動では起こせません。人に回してください`);
    }

    // **回数**（番頭の記録から数える）。同じ止まった理由の数えは、宛先に新しいまとめが出たら数え直す
    const key = stalled ?? act;
    const summarySeq = latestSummarySeq(target);
    const now = this.now();
    const instructed = supervisorActsOf(this.deps.automations, turn.supervisorId, Number.POSITIVE_INFINITY).filter(
      (a) => a.kind === "instructed" && a.threadId === target.id,
    );
    const same = instructed.filter((a) => a.stalledReason === key && (a.summarySeq ?? 0) === summarySeq).length;
    if (same >= INSTRUCT_LIMITS.sameReason) {
      return refuse(`この会話の同じ止まった理由（${key}）には、もう ${same} 回頼みました。動かないので人に回してください`, { stalledReason: key });
    }
    const today = dayKey(now, this.timeZone(policy));
    const todays = instructed.filter((a) => dayKey(new Date(a.at), this.timeZone(policy)) === today).length;
    if (todays >= INSTRUCT_LIMITS.perThreadPerDay) {
      return refuse(`この会話には今日もう ${todays} 回頼みました（1日 ${INSTRUCT_LIMITS.perThreadPerDay} 回まで）。人に回してください`, { stalledReason: key });
    }

    const actionId = randomUUID();
    let wake: Awaited<ReturnType<ThreadDeliveries["deliver"]>>;
    try {
      wake = await this.deps.deliveries.deliver({
        threadId: target.id,
        from: "banto",
        title: `番頭の指示：${ACTION_TITLES[act]}`,
        text: [`番頭が、この会話に次の手順を頼みました（行い ${act}：${ACTION_TITLES[act]}）。`, ACTION_REQUESTS[act]].join("\n"),
        hop,
        kind: "supervisor",
        supervisor: {
          supervisorId: turn.supervisorId,
          runId: turn.runId,
          automationId: turn.automation.id,
          actionId,
          ...(note !== "" ? { note } : {}),
        },
      });
    } catch (err) {
      return refuse(`届けられませんでした：${err instanceof Error ? err.message : String(err)}`);
    }
    const at = now.toISOString();
    await this.record(turn, {
      kind: "instructed",
      threadId: target.id,
      ...(target.lastTurn ? { turnId: target.lastTurn.turnId } : {}),
      action: act,
      hasNote: note !== "",
      actionId,
      stalledReason: key,
      summarySeq,
      reason,
    });
    // **受信箱**：開いているカードに「番頭が頼んだ」を添える。無ければ、指示で起きたターンの終わりのカードに出る（`judgeOfLastTurn`）
    const judge = instructedJudge(turn.automation, { action: act, hasNote: note !== "", actionId, reason, at });
    try {
      await this.deps.inbox.judgeReviews(target.id, judge);
    } catch (err) {
      this.log(`[host] 番頭の指示を ${target.id} のカードに添えられませんでした: ${err instanceof Error ? err.message : String(err)}`);
    }
    const when =
      wake.wake === "now"
        ? "その会話のターンが始まりました。"
        : wake.wake === "later"
          ? "その会話はいまターンが走っているので、終わってから始まります（始まる前に人が発言したら、この指示は捨てます）。"
          : `ただし、いまは自動では起こせませんでした（${wake.reason}）。人が次に発言したら、この指示は捨てます。`;
    return { ok: true, text: `頼みました（${ACTION_TITLES[act]}）。${when}結果はその会話のまとめと受信箱に出ます。` };
  }

  /**
   * **ターンを始める直前に、届いた番頭の指示を見直す**（turn-runner が届けものを積む前）。捨てたものを除いた届けものを返す。
   * 捨てるのは：人の発言で始まるターン（人を優先する）／宛先のターンが、指示を受けたあとに決めることを人に聞いて終わった
   * （答えていない決めることがある会話には頼めない——走っている間に積んだ指示がくぐらないように）
   */
  async screen(threadId: string, delivered: readonly PendingDelivery[], humanMessage: boolean): Promise<PendingDelivery[]> {
    const instructions = delivered.filter((d) => d.supervisor);
    if (instructions.length === 0) return [...delivered];
    const thread = this.deps.projectThread.getThread(threadId);
    const summary = thread ? summaryMessageOfLastTurn(thread) : undefined;
    const decided = summary?.turnSummary && decisionsOf(summary.turnSummary.summary).length > 0 ? summary.turnSummary.at : undefined;
    const drops: Array<{ d: PendingDelivery; reason: string }> = [];
    for (const d of instructions) {
      if (humanMessage) drops.push({ d, reason: "始まる前に人が発言しました（人を優先します）" });
      else if (decided !== undefined && decided >= d.receivedAt) {
        drops.push({ d, reason: "始まる前に、その会話のターンが決めることを人に聞いて終わりました" });
      }
    }
    if (drops.length === 0) return [...delivered];
    for (const reason of new Set(drops.map((x) => x.reason))) {
      await this.deps.projectThread.dropDeliveries(
        threadId,
        drops.filter((x) => x.reason === reason).map((x) => x.d.deliveryId),
        reason,
      );
    }
    for (const { d, reason } of drops) {
      const origin = d.supervisor!;
      const automation = this.deps.automations.get(origin.automationId);
      const instructed = automation?.supervisorActs?.find((a) => a.kind === "instructed" && a.actionId === origin.actionId);
      await this.recordTo(origin.automationId, {
        kind: "dropped",
        threadId,
        actionId: origin.actionId,
        ...(instructed?.action ? { action: instructed.action } : {}),
        reason,
      });
    }
    const dropped = new Set(drops.map((x) => x.d.deliveryId));
    return delivered.filter((d) => !dropped.has(d.deliveryId));
  }

  /**
   * **番頭の指示で起きたターンの決め**（受信箱のカードの `carriedJudge`、アーキ仕様 §4.5「記録」）。最後のターンに積んだ番頭の指示から、
   * 番頭の記録を引いて組む。指示で起きたターンでなければ undefined
   */
  judgeOfLastTurn(threadId: string): ReviewJudge | undefined {
    const thread = this.deps.projectThread.getThread(threadId);
    const startedSeq = thread?.lastTurn?.startedSeq;
    if (!thread || startedSeq === undefined) return undefined;
    const origin = [...thread.messages].reverse().find((m) => m.seq > startedSeq && m.origin?.supervisor)?.origin?.supervisor;
    if (!origin) return undefined;
    const automation = this.deps.automations.get(origin.automationId);
    const act = automation?.supervisorActs?.find((a) => a.kind === "instructed" && a.actionId === origin.actionId);
    if (!automation || !act?.action || !isDecisionKind(act.action) || act.action === "minor-design") return undefined;
    return instructedJudge(automation, { action: act.action as InstructAction, hasNote: act.hasNote === true, actionId: origin.actionId, reason: act.reason, at: act.at });
  }

  // ---- 内側 ---------------------------------------------------------------------------------------------------

  /** 呼んだ会話が番頭の回なら、その手がかり。番頭の印・届けた自動化が番頭のもの・届け先がこの会話、を全部見る */
  private supervisorTurn(callerThreadId: string): SupervisorTurn | undefined {
    const thread = this.deps.projectThread.getThread(callerThreadId);
    if (!thread || thread.restriction !== "supervisor") return undefined;
    const run = automationRunOfLastTurn(thread);
    const automation = run ? this.deps.automations.get(run.id) : undefined;
    if (!run || !automation || automation.mode !== "supervisor" || !automation.supervisorId) return undefined;
    if (automation.target.kind !== "dedicated" || automation.target.threadId !== thread.id) return undefined;
    return {
      supervisorId: automation.supervisorId,
      projectId: automation.projectId,
      automation: { id: automation.id, name: automation.name },
      runId: run.runId,
      readExternal: readExternalOf(thread),
    };
  }

  /** 宛先にできない理由（できるなら undefined）。一覧からも同じ決まりで外す */
  private targetProblem(thread: ThreadState | undefined, turn: SupervisorTurn, callerThreadId: string): string | undefined {
    if (!thread) return "その会話が見つかりません";
    if (thread.projectId !== turn.projectId) return "番頭は自分の Project の会話にだけ頼めます";
    if (thread.status !== "active") return "閉じた会話には頼めません";
    if (this.deps.projectThread.getProject(thread.projectId)?.status === "closed") return "閉じた Project の会話には頼めません";
    if (thread.id === callerThreadId) return "番頭自身の会話には頼めません";
    if (thread.restriction) return "見回り・番頭の会話には頼めません";
    const dedicated = this.deps.automations
      .list(thread.projectId)
      .some((a) => a.target.kind === "dedicated" && a.target.threadId === thread.id);
    if (dedicated) return "自動化・見回り・判断役・番頭の専用の Fork には頼めません";
    return undefined;
  }

  /**
   * 止まっている理由（止まっていない・外すものなら undefined）。`ignoreBusy` は、動いている（走っている・積む前の届けもの・裏の仕事）
   * ことを見ない——頼むときの数えの鍵に使う（前に頼んだ指示が積まれていても、同じ理由に数える）
   */
  private stalledReasonOf(
    thread: ThreadState,
    policy: SupervisorPolicy,
    acts: readonly SupervisorAct[],
    opts: { ignoreBusy?: boolean } = {},
  ): StalledReason | undefined {
    const turn = thread.lastTurn;
    if (!turn) return undefined;
    // 動いている・待っている（裏の仕事・積む前の届けもの）
    if (!opts.ignoreBusy) {
      if (this.deps.turns.isRunning(thread.id) || this.deps.turns.queued(thread.id) > 0) return undefined;
      if ((thread.deliveries?.length ?? 0) > 0 || (thread.awaitingReplies?.length ?? 0) > 0) return undefined;
    }
    const open = this.openReviewsOf(thread.id);
    // **外す**：番頭か判断役が人に回した・揃わず人に回った・種類で断られた会話（人が見るか発言するまで）
    if (open.some((r) => r.judge?.kind === "deferred" || r.judge?.kind === "incomplete")) return undefined;
    if (open.length > 0 && acts.some((a) => a.kind === "refused" && a.threadId === thread.id && a.turnId === turn.turnId && a.question !== undefined)) {
      return undefined;
    }
    // 外から来たものを読んだターンで止まった会話は、番頭が進めない（外の文に操られない）
    if (readExternalOf(thread)) return undefined;
    const m = thread.mission;
    if (m && (m.status === "stalled" || m.status === "exhausted") && !humanSpokeAfter(thread, m.finishedSeq ?? 0)) return "mission-stopped";
    // 使用量の上限で終わったターンは、自動で続けるか人に聞いている
    if (turn.rateLimit) return undefined;
    const outcome = turn.outcome ?? "interrupted";
    if (outcome === "failed" || outcome === "interrupted") return "failed-turn";
    // 人が止めたターンは進めない
    if (outcome !== "completed") return undefined;
    const summaryMessage = summaryMessageOfLastTurn(thread);
    const summary = summaryMessage?.turnSummary;
    if (!summaryMessage || !summary) return undefined;
    const decisions = decisionsOf(summary.summary);
    if (decisions.length > 0) {
      if (movedOnReason(thread, turn.turnId, this.deps.turns)) return undefined;
      if (open.some((r) => r.judge?.kind === "decided-by-automation")) return undefined;
      return decisions.every((d) => supervisorMayAnswer(d.kind, policy).ok) ? "decision-missed" : undefined;
    }
    if (this.now().getTime() - Date.parse(summary.at) < policy.idleHours * 60 * 60 * 1000) return undefined;
    const outcomeRecord = isRecord(summary.summary.outcome) ? summary.summary.outcome : undefined;
    const rest = strings(outcomeRecord?.notVerified).length + (Array.isArray(summary.summary.nextSuggestions) ? summary.summary.nextSuggestions.length : 0);
    return rest > 0 ? "idle" : undefined;
  }

  /**
   * その会話に、まだ答えていない決めることがあるか。受信箱の開いているカード（判断役・番頭が選んで届けたものは片づいている）と、
   * 最後のターンのまとめの決めること（人がカードを「見た」だけで答えていない——先へ進んでいなければ答えていない）
   */
  private hasOpenDecisions(thread: ThreadState): boolean {
    const turn = thread.lastTurn;
    if (
      turn?.outcome === "completed" &&
      decisionsOf(summaryMessageOfLastTurn(thread)?.turnSummary?.summary).length > 0 &&
      movedOnReason(thread, turn.turnId, this.deps.turns) === undefined
    ) {
      return true;
    }
    return this.openReviewsOf(thread.id).some((card) => {
      if (card.judge?.kind === "decided-by-automation") return false;
      const summary = card.automation
        ? [...thread.messages].reverse().find((m) => m.turnSummary && m.seq > card.automation!.startedSeq && m.seq < card.automation!.raisedSeq)
        : summaryMessageOfLastTurn(thread);
      return decisionsOf(summary?.turnSummary?.summary).length > 0;
    });
  }

  private openReviewsOf(threadId: string): ReviewItem[] {
    return this.deps.inbox.listOpen().filter((i): i is ReviewItem => i.kind === "review" && i.threadId === threadId);
  }

  private async record(turn: SupervisorTurn, act: Omit<SupervisorAct, "at">): Promise<void> {
    await this.recordTo(turn.automation.id, act);
  }

  /** 番頭の記録に書く。書けなくても止めない——書き残す */
  private async recordTo(automationId: string, act: Omit<SupervisorAct, "at">): Promise<void> {
    try {
      await this.deps.automations.recordSupervisorAct(automationId, { at: this.now().toISOString(), ...act });
    } catch (err) {
      this.log(`[host] 番頭の記録を書けませんでした（${act.kind}）: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private timeZone(policy: Pick<SupervisorPolicy, "timeZone">): string {
    return policy.timeZone ?? this.deps.defaultTimeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  }

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  private log(message: string): void {
    (this.deps.log ?? console.warn)(message);
  }
}

function instructedJudge(
  automation: Pick<Automation, "id" | "name">,
  input: { action: InstructAction; hasNote: boolean; actionId: string; reason: string; at: string },
): ReviewJudge {
  return {
    kind: "instructed",
    automation: { id: automation.id, name: automation.name },
    reason: input.reason,
    instruction: { action: input.action, title: ACTION_TITLES[input.action], hasNote: input.hasNote, actionId: input.actionId },
    at: input.at,
  };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function strings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

function stalledView(thread: ThreadState, reason: StalledReason): StalledThread {
  const summary = summaryMessageOfLastTurn(thread)?.turnSummary?.summary;
  const outcome = isRecord(summary?.outcome) ? summary.outcome : undefined;
  return {
    threadId: thread.id,
    title: thread.title ?? (thread.kind === "base" ? "Base Thread" : "Fork Thread"),
    reason,
    hint: STALLED_HINTS[reason],
    ...(summary
      ? {
          summary: {
            ...(typeof summary.request === "string" ? { request: summary.request } : {}),
            ...(typeof outcome?.headline === "string" ? { headline: outcome.headline } : {}),
            decisions: decisionsOf(summary).map((d) => ({ question: d.question, ...(d.kind ? { kind: d.kind } : {}), options: d.options.map((o) => o.label) })),
            notVerified: strings(outcome?.notVerified),
          },
        }
      : {}),
  };
}

/** 最後のターンのホップ（人が送ったターンは 0、届いたもので起きたターンは積んだ届けものの最大） */
export function lastTurnHop(thread: Pick<ThreadState, "lastTurn" | "messages">): number {
  const turn = thread.lastTurn;
  if (!turn || turn.cause === "human") return 0;
  return thread.messages.reduce((max, m) => (m.seq > turn.startedSeq && m.role === "user" && m.origin ? Math.max(max, m.origin.hop) : max), 0);
}

/** 会話の最後のまとめの位置（無ければ 0） */
function latestSummarySeq(thread: Pick<ThreadState, "messages">): number {
  return [...thread.messages].reverse().find((m: MessageEntry) => m.turnSummary)?.seq ?? 0;
}

/** その位置より後に人が発言したか（機械から届いたものは数えない） */
function humanSpokeAfter(thread: Pick<ThreadState, "messages">, seq: number): boolean {
  return thread.messages.some((m) => m.role === "user" && !m.origin && m.seq > seq);
}

/** そのタイムゾーンの日付（YYYY-MM-DD）。読めないタイムゾーンは UTC で数える（数えを止めない——任せすぎない側でもない） */
function dayKey(date: Date, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
  } catch {
    return date.toISOString().slice(0, 10);
  }
}

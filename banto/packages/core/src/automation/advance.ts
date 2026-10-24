// **止まった会話を進める自動化**（決定・2026-10-24、ユーザー。アーキ仕様 §4.3「判断役の一般化——番頭から引き継ぐ機能」の 2.・4.）。
//
// 番頭の `instruct_thread`・`list_stalled_threads`（`supervisor/instruct.ts`）を、自動化の台帳の `canAdvanceProject` を軸に一般化したもの。
// 番頭の実コードを消すまでは並存する——番頭の会話（`restriction: "supervisor"`）は今までどおり番頭の実装が受け、ここは受けない。
//
// - **使える会話**：`canAdvanceProject` を持つ自動化の専用の Fork だけ（判断役かどうか・きっかけの種類とは独立）。読むだけの回・番頭の回は除く
// - **任された行い**：その Fork を届け先にしている進める自動化に `delegateKinds` があればその和、無ければ Project の方針（`supervisor.delegate`
//   の全体＋Project の差分）。`release` は方針の既定では任されない
// - 送る文は host が行いから組む。自由な文は `note`（500字）だけで、外から来たものを届けられた回は付けられない
// - 断るもの・回数（同じ止まった理由に 2 回・会話ごとに1日 5 回）・全体の上限（全部の進める自動化で1時間に `instructionsPerHour`）は番頭と同じ。
//   数えは進める自動化の記録（`automation.advance_acted`）から——数えを別に持たない（規則3）
// - 届けた指示が始まる前に人が発言した・宛先のターンが決めることを人に聞いて終わった、なら捨てて記録に残す（`screen`）

import { randomUUID } from "node:crypto";
import type { ProjectThreadStore } from "../project-thread/store.js";
import type { MessageEntry, PendingDelivery, ThreadState } from "../project-thread/types.js";
import { DELIVERY_LIMITS, type ThreadDeliveries } from "../delivery/thread-deliveries.js";
import type { ThreadTurns } from "../delivery/thread-turns.js";
import type { InboxStore } from "../inbox/store.js";
import type { ReviewItem, ReviewJudge } from "../inbox/types.js";
import { automationRunOfLastTurn } from "../inbox/automation-review.js";
import {
  ACTION_TITLES,
  HUMAN_ONLY_KINDS,
  isDecisionKind,
  isSupervisorAction,
  supervisorMayAnswer,
  type SupervisorAction,
  type SupervisorPolicy,
} from "../supervisor/policy.js";
import type { AdvanceAct, Automation } from "./fold.js";
import type { AutomationStore } from "./store.js";
import { decisionsOf, movedOnReason, readExternalOf, summaryMessageOfLastTurn } from "./turn-decisions.js";

/** tool の名前は番頭のものと同じ（名前は変えない） */
export const INSTRUCT_THREAD_TOOL_NAME = "instruct_thread";
export const LIST_STALLED_THREADS_TOOL_NAME = "list_stalled_threads";

/** `note` の長さの上限 */
export const ADVANCE_NOTE_MAX_CHARS = 500;

/** host が数える指示の上限（番頭と同じ） */
export const ADVANCE_INSTRUCT_LIMITS = {
  /** 同じ会話・同じ止まった理由への指示（宛先に新しいまとめが出たら数え直す） */
  sameReason: 2,
  /** 会話ごとの1日の指示 */
  perThreadPerDay: 5,
} as const;

/** 頼める行い（`minor-design` は選択肢を選ぶための種類で、頼む行いではない） */
export type AdvanceAction = Exclude<SupervisorAction, "minor-design">;

/** **行いごとの決まった頼みの文**（送る文は host が組む——自動化の自由な文で手順を広げさせない） */
export const ADVANCE_ACTION_REQUESTS: Readonly<Record<AdvanceAction, string>> = {
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

/** 止まった理由（番頭の `list_stalled_threads` と同じ分け方） */
export type AdvanceStalledReason = "failed-turn" | "mission-stopped" | "decision-missed" | "idle";

const STALLED_HINTS: Readonly<Record<AdvanceStalledReason, string>> = {
  "failed-turn": "失敗した・途中で切れたターンで終わっています。retry-turn で頼めます",
  "mission-stopped": "任務が止まった・枠を使い切りました。枠を延ばす・止めるのは人なので、頼めません（人に回すもの）",
  "decision-missed":
    "任された種類の決めることで人を待っていますが、この回に出来事が届いていないので answer_decision では答えられず、instruct_thread も断られます。何もせず、人が答えるか判断役に出来事が届くのを待ってください",
  idle: "最後のまとめから動きが無く、確かめていないこと・次に頼めることが残っています。continue か、まとめに合う行いで頼めます",
};

/** `list_stalled_threads` が返す1件。会話の中身は返さない */
export interface AdvanceStalledThread {
  threadId: string;
  title: string;
  reason: AdvanceStalledReason;
  hint: string;
  summary?: {
    request?: string;
    headline?: string;
    decisions: Array<{ question: string; kind?: string; options: string[] }>;
    notVerified: string[];
  };
}

/** 進める自動化が使う方針（番頭の方針と同じ形の一部。上限の鍵は `automation.advance.*`） */
export type AdvancePolicy = Pick<SupervisorPolicy, "delegate" | "idleHours" | "timeZone" | "limits">;

/** 進める自動化の回（呼んだ会話）の手がかり */
export interface AdvanceTurn {
  projectId: string;
  /** 記録を書く自動化（その回を届けた進める自動化。人が打ったターンなら、その Fork を専用にしている進める自動化） */
  automation: Pick<Automation, "id" | "name">;
  /** その回の id（人が打ったターンなら無い） */
  runId?: string;
  /** その回の届けものに外から来たもの（出来事の本文・別の会話のメッセージ・Module の返事）がある */
  readExternal: boolean;
  /** 任された行い（`delegateKinds` があればその和、無ければ Project の方針） */
  delegate: SupervisorAction[];
}

/** **その会話を専用の Fork にしている、進める自動化**（`canAdvanceProject`。番頭の自動化・見回りは除く）。無ければ空 */
export function advanceAutomationsOfThread(
  automations: Pick<AutomationStore, "list">,
  thread: Pick<ThreadState, "id" | "projectId">,
): Automation[] {
  return automations
    .list(thread.projectId)
    .filter(
      (a) =>
        a.canAdvanceProject === true &&
        a.mode !== "supervisor" &&
        a.mode !== "patrol" &&
        a.target.kind === "dedicated" &&
        a.target.threadId === thread.id,
    );
}

/** **進める自動化の tool を見せる会話か**（その会話が進める自動化の専用の Fork で、読むだけの回・番頭の回でない） */
export function advanceAvailableIn(
  deps: { projectThread: Pick<ProjectThreadStore, "getThread">; automations: Pick<AutomationStore, "list"> },
  threadId: string,
): boolean {
  const thread = deps.projectThread.getThread(threadId);
  if (!thread || thread.restriction) return false;
  return advanceAutomationsOfThread(deps.automations, thread).length > 0;
}

/**
 * **呼んだ会話が進める自動化の回なら、その手がかり**（`instruct_thread`・`list_stalled_threads`・Factory の照らし合わせが引く）。
 * 任された行いは、その Fork の進める自動化に `delegateKinds` があればその和（人に回す種類は入らない）、無ければ Project の方針
 */
export function advanceTurnOf(
  deps: { projectThread: Pick<ProjectThreadStore, "getThread">; automations: Pick<AutomationStore, "get" | "list"> },
  callerThreadId: string,
  policy: (projectId: string) => Pick<SupervisorPolicy, "delegate">,
): AdvanceTurn | undefined {
  const thread = deps.projectThread.getThread(callerThreadId);
  if (!thread || thread.restriction) return undefined;
  const owners = advanceAutomationsOfThread(deps.automations, thread);
  if (owners.length === 0) return undefined;
  const run = automationRunOfLastTurn(thread);
  // 記録はその回を届けた自動化に。人が打ったターン・ほかの自動化の回なら、その Fork の進める自動化の最初のもの
  const automation = owners.find((a) => a.id === run?.id) ?? owners[0]!;
  const listed = owners.filter((a) => a.delegateKinds !== undefined);
  const delegate =
    listed.length > 0
      ? (Array.from(new Set(listed.flatMap((a) => a.delegateKinds ?? []))).filter(isSupervisorAction) as SupervisorAction[])
      : [...policy(thread.projectId).delegate];
  return {
    projectId: thread.projectId,
    automation: { id: automation.id, name: automation.name },
    ...(run && run.id === automation.id ? { runId: run.runId } : {}),
    readExternal: readExternalOf(thread) || deliveredOtherThanAutomation(thread),
    delegate,
  };
}

/** そのターンに、自動化の指示のほかに届いたもの（Module の返事など）を積んだか */
function deliveredOtherThanAutomation(thread: Pick<ThreadState, "lastTurn" | "messages">): boolean {
  const startedSeq = thread.lastTurn?.startedSeq ?? Number.MAX_SAFE_INTEGER;
  return thread.messages.some((m) => m.seq > startedSeq && m.role === "user" && m.origin !== undefined && m.origin.automation === undefined);
}

/** **進める自動化の記録**（その Project の、記録を持つ自動化を全部合わせた新しい順）。Project を渡さなければ全部の Project */
export function advanceActsOf(automations: Pick<AutomationStore, "listAll">, projectId?: string): Array<AdvanceAct & { automationId: string; projectId: string }> {
  return automations
    .listAll()
    .filter((a) => a.mode !== "supervisor" && (projectId === undefined || a.projectId === projectId))
    .flatMap((a) => (a.advanceActs ?? []).map((act) => ({ ...act, automationId: a.id, projectId: a.projectId })))
    .sort((a, b) => b.at.localeCompare(a.at));
}

const HOUR_MS = 60 * 60 * 1000;

/** 指示の全体の上限に届いていれば、断る理由（全部の進める自動化の合計、直近 1 時間） */
export function advanceInstructionLimitReason(
  automations: Pick<AutomationStore, "listAll">,
  limits: Pick<SupervisorPolicy["limits"], "instructionsPerHour">,
  now: Date,
): string | undefined {
  const limit = Math.max(0, Math.floor(limits.instructionsPerHour));
  const since = now.getTime() - HOUR_MS;
  const used = advanceActsOf(automations).filter((a) => a.kind === "instructed" && Date.parse(a.at) > since).length;
  if (used < limit) return undefined;
  return `全部の進める自動化で1時間に送れる指示は ${limit} 件までです（いま ${used} 件）。この時間は人に回してください`;
}

/** その自動化が進める自動化か（`canAdvanceProject` を持つ。番頭の自動化・見回りは除く） */
export function isAdvanceAutomation(a: Pick<Automation, "canAdvanceProject" | "mode">): boolean {
  return a.canAdvanceProject === true && a.mode !== "supervisor" && a.mode !== "patrol";
}

/**
 * **進める自動化の回の全体の上限に届いていれば、飛ばす理由**（全部の進める自動化の合計、直近 1 時間。アーキ仕様 §4.3「判断役の一般化」の 4.）。
 * 数えるのは届けた回だけ（飛ばした・断った回は数えない）。`AutomationRunner` が進める自動化の回を届ける手前で引く
 */
export function advanceRunLimitReason(
  automations: Pick<AutomationStore, "listAll">,
  limits: Pick<SupervisorPolicy["limits"], "runsPerHour">,
  now: Date,
): string | undefined {
  const limit = Math.max(0, Math.floor(limits.runsPerHour));
  const since = now.getTime() - HOUR_MS;
  const used = automations
    .listAll()
    .filter(isAdvanceAutomation)
    .flatMap((a) => a.runs)
    .filter((r) => r.result !== "skipped" && r.result !== "rejected" && Date.parse(r.at) > since).length;
  if (used < limit) return undefined;
  return `全部の進める自動化で1時間に起きる回は ${limit} 回までです（いま ${used} 回）。この時間は人に回しています`;
}

/** そのタイムゾーンの日付（YYYY-MM-DD）。読めないタイムゾーンは UTC で数える */
export function advanceDayKey(date: Date, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
  } catch {
    return date.toISOString().slice(0, 10);
  }
}

export interface AdvanceInstructInput {
  threadId: string;
  action: string;
  note?: string;
  reason: string;
}

export interface ProjectAdvanceDeps {
  projectThread: ProjectThreadStore;
  automations: Pick<AutomationStore, "get" | "list" | "listAll" | "recordAdvanceAct">;
  deliveries: Pick<ThreadDeliveries, "deliver">;
  turns: Pick<ThreadTurns, "isRunning" | "queued">;
  inbox: Pick<InboxStore, "listOpen" | "judgeReviews">;
  /** その Project の方針（回のたびに引く） */
  policy(projectId: string): AdvancePolicy;
  /** 方針にタイムゾーンが無いときの既定。無ければ banto が動いている場所のもの */
  defaultTimeZone?: string;
  now?: () => Date;
  log?: (message: string) => void;
}

type Reply = { ok: boolean; text: string };

const NOT_ADVANCE_TURN = "止まった会話を進める権限（canAdvanceProject）を持つ自動化の専用の Fork ではないので使えません。";

export class ProjectAdvance {
  constructor(private readonly deps: ProjectAdvanceDeps) {}

  /** その会話に2つの tool を見せるか（turn-runner がターンを始めるときに引く） */
  availableIn(threadId: string): boolean {
    return advanceAvailableIn(this.deps, threadId);
  }

  /** **`list_stalled_threads` の本体**。`callerThreadId` は呼んだ会話（進める自動化の専用の Fork） */
  listStalled(callerThreadId: string): Reply {
    const turn = this.turnOf(callerThreadId);
    if (!turn) return { ok: false, text: NOT_ADVANCE_TURN };
    const policy = this.deps.policy(turn.projectId);
    const acts = advanceActsOf(this.deps.automations, turn.projectId);
    const stalled: AdvanceStalledThread[] = [];
    for (const thread of this.deps.projectThread.listThreadsForProject(turn.projectId)) {
      if (this.targetProblem(thread, turn, callerThreadId)) continue;
      const reason = this.stalledReasonOf(thread, turn.delegate, policy, acts);
      if (reason) stalled.push(stalledView(thread, reason));
    }
    if (stalled.length === 0) return { ok: true, text: "止まっている会話はありません。" };
    return { ok: true, text: JSON.stringify(stalled, null, 2) };
  }

  /** **`instruct_thread` の本体**。断ったら理由を返し、記録に `refused` を残す */
  async instruct(callerThreadId: string, input: AdvanceInstructInput): Promise<Reply> {
    const turn = this.turnOf(callerThreadId);
    if (!turn) return { ok: false, text: NOT_ADVANCE_TURN };
    const refuse = async (why: string, extra: Partial<AdvanceAct> = {}): Promise<Reply> => {
      await this.record(turn.automation.id, {
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

    // **行い**：任された行いだけ。人に回す種類・選ぶための種類は頼めない
    const policy = this.deps.policy(turn.projectId);
    const action = input.action;
    if (!isDecisionKind(action)) return refuse(`知らない行い「${action}」です`);
    if ((HUMAN_ONLY_KINDS as readonly string[]).includes(action)) return refuse(`${ACTION_TITLES[action]}は人が決めます。人に回してください`);
    if (action === "minor-design") return refuse("minor-design は決めることの選択肢を選ぶための種類で、頼む行いではありません");
    if (!turn.delegate.includes(action as SupervisorAction)) return refuse(`この自動化には「${ACTION_TITLES[action]}」を任されていません。人に回してください`);
    const act = action as AdvanceAction;

    // **note**：500字まで。外から来たものを届けられた回は付けられない（外の文を指示の側へ運ばせない）
    const note = input.note?.trim() ?? "";
    if (note.length > ADVANCE_NOTE_MAX_CHARS) return refuse(`note は ${ADVANCE_NOTE_MAX_CHARS} 字までです（${note.length} 字）`);
    if (note !== "" && turn.readExternal) {
      return refuse("この回には外から来たもの（出来事の本文・別の会話のメッセージ）が届いているので、note は付けられません。note を外して頼んでください");
    }

    // **宛先**：その Project の、ふつうの開いている会話だけ
    const target = this.deps.projectThread.getThread(input.threadId);
    const problem = this.targetProblem(target, turn, callerThreadId);
    if (problem || !target) return refuse(problem ?? "その会話が見つかりません");
    const acts = advanceActsOf(this.deps.automations, turn.projectId);
    // 数えの鍵にする止まった理由は、宛先が動いている（前の指示が積まれている・走っている）ことに依らずに見る
    const stalled = this.stalledReasonOf(target, turn.delegate, policy, acts, { ignoreBusy: true });
    if (stalled === "mission-stopped") return refuse("任務が止まった・枠を使い切った会話です。枠を延ばす・止めるのは人なので、人に回してください");
    // **答えていない決めることがある会話には送れない**（問いの種類の断りを instruct でくぐらせない）
    if (this.hasOpenDecisions(target)) {
      return refuse("その会話には、まだ答えていない決めることがあります。決めることは answer_decision（届いた出来事）か人が答えます");
    }
    // **ホップ**：宛先の最後のターン＋2。上限を超えるなら自動では起こさない——届けずに断る
    const hop = advanceLastTurnHop(target) + 2;
    if (hop > DELIVERY_LIMITS.maxHop) {
      return refuse(`連鎖の上限（${DELIVERY_LIMITS.maxHop}）を超えるので、自動では起こせません。人に回してください`);
    }

    // **回数**（進める自動化の記録から数える——同じ会話へは、どの進める自動化が頼んだものも合わせる）
    const key = stalled ?? act;
    const summarySeq = latestSummarySeq(target);
    const now = this.now();
    const instructed = acts.filter((a) => a.kind === "instructed" && a.threadId === target.id);
    const same = instructed.filter((a) => a.stalledReason === key && (a.summarySeq ?? 0) === summarySeq).length;
    if (same >= ADVANCE_INSTRUCT_LIMITS.sameReason) {
      return refuse(`この会話の同じ止まった理由（${key}）には、もう ${same} 回頼みました。動かないので人に回してください`, { stalledReason: key });
    }
    // **全体の上限**（全部の進める自動化の合計）
    const overall = advanceInstructionLimitReason(this.deps.automations, policy.limits, now);
    if (overall) return refuse(overall, { stalledReason: key });
    const zone = this.timeZone(policy);
    const today = advanceDayKey(now, zone);
    const todays = instructed.filter((a) => advanceDayKey(new Date(a.at), zone) === today).length;
    if (todays >= ADVANCE_INSTRUCT_LIMITS.perThreadPerDay) {
      return refuse(`この会話には今日もう ${todays} 回頼みました（1日 ${ADVANCE_INSTRUCT_LIMITS.perThreadPerDay} 回まで）。人に回してください`, { stalledReason: key });
    }

    const actionId = randomUUID();
    let wake: Awaited<ReturnType<ThreadDeliveries["deliver"]>>;
    try {
      // 届けものの印は番頭の指示と同じもの（`origin.supervisor`）を使う——始まる前に人が発言したら捨てる・自動化の回に数えない・
      // 留めても受信箱に知らせない、の扱いをそのまま受ける。`supervisorId` には自動化の id を入れる
      wake = await this.deps.deliveries.deliver({
        threadId: target.id,
        from: "banto",
        title: `自動化「${turn.automation.name}」の指示：${ACTION_TITLES[act]}`,
        text: [`自動化「${turn.automation.name}」が、この会話に次の手順を頼みました（行い ${act}：${ACTION_TITLES[act]}）。`, ADVANCE_ACTION_REQUESTS[act]].join("\n"),
        hop,
        kind: "supervisor",
        supervisor: {
          supervisorId: turn.automation.id,
          runId: turn.runId ?? "",
          automationId: turn.automation.id,
          actionId,
          ...(note !== "" ? { note } : {}),
        },
      });
    } catch (err) {
      return refuse(`届けられませんでした：${err instanceof Error ? err.message : String(err)}`);
    }
    const at = now.toISOString();
    await this.record(turn.automation.id, {
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
    // **受信箱**：開いているカードに「自動化が頼んだ」を添える。無ければ、指示で起きたターンの終わりのカードに出る（`judgeOfLastTurn`）
    const judge = instructedJudge(turn.automation, { action: act, hasNote: note !== "", actionId, reason, at });
    try {
      await this.deps.inbox.judgeReviews(target.id, judge);
    } catch (err) {
      this.log(`[host] 自動化の指示を ${target.id} のカードに添えられませんでした: ${err instanceof Error ? err.message : String(err)}`);
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
   * **ターンを始める直前に、届いた進める自動化の指示を見直す**（turn-runner が届けものを積む前。番頭の指示は番頭の実装が見る）。
   * 捨てたものを除いた届けものを返す。捨てるのは：人の発言で始まるターン／宛先のターンが、指示を受けたあとに決めることを人に聞いて終わった
   */
  async screen(threadId: string, delivered: readonly PendingDelivery[], humanMessage: boolean): Promise<PendingDelivery[]> {
    const instructions = delivered.filter((d) => d.supervisor && this.deps.automations.get(d.supervisor.automationId)?.mode !== "supervisor");
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
      const instructed = this.deps.automations.get(origin.automationId)?.advanceActs?.find((a) => a.kind === "instructed" && a.actionId === origin.actionId);
      await this.record(origin.automationId, {
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
   * **進める自動化の指示で起きたターンの決め**（受信箱のカードの `carriedJudge`）。最後のターンに積んだ指示から記録を引いて組む。
   * 指示で起きたターンでなければ undefined（番頭の指示も undefined——番頭の実装が組む）
   */
  judgeOfLastTurn(threadId: string): ReviewJudge | undefined {
    const thread = this.deps.projectThread.getThread(threadId);
    const startedSeq = thread?.lastTurn?.startedSeq;
    if (!thread || startedSeq === undefined) return undefined;
    const origin = [...thread.messages].reverse().find((m) => m.seq > startedSeq && m.origin?.supervisor)?.origin?.supervisor;
    if (!origin) return undefined;
    const automation = this.deps.automations.get(origin.automationId);
    if (!automation || automation.mode === "supervisor") return undefined;
    const act = automation.advanceActs?.find((a) => a.kind === "instructed" && a.actionId === origin.actionId);
    if (!act?.action || !isDecisionKind(act.action) || act.action === "minor-design") return undefined;
    return instructedJudge(automation, { action: act.action as AdvanceAction, hasNote: act.hasNote === true, actionId: origin.actionId, reason: act.reason, at: act.at });
  }

  // ---- 内側 ---------------------------------------------------------------------------------------------------

  private turnOf(callerThreadId: string): AdvanceTurn | undefined {
    return advanceTurnOf(this.deps, callerThreadId, (projectId) => this.deps.policy(projectId));
  }

  /** 宛先にできない理由（できるなら undefined）。一覧からも同じ決まりで外す */
  private targetProblem(thread: ThreadState | undefined, turn: AdvanceTurn, callerThreadId: string): string | undefined {
    if (!thread) return "その会話が見つかりません";
    if (thread.projectId !== turn.projectId) return "自分の Project の会話にだけ頼めます";
    if (thread.status !== "active") return "閉じた会話には頼めません";
    if (this.deps.projectThread.getProject(thread.projectId)?.status === "closed") return "閉じた Project の会話には頼めません";
    if (thread.id === callerThreadId) return "自分自身の会話には頼めません";
    if (thread.restriction) return "見回り・番頭の会話には頼めません";
    const dedicated = this.deps.automations
      .list(thread.projectId)
      .some((a) => a.target.kind === "dedicated" && a.target.threadId === thread.id);
    if (dedicated) return "自動化・見回り・判断役の専用の Fork には頼めません";
    return undefined;
  }

  /** 止まっている理由（止まっていない・外すものなら undefined）。番頭の `stalledReasonOf` と同じ決まりで、任された行いだけを見る */
  private stalledReasonOf(
    thread: ThreadState,
    delegate: readonly SupervisorAction[],
    policy: AdvancePolicy,
    acts: readonly AdvanceAct[],
    opts: { ignoreBusy?: boolean } = {},
  ): AdvanceStalledReason | undefined {
    const turn = thread.lastTurn;
    if (!turn) return undefined;
    if (!opts.ignoreBusy) {
      if (this.deps.turns.isRunning(thread.id) || this.deps.turns.queued(thread.id) > 0) return undefined;
      if ((thread.deliveries?.length ?? 0) > 0 || (thread.awaitingReplies?.length ?? 0) > 0) return undefined;
    }
    const open = this.openReviewsOf(thread.id);
    // **外す**：判断役が人に回した・揃わず人に回った・種類で断られた会話（人が見るか発言するまで）
    if (open.some((r) => r.judge?.kind === "deferred" || r.judge?.kind === "incomplete")) return undefined;
    if (open.length > 0 && acts.some((a) => a.kind === "refused" && a.threadId === thread.id && a.turnId === turn.turnId && a.question !== undefined)) {
      return undefined;
    }
    // 外から来たものを読んだターンで止まった会話は進めない（外の文に操られない）
    if (readExternalOf(thread)) return undefined;
    const m = thread.mission;
    if (m && (m.status === "stalled" || m.status === "exhausted") && !humanSpokeAfter(thread, m.finishedSeq ?? 0)) return "mission-stopped";
    if (turn.rateLimit) return undefined;
    const outcome = turn.outcome ?? "interrupted";
    if (outcome === "failed" || outcome === "interrupted") return "failed-turn";
    if (outcome !== "completed") return undefined;
    const summaryMessage = summaryMessageOfLastTurn(thread);
    const summary = summaryMessage?.turnSummary;
    if (!summaryMessage || !summary) return undefined;
    const decisions = decisionsOf(summary.summary);
    if (decisions.length > 0) {
      if (movedOnReason(thread, turn.turnId, this.deps.turns)) return undefined;
      if (open.some((r) => r.judge?.kind === "decided-by-automation")) return undefined;
      return decisions.every((d) => supervisorMayAnswer(d.kind, { delegate: [...delegate] }).ok) ? "decision-missed" : undefined;
    }
    if (this.now().getTime() - Date.parse(summary.at) < policy.idleHours * HOUR_MS) return undefined;
    const outcomeRecord = isRecord(summary.summary.outcome) ? summary.summary.outcome : undefined;
    const rest = strings(outcomeRecord?.notVerified).length + (Array.isArray(summary.summary.nextSuggestions) ? summary.summary.nextSuggestions.length : 0);
    return rest > 0 ? "idle" : undefined;
  }

  /** その会話に、まだ答えていない決めることがあるか（番頭の `hasOpenDecisions` と同じ決まり） */
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

  /** 進める自動化の記録に書く。書けなくても止めない——書き残す */
  private async record(automationId: string, act: Omit<AdvanceAct, "at">): Promise<void> {
    try {
      await this.deps.automations.recordAdvanceAct(automationId, { at: this.now().toISOString(), ...act });
    } catch (err) {
      this.log(`[host] 進める自動化の記録を書けませんでした（${act.kind}）: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private timeZone(policy: Pick<AdvancePolicy, "timeZone">): string {
    return policy.timeZone ?? this.deps.defaultTimeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  }

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  private log(message: string): void {
    (this.deps.log ?? console.warn)(message);
  }
}

/** 受信箱のカードに添える「自動化が頼んだ」（判断役のものと同じく `by` は付けない——番頭のものではない） */
function instructedJudge(
  automation: Pick<Automation, "id" | "name">,
  input: { action: AdvanceAction; hasNote: boolean; actionId: string; reason: string; at: string },
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

function stalledView(thread: ThreadState, reason: AdvanceStalledReason): AdvanceStalledThread {
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
export function advanceLastTurnHop(thread: Pick<ThreadState, "lastTurn" | "messages">): number {
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

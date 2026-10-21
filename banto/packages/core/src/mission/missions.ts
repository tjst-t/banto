// docs/specs/v4-architecture.md §4.4「任務」——**会話に目標・終わりの条件・枠を付け、AI が枠の中で自分を「あとでもう一度」起こす**。
//
// - 置き場は project-thread の fold（`ThreadState.mission`、出来事 `mission.*`）。ここは確かめて書くところと、時計・出来事・
//   ターンの終わりで動くところ
// - **始めるのは必ず人に聞く**（AI の `start_mission`）。tool の中で会話のカードを出す——承認モードにも「承認をすべて自動で
//   許可する」にも依らない（自動化を作るのと同じ線、`automation/tools.ts`）。枠はカードの欄（Elicitation の form と同じ部品）で
//   人が変えられ、答えに載って戻る。人が画面から始めるときは聞かない
// - **枠の中の予約は聞かずに通す**（`schedule_followup`）。枠の外は理由と「人に延ばしてもらうには決めることで聞く」を返して断る
// - **起こすかは `deliver` の手前で決める**（自動化と同じ、§4.3）。会話が空いていなければ届けずに予約を残し、次の刻みで見直す。
//   答えていない「決めること」は判断役と同じ手がかり（`movedOnReason`）で見る——別の判定を作らない
// - **予約も終わりも無いままターンを終えさせない**：`report_turn` を断る（決めることがあれば受け付ける）・Stop hook で一度
//   差し戻す・それでも無ければ「止まっています」

import { randomUUID } from "node:crypto";
import { eventMatchesWhere, type EventDeclaration, type EventFieldValue, type EventWhere } from "@banto/module-contract";
import type { ProjectThreadStore } from "../project-thread/store.js";
import type {
  ExternalContent,
  MissionFollowup,
  MissionFrame,
  MissionState,
  MissionStatus,
  MissionWakeCause,
  MissionWakeResult,
  ThreadState,
} from "../project-thread/types.js";
import type { InboxStore } from "../inbox/store.js";
import type { PendingApprovalRegistry } from "../inbox/pending-approvals.js";
import type { ReviewMission } from "../inbox/types.js";
import { reviewDueAfterTurn } from "../inbox/review-turn.js";
import { reviewAttentionOf } from "../inbox/automation-review.js";
import type { ThreadTurns } from "../delivery/thread-turns.js";
import type { DeliverInput } from "../delivery/thread-deliveries.js";
import { decisionsOf, movedOnReason, summaryMessageOfLastTurn } from "../automation/turn-decisions.js";
import { AutomationInputError } from "../automation/store.js";

export const START_MISSION_TOOL_NAME = "start_mission";
export const SCHEDULE_FOLLOWUP_TOOL_NAME = "schedule_followup";
export const FINISH_MISSION_TOOL_NAME = "finish_mission";
/** 3つとも Runner の承認（canUseTool）を通さない——始めるのは tool の中で必ず人に聞き、予約・終わりは枠が抑える（§4.4「tool」） */
export const MISSION_TOOL_NAMES = [START_MISSION_TOOL_NAME, SCHEDULE_FOLLOWUP_TOOL_NAME, FINISH_MISSION_TOOL_NAME] as const;

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

/** 枠の既定と上限（アーキ仕様 §4.4「枠」） */
export const MISSION_LIMITS = {
  maxWakesDefault: 20,
  maxWakesMax: 100,
  untilDefaultMs: 3 * DAY,
  /** 始めた時刻から */
  untilMaxMs: 14 * DAY,
  minIntervalDefaultMinutes: 15,
  /** 自動化の最短と同じ */
  minIntervalMinMinutes: 15,
  /** 目標・終わりの条件・メモ・結果の長さ */
  textMaxChars: 2000,
} as const;

/** 確認のカードの選択肢。先頭が許す側（`inbox/answer-text.ts`） */
export const MISSION_START_CHOICES = ["始める", "始めない"] as const;

/** 予約も終わりも無いままターンを終えようとしたときの文（`report_turn` を断る・Stop hook の差し戻し） */
export const MISSION_CONTINUE_TEXT =
  "任務は続いています。先に schedule_followup で次を予約するか、finish_mission で終えてください（人に決めてほしいことがあるなら、report_turn の decisions で聞けば予約が無くても受け付けます）。";

/** 枠の外で断ったときに添える文 */
const EXTEND_HINT =
  "枠を延ばせるのは人だけです。延ばしてほしいときは、report_turn の decisions で人に聞いてください（決めることのあるまとめは、予約が無くても受け付けます）。";

/** 入力が決まりに合わない（AI には文で返す・画面の口は 400） */
export class MissionInputError extends Error {}
/** 今の状態ではできない（動いている任務がある・無い・枠を使い切った等。画面の口は 409） */
export class MissionConflictError extends Error {}

export interface MissionToolResult {
  ok: boolean;
  text: string;
}

export interface MissionsDeps {
  projectThread: ProjectThreadStore;
  inbox: Pick<InboxStore, "raiseJudgment" | "answerJudgment" | "listJudgmentsForThread" | "raiseMissionOutcome">;
  pendingApprovals: Pick<PendingApprovalRegistry, "register" | "resolve">;
  /** 走っているターンの画面へ、判断待ちが出たことを流す（会話の中の確認のカード） */
  publishJudgment?(
    threadId: string,
    judgment: {
      id: string;
      message: string;
      serverName: string;
      toolInput: unknown;
      choices: string[];
      requestedSchema: unknown;
    },
  ): void;
  deliveries: { deliver(input: DeliverInput): Promise<unknown> };
  turns: Pick<ThreadTurns, "isRunning" | "queued">;
  /** 待つ出来事が名乗られているか（自動化と同じ決まり——`AutomationStore.checkEventWait`）。無ければ出来事は待てない */
  events?: { checkEventWait(projectId: string, event: string, where: EventWhere | undefined): EventDeclaration };
  /** その会話に任務を付けられないなら理由（自動化の専用の Fork・判断役の Fork） */
  refuseThread?(thread: ThreadState): string | undefined;
  /** 予約を置いた（出来事を待つなら、その出どころを起こしておく——§4.3 段2） */
  onFollowupSet?(projectId: string): void;
  now?: () => Date;
  /** 最短の間隔の下限（分）。無ければ 15。E2E だけが縮める（15分を待たずに2回目を見る） */
  minIntervalFloorMinutes?: number;
  log?: (message: string) => void;
}

/** start_mission の引数（画面の口も同じ形） */
export interface MissionStartInput {
  goal: string;
  doneWhen: string;
  maxWakes?: number;
  until?: string;
  minInterval?: number;
}

export interface FollowupInput {
  at?: string;
  after?: number;
  event?: { name: string; where?: EventWhere; until?: string };
  note: string;
}

/** 起こしたもの・断ったもの（時計の刻み1回分。試験と観測用） */
export interface MissionTickReport {
  woke: string[];
  expired: string[];
}

function blank(s: unknown): boolean {
  return typeof s !== "string" || s.trim() === "";
}

function oneLine(text: string, max = 60): string {
  const flat = text.trim().replace(/\s+/g, " ");
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

function formatAt(iso: string): string {
  return new Intl.DateTimeFormat("ja-JP", { timeZone: "Asia/Tokyo", dateStyle: "short", timeStyle: "short" }).format(new Date(iso)) + "（日本時間）";
}

/** 任務の予約で起こした回のターンか。最後の人の発言と任務の届けもののうち、新しいほうが任務の届けものならその回 */
export function missionWakeOfLastTurn(thread: Pick<ThreadState, "messages">): { id: string; wake: number } | undefined {
  for (let i = thread.messages.length - 1; i >= 0; i--) {
    const m = thread.messages[i]!;
    if (m.role !== "user") continue;
    // 番頭の指示で起きたターンは任務の回に数えない（アーキ仕様 §4.5——人の発言と同じく区切る）
    if (!m.origin || m.origin.supervisor) return undefined;
    if (m.origin.mission) return m.origin.mission;
  }
  return undefined;
}

/**
 * **答えていない「決めること」がある**：最後のターンのまとめに `decisions` があり、まだ先へ進んでいない。判定は判断役と同じ
 * 手がかり（`movedOnReason`——ターンが変わった・まとめより後に人の発言がある・人のターンが走っている／並んでいる）
 */
export function hasUnansweredDecisions(
  thread: Pick<ThreadState, "id" | "status" | "lastTurn" | "messages">,
  turns: Pick<ThreadTurns, "isRunning" | "queued">,
): boolean {
  const turn = thread.lastTurn;
  if (!turn) return false;
  if (decisionsOf(summaryMessageOfLastTurn(thread)?.turnSummary?.summary).length === 0) return false;
  return movedOnReason(thread, turn.turnId, turns) === undefined;
}

/** 受信箱のカードに添える任務の結末 */
export function reviewMissionOf(m: MissionState): ReviewMission {
  return {
    id: m.id,
    goal: m.goal,
    status: m.status,
    wakes: m.wakes,
    maxWakes: m.frame.maxWakes,
    until: m.frame.until,
    ...(m.result ? { result: m.result } : {}),
  };
}

const STATUS_TEXT: Record<Exclude<MissionStatus, "active">, string> = {
  done: "任務が終わりました",
  "gave-up": "任務をあきらめました",
  exhausted: "枠を使い切りました",
  stalled: "止まっています",
  stopped: "止めました",
};

/** 受信箱のカードの1行（`summary`）——任務の結末 */
export function missionOutcomeLine(m: MissionState): string {
  if (m.status === "active") return `任務「${oneLine(m.goal)}」は続いています`;
  return `${STATUS_TEXT[m.status]}：任務「${oneLine(m.goal)}」（${m.wakes}/${m.frame.maxWakes} 回起きました）${m.result ? `——${oneLine(m.result, 200)}` : ""}`;
}

/**
 * **ターンが終わってレビュー待ちを出すと決まったあと**、任務の回としてどう出すか（アーキ仕様 §4.4「受信箱」）。
 * - このターンで任務が人に返った（終わった・枠を使い切った・止まっている）：結末を添えて出す
 * - 任務の予約で起きた回が、決めること・判断待ち・失敗のどれも無く終わった：出さない
 * - それ以外：任務とは関係なく今の決まりのまま
 */
export function planMissionReview(
  thread: Pick<ThreadState, "lastTurn" | "messages" | "mission">,
  hasLiveJudgment: boolean,
): { kind: "plain" } | { kind: "skip" } | { kind: "mission"; mission: ReviewMission } {
  const m = thread.mission;
  const turn = thread.lastTurn;
  if (m && m.status !== "active" && m.status !== "stopped" && turn && m.finishedSeq !== undefined && m.finishedSeq > turn.startedSeq) {
    return { kind: "mission", mission: reviewMissionOf(m) };
  }
  const wake = missionWakeOfLastTurn(thread);
  if (wake && m?.id === wake.id && m.status === "active" && !reviewAttentionOf(thread, hasLiveJudgment)) return { kind: "skip" };
  return { kind: "plain" };
}

/** 枠の欄（start_mission のカード）。答えの `updatedInput` にこの名前で載る */
function frameSchema(frame: MissionFrame, now: Date, floor: number): Record<string, unknown> {
  const days = Math.round(((Date.parse(frame.until) - now.getTime()) / DAY) * 10) / 10;
  return {
    type: "object",
    properties: {
      maxWakes: {
        type: "integer",
        title: "起きる回数の上限（回）",
        minimum: 1,
        maximum: MISSION_LIMITS.maxWakesMax,
        default: frame.maxWakes,
      },
      untilDays: {
        type: "number",
        title: "期限（今から何日）",
        minimum: 0.1,
        maximum: MISSION_LIMITS.untilMaxMs / DAY,
        default: days,
      },
      minInterval: {
        type: "integer",
        title: "最短の間隔（分）",
        minimum: floor,
        default: frame.minIntervalMinutes,
      },
    },
    required: ["maxWakes", "untilDays", "minInterval"],
  };
}

export class Missions {
  private ticking: Promise<MissionTickReport> | undefined;

  constructor(private readonly deps: MissionsDeps) {}

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  private floor(): number {
    return this.deps.minIntervalFloorMinutes ?? MISSION_LIMITS.minIntervalMinMinutes;
  }

  private log(message: string): void {
    (this.deps.log ?? console.warn)(message);
  }

  // ---- 枠 ----------------------------------------------------------------------------------------------------

  /**
   * **枠を読む**。省いた欄は `current`（変えるとき）か既定。`startedAt` は期限の上限の起点（始めた時刻）
   */
  parseFrame(
    raw: { maxWakes?: unknown; until?: unknown; minInterval?: unknown },
    startedAt: Date,
    current?: MissionFrame,
  ): MissionFrame {
    const now = this.now();
    const maxWakes = raw.maxWakes ?? current?.maxWakes ?? MISSION_LIMITS.maxWakesDefault;
    if (typeof maxWakes !== "number" || !Number.isInteger(maxWakes) || maxWakes < 1 || maxWakes > MISSION_LIMITS.maxWakesMax) {
      throw new MissionInputError(`maxWakes（起きる回数の上限）は 1〜${MISSION_LIMITS.maxWakesMax} の整数にしてください。`);
    }
    const latest = startedAt.getTime() + MISSION_LIMITS.untilMaxMs;
    let until: number;
    if (raw.until !== undefined) {
      until = typeof raw.until === "string" ? Date.parse(raw.until) : NaN;
      if (!Number.isFinite(until)) throw new MissionInputError("until（期限）は ISO 8601 の時刻で渡してください（例 2026-10-23T09:00:00+09:00）。");
    } else {
      until = current ? Date.parse(current.until) : Math.min(now.getTime() + MISSION_LIMITS.untilDefaultMs, latest);
    }
    if (until <= now.getTime()) throw new MissionInputError("until（期限）が今より前です。");
    if (until > latest + MINUTE) {
      throw new MissionInputError(`until（期限）は始めてから ${MISSION_LIMITS.untilMaxMs / DAY} 日までです（${formatAt(new Date(latest).toISOString())} まで）。`);
    }
    const minInterval = raw.minInterval ?? current?.minIntervalMinutes ?? Math.max(MISSION_LIMITS.minIntervalDefaultMinutes, this.floor());
    if (typeof minInterval !== "number" || !Number.isInteger(minInterval) || minInterval < this.floor()) {
      throw new MissionInputError(`minInterval（最短の間隔）は ${this.floor()} 分以上の整数にしてください。`);
    }
    return { maxWakes, until: new Date(Math.min(until, latest)).toISOString(), minIntervalMinutes: minInterval };
  }

  describeFrame(frame: MissionFrame): string {
    return `起きるのは ${frame.maxWakes} 回まで・期限 ${formatAt(frame.until)}・最短の間隔 ${frame.minIntervalMinutes} 分`;
  }

  // ---- 始める・変える・止める ----------------------------------------------------------------------------------

  /** 任務を付けられる会話か。付けられなければ理由（`MissionConflictError`） */
  private assertCanStart(thread: ThreadState | undefined): ThreadState {
    if (!thread) throw new MissionConflictError("この会話が見つかりません。");
    if (thread.status !== "active") throw new MissionConflictError("この会話は閉じられています。");
    const project = this.deps.projectThread.getProject(thread.projectId);
    if (!project || project.status === "closed") throw new MissionConflictError("この Project は閉じられています。");
    const refused = this.deps.refuseThread?.(thread);
    if (refused) throw new MissionConflictError(refused);
    if (thread.mission?.status === "active") {
      throw new MissionConflictError(
        `この会話には動いている任務があります（「${oneLine(thread.mission.goal)}」）。1つの会話に動いている任務は1つまでです。finish_mission で終えてから始めてください。`,
      );
    }
    return thread;
  }

  private parseStart(raw: Partial<MissionStartInput>): { goal: string; doneWhen: string; frame: MissionFrame } {
    if (blank(raw.goal)) throw new MissionInputError("goal（目標）が空です。");
    if (blank(raw.doneWhen)) throw new MissionInputError("doneWhen（終わりの条件）が空です。");
    const goal = raw.goal!.trim();
    const doneWhen = raw.doneWhen!.trim();
    if (goal.length > MISSION_LIMITS.textMaxChars || doneWhen.length > MISSION_LIMITS.textMaxChars) {
      throw new MissionInputError(`goal・doneWhen は ${MISSION_LIMITS.textMaxChars} 字までにしてください。`);
    }
    return { goal, doneWhen, frame: this.parseFrame(raw, this.now()) };
  }

  /** **AI が始める**（`start_mission`）。**必ず人に聞く**——枠はカードで変えられる */
  async start(threadId: string, raw: Partial<MissionStartInput>, signal?: AbortSignal): Promise<MissionToolResult> {
    return this.guard(async () => {
      this.assertCanStart(this.deps.projectThread.getThread(threadId));
      // 聞く前に確かめる——人が許したあとで「入力が違う」と断らない
      const { goal, doneWhen, frame } = this.parseStart(raw);
      const toolInput = {
        目標: goal,
        終わりの条件: doneWhen,
        何が起きるか: [
          "この会話の AI が、下の枠の中で自分を「あとでもう一度」起こせるようになります。人が見ていない時間にも、予約した時刻や出来事で起きて続けます。",
          "確認が要る操作に当たったら、そこで止まってあなたの答えを待ちます。",
          "会話のヘッダから、いつでも止められます。",
        ].join(""),
      };
      const requestedSchema = frameSchema(frame, this.now(), this.floor());
      const answer = await this.ask(threadId, "この任務を始めてよいですか", toolInput, requestedSchema, signal);
      if (!answer.allowed) return { ok: false, text: `人が始めないと答えたので、任務は始めていません。${answer.note}` };
      let chosen = frame;
      if (answer.values) {
        const v = answer.values;
        const days = v.untilDays;
        const until =
          typeof days === "number" && Number.isFinite(days) ? new Date(this.now().getTime() + days * DAY).toISOString() : undefined;
        try {
          chosen = this.parseFrame(
            {
              ...(v.maxWakes !== undefined ? { maxWakes: v.maxWakes } : {}),
              ...(until ? { until } : {}),
              ...(v.minInterval !== undefined ? { minInterval: v.minInterval } : {}),
            },
            this.now(),
            frame,
          );
        } catch (err) {
          if (err instanceof MissionInputError) {
            return { ok: false, text: `人が入れた枠が決まりに合わなかったので、任務は始めていません：${err.message}` };
          }
          throw err;
        }
      }
      // 人が答える間に別の任務が始まっていないか（画面から始めた等）
      this.assertCanStart(this.deps.projectThread.getThread(threadId));
      const missionId = randomUUID();
      await this.deps.projectThread.startMission(threadId, { missionId, goal, doneWhen, frame: chosen, by: "ai" });
      return {
        ok: true,
        text: [
          `人が許したので、任務を始めた（id: ${missionId}）。枠：${this.describeFrame(chosen)}。`,
          "続けるときは schedule_followup で次に起きる時刻か待つ出来事を予約し、終わったら finish_mission で終える。予約も終わりも無いままターンは終えられない。",
        ].join("\n"),
      };
    });
  }

  /**
   * **この会話で任務を始められないなら理由**（画面の「任務にする」を出すか、v4-frontend.md §6.47）。動いている任務があるときも理由
   */
  startRefusal(threadId: string): string | undefined {
    try {
      this.assertCanStart(this.deps.projectThread.getThread(threadId));
      return undefined;
    } catch (err) {
      if (err instanceof MissionConflictError) return err.message;
      throw err;
    }
  }

  /** **人が始める**（画面の口）。人が押しているので聞かない */
  async startByHuman(threadId: string, raw: Partial<MissionStartInput>): Promise<MissionState> {
    this.assertCanStart(this.deps.projectThread.getThread(threadId));
    const { goal, doneWhen, frame } = this.parseStart(raw);
    await this.deps.projectThread.startMission(threadId, { missionId: randomUUID(), goal, doneWhen, frame, by: "human" });
    return this.deps.projectThread.getThread(threadId)!.mission!;
  }

  /**
   * **人が枠を変える・止める**（画面の口の PATCH）。枠を使い切った・止まっている任務は、変えると動いている任務に戻る（「延ばす」）
   */
  async patch(threadId: string, raw: { maxWakes?: unknown; until?: unknown; minInterval?: unknown; stop?: unknown }): Promise<MissionState> {
    const thread = this.deps.projectThread.getThread(threadId);
    const m = thread?.mission;
    if (!thread || !m) throw new MissionConflictError("この会話に任務はありません。");
    if (raw.stop === true) {
      // 枠を使い切った・止まっている任務も、人が「終える」で止められる（受信箱のカード、v4-frontend.md §6.47）
      if (m.status !== "active" && m.status !== "exhausted" && m.status !== "stalled") throw new MissionConflictError("この任務はもう終わっています。");
      await this.deps.projectThread.finishMission(threadId, m.id, "stopped", "人が止めました");
      return this.deps.projectThread.getThread(threadId)!.mission!;
    }
    if (m.status !== "active" && m.status !== "exhausted" && m.status !== "stalled") {
      throw new MissionConflictError("終わった・止めた任務の枠は変えられません。新しく始めてください。");
    }
    if (thread.status !== "active") throw new MissionConflictError("この会話は閉じられています。");
    const frame = this.parseFrame(raw, new Date(m.startedAt), m.frame);
    if (frame.maxWakes < m.wakes) throw new MissionInputError(`maxWakes は、もう起きた回数（${m.wakes} 回）より少なくできません。`);
    await this.deps.projectThread.updateMissionFrame(threadId, m.id, frame, m.status !== "active");
    return this.deps.projectThread.getThread(threadId)!.mission!;
  }

  /** **人が「今すぐ起こす」**。最短の間隔に縛られない（回数には数える）。会話が空いていなければ断る */
  async wakeNow(threadId: string): Promise<MissionState> {
    const thread = this.deps.projectThread.getThread(threadId);
    const m = thread?.mission;
    if (!thread || !m || m.status !== "active") throw new MissionConflictError("この会話に動いている任務はありません。");
    if (m.wakes >= m.frame.maxWakes) throw new MissionConflictError(`起きる回数の上限（${m.frame.maxWakes} 回）を使い切っています。先に枠を延ばしてください。`);
    if (Date.parse(m.frame.until) <= this.now().getTime()) throw new MissionConflictError("期限を過ぎています。先に枠を延ばしてください。");
    const busy = this.wakeBlocker(thread);
    if (busy) throw new MissionConflictError(`いまは起こせません：${busy}`);
    await this.wake(thread, m, "human");
    return this.deps.projectThread.getThread(threadId)!.mission!;
  }

  // ---- 予約・終わり（AI） ----------------------------------------------------------------------------------------

  private activeMission(threadId: string): MissionState {
    const m = this.deps.projectThread.getThread(threadId)?.mission;
    if (!m || m.status !== "active") {
      throw new MissionConflictError("この会話には動いている任務がありません。先に start_mission で任務を始めてください。");
    }
    return m;
  }

  /** **予約**（`schedule_followup`）。枠の中なら聞かずに通す。予約は1つだけ——前の予約は置き換わる */
  async scheduleFollowup(threadId: string, raw: Partial<FollowupInput>): Promise<MissionToolResult> {
    return this.guard(async () => {
      const thread = this.deps.projectThread.getThread(threadId)!;
      const m = this.activeMission(threadId);
      if (blank(raw.note)) throw new MissionInputError("note（次に起きたら何を確かめるか）が空です。");
      const note = raw.note!.trim();
      if (note.length > MISSION_LIMITS.textMaxChars) throw new MissionInputError(`note は ${MISSION_LIMITS.textMaxChars} 字までにしてください。`);
      const given = [raw.at !== undefined, raw.after !== undefined, raw.event !== undefined].filter(Boolean).length;
      if (given !== 1) throw new MissionInputError("at（時刻）・after（何分後）・event（待つ出来事）のどれか1つだけを渡してください。");
      const now = this.now();
      const until = Date.parse(m.frame.until);
      if (m.wakes >= m.frame.maxWakes) {
        return { ok: false, text: `枠の外なので予約できません：起きる回数の上限（${m.frame.maxWakes} 回）を使い切っています。${EXTEND_HINT}` };
      }
      const earliest = m.lastWakeAt ? Date.parse(m.lastWakeAt) + m.frame.minIntervalMinutes * MINUTE : undefined;
      const setAt = now.toISOString();
      let followup: MissionFollowup;
      if (raw.event !== undefined) {
        const e = raw.event;
        if (typeof e !== "object" || e === null || blank(e.name)) throw new MissionInputError("event.name（待つ出来事の名前）が要ります。");
        if (!this.deps.events) throw new MissionInputError("この banto では出来事を待てません。at か after で予約してください。");
        const declared = this.deps.events.checkEventWait(thread.projectId, e.name.trim(), e.where);
        const waitUntil = e.until !== undefined ? Date.parse(e.until) : until;
        if (!Number.isFinite(waitUntil)) throw new MissionInputError("event.until（待つ上限）は ISO 8601 の時刻で渡してください。");
        if (waitUntil <= now.getTime()) throw new MissionInputError("event.until（待つ上限）が今より前です。");
        if (waitUntil > until) {
          return { ok: false, text: `枠の外なので予約できません：待つ上限が任務の期限（${formatAt(m.frame.until)}）より後です。${EXTEND_HINT}` };
        }
        followup = {
          note,
          setAt,
          event: {
            name: declared.name,
            ...(e.where && Object.keys(e.where).length > 0 ? { where: e.where } : {}),
            title: declared.title,
            until: new Date(waitUntil).toISOString(),
          },
        };
      } else {
        let at: number;
        if (raw.at !== undefined) {
          at = typeof raw.at === "string" ? Date.parse(raw.at) : NaN;
          if (!Number.isFinite(at)) throw new MissionInputError("at（時刻）は ISO 8601 の時刻で渡してください（例 2026-10-21T10:30:00+09:00）。");
        } else {
          const after = raw.after;
          if (typeof after !== "number" || !Number.isFinite(after) || after < 0) throw new MissionInputError("after（何分後）は 0 以上の数で渡してください。");
          at = now.getTime() + after * MINUTE;
        }
        if (at > until) {
          return { ok: false, text: `枠の外なので予約できません：${formatAt(new Date(at).toISOString())} は任務の期限（${formatAt(m.frame.until)}）より後です。${EXTEND_HINT}` };
        }
        if (earliest !== undefined && at < earliest) {
          return {
            ok: false,
            text: `枠の外なので予約できません：前に起きた時刻から最短の間隔（${m.frame.minIntervalMinutes} 分）より短いです。早くても ${formatAt(new Date(earliest).toISOString())} 以降にしてください。${EXTEND_HINT}`,
          };
        }
        followup = { note, setAt, at: new Date(Math.max(at, now.getTime())).toISOString() };
      }
      await this.deps.projectThread.setMissionFollowup(threadId, m.id, followup);
      this.deps.onFollowupSet?.(thread.projectId);
      const next = m.wakes + 1;
      const when = followup.at
        ? `${formatAt(followup.at)} に起こす`
        : `出来事 ${followup.event!.name}（${followup.event!.title}）が来たら起こす（${formatAt(followup.event!.until)} までに来なければ、そこで「来ませんでした」として起こす。最短の間隔より早く来たら、間隔が空くまで待つ）`;
      return {
        ok: true,
        text: `予約した：${when}。それが ${next}/${m.frame.maxWakes} 回目になる。前の予約があれば置き換えた。このターンはこのまま終えてよい。`,
      };
    });
  }

  /** **終える**（`finish_mission`）。受信箱に結末が出る（このターンのカードに添える） */
  async finish(threadId: string, raw: { status?: unknown; result?: unknown }): Promise<MissionToolResult> {
    return this.guard(async () => {
      const m = this.activeMission(threadId);
      if (raw.status !== "done" && raw.status !== "gave-up") throw new MissionInputError('status は "done"（終わった）か "gave-up"（あきらめた）にしてください。');
      if (blank(raw.result)) throw new MissionInputError("result（結果）が空です。");
      const result = (raw.result as string).trim();
      await this.deps.projectThread.finishMission(threadId, m.id, raw.status, result);
      return { ok: true, text: "任務を終えた。受信箱に結末が出る。人への報告をこのあとに書いてよい。" };
    });
  }

  // ---- 予約も終わりも無いままターンを終えさせない --------------------------------------------------------------------

  /** 任務が動いていて、予約が無く、裏の仕事の返事待ちも判断待ちも無い（＝このままターンを終えると誰も起こさない） */
  private needsFollowup(threadId: string): boolean {
    const thread = this.deps.projectThread.getThread(threadId);
    const m = thread?.mission;
    if (!thread || !m || m.status !== "active" || m.followup) return false;
    if ((thread.awaitingReplies?.length ?? 0) > 0) return false;
    return !this.deps.inbox.listJudgmentsForThread(threadId).some((j) => j.liveness === "live");
  }

  /**
   * **`report_turn` を受け付けてよいか**。この状態なら断る文を返す。**決めることのあるまとめは受け付ける**——人に聞いた時点で
   * 人に返っている（枠の外で予約を断られた AI が、枠を延ばしてほしいと人に聞く道を塞がない）
   */
  reportTurnProblem(threadId: string, decisions: number): string | undefined {
    if (decisions > 0) return undefined;
    return this.needsFollowup(threadId) ? MISSION_CONTINUE_TEXT : undefined;
  }

  /** **Stop hook**。任務の確かめを先に行う（差し戻しは、まとめの呼び忘れと合わせて1回——`stop_hook_active` は呼ぶ側が見る） */
  stopReason(threadId: string): string | undefined {
    return this.needsFollowup(threadId) ? MISSION_CONTINUE_TEXT : undefined;
  }

  // ---- ターンの終わり ----------------------------------------------------------------------------------------

  /**
   * **ターンが終わった**（受信箱のレビュー待ちを決めるより前に呼ぶ）。任務の回の結果を書き、期限を過ぎていれば「枠を使い切りました」、
   * 予約も終わりも無ければ「止まっています」（回数を使い切っていれば「枠を使い切りました」）にする
   */
  async turnEnded(threadId: string): Promise<void> {
    const thread = this.deps.projectThread.getThread(threadId);
    const m = thread?.mission;
    if (!thread || !m) return;
    const live = this.deps.inbox.listJudgmentsForThread(threadId).some((j) => j.liveness === "live");
    const wake = missionWakeOfLastTurn(thread);
    if (wake && wake.id === m.id && reviewDueAfterTurn(thread)) {
      const record = m.history.find((h) => h.wake === wake.wake);
      if (record && !record.result) {
        const attention = reviewAttentionOf(thread, live);
        const result: MissionWakeResult = attention === "failed" ? "failed" : attention === "waiting" ? "waiting" : attention === "decisions" ? "decisions" : "done";
        await this.deps.projectThread.settleMissionWake(threadId, m.id, wake.wake, result);
      }
    }
    if (m.status !== "active" || this.deps.turns.isRunning(threadId)) return;
    if (Date.parse(m.frame.until) <= this.now().getTime()) {
      await this.deps.projectThread.finishMission(threadId, m.id, "exhausted", "期限を過ぎました");
      return;
    }
    if (thread.lastTurn?.outcome !== "completed" || m.followup) return;
    if ((thread.awaitingReplies?.length ?? 0) > 0 || (thread.deliveries?.length ?? 0) > 0 || live) return;
    if (hasUnansweredDecisions(thread, this.deps.turns)) return;
    if (m.wakes >= m.frame.maxWakes) {
      await this.deps.projectThread.finishMission(threadId, m.id, "exhausted", "起きる回数の上限を使い切りました");
    } else {
      await this.deps.projectThread.finishMission(threadId, m.id, "stalled", "予約も終わりも無いままターンが終わりました");
    }
  }

  // ---- 時計・出来事 ----------------------------------------------------------------------------------------

  /** 会話が空いていなければ理由（自動化の「前の回が終わっていない」と同じ手がかりに、答えていない決めることを足す） */
  wakeBlocker(thread: ThreadState): string | undefined {
    if (this.deps.turns.isRunning(thread.id)) return "ターンが走っています";
    if (this.deps.turns.queued(thread.id) > 0) return "人の発言が順番を待っています";
    if ((thread.deliveries ?? []).length > 0) return "まだ会話に積んでいない届けものがあります";
    if ((thread.awaitingReplies ?? []).length > 0) return "裏の仕事の返事を待っています";
    if (this.deps.inbox.listJudgmentsForThread(thread.id).some((j) => j.liveness === "live")) return "人の判断を待っています";
    if (hasUnansweredDecisions(thread, this.deps.turns)) return "答えていない「決めること」があります";
    return undefined;
  }

  /** **時計の刻み**（自動化の1分の刻みから呼ぶ）。重ならない */
  tick(): Promise<MissionTickReport> {
    if (this.ticking) return this.ticking;
    this.ticking = this.step()
      .catch((err: unknown) => {
        this.log(`[host] 任務の時計の刻みで例外: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
        return { woke: [], expired: [] };
      })
      .finally(() => {
        this.ticking = undefined;
      });
    return this.ticking;
  }

  private async step(): Promise<MissionTickReport> {
    const report: MissionTickReport = { woke: [], expired: [] };
    const now = this.now().getTime();
    for (const project of this.deps.projectThread.listProjects()) {
      if (project.status === "closed") continue;
      for (const thread of this.deps.projectThread.listThreadsForProject(project.id)) {
        const m = thread.mission;
        if (!m || m.status !== "active" || thread.status !== "active") continue;
        try {
          if (Date.parse(m.frame.until) <= now) {
            // ターンが走っていれば、その終わり（`turnEnded`）で止める——カードはそのターンのものに添わる
            if (this.deps.turns.isRunning(thread.id)) continue;
            await this.expire(thread, m);
            report.expired.push(thread.id);
            continue;
          }
          const due = this.dueOf(m, now);
          if (!due) continue;
          if (m.wakes >= m.frame.maxWakes) continue;
          if (project.move) continue;
          if (this.wakeBlocker(thread)) continue;
          await this.wake(thread, m, due.cause, due.scheduledFor);
          report.woke.push(thread.id);
        } catch (err) {
          this.log(`[host] ${thread.id} の任務を時計で扱えませんでした: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }
    return report;
  }

  /** 予約の時刻が来たか。来ていればきっかけと、予定の時刻（遅れて起こすとき） */
  private dueOf(m: MissionState, now: number): { cause: MissionWakeCause; scheduledFor?: string } | undefined {
    const f = m.followup;
    if (!f) return undefined;
    if (f.at !== undefined && Date.parse(f.at) <= now) {
      const late = now - Date.parse(f.at) > 2 * MINUTE;
      return { cause: f.received ? "event" : "time", ...(late ? { scheduledFor: f.at } : {}) };
    }
    if (f.at === undefined && f.event && Date.parse(f.event.until) <= now) return { cause: "event-timeout" };
    return undefined;
  }

  /**
   * **時計の刻みで期限を過ぎて止めた**（ターンが無い）。ターンの外から、その会話のレビュー待ちを出す（未確認があればそれに結末を
   * 添える）
   */
  private async expire(thread: ThreadState, m: MissionState): Promise<void> {
    await this.deps.projectThread.finishMission(thread.id, m.id, "exhausted", "期限を過ぎました");
    const after = this.deps.projectThread.getThread(thread.id)?.mission;
    if (!after) return;
    await this.deps.inbox.raiseMissionOutcome({ threadId: thread.id, summary: missionOutcomeLine(after), mission: reviewMissionOf(after) });
  }

  /** **起こす**。数えるのはここ（ターンを起こした時点）。予約はここで使い切る */
  private async wake(thread: ThreadState, m: MissionState, cause: MissionWakeCause, scheduledFor?: string): Promise<void> {
    const wake = m.wakes + 1;
    const followup = m.followup;
    await this.deps.projectThread.recordMissionWake(thread.id, { missionId: m.id, wake, cause, ...(scheduledFor ? { scheduledFor } : {}) });
    const external: ExternalContent[] = followup?.received
      ? [
          {
            source: "event",
            receivedAt: followup.received.at,
            body: followup.received.text ?? "",
            ...(followup.received.truncatedFrom !== undefined ? { truncatedFrom: followup.received.truncatedFrom } : {}),
            event: {
              name: followup.received.name,
              title: followup.received.title,
              eventId: followup.received.eventId,
              occurredAt: followup.received.occurredAt,
              fields: followup.received.fields,
            },
          },
        ]
      : [];
    await this.deps.deliveries.deliver({
      threadId: thread.id,
      from: "banto",
      title: `任務「${oneLine(m.goal, 40)}」（${wake}/${m.frame.maxWakes} 回目）`,
      text: composeWakeText(m, wake, cause, followup),
      // ホップは 0 から（任務の枠が回数を抑える、§4.4）
      hop: 0,
      kind: "mission",
      // 会話の薄い1行に出す分（v4-frontend.md §6.47）——起こした時点の上限と前の予約のメモ
      mission: { id: m.id, wake, maxWakes: m.frame.maxWakes, ...(followup ? { note: oneLine(followup.note, 200) } : {}) },
      ...(external.length > 0 ? { external } : {}),
    });
  }

  /**
   * **出来事が来た**（自動化の出来事と同じ照合、§4.3 段2）。待っている任務の予約に、来たものと起こす時刻（来た時刻か、前に
   * 起こした時刻＋最短の間隔の遅いほう）を付けて置き直し、刻みを1回回す。置き直した数を返す
   */
  async receiveEvent(
    projectId: string,
    declared: EventDeclaration,
    event: { eventId: string; occurredAt: string; fields: Record<string, EventFieldValue>; text?: string; truncatedFrom?: number },
  ): Promise<number> {
    const now = this.now();
    let matched = 0;
    for (const thread of this.deps.projectThread.listThreadsForProject(projectId)) {
      const m = thread.mission;
      const f = m?.followup;
      if (!m || m.status !== "active" || !f?.event || f.at !== undefined || thread.status !== "active") continue;
      if (f.event.name !== declared.name || !eventMatchesWhere(f.event.where, event.fields)) continue;
      const earliest = m.lastWakeAt ? Date.parse(m.lastWakeAt) + m.frame.minIntervalMinutes * MINUTE : now.getTime();
      await this.deps.projectThread.setMissionFollowup(thread.id, m.id, {
        ...f,
        at: new Date(Math.max(now.getTime(), earliest)).toISOString(),
        received: {
          at: now.toISOString(),
          name: declared.name,
          title: declared.title,
          eventId: event.eventId,
          occurredAt: event.occurredAt,
          fields: event.fields,
          ...(event.text !== undefined ? { text: event.text } : {}),
          ...(event.truncatedFrom !== undefined ? { truncatedFrom: event.truncatedFrom } : {}),
        },
      });
      matched++;
    }
    if (matched > 0) void this.tick();
    return matched;
  }

  /** **その Project で待たれている出来事**（「待たれている Module を起こしておく」に乗せる、§4.3 段2） */
  awaitedEvents(projectId: string): Array<{ missionId: string; label: string; event: string }> {
    return this.deps.projectThread.listThreadsForProject(projectId).flatMap((t) => {
      const m = t.mission;
      const f = m?.followup;
      if (!m || m.status !== "active" || !f?.event || f.at !== undefined || t.status !== "active") return [];
      return [{ missionId: m.id, label: `任務「${oneLine(m.goal, 40)}」`, event: f.event.name }];
    });
  }

  // ---- 人に聞く ----------------------------------------------------------------------------------------------

  /** 入力の誤り・今はできないは、AI が読んで直せる文で返す。それ以外は投げる（規則2） */
  private async guard(fn: () => Promise<MissionToolResult>): Promise<MissionToolResult> {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof MissionInputError || err instanceof MissionConflictError) return { ok: false, text: err.message };
      // 出来事の名乗りの照合（自動化の決まり）が断った
      if (err instanceof AutomationInputError) return { ok: false, text: err.message };
      throw err;
    }
  }

  /**
   * **会話のカードで人に聞く**（自動化の確認と同じ形、`automation/tools.ts`）。承認モード・自動許可を見ない。枠の欄（form）を
   * 添え、許されたら欄の値（`updatedInput`）も返す
   */
  private async ask(
    threadId: string,
    message: string,
    toolInput: Record<string, unknown>,
    requestedSchema: Record<string, unknown>,
    signal: AbortSignal | undefined,
  ): Promise<{ allowed: boolean; note: string; values?: Record<string, unknown> }> {
    if (signal?.aborted) return { allowed: false, note: "（ターンが止まりました）" };
    const choices = [...MISSION_START_CHOICES];
    const judgment = await this.deps.inbox.raiseJudgment({
      threadId,
      source: "mission",
      message,
      serverName: "banto",
      toolInput,
      choices,
      mode: "form",
      requestedSchema,
    });
    this.deps.publishJudgment?.(threadId, { id: judgment.id, message, serverName: "banto", toolInput, choices, requestedSchema });

    let folding: Promise<unknown> | undefined;
    const answer = await new Promise<{ behavior: string; message?: unknown; updatedInput?: unknown }>((resolve) => {
      this.deps.pendingApprovals.register(judgment.id, (result) => resolve(result as { behavior: string }));
      const fold = (): void => {
        const denied = { behavior: "deny" as const, message: "ターンが止まりました" };
        if (this.deps.pendingApprovals.resolve(judgment.id, denied)) {
          folding = this.deps.inbox.answerJudgment(judgment.id, denied).catch((err: unknown) => {
            this.log(`[mission] 止めたターンの判断待ち ${judgment.id} を畳めませんでした: ${String(err)}`);
          });
        }
      };
      if (signal?.aborted) fold();
      else signal?.addEventListener("abort", fold, { once: true });
    });
    if (folding) await folding;
    if (signal?.aborted) return { allowed: false, note: "（ターンが止まりました）" };
    if (answer.behavior === "allow") {
      const values = typeof answer.updatedInput === "object" && answer.updatedInput !== null ? (answer.updatedInput as Record<string, unknown>) : undefined;
      return { allowed: true, note: "", ...(values ? { values } : {}) };
    }
    return { allowed: false, note: typeof answer.message === "string" && answer.message !== "" ? `（答え：${answer.message}）` : "" };
  }
}

const CAUSE_TEXT: Record<MissionWakeCause, string> = {
  time: "予約した時刻になりました。",
  event: "待っていた出来事が来ました（中身は下の囲み）。",
  "event-timeout": "待っていた出来事は、待つ上限までに来ませんでした。",
  human: "人が「今すぐ起こす」を押しました。",
};

/** **起こすときに AI へ渡す文**。banto が作る（目標・終わりの条件・何回目か・残り・前の予約のメモ・きっかけ） */
export function composeWakeText(m: MissionState, wake: number, cause: MissionWakeCause, followup: MissionFollowup | undefined): string {
  const waited = followup?.event ? `待っていた出来事：${followup.event.name}（${followup.event.title ?? ""}）` : undefined;
  return [
    `この会話の任務の続きです（${wake}/${m.frame.maxWakes} 回目）。`,
    `目標：${m.goal}`,
    `終わりの条件：${m.doneWhen}`,
    `残り：あと ${m.frame.maxWakes - wake} 回・期限 ${formatAt(m.frame.until)}・最短の間隔 ${m.frame.minIntervalMinutes} 分`,
    `きっかけ：${CAUSE_TEXT[cause]}`,
    ...(waited ? [waited] : []),
    ...(followup ? [`前に予約したときのメモ：${followup.note}`] : []),
    "",
    "続けるなら schedule_followup で次を予約し、終わりの条件を満たしたら finish_mission で終えてください。予約も終わりも無いままターンを終えることはできません。",
  ].join("\n");
}

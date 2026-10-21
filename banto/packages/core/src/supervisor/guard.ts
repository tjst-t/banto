// **番頭の守り**（決定・2026-10-21、ユーザー。アーキ仕様 §4.5「守り」、Backlog #510）。自動許可の絞りはここに無い（人の決定待ち）。
//
// - **量**：Claude のアカウントが全部閾値を越えている・全部の番頭の1時間の回が上限（`supervisor.limits.runsPerHour`）に届いている、なら
//   番頭の回を飛ばす（`AutomationRunner` が引く）。飛ばした回に届いていた決めることは人に残す——判断役が「人に任せました」と同じく
//   カードに `deferred`（番頭の印つき）を付け、記録に `skipped` と `deferred` を残す。指示の上限（`instructionsPerHour`）は
//   `instruct_thread` が断る（`instruct.ts`）。数えは全部、番頭の記録と自動化の回（fold）から——数えを別に持たない（規則3）
// - **全部止める・全部再開する**：止めた理由（全部止めた／Project ごと）は一時停止の `scope` で分け、全部再開はその印のものだけを再開する
// - **記録・取り消し・1日のまとめ**：番頭の記録（`automation.supervisor_acted`）を読む人の口。取り消しは巻き戻さない——選んだ・頼んだ
//   ものは元の会話に人の発言を送り、Factory に流したものは `cancelFactory` を呼ぶ。取り消したことも記録（`undone`）

import type { Automation, AutomationReceived, AutomationRun, SupervisorAct } from "../automation/fold.js";
import type { AutomationStore } from "../automation/store.js";
import { PATROL_SKIPPED_OVER_THRESHOLD } from "../automation/runner.js";
import { isJudgeAutomation, TURN_DECISIONS_EVENT } from "../automation/turn-decisions.js";
import type { ThreadTurns } from "../delivery/thread-turns.js";
import type { InboxStore } from "../inbox/store.js";
import type { ProjectThreadStore } from "../project-thread/store.js";
import { ACTION_TITLES, isDecisionKind, type SupervisorPolicy } from "./policy.js";
import { SupervisorConflictError, SupervisorNotFoundError, type Supervisors, type SupervisorView } from "./supervisors.js";

/** 全部止めたときの一時停止の理由（画面にそのまま出る） */
export const SUPERVISOR_STOP_ALL_REASON = "番頭を全部止めました（人が再開するまで動きません）";
/** 全部止めたときに捨てた指示の理由 */
export const SUPERVISOR_STOP_ALL_DROP_REASON = "番頭を全部止めたので、始まる前の指示を捨てました";
/** 取り消しの文（人が直したもの）の長さの上限 */
export const SUPERVISOR_UNDO_TEXT_MAX_CHARS = 2000;
/** 記録の口が返す件数の既定と上限 */
const LOG_LIMIT_DEFAULT = 200;
const LOG_LIMIT_MAX = 1000;

const HOUR_MS = 60 * 60 * 1000;

/** 取り消せる記録の種類 */
const UNDOABLE_KINDS: ReadonlySet<SupervisorAct["kind"]> = new Set(["answered", "instructed", "factory-started"]);

/** 人の口の入力が正しくない（HTTP は 400） */
export class SupervisorInputError extends Error {}

/** 全体の上限の今の数え（全部の番頭の合計、直近 1 時間） */
export interface SupervisorLimitsView {
  runs: { used: number; limit: number };
  instructions: { used: number; limit: number };
  /** 上限に届いているものが、この時刻に1つ空く（届いていなければ無い） */
  runsFreeAt?: string;
  instructionsFreeAt?: string;
}

/** 番頭の守りの今（`GET /api/supervisors` に添える） */
export interface SupervisorGuardView extends SupervisorLimitsView {
  /** 全部止めて止まっている番頭がある */
  stoppedAll: boolean;
}

/** その回の届けもの（出来事）が番頭の回で数える回か——飛ばした・断った回は数えない */
function countedRun(run: AutomationRun): boolean {
  return run.result !== "skipped" && run.result !== "rejected";
}

function supervisorAutomations(automations: Pick<AutomationStore, "listAll">): Automation[] {
  return automations.listAll().filter((a) => a.mode === "supervisor" && a.supervisorId !== undefined);
}

/** 窓の中のものの数と、上限に届いているなら1つ空く時刻 */
function windowCount(times: readonly string[], limit: number, now: Date): { used: number; freeAt?: string } {
  const since = now.getTime() - HOUR_MS;
  const inside = times.map((t) => Date.parse(t)).filter((t) => t > since).sort((a, b) => a - b);
  const used = inside.length;
  if (used < limit) return { used };
  // 上限ちょうどなら一番古いものが窓を出たとき、越えていればその分だけ後のものが出たときに1つ空く
  const at = inside[used - limit];
  return { used, ...(at !== undefined ? { freeAt: new Date(at + HOUR_MS).toISOString() } : {}) };
}

/**
 * **全体の上限の今の数え**。回は番頭の自動化の回（届けた回だけ。飛ばした・断った回は数えない）、指示は番頭の記録の `instructed`
 */
export function supervisorLimitsOf(
  automations: Pick<AutomationStore, "listAll">,
  limits: Pick<SupervisorPolicy["limits"], "runsPerHour" | "instructionsPerHour">,
  now: Date,
): SupervisorLimitsView {
  const list = supervisorAutomations(automations);
  const runLimit = Math.max(0, Math.floor(limits.runsPerHour));
  const instructionLimit = Math.max(0, Math.floor(limits.instructionsPerHour));
  const runs = windowCount(
    list.flatMap((a) => a.runs.filter(countedRun).map((r) => r.at)),
    runLimit,
    now,
  );
  const instructions = windowCount(
    list.flatMap((a) => (a.supervisorActs ?? []).filter((x) => x.kind === "instructed").map((x) => x.at)),
    instructionLimit,
    now,
  );
  return {
    runs: { used: runs.used, limit: runLimit },
    instructions: { used: instructions.used, limit: instructionLimit },
    ...(runs.freeAt ? { runsFreeAt: runs.freeAt } : {}),
    ...(instructions.freeAt ? { instructionsFreeAt: instructions.freeAt } : {}),
  };
}

/** 指示の上限に届いていれば、断る理由（`instruct_thread` が引く） */
export function instructionLimitReason(
  automations: Pick<AutomationStore, "listAll">,
  policy: Pick<SupervisorPolicy, "limits">,
  now: Date,
): string | undefined {
  const { instructions } = supervisorLimitsOf(automations, policy.limits, now);
  if (instructions.used < instructions.limit) return undefined;
  return `全部の番頭で1時間に送れる指示は ${instructions.limit} 件までです（いま ${instructions.used} 件）。この時間は人に回してください`;
}

export interface SupervisorSkipDeps {
  automations: Pick<AutomationStore, "listAll">;
  policy(projectId: string): Pick<SupervisorPolicy, "limits">;
  /** その Project の Claude のアカウントが全部閾値を越えているか。無ければ越えていない */
  allAccountsOver?(projectId: string): boolean;
  now?: () => Date;
}

/**
 * **その Project の番頭の回を飛ばす理由**（無ければ undefined）。アカウントの閾値と全体の1時間の回の上限。画面の「この時間は人に回して
 * います」もこれを引く（写しを持たない）
 */
export function supervisorSkipReason(projectId: string, deps: SupervisorSkipDeps): string | undefined {
  if (deps.allAccountsOver?.(projectId)) return `${PATROL_SKIPPED_OVER_THRESHOLD}（この間の決めることは人に残します）`;
  const { runs } = supervisorLimitsOf(deps.automations, deps.policy(projectId).limits, deps.now?.() ?? new Date());
  if (runs.used >= runs.limit) {
    return `全部の番頭で1時間に起きる回は ${runs.limit} 回までです（いま ${runs.used} 回）。この時間は人に回しています`;
  }
  return undefined;
}

/** 記録の口の1件（記録に、どの番頭・自動化のものかと、取り消しの様子を添えたもの。添えたものは保存しない） */
export interface SupervisorLogEntry extends SupervisorAct {
  actId: string;
  supervisorId: string;
  projectId: string;
  automationId: string;
  /** 取り消せる（選んだ・頼んだ・流したもので、まだ取り消していない） */
  undoable: boolean;
  /** 取り消した記録の id（取り消していれば） */
  undoneBy?: string;
}

export interface SupervisorLogFilter {
  projectId?: string;
  threadId?: string;
  kinds?: readonly string[];
  limit?: number;
}

/** 1日のまとめの1行（Project ごと） */
export interface SupervisorDailyRow {
  projectId: string;
  supervisorId: string;
  /** 記録の種類ごとの件数（選んだ answered・頼んだ instructed・流した factory-started・人に回した deferred・断られた refused ほか） */
  counts: Record<SupervisorAct["kind"], number>;
}

export interface SupervisorDaily {
  date: string;
  timeZone: string;
  projects: SupervisorDailyRow[];
}

/** 取り消しを実際に行う口（HTTP の層が渡す——人の発言のターンと Module の呼び出しはそちらにある） */
export interface SupervisorUndoExec {
  /** 元の会話に人の発言として送る（受け付けたら返す。ターンの終わりは待たない） */
  sendAsHuman(threadId: string, text: string): Promise<void>;
  /** その Project の Factory の `cancelFactory`（実行ごと） */
  cancelFactory(projectId: string, runId: string, reason: string): Promise<void>;
}

export interface SupervisorUndoResult {
  undone: SupervisorLogEntry[];
  /** 人の発言を送った会話と文（選んだ・頼んだもの） */
  sent?: { threadId: string; text: string };
  /** 取りやめた Factory の実行（流したもの） */
  cancelled?: { runId: string };
}

export interface SupervisorStopAllResult {
  /** 一時停止した番頭 */
  paused: string[];
  /** 止めた番頭の会話のターン */
  stoppedTurns: string[];
  /** 捨てた指示（宛先の会話と指示の id） */
  dropped: Array<{ threadId: string; actionId: string }>;
  supervisors: SupervisorView[];
}

export interface SupervisorControlsDeps {
  automations: AutomationStore;
  projectThread: Pick<ProjectThreadStore, "getThread" | "listProjects" | "listThreadsForProject" | "dropDeliveries">;
  turns: Pick<ThreadTurns, "isRunning">;
  inbox: Pick<InboxStore, "judgeReviews">;
  supervisors: Supervisors;
  policy(projectId: string): SupervisorPolicy;
  allAccountsOver?(projectId: string): boolean;
  /**
   * **番頭の回の途中の答えを人に回す**（`TurnDecisions.endTurn`——「揃わないまま終わった」と同じ）。全部止めるときに、ターンを止める前に
   * 呼ぶ。無ければ、止めたターンの終わりで同じことが起きる
   */
  handOverDecisions?(supervisorThreadId: string): Promise<void>;
  /** 方針にタイムゾーンが無いときの既定。無ければ banto が動いている場所のもの */
  defaultTimeZone?: string;
  now?: () => Date;
  log?: (message: string) => void;
}

export class SupervisorControls {
  /** 取り消している途中の記録（同じものを同時に2回取り消さない） */
  private readonly undoing = new Set<string>();

  constructor(private readonly deps: SupervisorControlsDeps) {}

  /** 守りの今（全部止めているか・全体の上限の数え） */
  status(): SupervisorGuardView {
    // 数の設定は全体の層だけを読む（`supervisorPolicy`）——どの Project で引いても同じ
    const limits = this.deps.policy("-").limits;
    return {
      stoppedAll: supervisorAutomations(this.deps.automations).some((a) => a.paused && a.pausedScope === "stop-all"),
      ...supervisorLimitsOf(this.deps.automations, limits, this.now()),
    };
  }

  /** その Project の番頭の回をいま飛ばす理由（画面の「この時間は人に回しています」） */
  handedToHuman(projectId: string): string | undefined {
    return supervisorSkipReason(projectId, { ...this.deps, now: () => this.now() });
  }

  /**
   * **番頭の回を飛ばした**（`AutomationRunner` が量で飛ばしたあとに呼ぶ）。記録に `skipped`、届いていた決めることは人に残す——その会話の
   * カードに「番頭が人に回した」（`deferred`）を付け、記録に `deferred` を残す（見回りが同じ会話を拾い直さない・1日のまとめの「人に回した」）
   */
  async skipped(automation: Automation, received: readonly AutomationReceived[], reason: string): Promise<void> {
    if (automation.mode !== "supervisor") return;
    const forkId = automation.target.kind === "dedicated" ? (automation.target.threadId ?? "") : "";
    await this.record(automation.id, { kind: "skipped", threadId: forkId, reason });
    if (!isJudgeAutomation(automation)) return;
    const handed = new Map<string, string>();
    for (const r of received) {
      if (r.kind !== "event" || r.name !== TURN_DECISIONS_EVENT) continue;
      const thread = r.fields.thread;
      const turnId = r.fields.turnId;
      if (typeof thread === "string" && typeof turnId === "string") handed.set(thread, turnId);
    }
    const why = `番頭はこの回を飛ばしました（${reason}）。人が決めてください`;
    for (const [threadId, turnId] of handed) {
      try {
        await this.deps.inbox.judgeReviews(threadId, {
          kind: "deferred",
          automation: { id: automation.id, name: automation.name },
          by: "supervisor",
          reason: why,
          at: this.now().toISOString(),
        });
      } catch (err) {
        this.warn(`[host] 番頭が飛ばした回の決めることを ${threadId} のカードに添えられませんでした: ${err instanceof Error ? err.message : String(err)}`);
      }
      await this.record(automation.id, { kind: "deferred", threadId, turnId, reason: why });
    }
  }

  /**
   * **番頭を全部止める**（人が押す）。(a) 全部の番頭の自動化を一時停止し（理由「全部止めた」）、走っている番頭のターンを止める
   * (b) 宛先にまだ始まっていない番頭の指示を捨てる（記録 `dropped`）(c) `answer_decision` の途中の答えは人に回す。番頭が流した
   * Factory の件は止めない
   */
  async stopAll(hooks: { stopTurn(threadId: string): Promise<unknown> }): Promise<SupervisorStopAllResult> {
    const paused = new Set<string>();
    const forks = new Set<string>();
    for (const a of supervisorAutomations(this.deps.automations)) {
      if (a.target.kind === "dedicated" && a.target.threadId) forks.add(a.target.threadId);
      // Project ごとに止めているもの・Fork を閉じて止まったものはそのまま（全部を再開しても残す）
      if (a.paused) continue;
      await this.deps.automations.pause(a.id, SUPERVISOR_STOP_ALL_REASON, { scope: "stop-all" });
      paused.add(a.supervisorId!);
    }
    // (c) を先に——ターンを止めている間に答えが揃って届かないように、途中の答えの預かりを人に回してから止める
    const stoppedTurns: string[] = [];
    for (const forkId of forks) {
      try {
        await this.deps.handOverDecisions?.(forkId);
      } catch (err) {
        this.warn(`[host] 番頭の途中の答えを人に回せませんでした（${forkId}）: ${err instanceof Error ? err.message : String(err)}`);
      }
      if (!this.deps.turns.isRunning(forkId)) continue;
      await hooks.stopTurn(forkId);
      stoppedTurns.push(forkId);
    }
    const dropped = await this.dropPendingInstructions();
    return { paused: [...paused], stoppedTurns, dropped, supervisors: this.deps.supervisors.list() };
  }

  /** **全部止めたものを再開する**（人が押す）。Project ごとに止めたものは再開しない */
  async resumeAll(): Promise<SupervisorView[]> {
    const ids = new Set(
      supervisorAutomations(this.deps.automations)
        .filter((a) => a.paused && a.pausedScope === "stop-all")
        .map((a) => a.supervisorId!),
    );
    for (const id of ids) {
      // 4件のうち1件でも Project ごと・Fork を閉じて止まっていれば、その番頭は人が Project ごとに再開する
      const group = supervisorAutomations(this.deps.automations).filter((a) => a.supervisorId === id);
      if (group.some((a) => a.paused && a.pausedScope !== "stop-all")) continue;
      await this.deps.supervisors.resume(id);
    }
    return this.deps.supervisors.list();
  }

  /** **番頭の記録**（全部の番頭の、新しい順）。Project・会話・種類で絞る */
  log(filter: SupervisorLogFilter = {}): SupervisorLogEntry[] {
    const kinds = filter.kinds && filter.kinds.length > 0 ? new Set(filter.kinds) : undefined;
    const limit = Math.min(LOG_LIMIT_MAX, Math.max(1, Math.floor(filter.limit ?? LOG_LIMIT_DEFAULT)));
    return this.entries()
      .filter((e) => (filter.projectId === undefined || e.projectId === filter.projectId) && (filter.threadId === undefined || e.threadId === filter.threadId))
      .filter((e) => kinds === undefined || kinds.has(e.kind))
      .slice(0, limit);
  }

  /**
   * **取り消す**（人が押す）。選んだもの（同じターンに届けた問いは全部一緒に）・頼んだものは、元の会話に人の発言として送る
   * （既定の文は「番頭の〈選んだ「…」／頼み「…」〉は取り消して。その前に戻して」、人が `text` で直せる）。Factory に流したものは
   * その実行を `cancelFactory` で取りやめる。巻き戻す仕組みは作らない。同じものは2回取り消せない
   */
  async undo(actId: string, input: { text?: string }, exec: SupervisorUndoExec): Promise<SupervisorUndoResult> {
    const all = this.entries();
    const target = all.find((e) => e.actId === actId);
    if (!target) throw new SupervisorNotFoundError(`番頭の記録が見つかりません: ${actId}`);
    if (!UNDOABLE_KINDS.has(target.kind)) {
      throw new SupervisorConflictError("取り消せるのは、番頭が選んだ答え・頼んだ手順・Factory に流したものだけです");
    }
    // 選んだ答えは、同じターンへ一緒に届けた問いを全部まとめて取り消す（届けたのは1回なので）
    const group =
      target.kind === "answered"
        ? all
            .filter((e) => e.kind === "answered" && e.supervisorId === target.supervisorId && e.threadId === target.threadId && e.turnId === target.turnId)
            .sort((a, b) => (a.question ?? 0) - (b.question ?? 0))
        : [target];
    if (group.some((e) => e.undoneBy !== undefined) || group.some((e) => this.undoing.has(e.actId))) {
      throw new SupervisorConflictError("これはもう取り消しました");
    }
    if (target.kind === "instructed" && all.some((e) => e.kind === "dropped" && e.actionId !== undefined && e.actionId === target.actionId)) {
      throw new SupervisorConflictError("この頼みは始まる前に捨てられています（取り消すものがありません）");
    }
    const text = input.text?.trim();
    if (input.text !== undefined && (text === undefined || text === "")) throw new SupervisorInputError("text が空です");
    if (text !== undefined && text.length > SUPERVISOR_UNDO_TEXT_MAX_CHARS) {
      throw new SupervisorInputError(`text は ${SUPERVISOR_UNDO_TEXT_MAX_CHARS} 字までです（${text.length} 字）`);
    }
    if (target.kind === "factory-started" && text !== undefined) {
      throw new SupervisorInputError("Factory に流したものの取り消しは cancelFactory で取りやめるだけで、文は送りません（text を外してください）");
    }

    for (const e of group) this.undoing.add(e.actId);
    try {
      const undoes = group.map((e) => e.actId);
      if (target.kind === "factory-started") {
        if (!target.runId) throw new SupervisorConflictError("この記録には Factory の実行の id がありません");
        const reason = "人が番頭の流したものを取り消しました";
        await exec.cancelFactory(target.projectId, target.runId, reason);
        await this.record(target.automationId, { kind: "undone", threadId: target.threadId, runId: target.runId, undoes, reason });
        return { undone: group, cancelled: { runId: target.runId } };
      }
      const thread = this.deps.projectThread.getThread(target.threadId);
      if (!thread || thread.status !== "active") throw new SupervisorConflictError("元の会話はもう閉じられています（送れません）");
      const message = text ?? defaultUndoText(group);
      await exec.sendAsHuman(target.threadId, message);
      await this.record(target.automationId, {
        kind: "undone",
        threadId: target.threadId,
        ...(target.turnId ? { turnId: target.turnId } : {}),
        ...(target.actionId ? { actionId: target.actionId } : {}),
        undoes,
        reason: text !== undefined ? "人が取り消しました（文を直して送りました）" : "人が取り消しました",
      });
      return { undone: group, sent: { threadId: target.threadId, text: message } };
    } finally {
      for (const e of group) this.undoing.delete(e.actId);
    }
  }

  /**
   * **1日のまとめ**（Project ごとの件数）。1日は `supervisor.timeZone`（無ければ動いている場所）の日付。`date` が無ければ今日。
   * 記録は1件の自動化につき直近 100 件までなので、それより古い分は数えられない
   */
  daily(date?: string): SupervisorDaily {
    const timeZone = this.timeZone();
    const day = date ?? dayKey(this.now(), timeZone);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new SupervisorInputError("date は YYYY-MM-DD で渡してください");
    const rows = new Map<string, SupervisorDailyRow>();
    for (const s of this.deps.supervisors.list()) rows.set(s.id, { projectId: s.projectId, supervisorId: s.id, counts: emptyCounts() });
    for (const e of this.entries()) {
      if (dayKey(new Date(e.at), timeZone) !== day) continue;
      const row = rows.get(e.supervisorId) ?? { projectId: e.projectId, supervisorId: e.supervisorId, counts: emptyCounts() };
      row.counts[e.kind] += 1;
      rows.set(e.supervisorId, row);
    }
    return { date: day, timeZone, projects: [...rows.values()] };
  }

  // ---- 内側 ---------------------------------------------------------------------------------------------------

  /** 全部の番頭の記録（新しい順）。取り消しの様子を添える */
  private entries(): SupervisorLogEntry[] {
    const raw = supervisorAutomations(this.deps.automations).flatMap((a) =>
      (a.supervisorActs ?? []).map((act) => ({
        ...act,
        actId: act.actId ?? "",
        supervisorId: a.supervisorId!,
        projectId: a.projectId,
        automationId: a.id,
      })),
    );
    const undoneBy = new Map<string, string>();
    for (const e of raw) if (e.kind === "undone") for (const id of e.undoes ?? []) undoneBy.set(id, e.actId);
    const dropped = new Set(raw.filter((e) => e.kind === "dropped" && e.actionId).map((e) => e.actionId!));
    return raw
      .map((e): SupervisorLogEntry => {
        const by = undoneBy.get(e.actId);
        const undoable = UNDOABLE_KINDS.has(e.kind) && by === undefined && !(e.kind === "instructed" && e.actionId !== undefined && dropped.has(e.actionId));
        return { ...e, undoable, ...(by ? { undoneBy: by } : {}) };
      })
      .sort((a, b) => b.at.localeCompare(a.at));
  }

  /** (b) 宛先にまだ始まっていない番頭の指示を捨てる */
  private async dropPendingInstructions(): Promise<Array<{ threadId: string; actionId: string }>> {
    const dropped: Array<{ threadId: string; actionId: string }> = [];
    for (const project of this.deps.projectThread.listProjects()) {
      for (const thread of this.deps.projectThread.listThreadsForProject(project.id)) {
        const pending = (thread.deliveries ?? []).filter((d) => d.supervisor);
        if (pending.length === 0) continue;
        await this.deps.projectThread.dropDeliveries(
          thread.id,
          pending.map((d) => d.deliveryId),
          SUPERVISOR_STOP_ALL_DROP_REASON,
        );
        for (const d of pending) {
          const origin = d.supervisor!;
          const instructed = this.deps.automations
            .get(origin.automationId)
            ?.supervisorActs?.find((a) => a.kind === "instructed" && a.actionId === origin.actionId);
          await this.record(origin.automationId, {
            kind: "dropped",
            threadId: thread.id,
            actionId: origin.actionId,
            ...(instructed?.action ? { action: instructed.action } : {}),
            reason: SUPERVISOR_STOP_ALL_DROP_REASON,
          });
          dropped.push({ threadId: thread.id, actionId: origin.actionId });
        }
      }
    }
    return dropped;
  }

  /** 番頭の記録に書く。番頭の自動化が消えていたら書けない——書き残す */
  private async record(automationId: string, act: Omit<SupervisorAct, "at">): Promise<void> {
    try {
      await this.deps.automations.recordSupervisorAct(automationId, { at: this.now().toISOString(), ...act });
    } catch (err) {
      this.warn(`[host] 番頭の記録を書けませんでした（${act.kind}）: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private timeZone(): string {
    return this.deps.policy("-").timeZone ?? this.deps.defaultTimeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  }

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  private warn(message: string): void {
    (this.deps.log ?? console.warn)(message);
  }
}

/** 取り消しの既定の文（アーキ仕様 §4.5「取り消し」） */
export function defaultUndoText(group: readonly Pick<SupervisorAct, "kind" | "label" | "question" | "action">[]): string {
  const first = group[0];
  if (first?.kind === "instructed") {
    const title = first.action && isDecisionKind(first.action) ? ACTION_TITLES[first.action] : (first.action ?? "");
    return `番頭の頼み「${title}」は取り消して。その前に戻して`;
  }
  const choices = group.map((e) => `「${e.label ?? ""}」${group.length > 1 && e.question !== undefined ? `（問い ${e.question}）` : ""}`).join("・");
  return `番頭の選んだ${choices}は取り消して。その前に戻して`;
}

function emptyCounts(): Record<SupervisorAct["kind"], number> {
  return {
    answered: 0,
    deferred: 0,
    refused: 0,
    instructed: 0,
    dropped: 0,
    "factory-started": 0,
    "factory-answered": 0,
    skipped: 0,
    undone: 0,
  };
}

/** そのタイムゾーンの日付（YYYY-MM-DD）。読めないタイムゾーンは UTC で数える（`instruct.ts` の1日の数えと同じ） */
export function dayKey(date: Date, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
  } catch {
    return date.toISOString().slice(0, 10);
  }
}

// docs/specs/v4-architecture.md §4.3「人と AI の作り方」——**AI が会話の tool から自動化を作る・直す口**の中身。
// tool の形（名前・引数・説明）は `http/fork-tool.ts`（`banto-thread`）、ここは確かめて台帳に書くところ。
//
// - **作る・変える・再開する・消すは、承認モードにも Project の「承認をすべて自動で許可する」にも依らず、会話のカードで必ず
//   人に聞く**——自動化は人が見ていない時間に繰り返し動く「立ち続ける許し」で、1回きりの操作とは性質が違う。自動化で
//   起きたターンの中から呼ばれても同じく聞く（v4-frontend.md §6.42「AI が作るときのカード」）
// - 一覧と一時停止は聞かない（止める方向は危なくない）
// - 触れるのは**呼んだ Thread の Project の自動化だけ**。入力の確かめは台帳（`store.ts`）に1つ——画面の口と同じ決まりで断る
// - **Webhook の URL（印）は AI に返さない**。返す形はここで欄を選んで組む（台帳の形をそのまま渡さない——後から台帳に
//   足した欄が黙って AI に漏れないように）

import type { InboxStore } from "../inbox/store.js";
import type { PendingApprovalRegistry } from "../inbox/pending-approvals.js";
import type { ProjectThreadStore } from "../project-thread/store.js";
import type { Automation, AutomationRepeat, AutomationSource, AutomationTarget } from "./fold.js";
import {
  AutomationInputError,
  AutomationNotFoundError,
  parseAutomationChanges,
  parseAutomationFields,
  type AutomationStore,
} from "./store.js";
import type { AutomationRunner } from "./runner.js";
import type { AutomationWebhooks } from "./webhook.js";
import { askInThread } from "../inbox/ask-in-thread.js";
import { nextFireOf } from "./schedule.js";
import { isJudgeAutomation } from "./turn-decisions.js";

/** 確認のカードの選択肢。許す側の言葉は画面が「許可」に写す（`apps/frontend/lib/backend/adapter.ts`） */
export const AUTOMATION_CREATE_CHOICES = ["作る", "作らない"] as const;
export const AUTOMATION_UPDATE_CHOICES = ["変える", "変えない"] as const;
export const AUTOMATION_RESUME_CHOICES = ["再開する", "再開しない"] as const;
export const AUTOMATION_REMOVE_CHOICES = ["消す", "消さない"] as const;

/** tool の結果（AI が読む文）。断ったときは `ok: false` で理由 */
export interface AutomationToolResult {
  ok: boolean;
  text: string;
}

export interface AutomationToolsDeps {
  projectThread: ProjectThreadStore;
  automations: AutomationStore;
  /** 専用の Fork を用意する（作った・再開した・届け先を変えた）。無ければ立てない（試験の構成） */
  runner?: Pick<AutomationRunner, "prepare">;
  /** 消した自動化の Webhook の鍵を捨てる（画面の口の `DELETE` と同じ）。無ければ捨てない（Webhook を受けない構成） */
  webhooks?: Pick<AutomationWebhooks, "forgetSecret">;
  inbox: InboxStore;
  pendingApprovals: PendingApprovalRegistry;
  /**
   * **判断役を作ったときの案内**（まとめがオフなら出来事が出ない・自動許可は判断役の会話に効かない、アーキ仕様 §4.3）。断らずに
   * 作った返事に添える（画面の口の `notices` と同じ）。無ければ添えない
   */
  judgeNotices?(projectId: string): string[];
  /** 今の時刻（「次は」の計算）。無ければ `new Date()`（試験が時刻を決める） */
  now?: () => Date;
  /** 走っているターンの画面へ、判断待ちが出たことを流す（会話の中の確認のカード） */
  publishJudgment?(
    threadId: string,
    judgment: { id: string; message: string; serverName: string; toolInput: unknown; choices: string[] },
  ): void;
}

const WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"];

/** 「平日 9:00（Asia/Tokyo）」の形。カードと一覧で同じ言い方にする */
export function describeAutomationSource(source: AutomationSource): string {
  if (source.kind === "webhook") return "Webhook を受けたとき";
  if (source.kind === "event") {
    const where = Object.entries(source.where ?? {})
      .map(([k, v]) => `${k} が ${(Array.isArray(v) ? v : [v]).map((x) => JSON.stringify(x)).join("・")}`)
      .join("、");
    return `出来事 ${source.event} が起きたとき${where ? `（${where}）` : ""}`;
  }
  return `${describeRepeat(source.repeat)}（${source.timeZone}）`;
}

function describeRepeat(repeat: AutomationRepeat): string {
  switch (repeat.kind) {
    case "daily":
      return `毎日 ${repeat.time}`;
    case "weekdays":
      return `平日 ${repeat.time}`;
    case "weekly":
      return `毎週${WEEKDAYS[repeat.day]}曜 ${repeat.time}`;
    case "interval":
      return `${repeat.hours} 時間ごと`;
    case "cron":
      return `cron の式「${repeat.expr}」`;
  }
}

/** AI に返す直近の回の数（新しい順）。台帳は 50 件持つが、AI が「動いたか・飛ばしたか」を読むには数件で足りる */
export const AUTOMATION_RUNS_FOR_AI = 5;

/**
 * AI に返す1件。**欄を選んで組む**（Webhook の印のような、AI に渡さない欄を足しても漏れない）。
 * 直近の回（結果・飛ばした理由）と次の時刻を添える——AI は台帳・ログ・画面に届かないことがあり、「区切りの直後に Fork が
 * idle だった」が動いて終わったのか飛ばされたのかを、ここでしか読めない（Backlog #338）。次の時刻は保存しない（規則3）
 */
export function automationForAi(a: Automation, now: Date = new Date()): Record<string, unknown> {
  const next = nextFireOf(a, now);
  return {
    id: a.id,
    name: a.name,
    instruction: a.instruction,
    source: a.source,
    when: describeAutomationSource(a.source),
    target: a.target,
    reviewOnDone: a.reviewOnDone,
    paused: a.paused,
    ...(a.pausedReason ? { pausedReason: a.pausedReason } : {}),
    createdBy: a.createdBy.kind,
    // 一時停止中・時刻でないきっかけ・該当する時刻が来ない cron の式は無い
    ...(next ? { nextFireAt: next.toISOString() } : {}),
    recentRuns: a.runs.slice(0, AUTOMATION_RUNS_FOR_AI).map((r) => ({
      at: r.at,
      cause: r.cause,
      result: r.result,
      ...(r.reason ? { reason: r.reason } : {}),
      ...(r.scheduledFor ? { scheduledFor: r.scheduledFor } : {}),
      ...(r.delayed ? { delayed: r.delayed } : {}),
    })),
  };
}

export class AutomationTools {
  constructor(private readonly deps: AutomationToolsDeps) {}

  list(threadId: string): AutomationToolResult {
    const projectId = this.projectOf(threadId);
    if (!projectId) return { ok: false, text: "この Thread が見つかりません。" };
    const list = this.deps.automations.list(projectId).map((a) => automationForAi(a, this.now()));
    return { ok: true, text: list.length === 0 ? "この Project に自動化はありません。" : JSON.stringify(list, null, 2) };
  }

  /** 作る。**必ず人に聞く**（許されたら作り、専用の Fork を立てる） */
  async create(threadId: string, raw: unknown, signal?: AbortSignal): Promise<AutomationToolResult> {
    const projectId = this.projectOf(threadId);
    if (!projectId) return { ok: false, text: "この Thread が見つかりません。" };
    return this.guard(async () => {
      // 聞く前に確かめる——人が許したあとで「入力が違う」と断らない
      const fields = parseAutomationFields(raw);
      const targetProblem = this.targetProblem(projectId, fields.target);
      if (targetProblem) return { ok: false, text: targetProblem };
      // 出来事が名乗られているか・条件が名乗りに合うか・判断役の届け先（断る理由は `guard` が AI に返す）
      this.deps.automations.checkFields(projectId, fields);
      const toolInput = {
        名前: fields.name,
        いつ: describeAutomationSource(fields.source),
        毎回届ける指示: fields.instruction,
        どの会話で動かすか: this.describeTarget(fields.target),
        終わったら受信箱に出す: fields.reviewOnDone ? "出す" : "出さない（判断待ち・決めること・失敗した回は出す）",
        何が起きるか: [
          ...(fields.target.kind === "dedicated" ? [`「${fields.name}」という名前の Fork が立ち、そこで動きます。`] : []),
          fields.source.kind === "event"
            ? "人が見ていない時間にも、その出来事が起きるたびに動きます。"
            : "人が見ていない時間にも、決まった時刻に繰り返し動きます。",
          "確認が要る操作に当たったら、そこで止まってあなたの答えを待ちます。",
          "自動化の一覧から、いつでも一時停止・削除できます。",
        ].join(""),
      };
      const answer = await this.ask(threadId, "この自動化を作ってよいですか", toolInput, AUTOMATION_CREATE_CHOICES, signal);
      if (!answer.allowed) return { ok: false, text: `人が作らないと答えたので、自動化は作っていません。${answer.note}` };
      const created = await this.deps.automations.create({ projectId, createdBy: { kind: "ai", threadId }, fields: raw });
      const prepared = (await this.deps.runner?.prepare(created)) ?? created;
      const notices = isJudgeAutomation(created) ? (this.deps.judgeNotices?.(projectId) ?? []) : [];
      return {
        ok: true,
        text: [
          `人が許したので、自動化「${prepared.name}」を作った（id: ${prepared.id}）。`,
          ...notices.map((n) => `注意：${n}`),
          JSON.stringify(automationForAi(prepared, this.now()), null, 2),
        ].join("\n"),
      };
    });
  }

  /** 変える。**必ず人に聞く** */
  async update(threadId: string, automationId: string, raw: unknown, signal?: AbortSignal): Promise<AutomationToolResult> {
    return this.guard(async () => {
      const current = this.mine(threadId, automationId);
      const changes = parseAutomationChanges(raw, current);
      if (changes.target) {
        const targetProblem = this.targetProblem(current.projectId, changes.target);
        if (targetProblem) return { ok: false, text: targetProblem };
      }
      const next = { ...current, ...changes };
      this.deps.automations.checkFields(current.projectId, next, changes.source !== undefined);
      const rows: Record<string, string> = { 自動化: current.name };
      if (changes.name !== undefined) rows["名前"] = `${current.name} → ${changes.name}`;
      if (changes.source) rows["いつ"] = `${describeAutomationSource(current.source)} → ${describeAutomationSource(changes.source)}`;
      if (changes.instruction !== undefined) rows["毎回届ける指示"] = changes.instruction;
      if (changes.target) rows["どの会話で動かすか"] = `${this.describeTarget(current.target)} → ${this.describeTarget(next.target)}`;
      if (changes.reviewOnDone !== undefined) rows["終わったら受信箱に出す"] = changes.reviewOnDone ? "出す" : "出さない";
      const answer = await this.ask(threadId, "この自動化を変えてよいですか", rows, AUTOMATION_UPDATE_CHOICES, signal);
      if (!answer.allowed) return { ok: false, text: `人が変えないと答えたので、自動化は変えていません。${answer.note}` };
      let updated = await this.deps.automations.update(automationId, raw);
      // 届け先を専用の Fork に変えたら立てる。一時停止のままなら立てない（画面の口と同じ）
      if (!updated.paused && this.deps.runner) updated = await this.deps.runner.prepare(updated);
      return { ok: true, text: `人が許したので、自動化「${updated.name}」を変えた。\n${JSON.stringify(automationForAi(updated, this.now()), null, 2)}` };
    });
  }

  /** 一時停止する。聞かない */
  async pause(threadId: string, automationId: string): Promise<AutomationToolResult> {
    return this.guard(async () => {
      const current = this.mine(threadId, automationId);
      if (current.paused) return { ok: true, text: `自動化「${current.name}」はもう一時停止しています。` };
      await this.deps.automations.pause(automationId, "AI が一時停止しました");
      return { ok: true, text: `自動化「${current.name}」を一時停止した。再開するには resume_automation（人の確認が要る）。` };
    });
  }

  /** 再開する。**必ず人に聞く** */
  async resume(threadId: string, automationId: string, signal?: AbortSignal): Promise<AutomationToolResult> {
    return this.guard(async () => {
      const current = this.mine(threadId, automationId);
      if (!current.paused) return { ok: true, text: `自動化「${current.name}」は一時停止していません。` };
      const rows = {
        自動化: current.name,
        いつ: describeAutomationSource(current.source),
        毎回届ける指示: current.instruction,
        ...(current.pausedReason ? { 止めた理由: current.pausedReason } : {}),
      };
      const answer = await this.ask(threadId, "この自動化を再開してよいですか", rows, AUTOMATION_RESUME_CHOICES, signal);
      if (!answer.allowed) return { ok: false, text: `人が再開しないと答えたので、一時停止のままです。${answer.note}` };
      let resumed = await this.deps.automations.resume(automationId);
      // 閉じた専用の Fork のまま再開したら、新しい Fork を立てる（runner.ts）
      if (this.deps.runner) resumed = await this.deps.runner.prepare(resumed);
      return { ok: true, text: `人が許したので、自動化「${resumed.name}」を再開した。` };
    });
  }

  /**
   * 消す。**必ず人に聞く**（取り返せない——回の記録・Webhook の URL ごと消える）。消し方は画面の口の `DELETE` と同じ：台帳から
   * 消して Webhook の鍵を捨てる。**専用の Fork とその会話は残す**（要らなければ人が閉じる）
   */
  async remove(threadId: string, automationId: string, signal?: AbortSignal): Promise<AutomationToolResult> {
    return this.guard(async () => {
      const current = this.mine(threadId, automationId);
      const rows = {
        自動化: current.name,
        いつ: describeAutomationSource(current.source),
        どの会話で動かすか: this.describeTarget(current.target),
        何が起きるか: [
          "この自動化はもう動きません。直近の回の記録も消えます。",
          ...(current.source.kind === "webhook" ? ["Webhook の URL は使えなくなります。"] : []),
          current.target.kind === "dedicated"
            ? "専用の Fork とその会話は残ります（要らなければ Fork を閉じてください）。"
            : "届け先の会話はそのまま残ります。",
        ].join(""),
      };
      const answer = await this.ask(threadId, "この自動化を消してよいですか", rows, AUTOMATION_REMOVE_CHOICES, signal);
      if (!answer.allowed) return { ok: false, text: `人が消さないと答えたので、自動化は消していません。${answer.note}` };
      await this.deps.automations.remove(automationId);
      this.deps.webhooks?.forgetSecret(automationId);
      return {
        ok: true,
        text: `人が許したので、自動化「${current.name}」を消した。${current.target.kind === "dedicated" ? "専用の Fork とその会話は残っている。" : ""}`,
      };
    });
  }

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  private projectOf(threadId: string): string | undefined {
    return this.deps.projectThread.getThread(threadId)?.projectId;
  }

  /** 呼んだ Thread の Project の自動化だけ。ほかの Project のものは「見つからない」（あるかどうかを漏らさない） */
  private mine(threadId: string, automationId: string): Automation {
    const projectId = this.projectOf(threadId);
    const a = this.deps.automations.get(automationId);
    if (!projectId || !a || a.projectId !== projectId) {
      throw new AutomationNotFoundError(`この Project に自動化 ${automationId} はありません（list_automations で id が分かります）。`);
    }
    return a;
  }

  /** 届け先が既存の Thread なら、この Project の開いているものか（画面の口 `app.ts` と同じ決まり） */
  private targetProblem(projectId: string, target: AutomationTarget): string | undefined {
    if (target.kind !== "thread") return undefined;
    const thread = this.deps.projectThread.getThread(target.threadId);
    if (!thread || thread.projectId !== projectId) return "届け先の Thread がこの Project にありません（list_threads で id が分かります）。";
    if (thread.status !== "active") return "届け先の Thread は閉じています。";
    return undefined;
  }

  private describeTarget(target: AutomationTarget): string {
    if (target.kind === "dedicated") {
      return target.mode === "fresh" ? "専用の Fork で、毎回まっさらから" : "専用の Fork で、前の回を引き継いで";
    }
    const thread = this.deps.projectThread.getThread(target.threadId);
    const label = thread?.title ?? (thread?.kind === "base" ? "Base Thread" : target.threadId);
    return `いまある会話「${label}」に届ける`;
  }

  /** 入力の誤り・見つからないは、AI が読んで直せる文で返す。それ以外は投げる（規則2） */
  private async guard(fn: () => Promise<AutomationToolResult>): Promise<AutomationToolResult> {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof AutomationInputError || err instanceof AutomationNotFoundError) return { ok: false, text: err.message };
      throw err;
    }
  }

  /**
   * **会話のカードで人に聞く**。承認モード・自動許可を見ない（ここに来たら必ず聞く）。止められたら待つのをやめて断る
   * ——形は共通の `inbox/ask-in-thread.ts`
   */
  private ask(
    threadId: string,
    message: string,
    toolInput: Record<string, unknown>,
    choices: readonly string[],
    signal: AbortSignal | undefined,
  ): Promise<{ allowed: boolean; note: string }> {
    return askInThread(this.deps, { threadId, source: "automation", message, toolInput, choices, signal, logTag: "automation" });
  }
}

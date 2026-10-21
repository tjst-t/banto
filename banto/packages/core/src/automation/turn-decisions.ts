// docs/specs/v4-architecture.md §4.3「`banto.turn-decisions` と判断役」——**AI の「決めること」を AI に決めさせる**。
//
// - **出す**：ターンが終わり、そのまとめ（`report_turn`）に決めることがあり、受信箱にレビュー待ちを出すのと同じ条件
//   （`reviewDueAfterTurn`）を満たす、最後まで行ったターン。レビュー待ちを出したあとに出す。まとめがオフの Project では出ない。
//   起こしたターンは印を引かずに直に渡す（ホップ＋1・自分の回の判定）
// - **判断役**＝`banto.turn-decisions` を待つ自動化。届け先は専用の Fork に限る（`store.ts` が断る）。その会話では「承認を
//   すべて自動で許可する」を効かせない（`autoApproveAllFor`）
// - **答える道具**（`banto-thread` の `answer_decision`）：呼べるのは、いま走っているターンを起こした届けものに含まれる
//   出来事の会話とターンだけ。選択肢の番号か「人に任せる」。元の会話がもう進んでいたら断る。途中の答えはメモリに置き、
//   揃ったら1回で届ける。一部でも人に任せたら全部人に、揃わないまま判断役のターンが終わったら全部人に（カードに理由）
//
// 選択肢の中身は出来事の `text` からではなく、元の会話の記録（まとめ）から引く——真実は1箇所（規則3）

import { isDecisionKind, supervisorMayAnswer, supervisorPolicy, type DecisionKind, type SupervisorPolicy } from "../supervisor/policy.js";
import type { EventDeclaration } from "@banto/module-contract";
import type { ProjectThreadStore } from "../project-thread/store.js";
import type { MessageEntry, PendingDelivery, ThreadState } from "../project-thread/types.js";
import type { ThreadDeliveries } from "../delivery/thread-deliveries.js";
import type { ThreadTurns } from "../delivery/thread-turns.js";
import type { InboxStore } from "../inbox/store.js";
import type { ReviewJudge } from "../inbox/types.js";
import { reviewDueAfterTurn } from "../inbox/review-turn.js";
import { automationRunOfLastTurn } from "../inbox/automation-review.js";
import type { Automation, SupervisorAct } from "./fold.js";
import type { AutomationStore } from "./store.js";
import type { AutomationEvents } from "./events.js";

export const TURN_DECISIONS_EVENT = "banto.turn-decisions";
export const ANSWER_DECISION_TOOL_NAME = "answer_decision";

/** banto 自身が名乗る出来事（出どころ `banto`）。作るときの照合と、出すときの形の確かめに使う */
export const BANTO_EVENTS: readonly EventDeclaration[] = [
  {
    name: TURN_DECISIONS_EVENT,
    title: "決めることのあるターンが終わった",
    description:
      "会話のターンが終わり、そのまとめに人が決めること（問いと返答の候補）があった。text はまとめの頼んだこと・結果の1文・決めること（番号つき）の JSON。answer_decision で答えられる",
    fields: {
      thread: { type: "string", title: "会話" },
      turnId: { type: "string", title: "ターン" },
      threadTitle: { type: "string", title: "会話の名前" },
      count: { type: "number", title: "問いの数" },
      hop: { type: "number", title: "そのターンのホップ" },
      readExternal: { type: "boolean", title: "外から来たものを読んだ" },
    },
    subject: "thread",
  },
];

export function bantoEventDeclaration(name: string): EventDeclaration | undefined {
  return BANTO_EVENTS.find((e) => e.name === name);
}

/** 判断役か（`banto.turn-decisions` を待つ自動化） */
export function isJudgeAutomation(a: Pick<Automation, "source">): boolean {
  return a.source.kind === "event" && a.source.event === TURN_DECISIONS_EVENT;
}

/** その Thread を専用の Fork にしている判断役（一時停止していても）。無ければ undefined */
export function judgeAutomationOf(
  automations: Pick<AutomationStore, "list">,
  projectThread: Pick<ProjectThreadStore, "getThread">,
  threadId: string,
): Automation | undefined {
  const thread = projectThread.getThread(threadId);
  if (!thread) return undefined;
  return automations
    .list(thread.projectId)
    .find((a) => isJudgeAutomation(a) && a.target.kind === "dedicated" && a.target.threadId === threadId);
}

/**
 * **「承認をすべて自動で許可する」を、判断役の会話では効かせない**（アーキ仕様 §4.3「守り」）。Thread が分からない呼び出し
 * （banto 全体の Module の中継で会話を引けないもの）は Project のスイッチのまま
 */
export function autoApproveAllFor(deps: {
  projectSwitch(projectId: string): boolean;
  automations: Pick<AutomationStore, "list"> | undefined;
  projectThread: Pick<ProjectThreadStore, "getThread">;
}): (projectId: string, threadId?: string) => boolean {
  return (projectId, threadId) => {
    if (!deps.projectSwitch(projectId)) return false;
    // 番頭の会話も（アーキ仕様 §4.5「番頭の会話の承認は判断役と同じく必ず聞く」）——番頭を消したあとの Fork も印で引く
    if (threadId && deps.projectThread.getThread(threadId)?.restriction === "supervisor") return false;
    if (threadId && deps.automations && judgeAutomationOf(deps.automations, deps.projectThread, threadId)) return false;
    return true;
  };
}

/**
 * **判断役を作る・直すときに添える案内**（アーキ仕様 §4.3——断らずに出す）。まとめがオフなら出来事が出ないこと、自動許可が
 * オンでも判断役の会話には効かないこと
 */
export function judgeNotices(projectId: string, deps: { turnSummaryEnabled(projectId: string): boolean; autoApproveAll(projectId: string): boolean }): string[] {
  const notices: string[] = [];
  if (!deps.turnSummaryEnabled(projectId)) {
    notices.push(
      "この Project はターンの終わりのまとめがオフなので、出来事 banto.turn-decisions が出ません。Project の設定の「一般」で「ターンの終わりのまとめ」をオンにしてください",
    );
  }
  if (deps.autoApproveAll(projectId)) {
    notices.push("この Project は「承認をすべて自動で許可する」がオンですが、判断役の会話には効きません（判断役の承認は必ず聞きます）");
  }
  return notices;
}

/** まとめの決めること1件（記録に残した形から読む分だけ） */
export interface TurnDecision {
  question: string;
  context?: string;
  /** 問いの種類（アーキ仕様 §4.5）。元の AI の申告で、書かれていなければ無い */
  kind?: DecisionKind;
  options: Array<{ label: string; reply: string; recommended?: boolean }>;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** まとめの `decisions`。形の合わないものは飛ばす（記録は `report_turn` が確かめてから書いている） */
export function decisionsOf(summary: Record<string, unknown> | undefined): TurnDecision[] {
  const raw = summary?.decisions;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((d): TurnDecision[] => {
    if (!isRecord(d) || typeof d.question !== "string" || !Array.isArray(d.options)) return [];
    const options = d.options.flatMap((o) =>
      isRecord(o) && typeof o.label === "string" && typeof o.reply === "string"
        ? [{ label: o.label, reply: o.reply, ...(o.recommended === true ? { recommended: true } : {}) }]
        : [],
    );
    return [
      {
        question: d.question,
        ...(typeof d.context === "string" ? { context: d.context } : {}),
        ...(isDecisionKind(d.kind) ? { kind: d.kind } : {}),
        options,
      },
    ];
  });
}

/** 最後に始めたターンのまとめを持つ AI の発言 */
export function summaryMessageOfLastTurn(thread: Pick<ThreadState, "lastTurn" | "messages">): MessageEntry | undefined {
  const startedSeq = thread.lastTurn?.startedSeq;
  if (startedSeq === undefined) return undefined;
  return [...thread.messages].reverse().find((m) => m.role === "assistant" && m.seq > startedSeq && m.turnSummary);
}

/**
 * **そのターンが外から来たものを読んだか**（最初は、そのターンに積んだ届けものに Webhook の本文・出来事・別の会話からの
 * メッセージがあったかだけ。外のページを読む Module の結果は今は区別できない）
 */
export function readExternalOf(thread: Pick<ThreadState, "lastTurn" | "messages">): boolean {
  const startedSeq = thread.lastTurn?.startedSeq ?? Number.MAX_SAFE_INTEGER;
  return thread.messages.some((m) => m.seq > startedSeq && m.origin && (m.origin.sender || (m.origin.external?.length ?? 0) > 0));
}

/**
 * **終わったターンが `banto.turn-decisions` を出すか、出すならその中身**。最後まで行った・残りが無い（`reviewDueAfterTurn`）・
 * まとめに決めることがある、のとき。まとめのスイッチはここでは見ない（呼ぶ側）
 */
export function turnDecisionsEventOf(thread: ThreadState, hop: number): {
  eventId: string;
  fields: { thread: string; turnId: string; threadTitle: string; count: number; hop: number; readExternal: boolean };
  text: string;
} | undefined {
  const turn = thread.lastTurn;
  if (!turn || turn.outcome !== "completed" || !reviewDueAfterTurn(thread)) return undefined;
  const summary = summaryMessageOfLastTurn(thread)?.turnSummary?.summary;
  const decisions = decisionsOf(summary);
  if (decisions.length === 0) return undefined;
  const outcome = isRecord(summary?.outcome) ? summary.outcome : undefined;
  const text = JSON.stringify(
    {
      request: typeof summary?.request === "string" ? summary.request : undefined,
      headline: typeof outcome?.headline === "string" ? outcome.headline : undefined,
      decisions: decisions.map((d, i) => ({
        number: i + 1,
        question: d.question,
        ...(d.context ? { context: d.context } : {}),
        ...(d.kind ? { kind: d.kind } : {}),
        options: d.options.map((o, j) => ({ number: j + 1, label: o.label, reply: o.reply, ...(o.recommended ? { recommended: true } : {}) })),
      })),
    },
    null,
    2,
  );
  return {
    eventId: `${thread.id}:${turn.turnId}`,
    fields: {
      thread: thread.id,
      turnId: turn.turnId,
      threadTitle: thread.title ?? (thread.kind === "base" ? "Base Thread" : "Fork Thread"),
      count: decisions.length,
      hop,
      readExternal: readExternalOf(thread),
    },
    text,
  };
}

/**
 * **元の会話がもう進んでいるか**（アーキ仕様 §4.3「もう進んでいたら断る」）。core には「問い N に人が答えた」という記録は無い
 * ——人の答えはふつうの発言として送られるので、まとめより後の人の発言・ターンが変わった・人のターンが走っている/並んでいる、で見る
 */
export function movedOnReason(
  thread: Pick<ThreadState, "id" | "status" | "lastTurn" | "messages">,
  turnId: string,
  turns: Pick<ThreadTurns, "isRunning" | "queued">,
): string | undefined {
  if (thread.status === "closed") return "その会話は閉じられました";
  const summarySeq = thread.lastTurn?.turnId === turnId ? summaryMessageOfLastTurn(thread)?.seq : undefined;
  const after = summarySeq ?? thread.lastTurn?.startedSeq ?? 0;
  if (thread.messages.some((m) => m.role === "user" && !m.origin && m.seq > after)) return "人がもう答えました";
  if (thread.lastTurn?.turnId !== turnId) return "その会話では次のターンが始まりました";
  if (turns.isRunning(thread.id)) return "その会話でいまターンが走っています";
  if (turns.queued(thread.id) > 0) return "その会話で人の発言が順番を待っています";
  if (summarySeq === undefined) return "そのターンのまとめが見つかりません";
  return undefined;
}

/** 記録に添える問いの種類（書かれていれば） */
function kindOf(decision: TurnDecision | undefined): { decisionKind?: string } {
  return decision?.kind ? { decisionKind: decision.kind } : {};
}

/** 判断役のターンが受けた出来事1件（答える先） */
interface JudgeTarget {
  thread: string;
  turnId: string;
  count: number;
  /** 元のターンのホップ（出来事の属性） */
  hop: number;
  /** 問いの番号 → 選んだ選択肢の番号 */
  answers: Map<number, number>;
  reasons: Map<number, string>;
  /** 片づいた（届けた・人に任せた・もう進んでいた）。理由の文 */
  settled?: string;
  /** 元のターンが外から来たものを読んだ（出来事の属性）。番頭はその問いを選べない */
  readExternal: boolean;
}

interface JudgeSession {
  automation: { id: string; name: string };
  /** 番頭の回なら、その Project（種類による断りが効く——判断役には効かない、アーキ仕様 §4.5） */
  supervisor?: { projectId: string };
  targets: Map<string, JudgeTarget>;
}

export interface AnswerDecisionInput {
  thread: string;
  turnId: string;
  question: number;
  choice?: number;
  defer?: boolean;
  reason: string;
}

export interface TurnDecisionsDeps {
  projectThread: ProjectThreadStore;
  automations: Pick<AutomationStore, "get" | "list">;
  events: Pick<AutomationEvents, "emitFromCore">;
  deliveries: Pick<ThreadDeliveries, "deliver">;
  turns: Pick<ThreadTurns, "isRunning" | "queued">;
  inbox: Pick<InboxStore, "judgeReviews">;
  turnSummaryEnabled(projectId: string): boolean;
  /** **番頭の方針**（アーキ仕様 §4.5「問いの種類」）。答えるたびに引く。無ければ方針の既定 */
  supervisorPolicy?(projectId: string): Pick<SupervisorPolicy, "delegate">;
  /** **番頭の記録に書く**（`automation.supervisor_acted`）。無ければ書き残すだけ */
  recordSupervisorAct?(automationId: string, act: SupervisorAct): Promise<void>;
  now?: () => Date;
  log?: (message: string) => void;
}

const targetKey = (thread: string, turnId: string) => `${thread}\0${turnId}`;

export class TurnDecisions {
  /** 判断役のターン（判断役の会話 → そのターンが受けた出来事）。走っている間だけ持つ */
  private readonly sessions = new Map<string, JudgeSession>();

  constructor(private readonly deps: TurnDecisionsDeps) {}

  /**
   * **ターンが終わり、レビュー待ちを出したあと**、決めることがあれば出来事を出す。カードを出してから出す——判断役の答えは
   * そのカードに添えるので、先に答えが来るとカードが無い
   */
  async emitIfDecided(threadId: string, hop: number): Promise<void> {
    const thread = this.deps.projectThread.getThread(threadId);
    if (!thread || !this.deps.turnSummaryEnabled(thread.projectId)) return;
    // 番頭の会話は決めることを出さない（§4.5——まとめも出さないので、ここに来るのは念のため）
    if (thread.restriction === "supervisor") return;
    const built = turnDecisionsEventOf(thread, hop);
    if (!built) return;
    const automation = automationRunOfLastTurn(thread);
    await this.deps.events.emitFromCore(
      thread.projectId,
      BANTO_EVENTS[0]!,
      { eventId: built.eventId, occurredAt: this.now().toISOString(), fields: built.fields, text: built.text },
      { threadId, turnId: built.fields.turnId, hop, ...(automation ? { automation } : {}) },
    );
  }

  /**
   * **ターンを始める**（turn-runner が届けものを積んだあと）。届けものに判断役の自動化が届けた `banto.turn-decisions` が
   * あれば、そのターンで答えられる先として覚える。自動化の届けもの（`kind: "automation"`）の中の出来事だけを見る——
   * `banto.*` は core だけが出せるので、届けものの中身は申告ではない
   */
  beginTurn(threadId: string, delivered: readonly PendingDelivery[]): void {
    this.sessions.delete(threadId);
    let automation: JudgeSession["automation"] | undefined;
    let supervisor: JudgeSession["supervisor"];
    const targets = new Map<string, JudgeTarget>();
    for (const d of delivered) {
      if (d.kind !== "automation" || !d.automation) continue;
      const a = this.deps.automations.get(d.automation.id);
      if (!a || !isJudgeAutomation(a)) continue;
      for (const e of d.external ?? []) {
        if (e.source !== "event" || e.event?.name !== TURN_DECISIONS_EVENT) continue;
        const f = e.event.fields;
        if (typeof f.thread !== "string" || typeof f.turnId !== "string" || typeof f.count !== "number") continue;
        automation = { id: a.id, name: a.name };
        if (a.mode === "supervisor") supervisor = { projectId: a.projectId };
        targets.set(targetKey(f.thread, f.turnId), {
          thread: f.thread,
          turnId: f.turnId,
          count: f.count,
          hop: typeof f.hop === "number" ? f.hop : 0,
          answers: new Map(),
          reasons: new Map(),
          // 読めない値は読んだ側に倒す（番頭に選ばせない）
          readExternal: f.readExternal !== false,
        });
      }
    }
    if (automation && targets.size > 0) this.sessions.set(threadId, { automation, ...(supervisor ? { supervisor } : {}), targets });
  }

  /** 判断役が見ている会話なら、その判断役（受信箱の「判断役が見ています」） */
  watching(threadId: string): { id: string; name: string } | undefined {
    for (const s of this.sessions.values()) {
      for (const t of s.targets.values()) if (t.thread === threadId && !t.settled) return s.automation;
    }
    return undefined;
  }

  /** **`answer_decision` の本体**。`judgeThreadId` は呼んだ会話（判断役の会話） */
  async answer(judgeThreadId: string, input: AnswerDecisionInput): Promise<{ ok: boolean; text: string }> {
    const refuse = (text: string) => ({ ok: false, text });
    const session = this.sessions.get(judgeThreadId);
    if (!session) {
      return refuse("このターンには、答えられる出来事（判断役の自動化が届けた banto.turn-decisions）が届いていません。");
    }
    const target = session.targets.get(targetKey(input.thread, input.turnId));
    if (!target) {
      return refuse("その会話とターンは、このターンに届いた出来事にありません。届いた出来事の属性 thread と turnId をそのまま指してください。");
    }
    if (target.settled) return refuse(`その会話の決めることはもう片づいています（${target.settled}）。何も届けていません。`);
    const reason = input.reason.trim();
    if (reason === "") return refuse("理由（reason）が空です。");
    if (!Number.isInteger(input.question) || input.question < 1 || input.question > target.count) {
      return refuse(`question は 1〜${target.count} の問いの番号です。`);
    }
    const thread = this.deps.projectThread.getThread(target.thread);
    const moved = thread ? movedOnReason(thread, target.turnId, this.deps.turns) : "その会話が見つかりません";
    if (moved || !thread) {
      target.settled = moved ?? "その会話が見つかりません";
      return refuse(`もう進んでいます（${target.settled}）。何も届けていません。`);
    }
    const decisions = decisionsOf(summaryMessageOfLastTurn(thread)?.turnSummary?.summary);
    const decision = decisions[input.question - 1];
    // 決めたターンの位置（届けると元の会話は次のターンへ進む——カードはこのターンの中身を出し続ける）。ここでは最後のターンが
    // 出来事のターン（`movedOnReason` が確かめた）
    const judgedTurn = thread.lastTurn
      ? {
          startedSeq: thread.lastTurn.startedSeq,
          beforeSeq: (thread.messages.at(-1)?.seq ?? thread.lastTurn.startedSeq) + 1,
          ...(thread.lastTurn.outcome ? { outcome: thread.lastTurn.outcome } : {}),
        }
      : undefined;
    if (!decision || decisions.length !== target.count) {
      target.settled = "そのターンのまとめが出来事と合いません";
      return refuse(`${target.settled}。何も届けていません。`);
    }

    if (input.defer === true) {
      target.settled = "人に任せました";
      await this.judge(target.thread, { kind: "deferred", automation: session.automation, reason, at: this.now().toISOString() });
      await this.recordAct(session, { kind: "deferred", threadId: target.thread, turnId: target.turnId, question: input.question, reason, ...kindOf(decision) });
      return {
        ok: true,
        text: "人に任せました。この会話の決めることは、答えた分も含めて全部人が答えます（何も届けていません）。ほかの問いに答える必要はありません。",
      };
    }
    const choice = input.choice;
    if (choice === undefined || !Number.isInteger(choice) || choice < 1 || choice > decision.options.length) {
      return refuse(`choice は 1〜${decision.options.length} の選択肢の番号です（人に任せるなら defer: true）。自由な文は送れません。`);
    }
    // **番頭は種類で絞る**（アーキ仕様 §4.5「問いの種類」）。外から来たものを読んだターンの問い・任されていない種類は選べない
    // ——defer はいつもできる。判断役（ふつうの自動化）には効かない
    if (session.supervisor) {
      const may = target.readExternal
        ? { ok: false as const, reason: "外から来たもの（Webhook・出来事・別の会話のメッセージ）を読んだターンの問いは人が決めます" }
        : supervisorMayAnswer(decision.kind, this.policyOf(session.supervisor.projectId));
      if (!may.ok) {
        await this.recordAct(session, {
          kind: "refused",
          threadId: target.thread,
          turnId: target.turnId,
          question: input.question,
          reason: may.reason,
          ...kindOf(decision),
        });
        return refuse(`番頭はこの問いを選べません：${may.reason}。defer: true で人に回してください（何も届けていません）。`);
      }
    }
    target.answers.set(input.question, choice);
    target.reasons.set(input.question, reason);
    const missing = Array.from({ length: target.count }, (_, i) => i + 1).filter((q) => !target.answers.has(q));
    if (missing.length > 0) {
      return {
        ok: true,
        text: `問い ${input.question} の答えを預かりました。残りの問い（${missing.join("・")}）にも答えると、まとめて1回で届けます。どれかを人に任せるなら、全部人に回ります。`,
      };
    }

    // **揃った**——先に片づけてから届ける（同時に呼ばれても二度届けない）
    target.settled = "答えを届けました";
    const answers = decisions.map((d, i) => {
      const n = target.answers.get(i + 1)!;
      return { question: i + 1, choice: n, label: d.options[n - 1]!.label, reply: d.options[n - 1]!.reply, reason: target.reasons.get(i + 1)!, text: d.question, kind: d.kind };
    });
    const who = session.supervisor ? "番頭" : `判断役（自動化「${session.automation.name}」）`;
    try {
      await this.deps.deliveries.deliver({
        threadId: target.thread,
        from: "banto",
        title: `${who}が選んだ答え`,
        text: [
          `前のターンのまとめで人に聞いた決めることに、${who}が、あなたの出した選択肢から答えました。`,
          // 理由も届ける——元の会話の AI と、後から記録を読む人に、なぜそれを選んだかが見えるように
          ...answers.map((a) => `\n問い ${a.question}：${a.text}\n選んだもの：${a.label}\n理由：${a.reason}\n${a.reply}`),
        ].join("\n"),
        // 元のターン＋2（出来事で＋1、判断役の答えで＋1）。上限（10）を超えると自動では起こさない
        hop: target.hop + 2,
        kind: "decision",
      });
    } catch (err) {
      target.settled = "届けられませんでした";
      return refuse(`届けられませんでした：${err instanceof Error ? err.message : String(err)}`);
    }
    for (const a of answers) {
      await this.recordAct(session, {
        kind: "answered",
        threadId: target.thread,
        turnId: target.turnId,
        question: a.question,
        choice: a.choice,
        label: a.label,
        reason: a.reason,
        ...(a.kind ? { decisionKind: a.kind } : {}),
      });
    }
    await this.judge(target.thread, {
      kind: "decided-by-automation",
      automation: session.automation,
      answers: answers.map((a) => ({ question: a.question, choice: a.choice, label: a.label, reason: a.reason })),
      ...(judgedTurn ? { turn: judgedTurn } : {}),
      at: this.now().toISOString(),
    });
    return { ok: true, text: "全部の問いに答えが揃ったので、元の会話に届けました。元の会話の AI がこの答えで続けます。" };
  }

  /**
   * **ターンが終わった**（`ThreadTurns` の `ended`。最後まで行った・失敗した・止めた）。判断役のターンなら、揃わなかったものは
   * 全部人に回す
   */
  async endTurn(judgeThreadId: string): Promise<void> {
    const session = this.sessions.get(judgeThreadId);
    if (!session) return;
    this.sessions.delete(judgeThreadId);
    for (const t of session.targets.values()) {
      if (t.settled) continue;
      const thread = this.deps.projectThread.getThread(t.thread);
      // もう進んでいる会話のカードには添えない（人が答えた・次のターンが始まった）
      if (!thread || movedOnReason(thread, t.turnId, this.deps.turns)) continue;
      await this.judge(t.thread, {
        kind: "incomplete",
        automation: session.automation,
        answered: t.answers.size,
        total: t.count,
        at: this.now().toISOString(),
      });
    }
  }

  private async judge(threadId: string, judge: ReviewJudge): Promise<void> {
    try {
      const n = await this.deps.inbox.judgeReviews(threadId, judge);
      if (n === 0) this.log(`[host] ${threadId} に開いているレビュー待ちが無いので、判断役の答え（${judge.kind}）をカードに添えませんでした`);
    } catch (err) {
      this.log(`[host] 判断役の答えを ${threadId} のカードに添えられませんでした: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private policyOf(projectId: string): Pick<SupervisorPolicy, "delegate"> {
    return this.deps.supervisorPolicy?.(projectId) ?? supervisorPolicy(undefined, projectId);
  }

  /** **番頭の記録に書く**（番頭の回だけ）。書けなくても答えは止めない——書き残す */
  private async recordAct(session: JudgeSession, act: Omit<SupervisorAct, "at">): Promise<void> {
    if (!session.supervisor) return;
    try {
      await this.deps.recordSupervisorAct?.(session.automation.id, { at: this.now().toISOString(), ...act });
    } catch (err) {
      this.log(`[host] 番頭の記録を書けませんでした（${act.kind}）: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  private log(message: string): void {
    (this.deps.log ?? console.warn)(message);
  }
}

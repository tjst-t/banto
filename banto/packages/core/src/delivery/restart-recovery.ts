// **起き直したときの片づけ：返事待ちの札と、切れたターン**（追加・2026-10-05、アーキ仕様 §2.5「起こし直しをまたいで続ける」
// の「2. Module の仕事を続ける」・§4.2「返事待ちの札は失くさない」）。
//
// 前の走行で「あとで届ける」と約束したまま終わっていない仕事（返事待ちの札）は、札を渡した Module が「起こし直しても
// 続けられる」と名乗っていれば（`dev.banto/module` の `resumesAfterRestart`）その Module に続けるかを問い、名乗って
// いなければ今どおり「途中で終わりました」を届ける。**Thread の続き（切れたターン）は、その Thread の札の判定のあと**
// ——先に続きを積むと、AI に「結果は分かりません」が届いた直後に Module が続きを届け、同じ仕事を二重に扱う（レビュー 1-5）。
//
// 札の宛先は2つ：Thread（AI が頼んだ）と Module（Module が中継で頼んだ——§4.2「Module 宛ての返事」、`module-replies.ts`）。
// **どちらも同じ問いに乗せる**（決定・2026-10-05、ユーザー——Factory が中継で頼んだ Subagent の仕事が起こし直しで必ず
// 失われないように）。Module 宛ての札は、問いの Thread の代わりに呼び元の Module を渡し、続けるなら同じ印で覚え直して
// 返事を待ち続ける。続けない・答えない・名乗らないなら、今どおり呼び元に「途中で終わりました」を渡す。
//
// **2段に分ける**（待ち受けの前と後）：
//   1. 待ち受けの前（`beforeListen`）：名乗らない Module の札に「途中で終わりました」を届け、名乗った Module の札は同じ印で
//      覚え直す（最後の届け1回だけ、`ReplyHandles.restore`）。名乗った Module の Thread 宛ての札を持たない Thread の
//      切れたターンを片づける（今までどおり）
//   2. 待ち受けの後（`afterListen`）：名乗った Module を起こして問う。答えが「続ける」でなければ「途中で終わりました」。
//      そのあと、残りの Thread の切れたターンを片づける（続けると答えた Module は続きの文に「続いています」）
// 待ち受けの後に問うのは、**Module が host に届く口（中継）が待ち受けと同じ所にある**から——続けると答えた Module は
// すぐ資格情報を中継で受け取り、終われば札で届ける。待ち受けの前に問うと、その間 Module は host に届けず、Project の
// コンテナを起こす時間だけ画面も開けない。
//
// **判定の終わっていない Thread は留める**（`holdReason`・`waitFor`）：届いたもので起こさず、人が送ったターンも判定の
// 終わりを待ってから始める。留めないと、人のターンが最後のターンになって切れたターンの続きが積まれない・続きより
// 先に届いたもので起きる。
//
// **期限を過ぎたら、問いは打ち切る**（改訂・2026-10-05、Fable のレビュー）：外側で答えを捨てるだけでは、内側（コンテナを
// 起こす・問いを送る）が走り続け、host が「途中で終わりました」を届けて札を片づけたあとに問いが届き、Module だけが
// 続けて結果が誰にも届かない。起こす・問うの両方に打ち切りの合図を渡し、**問いを送る直前に**期限と札の状態を見る。

import { parseResumeAnswers, type ResumeAnswer, type ResumeQuestion, type ResumeQuestionItem } from "@banto/module-contract";
import type { InboxStore } from "../inbox/store.js";
import type { ProjectThreadStore } from "../project-thread/store.js";
import type { BackgroundWork, ReplyHandles, ReplyToModule } from "./reply-handles.js";
import type { ModuleAwaitingReply } from "./module-replies.js";
import type { ThreadDeliveries } from "./thread-deliveries.js";
import { resumeInterruptedTurns, type SessionReader, type TurnContinuationDeps } from "./turn-continuation.js";

/** Module に問うのを待つ上限（起こす時間も入れて）。過ぎたら打ち切って「途中で終わりました」 */
export const RESUME_ASK_TIMEOUT_MS = 120_000;

/** 問う相手（札を渡した Module の接続） */
export interface ResumeTarget {
  moduleName: string;
  /** 札を渡した接続の名前（Project ごとの Module は `<名前>-<projectId>`） */
  connName: string;
  /** その接続が Project の Module ならその Project（起こすのに要る）。banto 全体の Module・分からなければ無い */
  projectId?: string;
}

/** 判定を待っている札1件 */
type PendingReply =
  | {
      kind: "thread";
      replyTo: string;
      moduleName: string;
      connName: string;
      projectId: string;
      threadId: string;
      /** 届いたときのホップ（札を出したターンのホップ＋1） */
      hop: number;
      work?: BackgroundWork;
    }
  | {
      kind: "module";
      replyTo: string;
      moduleName: string;
      connName: string;
      projectId?: string;
      toModule: ReplyToModule;
    };

export interface RestartRecoveryDeps {
  projectThread: ProjectThreadStore;
  inbox: InboxStore;
  deliveries: ThreadDeliveries;
  replyHandles: ReplyHandles;
  sessions?: SessionReader;
  /** Module 宛ての返事待ち（`module-replies.ts`）。無ければ Module 宛ての札は無い */
  moduleReplies?: {
    awaiting(): readonly ModuleAwaitingReply[];
    /** 呼び元に「途中で終わりました」を渡す */
    loseOne(replyTo: string, why: string): Promise<void>;
  };
  /** その Module が「起こし直しても続けられる」と名乗っているか（宣言で見る——起こさずに分かる） */
  resumable(target: { moduleName: string; projectId?: string }): boolean;
  /**
   * その Module を（Project の Module ならその Project で）起こして繋ぐ。起こせなければ投げる。`signal` が立ったら
   * やめる（間に合わなければ、繋がったあと問いを送らない——ここが見る）
   */
  connect(target: ResumeTarget, signal: AbortSignal): Promise<{ ask(question: ResumeQuestion, signal: AbortSignal): Promise<unknown> }>;
  /** Thread 宛ての札に「途中で終わりました」を届けて札を片づける（cli.ts の `deliverLostReply`） */
  deliverLost(reply: { threadId: string; replyTo: string; moduleName: string; hop: number }, why: string): Promise<void>;
  /** バックグラウンドの印を描き直させる */
  publishBackground(threadId: string): void;
  askTimeoutMs?: number;
}

type TurnResults = Awaited<ReturnType<typeof resumeInterruptedTurns>>;

/** 1件の札の判定の結果（ログ用） */
export interface ReplyOutcome {
  target: ResumeTarget;
  replyTo: string;
  /** Thread 宛てならその Thread、Module 宛てなら呼び元の Module */
  to: { threadId: string } | { module: string };
  /** kept：続けると答えた（札を覚え直した）／lost：「途中で終わりました」を届けた／settled：答えの前に済んでいた */
  outcome: "kept" | "lost" | "settled";
  why?: string;
}

export class RestartRecovery {
  /** 判定を待っている札（接続ごと） */
  private readonly groups = new Map<string, PendingReply[]>();
  /** 判定が終わるまで留める Thread と、終わったら解く約束 */
  private readonly held = new Map<string, { done: Promise<void>; resolve: () => void }>();
  /** 続けると答えた Module（Thread ごと） */
  private readonly kept = new Map<string, Set<string>>();
  /** 判定の間に済んだ札とその済み方（届いた・「途中で終わりました」） */
  private readonly settled = new Map<string, "delivered" | "lost">();

  constructor(private readonly deps: RestartRecoveryDeps) {}

  /** 1段目（待ち受けの前）。片づけた切れたターンを返す（ログ用） */
  async beforeListen(): Promise<TurnResults> {
    const { projectThread } = this.deps;
    for (const p of projectThread.listProjects()) {
      for (const t of projectThread.listThreadsForProject(p.id)) {
        for (const r of t.awaitingReplies ?? []) {
          const open = p.status !== "closed" && t.status !== "closed";
          if (!open || !this.deps.resumable({ moduleName: r.moduleName, projectId: p.id })) {
            await this.deps.deliverLost({ threadId: t.id, replyTo: r.replyTo, moduleName: r.moduleName, hop: r.hop }, "banto を起動し直したため");
            continue;
          }
          // **同じ印で覚え直す**（使えるのは最後の届け1回だけ）。問う前に覚え直す——続けると答えた Module がすぐ
          // 終わって届けても受けられる。続けないと答えたら `deliverLost` が片づける
          this.deps.replyHandles.restore(r.replyTo, {
            threadId: t.id,
            projectId: p.id,
            connName: r.connName,
            moduleName: r.moduleName,
            // 札を出したターンのホップ（返事待ちには届いたときのホップ＝＋1 が入っている）
            hop: Math.max(0, r.hop - 1),
            ...(r.work ? { work: r.work } : {}),
          });
          this.pend({
            kind: "thread",
            replyTo: r.replyTo,
            moduleName: r.moduleName,
            connName: r.connName,
            projectId: p.id,
            threadId: t.id,
            hop: r.hop,
            ...(r.work ? { work: r.work } : {}),
          });
          if (!this.held.has(t.id)) {
            let resolve!: () => void;
            const done = new Promise<void>((r2) => (resolve = r2));
            this.held.set(t.id, { done, resolve });
          }
        }
      }
    }
    // **Module 宛ての札**（追加・2026-10-05、上の注記）。Thread は留めない（Thread の続きとは関わらない）
    for (const a of this.deps.moduleReplies?.awaiting() ?? []) {
      // **呼び元も名乗っていなければ問わない**（改訂・2026-10-05、Fable のレビュー）：呼び元は名乗っていなければ自分の
      // Thread 宛ての札を「途中で終わりました」にする——頼んだ先が続けて結果が届き直すと、同じ仕事が二重に見える
      const where = a.projectId ? { projectId: a.projectId } : {};
      if (!this.deps.resumable({ moduleName: a.fromModule, ...where }) || !this.deps.resumable({ moduleName: a.toModule, ...where })) {
        await this.deps.moduleReplies!.loseOne(a.replyTo, "banto を起動し直したため");
        continue;
      }
      const toModule: ReplyToModule = { connName: a.toConn, moduleName: a.toModule, replyId: a.replyId };
      this.deps.replyHandles.restore(a.replyTo, {
        threadId: "",
        toModule,
        ...(a.projectId ? { projectId: a.projectId } : {}),
        connName: a.fromConn,
        moduleName: a.fromModule,
        hop: 0,
      });
      this.pend({
        kind: "module",
        replyTo: a.replyTo,
        moduleName: a.fromModule,
        connName: a.fromConn,
        ...(a.projectId ? { projectId: a.projectId } : {}),
        toModule,
      });
    }
    return resumeInterruptedTurns(this.turnDeps(), (threadId) => !this.held.has(threadId));
  }

  /** 2段目（待ち受けの後）。名乗った Module に問い、残りの切れたターンを片づけ、留めを解く。投げない */
  async afterListen(): Promise<{ answers: ReplyOutcome[]; turns: TurnResults }> {
    const answers: ReplyOutcome[] = [];
    let turns: TurnResults = [];
    try {
      await Promise.all(
        [...this.groups.values()].map(async (replies) => {
          const target = targetOf(replies);
          const got = await this.askOne(target, replies);
          for (const r of replies) {
            const to = r.kind === "thread" ? { threadId: r.threadId } : { module: r.toModule.moduleName };
            // 判定の間に札が済んだ：答えの前に最後の届けが済んだか、Module が止まって「途中で終わりました」を届けた
            if (this.deps.replyHandles.get(r.replyTo) === undefined) {
              const how = this.settled.get(r.replyTo);
              answers.push({
                target,
                replyTo: r.replyTo,
                to,
                outcome: "settled",
                why:
                  how === "delivered"
                    ? "答えの前に最後の届けが済んだ"
                    : how === "lost"
                      ? "答えの前に Module が止まり、「途中で終わりました」を届けた"
                      : "答えの前に札が済んだ（済み方は分からない）",
              });
              continue;
            }
            const answer = "error" in got ? undefined : got.answers.get(r.replyTo);
            if (answer?.resume) {
              if (r.kind === "thread") {
                const modules = this.kept.get(r.threadId) ?? new Set<string>();
                modules.add(target.moduleName);
                this.kept.set(r.threadId, modules);
                await this.deps.projectThread.markReplyKept(r.threadId, r.replyTo).catch((err: unknown) =>
                  console.warn(`[host] ${r.threadId} の札を「続けています」にできませんでした:`, err),
                );
                this.deps.publishBackground(r.threadId);
              }
              // Module 宛ての札は、返事待ち（module-replies）に残ったまま待ち続ける
              answers.push({ target, replyTo: r.replyTo, to, outcome: "kept" });
              continue;
            }
            const why =
              "error" in got
                ? `banto を起動し直したため（${target.moduleName} に続けるかを聞けませんでした：${got.error}）`
                : answer
                  ? `banto を起動し直したため（${target.moduleName} が続けられないと答えました：${(answer as Extract<ResumeAnswer, { resume: false }>).reason}）`
                  : `banto を起動し直したため（${target.moduleName} がこの仕事について答えませんでした）`;
            await this.lose(r, why);
            answers.push({ target, replyTo: r.replyTo, to, outcome: "lost", why });
          }
        }),
      );
      turns = await resumeInterruptedTurns(this.turnDeps(), (threadId) => this.held.has(threadId));
    } catch (err) {
      console.warn("[host] 起き直したときの札の判定が途中で失敗しました（留めた Thread は解きます）:", err);
    } finally {
      for (const [threadId, h] of this.held) {
        this.held.delete(threadId);
        h.resolve();
        this.deps.deliveries.kick(threadId);
      }
    }
    return { answers, turns };
  }

  /**
   * **判定の間に札が済んだ**（cli.ts が呼ぶ：最後の届けが済んだ・「途中で終わりました」を届けた）。済み方をログに正しく書く
   */
  noteSettled(replyTo: string, how: "delivered" | "lost"): void {
    if ([...this.groups.values()].some((rs) => rs.some((r) => r.replyTo === replyTo))) this.settled.set(replyTo, how);
  }

  /** 判定の終わっていない Thread を届いたもので起こさない理由（`ThreadDeliveries` の `hold`） */
  holdReason(threadId: string): string | undefined {
    return this.held.has(threadId)
      ? "banto を起こし直したあと、この会話で頼んだ仕事を続けるかを Module に聞いています（終わったら起こします）"
      : undefined;
  }

  /** 人が送ったターンは、その Thread の判定が終わるまで待ってから始める */
  waitFor(threadId: string): Promise<void> {
    return this.held.get(threadId)?.done ?? Promise.resolve();
  }

  /** 続けると答えた Module（その Thread の分）。切れたターンの続きの文に「続いています」と書く */
  keptReplies(threadId: string): Array<{ moduleName: string }> {
    return [...(this.kept.get(threadId) ?? [])].map((moduleName) => ({ moduleName }));
  }

  private pend(r: PendingReply): void {
    const group = this.groups.get(r.connName) ?? [];
    group.push(r);
    this.groups.set(r.connName, group);
  }

  private async lose(r: PendingReply, why: string): Promise<void> {
    if (r.kind === "thread") {
      await this.deps.deliverLost({ threadId: r.threadId, replyTo: r.replyTo, moduleName: r.moduleName, hop: r.hop }, why);
    } else {
      this.deps.replyHandles.settle(r.replyTo);
      await this.deps.moduleReplies!.loseOne(r.replyTo, why);
    }
  }

  private turnDeps(): TurnContinuationDeps {
    const { projectThread, inbox, deliveries, sessions } = this.deps;
    return { projectThread, inbox, deliveries, ...(sessions ? { sessions } : {}), keptReplies: (id) => this.keptReplies(id) };
  }

  private async askOne(target: ResumeTarget, replies: readonly PendingReply[]): Promise<{ answers: Map<string, ResumeAnswer> } | { error: string }> {
    const limit = this.deps.askTimeoutMs ?? RESUME_ASK_TIMEOUT_MS;
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(new Error(`${Math.round(limit / 1000)} 秒待っても答えが来ませんでした`)), limit);
    try {
      const conn = await untilAborted(this.deps.connect(target, deadline.signal), deadline.signal);
      // **問いを送る直前に**：期限が過ぎていれば送らない。札がもう済んでいる（Module が止まって「途中で終わりました」を
      // 届けた・答えの前に届け終えた）ものは問いに載せない
      if (deadline.signal.aborted) throw deadline.signal.reason;
      const live = replies.filter((r) => this.deps.replyHandles.get(r.replyTo) !== undefined);
      if (live.length === 0) return { answers: new Map() };
      const raw = await untilAborted(conn.ask({ items: live.map(questionItemOf) }, deadline.signal), deadline.signal);
      return { answers: parseResumeAnswers(raw, live.map((r) => r.replyTo)) };
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    } finally {
      clearTimeout(timer);
    }
  }
}

/** 問う相手：同じ接続の札。Project は札がみな同じ Project のときだけ（banto 全体の Module は札ごとに違う） */
function targetOf(replies: readonly PendingReply[]): ResumeTarget {
  const first = replies[0]!;
  const projects = new Set(replies.map((r) => r.projectId));
  return {
    moduleName: first.moduleName,
    connName: first.connName,
    ...(projects.size === 1 && first.projectId !== undefined ? { projectId: first.projectId } : {}),
  };
}

/** 問いの1件。**Project は札ごと**（banto 全体の Module は札ごとに違う Project を持つ） */
function questionItemOf(r: PendingReply): ResumeQuestionItem {
  const base = {
    replyTo: r.replyTo,
    ...(r.kind === "thread" && r.work?.toolName ? { toolName: r.work.toolName } : {}),
    ...(r.kind === "thread" && r.work?.toolCallId ? { toolCallId: r.work.toolCallId } : {}),
  };
  return r.kind === "thread"
    ? { ...base, thread: { projectId: r.projectId, threadId: r.threadId } }
    : { ...base, caller: { module: r.toModule.moduleName, ...(r.projectId ? { projectId: r.projectId } : {}) } };
}

/** `signal` が立ったら投げる（中の仕事は `signal` を見てやめる） */
function untilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(
      (v) => {
        signal.removeEventListener("abort", onAbort);
        resolve(v);
      },
      (err: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(err);
      },
    );
  });
}

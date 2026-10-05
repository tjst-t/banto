// **起き直したときの片づけ：返事待ちの札と、切れたターン**（追加・2026-10-05、アーキ仕様 §2.5「起こし直しをまたいで続ける」
// の「2. Module の仕事を続ける」・§4.2「返事待ちの札は失くさない」）。
//
// 前の走行で「あとで届ける」と約束したまま終わっていない仕事（返事待ちの札）は、札を渡した Module が「起こし直しても
// 続けられる」と名乗っていれば（`dev.banto/module` の `resumesAfterRestart`）その Module に続けるかを問い、名乗って
// いなければ今どおり「途中で終わりました」を届ける。**Thread の続き（切れたターン）は、その Thread の札の判定のあと**
// ——先に続きを積むと、AI に「結果は分かりません」が届いた直後に Module が続きを届け、同じ仕事を二重に扱う（レビュー 1-5）。
//
// **2段に分ける**（待ち受けの前と後）：
//   1. 待ち受けの前（`beforeListen`）：名乗らない Module の札に「途中で終わりました」を届け、名乗った Module の札は同じ印で
//      覚え直す（最後の届け1回だけ、`ReplyHandles.restore`）。名乗った Module の札を持たない Thread の切れたターンを
//      片づける（今までどおり）
//   2. 待ち受けの後（`afterListen`）：名乗った Module を起こして問う。答えが「続ける」でなければ「途中で終わりました」。
//      そのあと、残りの Thread の切れたターンを片づける（続けると答えた Module は続きの文に「続いています」）
// 待ち受けの後に問うのは、**Module が host に届く口（中継）が待ち受けと同じ所にある**から——続けると答えた Module は
// すぐ資格情報を中継で受け取り、終われば札で届ける。待ち受けの前に問うと、その間 Module は host に届けず、Project の
// コンテナを起こす時間だけ画面も開けない。
//
// **判定の終わっていない Thread は留める**（`holdReason`・`waitFor`）：届いたもので起こさず、人が送ったターンも判定の
// 終わりを待ってから始める。留めないと、人のターンが最後のターンになって切れたターンの続きが積まれない・続きより
// 先に届いたもので起きる。

import { parseResumeAnswers, type ResumeAnswer, type ResumeQuestion } from "@banto/module-contract";
import type { InboxStore } from "../inbox/store.js";
import type { ProjectThreadStore } from "../project-thread/store.js";
import type { AwaitingReply } from "../project-thread/types.js";
import type { ReplyHandles } from "./reply-handles.js";
import type { ThreadDeliveries } from "./thread-deliveries.js";
import { resumeInterruptedTurns, type SessionReader, type TurnContinuationDeps } from "./turn-continuation.js";

/** Module に問うのを待つ上限（起こす時間も入れて）。過ぎたら「途中で終わりました」 */
export const RESUME_ASK_TIMEOUT_MS = 120_000;

/** 問う相手（札を渡した Module の接続）と、その接続に渡した札 */
export interface ResumeTarget {
  moduleName: string;
  /** 札を渡した接続の名前（Project ごとの Module は `<名前>-<projectId>`） */
  connName: string;
  projectId: string;
}

export interface RestartRecoveryDeps {
  projectThread: ProjectThreadStore;
  inbox: InboxStore;
  deliveries: ThreadDeliveries;
  replyHandles: ReplyHandles;
  sessions?: SessionReader;
  /** その Module が「起こし直しても続けられる」と名乗っているか（宣言で見る——起こさずに分かる） */
  resumable(target: { moduleName: string; projectId: string }): boolean;
  /**
   * その Module を（Project の Module ならその Project で）起こし、問いを渡して答え（tool の結果の JSON）を返す。
   * 起こせない・断られたら投げる
   */
  ask(target: ResumeTarget, question: ResumeQuestion): Promise<unknown>;
  /** 「途中で終わりました」を届けて札を片づける（cli.ts の `deliverLostReply`） */
  deliverLost(reply: { threadId: string; replyTo: string; moduleName: string; hop: number }, why: string): Promise<void>;
  /** バックグラウンドの印を描き直させる */
  publishBackground(threadId: string): void;
  askTimeoutMs?: number;
}

type TurnResults = Awaited<ReturnType<typeof resumeInterruptedTurns>>;

export class RestartRecovery {
  /** 判定を待っている札（接続ごと） */
  private readonly groups = new Map<string, { target: ResumeTarget; replies: Array<AwaitingReply & { threadId: string }> }>();
  /** 判定が終わるまで留める Thread と、終わったら解く約束 */
  private readonly held = new Map<string, { done: Promise<void>; resolve: () => void }>();
  /** 続けると答えた Module（Thread ごと） */
  private readonly kept = new Map<string, Set<string>>();

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
          const group = this.groups.get(r.connName) ?? {
            target: { moduleName: r.moduleName, connName: r.connName, projectId: p.id },
            replies: [],
          };
          group.replies.push({ ...r, threadId: t.id });
          this.groups.set(r.connName, group);
          if (!this.held.has(t.id)) {
            let resolve!: () => void;
            const done = new Promise<void>((r2) => (resolve = r2));
            this.held.set(t.id, { done, resolve });
          }
        }
      }
    }
    return resumeInterruptedTurns(this.turnDeps(), (threadId) => !this.held.has(threadId));
  }

  /** 2段目（待ち受けの後）。名乗った Module に問い、残りの切れたターンを片づけ、留めを解く。投げない */
  async afterListen(): Promise<{ answers: Array<{ target: ResumeTarget; replyTo: string; threadId: string; kept: boolean; why?: string }>; turns: TurnResults }> {
    const answers: Array<{ target: ResumeTarget; replyTo: string; threadId: string; kept: boolean; why?: string }> = [];
    let turns: TurnResults = [];
    try {
      await Promise.all(
        [...this.groups.values()].map(async ({ target, replies }) => {
          const got = await this.askOne(target, replies);
          for (const r of replies) {
            const answer = "error" in got ? undefined : got.answers.get(r.replyTo);
            // 問っている間に Module が止まった（`onclose` が「途中で終わりました」を届けた）なら、もう札は無い
            const alive = this.deps.replyHandles.get(r.replyTo) !== undefined;
            if (answer?.resume && alive) {
              const modules = this.kept.get(r.threadId) ?? new Set<string>();
              modules.add(target.moduleName);
              this.kept.set(r.threadId, modules);
              await this.deps.projectThread.markReplyKept(r.threadId, r.replyTo).catch((err: unknown) =>
                console.warn(`[host] ${r.threadId} の札を「続けています」にできませんでした:`, err),
              );
              this.deps.publishBackground(r.threadId);
              answers.push({ target, replyTo: r.replyTo, threadId: r.threadId, kept: true });
              continue;
            }
            const why =
              "error" in got
                ? `banto を起動し直したため（${target.moduleName} に続けるかを聞けませんでした：${got.error}）`
                : answer && !answer.resume
                  ? `banto を起動し直したため（${target.moduleName} が続けられないと答えました：${(answer as Extract<ResumeAnswer, { resume: false }>).reason}）`
                  : answer
                    ? "Module が止まったため"
                    : `banto を起動し直したため（${target.moduleName} がこの仕事について答えませんでした）`;
            if (alive) await this.deps.deliverLost({ threadId: r.threadId, replyTo: r.replyTo, moduleName: r.moduleName, hop: r.hop }, why);
            answers.push({ target, replyTo: r.replyTo, threadId: r.threadId, kept: false, why });
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

  private turnDeps(): TurnContinuationDeps {
    const { projectThread, inbox, deliveries, sessions } = this.deps;
    return { projectThread, inbox, deliveries, ...(sessions ? { sessions } : {}), keptReplies: (id) => this.keptReplies(id) };
  }

  private async askOne(
    target: ResumeTarget,
    replies: ReadonlyArray<AwaitingReply & { threadId: string }>,
  ): Promise<{ answers: Map<string, ResumeAnswer> } | { error: string }> {
    const question: ResumeQuestion = {
      items: replies.map((r) => ({
        replyTo: r.replyTo,
        ...(r.work?.toolName ? { toolName: r.work.toolName } : {}),
        ...(r.work?.toolCallId ? { toolCallId: r.work.toolCallId } : {}),
        thread: { projectId: target.projectId, threadId: r.threadId },
      })),
    };
    const limit = this.deps.askTimeoutMs ?? RESUME_ASK_TIMEOUT_MS;
    let timer: NodeJS.Timeout | undefined;
    try {
      const raw = await Promise.race([
        this.deps.ask(target, question),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`${Math.round(limit / 1000)} 秒待っても答えが来ませんでした`)), limit);
        }),
      ]);
      return { answers: parseResumeAnswers(raw, replies.map((r) => r.replyTo)) };
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    } finally {
      clearTimeout(timer);
    }
  }
}

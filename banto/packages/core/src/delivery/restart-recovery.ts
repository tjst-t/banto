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

//
// **別のサーバの Module は繋がるまで待つ**（決定・2026-10-16、ユーザー。Backlog #324）：banto を更新すると別のサーバへ新しい
// 版のコードを送ってから Module を起こすので、120 秒の期限に間に合わず、向こうで動き続けている仕事が「途中で終わりました」に
// なっていた。別のサーバの Module では期限を2つに分ける——繋がるまで（`REMOTE_CONNECT_LIMIT_MS`、送り込みが止まったら
// `remote-ssh.ts` が先に打ち切る）と、繋がってから答えるまで（120 秒）。この機械のコンテナの Module は今どおり1つの期限。
// 繋がるのを待つ間、札は「起こし直しのあと続けています」の形で出し続け、Thread は届いたもので起こさない——ただし人が
// その Thread で送ったら待たずにターンを始める（切れたターンの続きを先に積み、人のターンが引き継ぐ）。
//
// **打ち切ったら、届け直せる印を残す**：別のサーバの Module に繋がらない・答えないまま打ち切った Thread 宛ての札は、
// 「途中で終わりました」に理由と結果の場所（札を出したときに Module が名乗った `dev.banto/resultLocation`）を添え、
// Event Store に「届け直せる」印（`reply.redeliverable`）を残す。あとでその Module が繋がったら（`moduleConnected`）、
// 印の札を「打ち切った札」（`afterLost`）として同じ問いで渡す。問う直前に札を覚え直して返事待ちに戻す——印はここで
// 使い切る（一度だけ）。Module が「続ける」と答えれば、終わっていればすぐ・動いていれば終わったときに、その札で届く
// （題に「起こし直しで途切れたあとに終わっていました」が付く——cli.ts）。続けないと答えたら何も届けずに片づける。
// また繋がらなければ印を残し直す。
//
// **banto は動いたまま、Module との接続だけが切れたとき**（決定・2026-10-17、Backlog #362。実機：host から別のサーバへの
// 経路が2分途切れ、SSH が閉じた瞬間に Shell の待たないコマンドの札がみな「途中で終わりました」になった——コマンドは
// 向こうで最後まで走っていた）：名乗った Module の札は、接続が閉じても「途中で終わりました」にせず、繋がり直すのを待つ
// （`connectionLost`）。繋がり直したら（`moduleConnected`）、起こし直しのときと同じ問いを1回送る——その接続の待っている札と
// 届け直せる札を1つの問いに乗せる。繋がらないまま上限（`REMOTE_CONNECT_LIMIT_MS`、最初に切れた時から）を越えたら、
// 打ち切った札と同じく理由と結果の場所を添えた「途中で終わりました」と届け直せる印。人が止めた（畳んだ・外した）なら
// 今どおりすぐ「途中で終わりました」、起こし直さないと決めたら待つのをやめて「途中で終わりました」（`abandonReconnect`）。
// banto が止まる途中なら触らない（`stop`——Event Store に残った返事待ちを、次に起きたときの判定が拾う）。

import { parseResumeAnswers, type ResumeAnswer, type ResumeQuestion, type ResumeQuestionItem } from "@banto/module-contract";
import type { InboxStore } from "../inbox/store.js";
import type { ProjectThreadStore } from "../project-thread/store.js";
import type { BackgroundWork, ReplyHandle, ReplyHandles, ReplyToModule } from "./reply-handles.js";
import type { ModuleAwaitingReply } from "./module-replies.js";
import type { ThreadDeliveries } from "./thread-deliveries.js";
import { resumeInterruptedTurns, type SessionReader, type TurnContinuationDeps } from "./turn-continuation.js";

/** Module に問うのを待つ上限（この機械の Module は起こす時間も入れて、別のサーバの Module は繋がってから）。過ぎたら打ち切る */
export const RESUME_ASK_TIMEOUT_MS = 120_000;
/** 別のサーバの Module に繋がるのを待つ上限（経路が途切れている等）。送り込みが止まったときは `remote-ssh.ts` が先に打ち切る */
export const REMOTE_CONNECT_LIMIT_MS = 30 * 60_000;
/** 接続が切れて待っていた札の「途中で終わりました」の理由の頭（起こし直しのときの「banto を起動し直したため」に当たる） */
export const DISCONNECT_WHY = "Module との接続が切れたため";
/** 別のサーバの Module を起こせなかったとき、次に試すまでの間 */
const REMOTE_CONNECT_RETRY_MS = 5_000;

/**
 * **まだ起きていない**（追加・2026-10-16、Backlog #324）。`connect` がこれを投げたら、別のサーバの Module では待って試し直す
 * （繋がるのを待つ上限まで）。ほかの失敗（宣言が無い等）は待たずに打ち切る
 */
export class ModuleNotUpYetError extends Error {}

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
      /** 打ち切った札（届け直せる印から）。Thread は留めない——「途中で終わりました」はもう届いている */
      afterLost?: boolean;
      /** banto は動いたまま、Module との接続が切れて待っていた札（Backlog #362）。理由の文を書き分ける */
      cause?: "disconnect";
    }
  | {
      kind: "module";
      replyTo: string;
      moduleName: string;
      connName: string;
      projectId?: string;
      toModule: ReplyToModule;
      cause?: "disconnect";
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
   * その Module を（Project の Module ならその Project で）起こして繋ぐ。起こせなければ投げる（まだ起きていないだけなら
   * `ModuleNotUpYetError`）。`signal` が立ったらやめる（間に合わなければ、繋がったあと問いを送らない——ここが見る）
   */
  connect(target: ResumeTarget, signal: AbortSignal): Promise<{ ask(question: ResumeQuestion, signal: AbortSignal): Promise<unknown> }>;
  /**
   * 「途中で終わりました」を届けて札を片づける（cli.ts の `deliverLostReply`）。`note` は、打ち切った札を繋がったあと
   * 届け直すときに添える文（結果の場所・届け直すこと）
   */
  deliverLost(reply: { threadId: string; replyTo: string; moduleName: string; hop: number }, why: string, opts?: { note?: string }): Promise<void>;
  /** バックグラウンドの印を描き直させる */
  publishBackground(threadId: string): void;
  /** その Module が別のサーバで動くなら、その実行場所の名前（この機械なら undefined）。無ければみなこの機械 */
  remoteOf?(target: ResumeTarget): string | undefined;
  /** その実行場所に SSH で繋がらないなら、その理由（`remote-outage.ts`） */
  unreachableReason?(runtimeName: string): string | undefined;
  /** その接続がいま繋がっているか（打ち切ったあと、もう繋がっていればすぐ届け直す） */
  isConnected?(connName: string): boolean;
  askTimeoutMs?: number;
  /** 別のサーバの Module に繋がるのを待つ上限（既定 `REMOTE_CONNECT_LIMIT_MS`。E2E が縮める） */
  connectLimitMs?: number;
  /** 起こせなかったとき、次に試すまでの間（既定 5 秒。試験が縮める） */
  connectRetryMs?: number;
}

type TurnResults = Awaited<ReturnType<typeof resumeInterruptedTurns>>;

/** 1件の札の判定の結果（ログ用） */
export interface ReplyOutcome {
  target: ResumeTarget;
  replyTo: string;
  /** Thread 宛てならその Thread、Module 宛てなら呼び元の Module */
  to: { threadId: string } | { module: string };
  /**
   * kept：続けると答えた（札を覚え直した）／lost：「途中で終わりました」を届けた／settled：答えの前に済んでいた。
   * 打ち切った札（`afterLost`）は、kept：届け直す／lost：届け直さない（続けないと答えた・また繋がらなかった——`why`）。
   * waiting：問いの最中に接続が切れたので、繋がり直すのをまた待つ（Backlog #362）
   */
  outcome: "kept" | "lost" | "settled" | "waiting";
  why?: string;
  afterLost?: boolean;
}

/** 問いの失敗。`cause` で「途中で終わりました」の理由を書き分ける */
interface AskFailure {
  error: string;
  /** 別のサーバの Module で打ち切った（繋がらなかった・起きなかった・答えなかった）——届け直せる */
  gaveUp?: boolean;
}

export class RestartRecovery {
  /** 判定を待っている札（接続ごと） */
  private readonly groups = new Map<string, PendingReply[]>();
  /** 判定の終わった接続 */
  private readonly finished = new Set<string>();
  /** 問っている最中の接続（起き直したときの判定・届け直し）。同じ Module に2つの問いを並べない */
  private readonly inFlight = new Set<string>();
  /** 別のサーバの Module に繋がるのを待っている接続 → 実行場所 */
  private readonly waitingRemote = new Map<string, string>();
  /** 判定が終わるまで留める Thread と、終わったら解く約束 */
  private readonly held = new Map<string, { done: Promise<void>; resolve: () => void }>();
  /** 人が送ったので、切れたターンを先に片づけた Thread（その片づけの終わり） */
  private readonly releasedForHuman = new Map<string, Promise<void>>();
  /** 続けると答えた Module（Thread ごと） */
  private readonly kept = new Map<string, Set<string>>();
  /** 判定の間に済んだ札とその済み方（届いた・「途中で終わりました」） */
  private readonly settled = new Map<string, "delivered" | "lost">();
  /** 打ち切った札のうち、問う前に覚え直して返事待ちに戻したもの */
  private readonly prepared = new Set<string>();
  /** 切れたターンの片づけは1本ずつ（同じターンを2回見ない） */
  private turnChain: Promise<unknown> = Promise.resolve();
  /** banto は動いたまま接続が切れ、繋がり直すのを待っている札（接続ごと）と、上限で打ち切る時計（Backlog #362） */
  private readonly disconnected = new Map<string, { replies: PendingReply[]; timer?: NodeJS.Timeout }>();
  /** 札ごとに最初に接続が切れた時刻。問いの最中にまた切れても、上限は最初に切れた時から数える（切れ続けても待ち続けない） */
  private readonly lostAt = new Map<string, number>();
  /** banto が止まる途中（`stop`）。もう札に触らない */
  private stopped = false;

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
    // **届け直せる札**（前の走行で打ち切ったもの、Backlog #324）も同じ問いに乗せる——Module ごとに問いは1回（Subagent は
    // 問われなかった記録を片づける）。Thread は留めない。覚え直すのは問う直前（`askOne`）
    for (const r of this.redeliverable()) this.pend(r);
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

  /**
   * 2段目（待ち受けの後）。名乗った Module に問い、**答えの出た接続から**、その札だけを待っていた Thread の切れたターンを
   * 片づけて留めを解く（別のサーバの Module に繋がるのを待つ間、ほかの Thread を待たせない）。投げない
   */
  async afterListen(): Promise<{ answers: ReplyOutcome[]; turns: TurnResults }> {
    const answers: ReplyOutcome[] = [];
    const turns: TurnResults = [];
    try {
      await Promise.all(
        [...this.groups].map(async ([connName, replies]) => {
          this.inFlight.add(connName);
          try {
            const target = targetOf(replies);
            answers.push(...(await this.judge(target, replies, await this.askOne(target, replies))));
          } catch (err) {
            console.warn(`[host] 起き直したときの ${connName} の札の判定が途中で失敗しました（留めた Thread は解きます）:`, err);
          } finally {
            this.inFlight.delete(connName);
            this.finished.add(connName);
            turns.push(...(await this.releaseThreadsOf(replies)));
            // 打ち切ったあと、もう繋がっていれば（打ち切った直後に繋がった）すぐ届け直す
            if (this.deps.isConnected?.(connName)) void this.redeliverTo(connName);
          }
        }),
      );
    } catch (err) {
      console.warn("[host] 起き直したときの札の判定が途中で失敗しました（留めた Thread は解きます）:", err);
    } finally {
      for (const threadId of [...this.held.keys()]) this.release(threadId);
    }
    return { answers, turns };
  }

  /**
   * **Module が繋がった**（cli.ts の `finishModuleConnection` が呼ぶ。追加・2026-10-16、Backlog #324）。その接続に届け直せる札
   * があれば、打ち切った札として問う。起き直したときの判定の最中なら何もしない——その問いに乗っているか、判定の終わりに
   * もう一度見る
   */
  moduleConnected(connName: string): void {
    if (this.stopped || this.inFlight.has(connName) || (this.groups.has(connName) && !this.finished.has(connName))) return;
    void this.redeliverTo(connName);
  }

  /**
   * **Module との接続が閉じた**（cli.ts の `client.onclose` が呼ぶ。Backlog #362）。その接続に渡した返事待ちの札を分ける：
   * 人が止めた（`onPurpose`——畳んだ・外した）でなく、`keepsAcrossDisconnect` の札は繋がり直すのを待つ（`waiting`）。
   * 残り（`lose`）は呼ぶ側が今どおり「途中で終わりました」にする。**banto が止まる途中（`stop` のあと）なら undefined**
   * ——札に触らない
   */
  connectionClosed(connName: string, opts: { onPurpose: boolean }): { lose: Array<[string, ReplyHandle]>; waiting: ReadonlySet<string> } | undefined {
    if (this.stopped) return undefined;
    const lose: Array<[string, ReplyHandle]> = [];
    const waiting: Array<[string, ReplyHandle]> = [];
    for (const [replyTo, h] of this.deps.replyHandles.awaitingFor(connName)) {
      (!opts.onPurpose && this.keepsAcrossDisconnect(h) ? waiting : lose).push([replyTo, h]);
    }
    this.connectionLost(connName, waiting);
    return { lose, waiting: new Set(waiting.map(([replyTo]) => replyTo)) };
  }

  /**
   * **接続が切れたとき、この札を繋がり直すまで待たせるか**。札を渡した Module が続けられると名乗っていて、宛先がまだある
   * （Thread 宛て：Thread も Project も閉じていない／Module 宛て：呼び元も名乗っている——起こし直しのときと同じ条件）
   */
  private keepsAcrossDisconnect(h: ReplyHandle): boolean {
    if (h.toModule) {
      const where = h.projectId ? { projectId: h.projectId } : {};
      return this.deps.resumable({ moduleName: h.moduleName, ...where }) && this.deps.resumable({ moduleName: h.toModule.moduleName, ...where });
    }
    const thread = this.deps.projectThread.getThread(h.threadId);
    if (!thread || thread.status === "closed" || this.deps.projectThread.getProject(thread.projectId)?.status === "closed") return false;
    return this.deps.resumable({ moduleName: h.moduleName, projectId: thread.projectId });
  }

  /**
   * 札を繋がり直すまで待たせる——札は返事待ちのまま（画面は「接続が切れたあと続けています」）。繋がり直したら
   * `moduleConnected` が問う。上限を越えたら打ち切る
   */
  private connectionLost(connName: string, handles: ReadonlyArray<readonly [string, ReplyHandle]>): void {
    if (handles.length === 0) return;
    const entry = this.disconnected.get(connName) ?? { replies: [] };
    const now = Date.now();
    for (const [replyTo, h] of handles) {
      if (entry.replies.some((r) => r.replyTo === replyTo)) continue;
      if (!this.lostAt.has(replyTo)) this.lostAt.set(replyTo, now);
      if (h.toModule) {
        entry.replies.push({
          kind: "module",
          replyTo,
          moduleName: h.moduleName,
          connName,
          ...(h.projectId ? { projectId: h.projectId } : {}),
          toModule: h.toModule,
          cause: "disconnect",
        });
        continue;
      }
      const thread = this.deps.projectThread.getThread(h.threadId);
      if (!thread) continue;
      entry.replies.push({
        kind: "thread",
        replyTo,
        moduleName: h.moduleName,
        connName,
        projectId: thread.projectId,
        threadId: h.threadId,
        // 届いたときのホップ（札を出したターンのホップ＋1）
        hop: h.hop + 1,
        ...(h.work ? { work: h.work } : {}),
        cause: "disconnect",
      });
      void this.deps.projectThread
        .markReplyKept(h.threadId, replyTo, { after: "disconnect" })
        .catch((err: unknown) => console.warn(`[host] ${h.threadId} の札を「接続が切れたあと続けています」にできませんでした:`, err))
        .finally(() => this.deps.publishBackground(h.threadId));
    }
    if (entry.replies.length === 0) return;
    // 上限は、その接続で待っている札のうち最初に切れた時から
    const limit = this.deps.connectLimitMs ?? REMOTE_CONNECT_LIMIT_MS;
    const first = Math.min(...entry.replies.map((r) => this.lostAt.get(r.replyTo) ?? now));
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = setTimeout(() => void this.giveUpReconnect(connName), Math.max(0, first + limit - now));
    entry.timer.unref?.();
    this.disconnected.set(connName, entry);
    console.log(`[host] ${connName} との接続が切れました——続けられる札 ${entry.replies.length} 件は、繋がり直すのを待ちます（上限 ${spanOf(limit)}）`);
  }

  /**
   * **繋がり直すのを待つのをやめる**（Backlog #362）：繋がり直す前に人が Module を畳んだ・外した、起こし直さないと決めた
   * （宣言から外れた・Project が無い）。待っていた札に「途中で終わりました」を届ける（届け直せる印は残さない）
   */
  async abandonReconnect(match: (connName: string) => boolean, why: string): Promise<void> {
    for (const [connName, entry] of [...this.disconnected]) {
      if (!match(connName)) continue;
      this.disconnected.delete(connName);
      if (entry.timer) clearTimeout(entry.timer);
      for (const r of entry.replies) {
        this.lostAt.delete(r.replyTo);
        if (this.deps.replyHandles.get(r.replyTo) === undefined) continue;
        await this.lose(r, why).catch((err: unknown) => console.warn(`[host] ${connName} の札を片づけられませんでした:`, err));
      }
    }
  }

  /** その接続で、繋がり直すのを待っている札があるか */
  awaitingReconnect(connName: string): boolean {
    return this.disconnected.has(connName);
  }

  /**
   * **banto が止まる途中**（SIGTERM）。もう札に触らない——待っている札は Event Store に返事待ちのまま残り、次に起きたときの
   * 判定（`beforeListen`）が拾う。打ち切りの時計も止める
   */
  stop(): void {
    this.stopped = true;
    for (const entry of this.disconnected.values()) if (entry.timer) clearTimeout(entry.timer);
  }

  /**
   * **判定の間に札が済んだ**（cli.ts が呼ぶ：最後の届けが済んだ・「途中で終わりました」を届けた）。済み方をログに正しく書く
   */
  noteSettled(replyTo: string, how: "delivered" | "lost"): void {
    if ([...this.groups.values()].some((rs) => rs.some((r) => r.replyTo === replyTo))) this.settled.set(replyTo, how);
  }

  /** 判定の終わっていない Thread を届いたもので起こさない理由（`ThreadDeliveries` の `hold`） */
  holdReason(threadId: string): string | undefined {
    if (!this.held.has(threadId)) return undefined;
    const remote = this.remoteWaitsOf(threadId)[0];
    return remote
      ? `banto を起こし直したあと、この会話で頼んだ仕事を続けるかを聞くため、別のサーバ「${remote.runtime}」の Module に繋がるのを待っています（終わったら起こします）`
      : "banto を起こし直したあと、この会話で頼んだ仕事を続けるかを Module に聞いています（終わったら起こします）";
  }

  /**
   * 人が送ったターンは、その Thread の判定が終わるまで待ってから始める。**別のサーバの Module に繋がるのを待っているなら
   * 待たせない**（Backlog #324——繋がるまで何分もかかりうる）：切れたターンの続きを先に積み（人のターンが引き継ぐ）、
   * すぐ始める。札は待ち続け、届いたものでは起こさないまま
   */
  waitFor(threadId: string): Promise<void> {
    const h = this.held.get(threadId);
    if (!h) return Promise.resolve();
    if (this.remoteWaitsOf(threadId).length === 0) return h.done;
    let released = this.releasedForHuman.get(threadId);
    if (!released) {
      released = this.resumeTurnsOf(new Set([threadId])).then(
        (results) => logHumanRelease(threadId, results),
        (err: unknown) => console.warn(`[host] ${threadId} の切れたターンを片づけられませんでした:`, err),
      );
      this.releasedForHuman.set(threadId, released);
    }
    return released;
  }

  /** 続けると答えた Module（その Thread の分）と、繋がるのを待っている別のサーバの Module。切れたターンの続きの文に書く */
  keptReplies(threadId: string): Array<{ moduleName: string; waitingFor?: string }> {
    return [
      ...[...(this.kept.get(threadId) ?? [])].map((moduleName) => ({ moduleName })),
      ...this.remoteWaitsOf(threadId).map((w) => ({ moduleName: w.moduleName, waitingFor: w.runtime })),
    ];
  }

  private pend(r: PendingReply): void {
    const group = this.groups.get(r.connName) ?? [];
    group.push(r);
    this.groups.set(r.connName, group);
  }

  /** その Thread の札で、別のサーバの Module に繋がるのを待っているもの */
  private remoteWaitsOf(threadId: string): Array<{ moduleName: string; runtime: string }> {
    const out: Array<{ moduleName: string; runtime: string }> = [];
    for (const [connName, runtime] of this.waitingRemote) {
      const replies = this.groups.get(connName) ?? [];
      const r = replies.find((x) => x.kind === "thread" && !x.afterLost && x.threadId === threadId);
      if (r && !out.some((o) => o.moduleName === r.moduleName)) out.push({ moduleName: r.moduleName, runtime });
    }
    return out;
  }

  /** 届け直せる札（開いている Thread・Project の、名乗った Module のもの）。`connName` を渡せばその接続の分だけ */
  private redeliverable(connName?: string): PendingReply[] {
    const out: PendingReply[] = [];
    for (const p of this.deps.projectThread.listProjects()) {
      if (p.status === "closed") continue;
      for (const t of this.deps.projectThread.listThreadsForProject(p.id)) {
        if (t.status === "closed") continue;
        for (const r of t.redeliverableReplies ?? []) {
          if (connName !== undefined && r.connName !== connName) continue;
          if (!this.deps.resumable({ moduleName: r.moduleName, projectId: p.id })) continue;
          out.push({
            kind: "thread",
            replyTo: r.replyTo,
            moduleName: r.moduleName,
            connName: r.connName,
            projectId: p.id,
            threadId: t.id,
            hop: r.hop,
            ...(r.work ? { work: r.work } : {}),
            afterLost: true,
            ...(r.after ? { cause: r.after } : {}),
          });
        }
      }
    }
    return out;
  }

  /**
   * 繋がったあと、その接続の札を1つの問いで問う：接続が切れて待っていた札（Backlog #362）と、届け直せる札（打ち切った札
   * として）。投げない
   */
  private async redeliverTo(connName: string): Promise<void> {
    if (this.stopped || this.inFlight.has(connName)) return;
    const waiting = this.disconnected.get(connName);
    if (waiting) {
      this.disconnected.delete(connName);
      if (waiting.timer) clearTimeout(waiting.timer);
    }
    const replies = [...(waiting?.replies ?? []), ...this.redeliverable(connName)];
    if (replies.length === 0) return;
    this.inFlight.add(connName);
    try {
      const target = targetOf(replies);
      for (const a of await this.judge(target, replies, await this.askOne(target, replies))) {
        const to = "threadId" in a.to ? `Thread ${a.to.threadId}` : `呼び元 ${a.to.module}`;
        if (a.afterLost) {
          console.log(
            `[host] 打ち切った札を ${a.target.moduleName} に問い直した（${to}）→ ` +
              (a.outcome === "kept" ? "届け直す（終わっていれば今、動いていれば終わったら）" : a.outcome === "settled" ? "もう届いた" : `届け直さない（${a.why}）`),
          );
          continue;
        }
        if (a.outcome === "kept" || a.outcome === "settled") this.lostAt.delete(a.replyTo);
        console.log(
          `[host] 接続が切れたあとの返事待ち（${a.target.moduleName}・${to}）→ ` +
            (a.outcome === "kept"
              ? "続けると答えた"
              : a.outcome === "settled"
                ? `問いの答えより前に済んだ（${a.why}）`
                : a.outcome === "waiting"
                  ? "問いの最中にまた切れた（繋がり直すのを待つ）"
                  : `途中で終わりました（${a.why}）`),
        );
      }
    } catch (err) {
      console.warn(`[host] ${connName} に続けるかを問えませんでした:`, err);
    } finally {
      this.inFlight.delete(connName);
      for (const r of replies) if (!this.waitingReconnect(r.replyTo) && this.deps.replyHandles.get(r.replyTo) === undefined) this.lostAt.delete(r.replyTo);
    }
  }

  /** その札が、接続が切れて繋がり直すのを待っているか */
  private waitingReconnect(replyTo: string): boolean {
    for (const entry of this.disconnected.values()) if (entry.replies.some((r) => r.replyTo === replyTo)) return true;
    return false;
  }

  /** 接続が切れたまま上限を越えた：理由と結果の場所を添えた「途中で終わりました」と、届け直せる印 */
  private async giveUpReconnect(connName: string): Promise<void> {
    const entry = this.disconnected.get(connName);
    if (!entry || this.stopped) return;
    this.disconnected.delete(connName);
    const target = targetOf(entry.replies);
    const remote = this.deps.remoteOf?.(target);
    const limit = this.deps.connectLimitMs ?? REMOTE_CONNECT_LIMIT_MS;
    const reason = remote !== undefined ? this.connectGiveUp(target, remote, limit, undefined) : `${target.moduleName} に ${spanOf(limit)}繋がり直せませんでした`;
    const why = `${DISCONNECT_WHY}（${reason}）`;
    console.warn(`[host] ${connName} に繋がり直さないまま上限を越えました——待っていた札 ${entry.replies.length} 件を打ち切ります（${reason}）`);
    for (const r of entry.replies) {
      this.lostAt.delete(r.replyTo);
      if (this.deps.replyHandles.get(r.replyTo) === undefined) continue;
      try {
        if (r.kind !== "thread") {
          await this.lose(r, why);
          continue;
        }
        await this.deps.projectThread.markReplyRedeliverable({
          threadId: r.threadId,
          replyTo: r.replyTo,
          connName: r.connName,
          moduleName: r.moduleName,
          hop: r.hop,
          ...(r.work ? { work: r.work } : {}),
          after: "disconnect",
        });
        const location = r.work?.resultLocation;
        await this.deps.deliverLost({ threadId: r.threadId, replyTo: r.replyTo, moduleName: r.moduleName, hop: r.hop }, why, {
          note:
            (location ? `結果の場所：${location}${remote !== undefined ? `（別のサーバ「${remote}」の中）` : ""}。` : "") +
            `${target.moduleName} に繋がったら、そのときまでに終わっていた結果をこの会話に届け直します`,
        });
      } catch (err) {
        console.warn(`[host] ${connName} の札を打ち切れませんでした:`, err);
      }
    }
  }

  /** 答えを札ごとに片づける */
  private async judge(target: ResumeTarget, replies: readonly PendingReply[], got: { answers: Map<string, ResumeAnswer> } | AskFailure): Promise<ReplyOutcome[]> {
    const out: ReplyOutcome[] = [];
    const remote = this.deps.remoteOf?.(target);
    for (const r of replies) {
      const to = r.kind === "thread" ? { threadId: r.threadId } : { module: r.toModule.moduleName };
      if (r.kind === "thread" && r.afterLost) {
        out.push({ target, replyTo: r.replyTo, to, afterLost: true, ...(await this.judgeAfterLost(r, got)) });
        continue;
      }
      // **問いの最中に接続が切れた**（Backlog #362）：札は繋がり直すのをまた待っている（cli.ts の onclose が先に渡す）——
      // 答えが来なかったことを「途中で終わりました」にしない
      if (this.waitingReconnect(r.replyTo)) {
        out.push({ target, replyTo: r.replyTo, to, outcome: "waiting" });
        continue;
      }
      // 判定の間に札が済んだ：答えの前に最後の届けが済んだか、Module が止まって「途中で終わりました」を届けた
      if (this.deps.replyHandles.get(r.replyTo) === undefined) {
        const how = this.settled.get(r.replyTo);
        out.push({
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
          await this.deps.projectThread.markReplyKept(r.threadId, r.replyTo, r.cause ? { after: r.cause } : {}).catch((err: unknown) =>
            console.warn(`[host] ${r.threadId} の札を「続けています」にできませんでした:`, err),
          );
          this.deps.publishBackground(r.threadId);
        }
        // Module 宛ての札は、返事待ち（module-replies）に残ったまま待ち続ける
        out.push({ target, replyTo: r.replyTo, to, outcome: "kept" });
        continue;
      }
      // **別のサーバの Module で打ち切った**（繋がらない・起きない・答えない）：理由と結果の場所を添え、届け直せる印を残す
      const gaveUp = remote !== undefined && ("error" in got ? got.gaveUp === true : answer === undefined);
      const head = r.cause === "disconnect" ? DISCONNECT_WHY : "banto を起動し直したため";
      const why =
        "error" in got
          ? remote !== undefined
            ? `${head}（${got.error}）`
            : `${head}（${target.moduleName} に続けるかを聞けませんでした：${got.error}）`
          : answer
            ? `${head}（${target.moduleName} が続けられないと答えました：${(answer as Extract<ResumeAnswer, { resume: false }>).reason}）`
            : `${head}（${target.moduleName} がこの仕事について答えませんでした）`;
      if (gaveUp && r.kind === "thread") {
        await this.deps.projectThread
          .markReplyRedeliverable({
            threadId: r.threadId,
            replyTo: r.replyTo,
            connName: r.connName,
            moduleName: r.moduleName,
            hop: r.hop,
            ...(r.work ? { work: r.work } : {}),
          })
          .catch((err: unknown) => console.warn(`[host] ${r.threadId} の札に届け直せる印を残せませんでした:`, err));
        const location = r.work?.resultLocation;
        await this.deps.deliverLost({ threadId: r.threadId, replyTo: r.replyTo, moduleName: r.moduleName, hop: r.hop }, why, {
          note:
            (location ? `結果の場所：${location}（別のサーバ「${remote}」の中）。` : "") +
            `${target.moduleName} に繋がったら、そのときまでに終わっていた結果をこの会話に届け直します`,
        });
      } else {
        await this.lose(r, why);
      }
      out.push({ target, replyTo: r.replyTo, to, outcome: "lost", why });
    }
    return out;
  }

  /** 打ち切った札の答え。届け直さないなら札を黙って片づける（「途中で終わりました」はもう届いている） */
  private async judgeAfterLost(
    r: Extract<PendingReply, { kind: "thread" }>,
    got: { answers: Map<string, ResumeAnswer> } | AskFailure,
  ): Promise<Pick<ReplyOutcome, "outcome" | "why">> {
    // 問う前に打ち切った（繋がらなかった）——印は残っている
    if (!this.prepared.has(r.replyTo)) return { outcome: "lost", why: "error" in got ? `また打ち切りました（${got.error}）。届け直せる印は残します` : "問いに載せませんでした" };
    this.prepared.delete(r.replyTo);
    // 問いの間に届いた（Module がすぐ届けた）
    if (this.deps.replyHandles.get(r.replyTo) === undefined) return { outcome: "settled", why: "答えの前に届いた" };
    const answer = "error" in got ? undefined : got.answers.get(r.replyTo);
    if (answer?.resume) {
      await this.deps.projectThread.markReplyKept(r.threadId, r.replyTo).catch(() => undefined);
      this.deps.publishBackground(r.threadId);
      return { outcome: "kept" };
    }
    this.deps.replyHandles.settle(r.replyTo);
    await this.deps.projectThread.settleReply(r.threadId, r.replyTo).catch(() => undefined);
    if ("error" in got) {
      // また答えが来なかった——次に繋がったときにもう一度
      await this.deps.projectThread
        .markReplyRedeliverable({
          threadId: r.threadId,
          replyTo: r.replyTo,
          connName: r.connName,
          moduleName: r.moduleName,
          hop: r.hop,
          ...(r.work ? { work: r.work } : {}),
          ...(r.cause ? { after: r.cause } : {}),
        })
        .catch((err: unknown) => console.warn(`[host] ${r.threadId} の札に届け直せる印を残し直せませんでした:`, err));
    }
    this.deps.publishBackground(r.threadId);
    return {
      outcome: "lost",
      why: "error" in got ? `答えが来ませんでした（${got.error}）。届け直せる印は残します` : answer ? `続けないと答えました：${(answer as Extract<ResumeAnswer, { resume: false }>).reason}` : "この札について答えませんでした",
    };
  }

  /** その接続の札を待っていた Thread のうち、ほかの接続の判定も終わったものの切れたターンを片づけ、留めを解く */
  private async releaseThreadsOf(replies: readonly PendingReply[]): Promise<TurnResults> {
    const ready = new Set<string>();
    for (const r of replies) {
      if (r.kind !== "thread" || r.afterLost || !this.held.has(r.threadId)) continue;
      const waiting = [...this.groups].some(
        ([conn, rs]) => !this.finished.has(conn) && rs.some((x) => x.kind === "thread" && !x.afterLost && x.threadId === r.threadId),
      );
      if (!waiting) ready.add(r.threadId);
    }
    if (ready.size === 0) return [];
    let results: TurnResults = [];
    try {
      results = await this.resumeTurnsOf(ready);
    } catch (err) {
      console.warn("[host] 切れたターンを片づけられませんでした（留めた Thread は解きます）:", err);
    }
    for (const threadId of ready) this.release(threadId);
    return results;
  }

  private release(threadId: string): void {
    const h = this.held.get(threadId);
    if (!h) return;
    this.held.delete(threadId);
    h.resolve();
    this.deps.deliveries.kick(threadId);
  }

  /** 切れたターンを片づける（1本ずつ） */
  private resumeTurnsOf(threadIds: ReadonlySet<string>): Promise<TurnResults> {
    const run = this.turnChain.then(() => resumeInterruptedTurns(this.turnDeps(), (threadId) => threadIds.has(threadId)));
    this.turnChain = run.catch(() => undefined);
    return run;
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

  /** 打ち切った札を、問う直前に覚え直して返事待ちに戻す（届け直せる印はここで使い切る） */
  private async prepareAfterLost(r: Extract<PendingReply, { kind: "thread" }>): Promise<boolean> {
    const thread = this.deps.projectThread.getThread(r.threadId);
    if (!thread?.redeliverableReplies?.some((x) => x.replyTo === r.replyTo)) return false;
    this.deps.replyHandles.restore(
      r.replyTo,
      {
        threadId: r.threadId,
        projectId: r.projectId,
        connName: r.connName,
        moduleName: r.moduleName,
        hop: Math.max(0, r.hop - 1),
        ...(r.work ? { work: r.work } : {}),
      },
      { afterLost: true, ...(r.cause ? { lostBy: r.cause } : {}) },
    );
    await this.deps.projectThread.recordAwaitingReply({
      threadId: r.threadId,
      replyTo: r.replyTo,
      connName: r.connName,
      moduleName: r.moduleName,
      hop: r.hop,
      ...(r.work ? { work: r.work } : {}),
    });
    this.prepared.add(r.replyTo);
    this.deps.publishBackground(r.threadId);
    return true;
  }

  private async askOne(target: ResumeTarget, replies: readonly PendingReply[]): Promise<{ answers: Map<string, ResumeAnswer> } | AskFailure> {
    const askLimit = this.deps.askTimeoutMs ?? RESUME_ASK_TIMEOUT_MS;
    const remote = this.deps.remoteOf?.(target);
    const deadline = new AbortController();
    let phase: "connect" | "ask" = remote ? "connect" : "ask";
    let lastConnectError: string | undefined;
    const arm = (ms: number) =>
      setTimeout(() => deadline.abort(new Error(phase === "connect" ? this.connectGiveUp(target, remote!, ms, lastConnectError) : askGiveUp(target, ms, remote))), ms);
    let timer = arm(remote ? (this.deps.connectLimitMs ?? REMOTE_CONNECT_LIMIT_MS) : askLimit);
    try {
      let conn: Awaited<ReturnType<RestartRecoveryDeps["connect"]>>;
      if (remote) {
        // **繋がるまで待つ**：送り込み・起動の間は答えの期限を数えない。札は「起こし直しのあと続けています」の形で出し続ける
        this.waitingRemote.set(target.connName, remote);
        for (const r of replies) {
          if (r.kind !== "thread" || r.afterLost) continue;
          await this.deps.projectThread.markReplyKept(r.threadId, r.replyTo, r.cause ? { after: r.cause } : {}).catch(() => undefined);
          this.deps.publishBackground(r.threadId);
        }
        try {
          for (;;) {
            try {
              conn = await untilAborted(this.deps.connect(target, deadline.signal), deadline.signal);
              break;
            } catch (err) {
              if (deadline.signal.aborted) throw deadline.signal.reason;
              if (!(err instanceof ModuleNotUpYetError)) throw err;
              lastConnectError = err.message;
              await sleepUnlessAborted(this.deps.connectRetryMs ?? REMOTE_CONNECT_RETRY_MS, deadline.signal);
            }
          }
        } finally {
          this.waitingRemote.delete(target.connName);
        }
        // 繋がった——ここから答えの期限を数える
        clearTimeout(timer);
        phase = "ask";
        timer = arm(askLimit);
      } else {
        conn = await untilAborted(this.deps.connect(target, deadline.signal), deadline.signal);
      }
      // **問いを送る直前に**：期限が過ぎていれば送らない。札がもう済んでいる（Module が止まって「途中で終わりました」を
      // 届けた・答えの前に届け終えた）ものは問いに載せない。打ち切った札はここで覚え直す
      if (deadline.signal.aborted) throw deadline.signal.reason;
      const live: PendingReply[] = [];
      for (const r of replies) {
        if (r.kind === "thread" && r.afterLost) {
          if (await this.prepareAfterLost(r)) live.push(r);
        } else if (this.deps.replyHandles.get(r.replyTo) !== undefined) live.push(r);
      }
      if (live.length === 0) return { answers: new Map() };
      const raw = await untilAborted(conn.ask({ items: live.map(questionItemOf) }, deadline.signal), deadline.signal);
      return { answers: parseResumeAnswers(raw, live.map((r) => r.replyTo)) };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      // 別のサーバの Module：繋がらない・起きない・答えないまま打ち切った（宣言が無い等、待っても変わらないものは除く）
      const gaveUp = remote !== undefined && (deadline.signal.aborted || err instanceof ModuleNotUpYetError);
      return { error: remote !== undefined && !deadline.signal.aborted && phase === "ask" ? `${target.moduleName} に続けるかを聞けませんでした：${error}` : error, ...(gaveUp ? { gaveUp } : {}) };
    } finally {
      clearTimeout(timer);
    }
  }

  /** 繋がるのを待つ上限を越えた理由（実行場所に繋がらない／Module が起きない） */
  private connectGiveUp(target: ResumeTarget, runtime: string, ms: number, last: string | undefined): string {
    const span = spanOf(ms);
    const unreachable = this.deps.unreachableReason?.(runtime);
    return unreachable !== undefined
      ? `別のサーバ「${runtime}」に ${span}繋がりませんでした：${unreachable}`
      : `別のサーバ「${runtime}」で ${target.moduleName} が ${span}たっても起きませんでした${last ? `：${last}` : ""}`;
  }
}

/** 待った長さ（「30 分」「20 秒」） */
function spanOf(ms: number): string {
  return ms >= 120_000 ? `${Math.round(ms / 60_000)} 分` : `${Math.max(1, Math.round(ms / 1000))} 秒`;
}

/** 答えの期限を越えた理由。この機械の Module は前からの文のまま */
function askGiveUp(target: ResumeTarget, ms: number, remote: string | undefined): string {
  const seconds = Math.round(ms / 1000);
  return remote !== undefined
    ? `別のサーバ「${remote}」の ${target.moduleName} が、繋がってから ${seconds} 秒たっても続けるかに答えませんでした`
    : `${seconds} 秒待っても答えが来ませんでした`;
}

function logHumanRelease(threadId: string, results: TurnResults): void {
  if (results.length === 0) return;
  console.log(
    `[host] Thread ${threadId}：別のサーバの Module に繋がるのを待っている間に人が送ったので、切れたターンを先に片づけた（${results.map((r) => r.action).join("・")}）`,
  );
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
    ...(r.kind === "thread" && r.afterLost ? { afterLost: true } : {}),
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

/** 待つ。`signal` が立ったら投げる */
function sleepUnlessAborted(ms: number, signal: AbortSignal): Promise<void> {
  return untilAborted(new Promise<void>((resolve) => setTimeout(resolve, ms)), signal);
}

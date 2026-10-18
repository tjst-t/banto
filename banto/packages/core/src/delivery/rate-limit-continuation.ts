// **上限で止まったターンを、リセットのあと人を待たずに続ける**（決定・2026-10-18、ユーザー。v4-security.md §2「Claude の
// アカウントを複数持つ」の 9.）。
//
// 並びの全部が上限で断り、ターンが上限のエラー（Runner の `error: "rate_limit"`）で終わったら、終わりに `reason: "rate_limit"`
// と `continueAt` を書く（`turn-runner.ts` がここの `continueAt` で決める）。待ちは Event Store から導く（`rateLimitWaitOf`）
// ——起こし直したら fold が同じ待ちを作り直し、ここが時計を掛け直す（過ぎていればすぐ続ける）。
//
// 時刻が来たら、送り手 banto の届いたもの（`continues` に `reason: "rate_limit"`）を届ける。起こし直しで切れたターンの続き
// （`turn-continuation.ts`）と同じ口なので、待ち行列の先頭に並び、起こす回数の歯止め（`wakesPerHour`）に数えず、続きを積んだ
// ターンは同じ会話（Thread の resume-point）を resume する。眠っている Project はターンを開く口（`openTurn`）が起こす。
//
//   - 待っている間に届いたもの（send_message・自動化・裏の仕事の結果）は留め（`hold`）、続けたターンに一緒に積む。人の番では
//     ないので受信箱には出さない
//   - 人が送ればその発言でふつうにターンを開く——最後のターンが替わるので待ちは消える。留めていたものも一緒に積まれる
//   - 「待つのをやめる」・止めるボタンは `turn.continuation_cancelled`。閉じた Fork・Clear は fold が待ちを消す
//   - 続けて上限に当たった回数が `RATE_LIMIT_CONTINUE_LIMIT` に達したら、待たずに受信箱で聞く（起こし直しで切れ続けたときの
//     お知らせと同じ形——続きは待ち行列に積むが起こさず、人が「続ける」を押すか、その会話で送る）
//   - 待ちは「動いているもの」に数えない（`hostActivity` に入れない）——週の窓が尽きたときの数日の待ちの間も眠ってよい

import type { InboxStore } from "../inbox/store.js";
import { continuationOf, rateLimitContinuedOf, rateLimitWaitOf, type RateLimitWait } from "../project-thread/rate-limit-wait.js";
import type { ProjectThreadStore } from "../project-thread/store.js";
import type { ContinuationCancelledBy, PendingDelivery, ThreadState, TurnContinuation } from "../project-thread/types.js";
import type { ThreadDeliveries } from "./thread-deliveries.js";
import { RESUME_SENDER } from "./turn-continuation.js";

/**
 * **上限で続けて続ける回数の上限**（決定・2026-10-18、ユーザー）。上限で止まったターンの続きが、また上限で止まるたびに
 * 数える。6回続けても（7回目も）上限で止まったら、待たずに受信箱で聞く
 */
export const RATE_LIMIT_CONTINUE_LIMIT = 6;
/** 続ける時刻は、リセットの時刻のこれだけ後（リセットぴったりに送ると、まだ断られることがある） */
export const RATE_LIMIT_CONTINUE_MARGIN_MS = 60_000;

export const RATE_LIMIT_CONTINUE_TITLE = "Claude の使用量の上限が戻ったので、止まったところから続けます";
export const RATE_LIMIT_GAVE_UP_TITLE = "Claude の使用量の上限に続けて当たったので、自動で続けるのをやめました";
export const RATE_LIMIT_UNKNOWN_RESET_TITLE = "Claude の使用量の上限に当たりました（リセットの時刻が分からないので、自動では続けません）";
const CONTINUE_TEXT =
  "Claude の使用量の上限に当たって、直前のターンが途中で止まっていました。上限が戻ったので、止まったところから続けてください。";

/** setTimeout が待てる長さの上限（越えたら途中で起きて掛け直す） */
const MAX_TIMER_MS = 2 ** 31 - 1;
/** 時刻が来たとき Project を別の実行場所へ移している途中なら、これだけ待ってから見直す（移し終えるのを待つ） */
const MOVE_RETRY_MS = 30_000;

export interface RateLimitContinuationsDeps {
  projectThread: ProjectThreadStore;
  inbox: InboxStore;
  deliveries: ThreadDeliveries;
  /**
   * **中継が持つ、その Project の並びで一番早いリセットの時刻**（ミリ秒）。断っているアカウント（status が rejected）の
   * リセットの時刻のうち一番早いもの。持っていなければ（本体が中継を通らない banto 等）undefined——ターンの最後の
   * `rate_limit_event.resetsAt` を使う
   */
  earliestReset?(projectId: string): number | undefined;
  /**
   * **待ちが変わったかもしれない**（掛け直した・やめた）。画面に知らせる口（`rate_limit_wait.changed`、v4-frontend.md §6.46）。
   * 同じ待ちのままでも呼ぶ——知らせる側が今の待ちを読んで送る
   */
  onChange?(threadId: string): void;
  /** リセットのあと何ミリ秒で続けるか（無ければ `RATE_LIMIT_CONTINUE_MARGIN_MS`。E2E だけが縮める） */
  marginMs?: number;
  now?: () => number;
}

export type RateLimitActionResult = { ok: true } | { ok: false; status: 404 | 409; error: string };

export class RateLimitContinuations {
  /** Thread ごとの、続ける時刻の時計 */
  private readonly timers = new Map<string, NodeJS.Timeout>();
  /** いま続きを届けている Thread（時計と「今すぐ続ける」が重なっても1回） */
  private readonly delivering = new Set<string>();
  private readonly now: () => number;

  constructor(private readonly deps: RateLimitContinuationsDeps) {
    this.now = deps.now ?? Date.now;
  }

  /**
   * **上限で終わったターンを、いつ続けるか**（`turn-runner.ts` がターンの終わりを書く直前に呼ぶ——Thread の最後のターンは
   * まだそのターン）。中継の一番早いリセット、無ければ `resetsAt`（UNIX 秒）に余白を足した時刻。続けないなら undefined
   * ——続けた回数が上限に達した・時刻が分からないときは、続きを待ち行列に積んで（起こさない）受信箱で聞く
   */
  async continueAt(threadId: string, resetsAt: number | undefined): Promise<string | undefined> {
    const thread = this.deps.projectThread.getThread(threadId);
    const turn = thread?.lastTurn;
    if (!thread || !turn) throw new Error(`Thread ${threadId} の最後のターンがありません`);
    const continued = rateLimitContinuedOf(turn);
    if (continued >= RATE_LIMIT_CONTINUE_LIMIT) {
      await this.giveUp(thread, RATE_LIMIT_GAVE_UP_TITLE, `上限のあと続けて ${continued} 回続けましたが、また上限に当たりました`);
      return undefined;
    }
    const reset = this.deps.earliestReset?.(thread.projectId) ?? (resetsAt !== undefined ? resetsAt * 1000 : undefined);
    if (reset === undefined) {
      await this.giveUp(thread, RATE_LIMIT_UNKNOWN_RESET_TITLE, "上限がいつ戻るかが返事に無かったので、自動では続けません");
      return undefined;
    }
    return new Date(Math.max(reset, this.now()) + (this.deps.marginMs ?? RATE_LIMIT_CONTINUE_MARGIN_MS)).toISOString();
  }

  /**
   * **待っている Thread を留める理由**（`ThreadDeliveries` の `hold`、受信箱に出さない）。届いたものは続けたターンに一緒に積む。
   * 続きをもう届けていれば留めない（それを積むターンを起こす）
   */
  hold(threadId: string): string | undefined {
    const thread = this.deps.projectThread.getThread(threadId);
    const wait = rateLimitWaitOf(thread);
    if (!wait || queuedContinuation(thread, wait.turnId)) return undefined;
    const at = new Date(wait.continueAt).toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit", hour12: false });
    return `Claude の使用量の上限が戻るのを待っています（${at} に自動で続けます）`;
  }

  /** **起動したとき**：待っている Thread の時計を全部掛ける（時刻を過ぎていればすぐ続ける）。ターンを開く口ができてから呼ぶ */
  start(): void {
    for (const p of this.deps.projectThread.listProjects()) {
      for (const t of this.deps.projectThread.listThreadsForProject(p.id)) this.arm(t.id);
    }
  }

  /** その Thread の時計を掛け直す（待ちが無ければ外す）。ターンが始まった・終わったときに呼ぶ */
  arm(threadId: string): void {
    this.clear(threadId);
    const wait = rateLimitWaitOf(this.deps.projectThread.getThread(threadId));
    this.deps.onChange?.(threadId);
    if (!wait) return;
    this.schedule(threadId, Date.parse(wait.continueAt) - this.now());
  }

  /** 時計を全部外す（止めるとき・試験） */
  stop(): void {
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
  }

  /** **今すぐ続ける**（人が押した）。待っていなければ断る */
  async continueNow(threadId: string): Promise<RateLimitActionResult> {
    const thread = this.deps.projectThread.getThread(threadId);
    if (!thread) return { ok: false, status: 404, error: "この会話はありません" };
    const wait = rateLimitWaitOf(thread);
    if (!wait) return { ok: false, status: 409, error: "この会話は上限が戻るのを待っていません" };
    this.clear(threadId);
    await this.deliver(thread, wait);
    return { ok: true };
  }

  /**
   * **待つのをやめる**（人が「待つのをやめる」・止めるボタン）。待っていなければ断る。留めていた届いたものは待ち行列に
   * 残る——起こさない（人がやめたので、すぐ AI を動かさない。次に人が送ったターン・次に届いたもので起こすターンに積む）
   */
  async cancel(threadId: string, by: ContinuationCancelledBy): Promise<RateLimitActionResult> {
    const thread = this.deps.projectThread.getThread(threadId);
    if (!thread) return { ok: false, status: 404, error: "この会話はありません" };
    const wait = rateLimitWaitOf(thread);
    if (!wait) return { ok: false, status: 409, error: "この会話は上限が戻るのを待っていません" };
    this.clear(threadId);
    await this.deps.projectThread.cancelContinuation(threadId, wait.turnId, by);
    this.deps.onChange?.(threadId);
    return { ok: true };
  }

  private schedule(threadId: string, delayMs: number): void {
    const timer = setTimeout(() => {
      this.timers.delete(threadId);
      void this.fire(threadId).catch((err: unknown) =>
        console.warn(`[host] ${threadId} の上限のあとの続きを届けられませんでした（起こし直したらまた試します）:`, err),
      );
    }, Math.min(Math.max(0, delayMs), MAX_TIMER_MS));
    timer.unref();
    this.timers.set(threadId, timer);
  }

  private clear(threadId: string): void {
    const t = this.timers.get(threadId);
    if (t) clearTimeout(t);
    this.timers.delete(threadId);
  }

  /** 時刻が来た（または途中で起きた）——まだ待っていて時刻を過ぎていれば続きを届ける */
  private async fire(threadId: string): Promise<void> {
    const thread = this.deps.projectThread.getThread(threadId);
    const wait = rateLimitWaitOf(thread);
    if (!thread || !wait) return;
    const left = Date.parse(wait.continueAt) - this.now();
    if (left > 0) return this.schedule(threadId, left);
    // 移している間に届けると「自動では起こしませんでした」のお知らせが出る——移し終えるのを待つ（移す側は起こさない）
    if (this.deps.projectThread.getProject(thread.projectId)?.move) return this.schedule(threadId, MOVE_RETRY_MS);
    await this.deliver(thread, wait);
  }

  /** 続きを届けて起こす（もう届けてあれば起こすだけ）。眠っている Project はターンを開く口が起こす */
  private async deliver(thread: ThreadState, wait: RateLimitWait): Promise<void> {
    if (this.delivering.has(thread.id)) return;
    this.delivering.add(thread.id);
    try {
      if (queuedContinuation(thread, wait.turnId)) {
        this.deps.deliveries.kick(thread.id);
        return;
      }
      await this.deps.deliveries.deliver({
        threadId: thread.id,
        from: RESUME_SENDER,
        title: RATE_LIMIT_CONTINUE_TITLE,
        text: CONTINUE_TEXT,
        hop: wait.hop,
        continues: { turnId: wait.turnId, attempt: wait.continued + 1, fromSeq: wait.fromSeq, reason: "rate_limit" },
      });
    } finally {
      this.delivering.delete(thread.id);
    }
  }

  /**
   * **待たずに受信箱で聞く**。続きは待ち行列に積むが起こさない——人が「続ける」を押す（`continueStoppedTurn`）か、その会話で
   * 送ったターンが引き継ぐ。お知らせが開いている間は届いたものでも起こさない（`resumeHoldReason`）——起こし直しで切れ続けた
   * ときと同じ形
   */
  private async giveUp(thread: ThreadState, title: string, why: string): Promise<void> {
    const turn = thread.lastTurn!;
    if (!queuedContinuation(thread, turn.turnId)) {
      const { continued, fromSeq, hop } = continuationOf(thread);
      await this.deps.deliveries.deliver(
        {
          threadId: thread.id,
          from: RESUME_SENDER,
          title: RATE_LIMIT_CONTINUE_TITLE,
          text: CONTINUE_TEXT,
          hop,
          continues: { turnId: turn.turnId, attempt: continued + 1, fromSeq, reason: "rate_limit" },
        },
        { wake: false },
      );
    }
    const project = this.deps.projectThread.getProject(thread.projectId);
    const where = `${project?.name ?? "Project"} の ${thread.title ?? (thread.kind === "base" ? "Base Thread" : "Fork Thread")}`;
    await this.deps.inbox.raiseNotice({
      projectId: thread.projectId,
      dedupeKey: `turn-resume:${thread.id}:${turn.turnId}`,
      title,
      detail: `${where}——${why}。続けるなら「続ける」を押すか、この会話で次を送ってください`,
      resume: { threadId: thread.id, turnId: turn.turnId },
    });
  }
}

/** 待ち行列にある、そのターンの上限の続き */
function queuedContinuation(
  thread: Pick<ThreadState, "deliveries"> | undefined,
  turnId: string,
): (PendingDelivery & { continues: TurnContinuation }) | undefined {
  return thread?.deliveries?.find(
    (d): d is PendingDelivery & { continues: TurnContinuation } => d.continues?.reason === "rate_limit" && d.continues.turnId === turnId,
  );
}

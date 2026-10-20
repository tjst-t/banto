// **空いた会話の冷める前の要約**（idle compaction。決定・2026-10-20、ユーザー。`docs/specs/v4-architecture.md` §3.1「冷める前の要約
// （host）」）。
//
// 中継の温め直し（`claude-login/keep-alive.ts`）が最後の本物の要求から 50・100・150・200 分に会話のキャッシュを温め直す。4時間で人が
// 戻っていなければ、キャッシュが温かいうちに host がその会話を要約する——戻ったときは要約と土台の分だけを書けばよい。
//
// **不変条件：要約はキャッシュが当たっているときだけ**。225 分の時刻に、200 分の温め直しまで終えていて、直前の本物の要求か温め直しが
// 60 分以内に**当たった**ときだけ走らせる。温め直しが途中で止まった会話（失敗・外れた・余白を割った・押し出された・起こし直した）は
// 要約しない——人が戻ったら今どおり書き直す。
//
// 要約は `idle-compaction` のターン（`turn-runner.ts` の `idleCompaction`）。順番の鍵は人のターンと同じ（人が要約中に送れば終わるまで
// 待ち、届いたものは終わってから起こす）。受信箱に出さない・眠った Project を起こさない・画面の「走っている」に出さない（聞き手が
// `TurnChange.idleCompaction` を見る）。失敗はログだけ。起こし直しで切れたら続けない（`start` が記録を締める）。
//
// 画面には予定の時刻（`at`）と帯を出す時刻（`noticeAt`、5分前）を `/api/events` の `idle_compaction.changed` で知らせる。人が
// 帯の出ている会話で打った・送った・押したら `cancel`——要約をやめて温め直しを続ける（4時間を越えても 50 分ごと、上限の中で）。

import type { CacheKeepAlive } from "../claude-login/keep-alive.js";
import { KEEP_ALIVE_MINUTES } from "../claude-login/keep-alive.js";
import type { ProjectThreadStore } from "../project-thread/store.js";
import type { ThreadTurns } from "./thread-turns.js";

/** 要約する時刻（最後の本物の要求の開始から、分。200 分の温め直しのあと、寿命の1時間が切れる前） */
export const IDLE_COMPACTION_MINUTES = 225;
/** 画面に「まもなく要約します」の帯を出すのは、要約の何分前か */
export const IDLE_COMPACTION_NOTICE_MINUTES = 5;
/** 直前の本物の要求か温め直しが、これより前に当たったなら要約しない（キャッシュの寿命1時間） */
const HIT_WITHIN_MINUTES = 60;

/** 画面に出す、その会話の様子（`idle_compaction.changed` と会話の中身の `idleCompaction`） */
export interface IdleCompactionView {
  /** 要約する予定の時刻（ISO）。無ければ予定は無い */
  at?: string;
  /** 帯を出す時刻（ISO、予定の5分前） */
  noticeAt?: string;
  /** いま要約している */
  compacting: boolean;
  /** この会話で温め直した回数と読み出しの量（中継のメモリだけ。起こし直すと 0 に戻る。右上の文脈のメーター） */
  warms: number;
  warmTokens: number;
}

export type IdleCompactionCancel = { ok: true } | { ok: false; status: 404 | 409; error: string };

export interface IdleCompactionsDeps {
  keepAlive: Pick<CacheKeepAlive, "cacheOf" | "extend" | "stop" | "minute">;
  turns: Pick<ThreadTurns, "isRunning">;
  projectThread: Pick<ProjectThreadStore, "getThread" | "listProjects" | "listThreadsForProject" | "endTurn">;
  /**
   * **まだ要約してよいか**の印（温め直しの `WarmTicket.fingerprint` と同じもの——閉じた・眠った・読むだけ・スイッチがオフなら
   * undefined）。予定を立てたときと要約する時刻で同じかを見る（モデル・effort・Module の集合・resume-point を変えたら要約しない）
   */
  fingerprint(threadId: string): string | undefined;
  /** 画面に知らせる（予定・帯の時刻・要約している・温め直しの回数が変わった） */
  onChange?(threadId: string, view: IdleCompactionView): void;
  /** 帯を出すのは要約の何ミリ秒前か（無ければ 5 分。E2E だけが伸ばす——1分を縮めると帯の出ている間が短すぎる） */
  noticeMs?: number;
  now?: () => number;
  log?: (line: string) => void;
  /** 時計を回すか（試験は回さず `runDue` を呼ぶ） */
  timers?: boolean;
}

interface Plan {
  /** 温め直しの時刻の基準（最後の本物の要求の開始） */
  baseAt: number;
  at: number;
  fingerprint: string | undefined;
  timer?: NodeJS.Timeout;
}

export class IdleCompactions {
  private readonly plans = new Map<string, Plan>();
  /** 人が取りやめた基準（同じ基準ではもう予定を立てない。次のターンで基準が替われば消える） */
  private readonly cancelled = new Map<string, number>();
  private readonly compacting = new Set<string>();
  /** 最後に知らせた様子（変わったときだけ知らせる） */
  private readonly published = new Map<string, string>();
  /** 要約のターンを1本回す口（HTTP の層が持つ。鍵を取れなければ false） */
  private runner: ((threadId: string) => Promise<boolean>) | undefined;
  private readonly now: () => number;
  private readonly log: (line: string) => void;

  constructor(private readonly deps: IdleCompactionsDeps) {
    this.now = deps.now ?? Date.now;
    this.log = deps.log ?? ((line) => console.log(line));
  }

  setRunner(run: (threadId: string) => Promise<boolean>): void {
    this.runner = run;
  }

  /**
   * **起動したとき**：起こし直しで切れた要約のターンの記録を締める（続けない——起き直したときにはキャッシュは冷えている、§3.1
   * 「切れた・失敗したとき」）。何かを走らせる前に呼ぶ
   */
  async start(): Promise<void> {
    for (const p of this.deps.projectThread.listProjects()) {
      for (const t of this.deps.projectThread.listThreadsForProject(p.id)) {
        const cut = t.idleCompactionTurn;
        if (!cut) continue;
        await this.deps.projectThread.endTurn(t.id, cut.turnId, "failed");
        this.log(`[host] 起こし直しで切れた冷める前の要約の記録を締めました（続けません）thread=${t.id}`);
      }
    }
  }

  /** **その会話の温め直しの様子が変わった**（中継の温め直しが知らせる）。予定を立て直す */
  refresh(threadId: string): void {
    const state = this.deps.keepAlive.cacheOf(threadId);
    const base = state?.baseAt;
    if (base === undefined || this.cancelled.get(threadId) !== base) this.cancelled.delete(threadId);
    const wanted = state !== undefined && base !== undefined && !state.abandoned && !this.cancelled.has(threadId) && !this.compacting.has(threadId);
    const plan = this.plans.get(threadId);
    if (!wanted) {
      if (plan) this.clear(threadId);
    } else if (!plan || plan.baseAt !== base) {
      if (plan) this.clear(threadId);
      const next: Plan = { baseAt: base, at: base + IDLE_COMPACTION_MINUTES * this.deps.keepAlive.minute, fingerprint: this.deps.fingerprint(threadId) };
      this.plans.set(threadId, next);
      this.arm(threadId, next);
    }
    this.publish(threadId);
  }

  /** その会話の様子（画面） */
  view(threadId: string): IdleCompactionView {
    const plan = this.plans.get(threadId);
    const state = this.deps.keepAlive.cacheOf(threadId);
    const noticeMs = this.deps.noticeMs ?? IDLE_COMPACTION_NOTICE_MINUTES * this.deps.keepAlive.minute;
    return {
      ...(plan ? { at: new Date(plan.at).toISOString(), noticeAt: new Date(plan.at - noticeMs).toISOString() } : {}),
      compacting: this.compacting.has(threadId),
      warms: state?.totalWarms ?? 0,
      warmTokens: state?.totalWarmTokens ?? 0,
    };
  }

  /** 予定がある・要約している会話（`/api/events` の hello） */
  list(): Array<{ threadId: string } & IdleCompactionView> {
    const ids = new Set([...this.plans.keys(), ...this.compacting]);
    return [...ids].map((threadId) => ({ threadId, ...this.view(threadId) }));
  }

  /**
   * **人が取りやめた**（帯の出ている会話で打った・送った・押した）。要約をやめ、温め直しを続ける（4時間を越えても 50 分ごと）。
   * 予定が無ければ断る
   */
  cancel(threadId: string): IdleCompactionCancel {
    if (!this.deps.projectThread.getThread(threadId)) return { ok: false, status: 404, error: "この会話はありません" };
    if (this.compacting.has(threadId)) return { ok: false, status: 409, error: "もう要約しています" };
    const plan = this.plans.get(threadId);
    if (!plan) return { ok: false, status: 409, error: "この会話は要約を待っていません" };
    this.cancelled.set(threadId, plan.baseAt);
    this.clear(threadId);
    this.log(`[host] 人が冷める前の要約を取りやめました（温め直しを続けます）thread=${threadId}`);
    // 温め直しの様子が変わったら refresh が呼ばれる——取りやめた基準なので予定は立て直さない
    this.deps.keepAlive.extend(threadId);
    this.publish(threadId);
    return { ok: true };
  }

  /** 止めるとき・試験 */
  close(): void {
    for (const plan of this.plans.values()) if (plan.timer) clearTimeout(plan.timer);
  }

  /** **時刻の来たものを要約する**（時計から。試験は直に呼ぶ） */
  async runDue(): Promise<void> {
    const now = this.now();
    for (const [threadId, plan] of [...this.plans]) {
      if (plan.at <= now) await this.fire(threadId, plan);
    }
  }

  /** **要約しない理由**（無ければ要約してよい）。§3.1 の「当たっているときだけ」と、会話がまだ同じであること */
  private whyNot(threadId: string, plan: Plan): string | undefined {
    const state = this.deps.keepAlive.cacheOf(threadId);
    if (!state) return "温め直しの様子がありません";
    if (state.abandoned) return `温め直しが途中で止まりました（${state.abandoned}）`;
    if (state.baseAt !== plan.baseAt) return "温め直しが止まったか、次のターンが始まりました";
    if (state.warms < KEEP_ALIVE_MINUTES.length) return `4時間の温め直しが終わっていません（${state.warms} 回）`;
    if (!state.lastHit || state.lastHitAt === undefined || this.now() - state.lastHitAt > HIT_WITHIN_MINUTES * this.deps.keepAlive.minute) {
      return "直前の温め直しが 60 分以内に当たっていません";
    }
    if (this.deps.turns.isRunning(threadId)) return "ターンが走っています";
    const thread = this.deps.projectThread.getThread(threadId);
    if (!thread) return "会話がありません";
    if (thread.resumePoint !== state.sessionId) return "会話のセッションが替わりました";
    if (thread.idleCompactionTurn) return "もう要約しています";
    const fingerprint = this.deps.fingerprint(threadId);
    if (fingerprint === undefined || fingerprint !== plan.fingerprint) {
      return "会話を閉じた・Project を眠らせた・スイッチを切った・モデルなどを変えました";
    }
    return undefined;
  }

  private async fire(threadId: string, plan: Plan): Promise<void> {
    if (this.plans.get(threadId) !== plan) return;
    this.clear(threadId);
    const why = this.whyNot(threadId, plan);
    if (why !== undefined || !this.runner) {
      this.log(`[host] 冷める前の要約をしません thread=${threadId}: ${why ?? "要約を回す口がまだありません"}`);
      // 4時間の温め直しのあと持っていた本文を捨てる（要約もしないので、もう温めない）
      this.deps.keepAlive.stop(threadId);
      this.publish(threadId);
      return;
    }
    this.compacting.add(threadId);
    this.publish(threadId);
    this.log(`[host] 冷める前の要約を始めます thread=${threadId}`);
    try {
      const ran = await this.runner(threadId);
      if (!ran) {
        this.log(`[host] 冷める前の要約をしません thread=${threadId}: ほかのターンが先に鍵を取りました`);
        this.deps.keepAlive.stop(threadId);
      }
    } catch (err) {
      // 失敗はログだけ（受信箱に出さない、§3.1）——次に人が戻ったら今どおり書き直す
      this.log(`[host] 冷める前の要約に失敗しました thread=${threadId}: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.compacting.delete(threadId);
      this.publish(threadId);
    }
  }

  private arm(threadId: string, plan: Plan): void {
    if (this.deps.timers === false) return;
    plan.timer = setTimeout(
      () => {
        plan.timer = undefined;
        void this.fire(threadId, plan).catch((err: unknown) => console.warn(`[host] ${threadId} の冷める前の要約の時計が例外を投げました:`, err));
      },
      Math.min(Math.max(0, plan.at - this.now()), 2 ** 31 - 1),
    );
    plan.timer.unref();
  }

  private clear(threadId: string): void {
    const plan = this.plans.get(threadId);
    if (plan?.timer) clearTimeout(plan.timer);
    this.plans.delete(threadId);
  }

  private publish(threadId: string): void {
    const view = this.view(threadId);
    const key = JSON.stringify(view);
    if (this.published.get(threadId) === key) return;
    this.published.set(threadId, key);
    try {
      this.deps.onChange?.(threadId, view);
    } catch (err) {
      console.warn("[host] 冷める前の要約の様子の聞き手が例外を投げました:", err);
    }
  }
}

// docs/specs/v4-architecture.md §4.3「Webhook」の「まとめる」・「段2」——**受けたものをまとめて届ける役**（Webhook と出来事で共通）。
//
// 受けたものは先に `automation.received` に残っている（受け口が書く）。ここは、待つ時間（`source.batchSeconds`）が過ぎたら
// 溜まった分を1回の `run` にまとめる。前の回が終わっていなければ溜めたまま、空いたら（ターンが終わったら）届ける。起き直したら
// 残っている `automation.received` からまとめ直す（`start`）

import type { AutomationStore } from "./store.js";
import type { AutomationRunner } from "./runner.js";
import type { Automation } from "./fold.js";

/** 前の回が終わっていなくて届けられなかったとき、次に見直すまで（ターンの終わりでも見直す） */
const RETRY_MS = 30_000;

/** まとめて届けるきっかけの種類 */
export type BatchedSourceKind = "webhook" | "event";

export interface AutomationBatcherDeps {
  automations: AutomationStore;
  runner: Pick<AutomationRunner, "run">;
  /** ターンが終わった（届け先が空いたかもしれない）を聞く */
  onTurnEnded(listener: (threadId: string) => void): void;
  now?: () => Date;
  log?: (message: string) => void;
}

export class AutomationBatcher {
  private readonly timers = new Map<string, { at: number; timer: NodeJS.Timeout }>();
  private readonly flushing = new Set<string>();
  private started = false;

  constructor(
    private readonly kind: BatchedSourceKind,
    private readonly deps: AutomationBatcherDeps,
  ) {}

  /**
   * **起き直したらまとめ直す**——残っている `automation.received` を、待つ時間から数えて届ける。届けものの再開
   * （`resumeAll`）と待ち受けの開始のあとに呼ぶ
   */
  start(): void {
    if (this.started) return;
    this.started = true;
    for (const a of this.deps.automations.listAll()) this.consider(a.id);
    // 再開した・待つ時間を変えた・消した等。溜まったものがあれば数え直す
    this.deps.automations.onChange(({ id }) => this.consider(id));
    // 届け先が空いたかもしれない——溜まったものを届けに行く（待つ時間が過ぎていれば）
    this.deps.onTurnEnded((threadId) => {
      for (const a of this.deps.automations.listAll()) {
        if (this.mine(a) && a.received.length > 0 && a.target.threadId === threadId) this.consider(a.id);
      }
    });
  }

  stop(): void {
    this.started = false;
    for (const { timer } of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }

  /** 溜まったものがあれば、待つ時間が過ぎたときに届けに行く（もう過ぎていればすぐ） */
  consider(id: string): void {
    if (!this.started) return;
    const a = this.deps.automations.get(id);
    if (!a || !this.mine(a) || a.received.length === 0 || a.paused) {
      this.cancel(id);
      return;
    }
    this.schedule(id, Math.max(0, this.dueAt(a) - this.now().getTime()));
  }

  private mine(a: Automation): boolean {
    return a.source.kind === this.kind;
  }

  private dueAt(a: Automation): number {
    const batchSeconds = a.source.kind === "webhook" || a.source.kind === "event" ? a.source.batchSeconds : 0;
    return Date.parse(a.received[0]!.at) + batchSeconds * 1000;
  }

  private schedule(id: string, delayMs: number): void {
    const at = this.now().getTime() + delayMs;
    const current = this.timers.get(id);
    if (current && current.at <= at) return;
    if (current) clearTimeout(current.timer);
    const timer = setTimeout(() => {
      this.timers.delete(id);
      void this.flush(id).catch((err: unknown) =>
        this.log(`[host] 自動化 ${id} の${this.kind === "webhook" ? " Webhook" : "出来事"}を届けられませんでした: ${err instanceof Error ? err.stack ?? err.message : String(err)}`),
      );
    }, delayMs);
    timer.unref();
    this.timers.set(id, { at, timer });
  }

  private cancel(id: string): void {
    const current = this.timers.get(id);
    if (!current) return;
    clearTimeout(current.timer);
    this.timers.delete(id);
  }

  /** 溜まった分を1回にまとめて届ける。前の回が終わっていなければ溜めたまま、あとで見直す */
  private async flush(id: string): Promise<void> {
    if (this.flushing.has(id)) return;
    this.flushing.add(id);
    try {
      const a = this.deps.automations.get(id);
      if (!a || !this.mine(a) || a.received.length === 0 || a.paused) return;
      const due = this.dueAt(a);
      if (due > this.now().getTime()) {
        this.schedule(id, due - this.now().getTime());
        return;
      }
      const started = await this.deps.runner.run(a, this.kind, {}, a.received);
      if (started.deferred) this.schedule(id, RETRY_MS);
    } finally {
      this.flushing.delete(id);
    }
    // 届けている間に受けたものは、次の回にまとめる
    this.consider(id);
  }

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  private log(message: string): void {
    (this.deps.log ?? console.warn)(message);
  }
}

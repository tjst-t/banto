// docs/specs/v4-architecture.md §4.3「時計」——**時刻のきっかけで自動化を動かす**。
//
// - **1分ごとの刻み1本**で、各自動化の次の時刻が来たかを見る。自動化ごとに長い `setTimeout` を積まない（Node のタイマーは
//   約24.8日で溢れる）。止まっていた間・機械が眠っていた間も同じ経路で扱う
// - 次の時刻は覚えておかず、台帳の `clockFrom`（作った・変えた・再開した時刻と、時計で動いた回の予定の時刻の一番後）から
//   毎回計算する（規則3）。この走行の中で済ませた時刻（閉じた Project の分・ずらし中）だけ手元に持つ
// - 起きたら（最初の刻み）、「最後に動かした時刻〜今」に入る時刻のうち**一番最近の1回だけ**動かし、残りは `skipped`
//   （理由「banto が止まっていた間」）。最初の刻みは届いたものの再開（`resumeAll`）と待ち受けの開始のあとに呼ぶ
// - 前の回が終わっていなければ飛ばす——判断は届ける層（`runner.ts`）が持つ
// - **同時本数**：自動化で起こすターンが上限だけ走っていたら、超えた分は数分ずらし、ずらした理由を回に残す
// - 一時停止中は数えない（再開した時刻から数え直す）。Project が閉じている間は動かさず、記録もしない

import { randomUUID } from "node:crypto";
import type { ProjectThreadStore } from "../project-thread/store.js";
import type { Automation } from "./fold.js";
import type { AutomationStore } from "./store.js";
import type { AutomationRunner } from "./runner.js";
import { dueFireTimes } from "./schedule.js";

/** 自動化で起こすターンの同時本数の上限（仮置き・2026-10-15。資源の順番待ち——Backlog #277——ができたらそこに並べる） */
export const AUTOMATION_MAX_CONCURRENT = 3;
/** 上限を超えた回をずらす長さ */
export const AUTOMATION_DEFER_MS = 2 * 60_000;

const MINUTE = 60_000;

export interface AutomationClockDeps {
  automations: Pick<AutomationStore, "listAll" | "recordRun">;
  projectThread: Pick<ProjectThreadStore, "getProject">;
  runner: Pick<AutomationRunner, "run" | "activeRuns">;
  now?: () => Date;
  maxConcurrent?: number;
  deferMs?: number;
  /** 刻みの間隔。渡さなければ毎分 0 秒の少しあと（試験だけ縮める） */
  intervalMs?: number;
  log?: (message: string) => void;
}

interface Deferred {
  slot: Date;
  until: number;
  reason: string;
}

export class AutomationClock {
  /** この走行で済ませた一番後の時刻（ms）。台帳の `clockFrom` と大きいほうから数える */
  private readonly handled = new Map<string, number>();
  private readonly deferred = new Map<string, Deferred>();
  private caughtUp = false;
  private ticking: Promise<void> | undefined;
  private timer: NodeJS.Timeout | undefined;
  private stopped = false;

  constructor(private readonly deps: AutomationClockDeps) {}

  /** 最初の刻み（止まっていた間の取り戻し）をすぐ行い、あとは刻みを続ける */
  start(): void {
    this.stopped = false;
    void this.tick();
    this.schedule();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  /** 1回分の刻み。重ならない（前の刻みが届け終わる前に次が来たら、それを待つだけ） */
  tick(): Promise<void> {
    if (this.ticking) return this.ticking;
    this.ticking = this.step()
      .catch((err: unknown) => this.log(`[host] 自動化の時計の刻みで例外: ${err instanceof Error ? err.stack ?? err.message : String(err)}`))
      .finally(() => {
        this.ticking = undefined;
      });
    return this.ticking;
  }

  private schedule(): void {
    if (this.stopped) return;
    const now = this.now().getTime();
    // 毎分 0 秒の少しあとに揃える（時刻ちょうどの回が、刻みの位相の分だけ遅れないように）
    const delay = this.deps.intervalMs ?? MINUTE - (now % MINUTE) + 500;
    this.timer = setTimeout(() => {
      void this.tick().finally(() => this.schedule());
    }, delay);
    this.timer.unref();
  }

  private async step(): Promise<void> {
    const now = this.now();
    const catchUp = !this.caughtUp;
    this.caughtUp = true;
    const due: Array<{ automation: Automation; slot: Date; delayed?: string }> = [];

    for (const a of this.deps.automations.listAll()) {
      if (a.source.kind !== "time") continue;
      if (a.paused) {
        this.deferred.delete(a.id);
        continue;
      }
      const project = this.deps.projectThread.getProject(a.projectId);
      if (!project) continue;
      const from = Math.max(Date.parse(a.clockFrom), this.handled.get(a.id) ?? -Infinity);
      const found = dueFireTimes(a.source.repeat, a.source.timeZone, new Date(from), now);
      const pending = this.deferred.get(a.id);

      if (project.status === "closed") {
        // 閉じている間は動かさず、記録もしない（開き直したら次の時刻から）
        if (found) this.handled.set(a.id, found.latest.getTime());
        this.deferred.delete(a.id);
        continue;
      }
      if (found) {
        this.handled.set(a.id, found.latest.getTime());
        if (pending) {
          this.deferred.delete(a.id);
          await this.skip(a, pending.slot, now, `${pending.reason}——ずらしている間に次の時刻が来たので飛ばしました`);
        }
        if (found.count > 1) {
          const missed = found.count - 1;
          const when = catchUp ? "banto が止まっていた間" : "時計が進んでいなかった間（機械が眠っていた等）";
          await this.skip(
            a,
            found.earliest,
            now,
            `${when}の時刻です（${found.capped ? `${missed} 回以上` : `${missed} 回`}、${formatIn(found.earliest, a.source.timeZone)} から）。一番最近の1回だけ動かしました`,
          );
        }
        due.push({ automation: a, slot: found.latest });
      } else if (pending && pending.until <= now.getTime()) {
        due.push({ automation: a, slot: pending.slot, delayed: pending.reason });
      }
    }

    due.sort((x, y) => x.slot.getTime() - y.slot.getTime());
    const max = this.deps.maxConcurrent ?? AUTOMATION_MAX_CONCURRENT;
    let free = max - this.deps.runner.activeRuns();
    for (const { automation: a, slot, delayed } of due) {
      if (free <= 0) {
        const reason =
          delayed ??
          `同時に動いている自動化が上限（${max} 本）に達していたので、${formatIn(slot, a.source.timeZone)} の回をずらしました`;
        this.deferred.set(a.id, { slot, until: now.getTime() + (this.deps.deferMs ?? AUTOMATION_DEFER_MS), reason });
        if (!delayed) this.log(`[host] 自動化「${a.name}」：${reason}`);
        continue;
      }
      this.deferred.delete(a.id);
      try {
        const started = await this.deps.runner.run(a, "clock", { scheduledFor: slot.toISOString(), ...(delayed ? { delayed } : {}) });
        // 留めている回（理由つき）は、走るまで数えない（`activeRuns`）
        if (started.result === "running" && !started.reason) free--;
      } catch (err) {
        this.log(`[host] 自動化「${a.name}」を時計で動かせませんでした: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  private async skip(a: Automation, slot: Date, now: Date, reason: string): Promise<void> {
    await this.deps.automations.recordRun(a.id, {
      runId: randomUUID(),
      at: now.toISOString(),
      cause: "clock",
      result: "skipped",
      reason,
      scheduledFor: slot.toISOString(),
    });
  }

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  private log(message: string): void {
    (this.deps.log ?? console.warn)(message);
  }
}

function formatIn(at: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("ja-JP", { timeZone, dateStyle: "short", timeStyle: "short" }).format(at);
}

// docs/specs/v4-architecture.md §4.3「判断は届ける口の手前に置く」「専用の Fork」——**自動化を1回動かす**。
//
// `deliver`（`delivery/thread-deliveries.ts`）は「起こすか、溜めて後で起こすか」の口で、「飛ばす・Clear してから届ける」は
// 判断しない。その判断はここで `deliver` の手前に行い、`deliver` は変えない。
//
// - 届け先が閉じている・Project が閉じている・移している・前の回が終わっていない（`busy.ts`）なら届けず `skipped` を書く
// - 毎回まっさら：`ThreadTurns` の鍵を一瞬押さえ、取れたら Clear してから鍵を返し、`deliver` する。Clear を turn-runner に
//   持ち込まない——人がその Fork に送った発言のターンまで畳むため
// - 届けたものには `MessageOrigin.automation` が付く。ターンの終わりを聞き、その回の結末を `automation.fired` に書く
// - 専用の Fork：作るときに立て、`AUTOMATION_FORK_RUNS` 回ごとに乗り換える。人が閉じたら一時停止して1件知らせる
//   （開き直しても自動では再開しない）

import { randomUUID } from "node:crypto";
import type { ProjectThreadStore } from "../project-thread/store.js";
import type { ThreadState } from "../project-thread/types.js";
import type { ThreadTurns } from "../delivery/thread-turns.js";
import type { ThreadDeliveries } from "../delivery/thread-deliveries.js";
import type { JudgmentItem } from "../inbox/types.js";
import { AUTOMATION_FORK_RUNS, type Automation, type AutomationRunCause, type AutomationRunResult } from "./fold.js";
import type { AutomationStore } from "./store.js";
import { previousRunUnfinished } from "./busy.js";

export interface AutomationRunnerDeps {
  projectThread: ProjectThreadStore;
  automations: AutomationStore;
  turns: ThreadTurns;
  deliveries: ThreadDeliveries;
  listJudgmentsForThread(threadId: string): JudgmentItem[];
  /** 人への知らせ（受信箱の「お知らせ」） */
  notify(input: { projectId: string; dedupeKey: string; title: string; detail: string }): Promise<void>;
  now?: () => Date;
}

/** 時計で動かす回の添え書き（`automation.fired` に残す） */
export interface AutomationRunExtras {
  /** 予定の時刻 */
  scheduledFor?: string;
  /** ずらした理由 */
  delayed?: string;
}

export interface AutomationRunStarted {
  runId: string;
  /**
   * `running`＝届けた（ターンの結末はあとで同じ `runId` に書く。`reason` があれば、届けたが AI を起こさずに留めている）。
   * `skipped`＝届けなかった
   */
  result: Extract<AutomationRunResult, "running" | "skipped">;
  reason?: string;
  threadId?: string;
}

/** 自動化の届けものの送り手（`MessageOrigin.from`）。core が使う名前（アーキ仕様 §5.2） */
const FROM = "banto";

/** 届けたが AI を起こさずに留めている回の、`running` に添える理由の頭 */
const HELD_PREFIX = "届けましたが、AI をまだ起こしていません——";

export class AutomationRunner {
  /** 届けている途中の自動化（Clear してから届けるまでの間に、同じ自動化のもう1回が割り込まないように） */
  private readonly starting = new Set<string>();

  constructor(private readonly deps: AutomationRunnerDeps) {
    // その回のターンが終わったら結末を書く（鍵を返すのは `turn.ended` を書いたあと——`lastTurn.outcome` が読める）
    deps.turns.onChange((change) => {
      if (change.type !== "ended") return;
      void this.settleRuns(change.threadId).catch((err: unknown) =>
        console.warn(`[host] ${change.threadId} の自動化の回の結末を記録できませんでした:`, err),
      );
    });
  }

  /**
   * **専用の Fork を用意する**（作ったとき・届け先を専用の Fork に変えたとき・再開したとき）。無い・閉じているなら立てる
   * ——閉じた Fork は開き直さない（閉じた一覧に記録は残る）。届け先が既存の Thread なら何もしない
   */
  async prepare(automation: Automation): Promise<Automation> {
    const target = automation.target;
    if (target.kind !== "dedicated") return automation;
    const current = target.threadId ? this.deps.projectThread.getThread(target.threadId) : undefined;
    if (current && current.status !== "closed") return automation;
    const thread = await this.newFork(automation);
    return this.deps.automations.setDedicatedThread(automation.id, thread.id);
  }

  /** 1回動かす。届けなかったときも `skipped` と理由を台帳に残して返す */
  async run(automation: Automation, cause: AutomationRunCause, extras: AutomationRunExtras = {}): Promise<AutomationRunStarted> {
    if (this.starting.has(automation.id)) {
      const runId = randomUUID();
      const reason = "前の回を届けているところです";
      const at = (this.deps.now?.() ?? new Date()).toISOString();
      await this.deps.automations.recordRun(automation.id, { runId, at, cause, result: "skipped", reason, ...extras });
      return { runId, result: "skipped", reason };
    }
    this.starting.add(automation.id);
    try {
      return await this.start(automation, cause, extras);
    } finally {
      this.starting.delete(automation.id);
    }
  }

  /** 自動化で起こしたターンのうち、いま走っている（届けて、まだ結末が出ていない）回の数。同時本数の上限に使う */
  activeRuns(): number {
    let n = 0;
    for (const p of this.deps.projectThread.listProjects()) {
      for (const a of this.deps.automations.list(p.id)) {
        for (const run of a.runs) {
          if (run.result !== "running" || !run.threadId) continue;
          // 結末を書けずに残った running（落ちた等）は数えない——走っているか、届けものが積まれる前のものだけ。
          // 留めている回（理由つき）は、留めが解けてターンが走るまで数えない
          const thread = this.deps.projectThread.getThread(run.threadId);
          const queued = !run.reason && thread?.deliveries?.some((d) => d.automation?.runId === run.runId);
          if (this.deps.turns.isRunning(run.threadId) || queued) n++;
        }
      }
    }
    return n;
  }

  private async start(automation: Automation, cause: AutomationRunCause, extras: AutomationRunExtras): Promise<AutomationRunStarted> {
    const runId = randomUUID();
    const at = (this.deps.now?.() ?? new Date()).toISOString();
    const skip = async (reason: string, threadId?: string): Promise<AutomationRunStarted> => {
      await this.deps.automations.recordRun(automation.id, {
        runId,
        at,
        cause,
        result: "skipped",
        reason,
        ...(threadId ? { threadId } : {}),
        ...extras,
      });
      return { runId, result: "skipped", reason, ...(threadId ? { threadId } : {}) };
    };

    const project = this.deps.projectThread.getProject(automation.projectId);
    if (!project) return skip("この Project がありません");
    if (project.status === "closed") return skip("この Project は閉じられています");
    if (project.move) return skip("この Project はいま別の実行場所へ移しています");

    // 作ったときに立てていなかった（立てる口を繋ぐ前に作ったもの）なら、ここで立てる
    let current = automation;
    if (current.target.kind === "dedicated" && !current.target.threadId) current = await this.prepare(current);
    const targetId = current.target.threadId;
    const thread = targetId ? this.deps.projectThread.getThread(targetId) : undefined;
    if (!targetId || !thread || thread.projectId !== current.projectId) return skip("届け先の Thread がありません");
    if (thread.status === "closed") {
      return skip(current.target.kind === "dedicated" ? "専用の Fork が閉じられています" : "届け先の Thread は閉じられています", thread.id);
    }
    const busy = previousRunUnfinished(thread, {
      isRunning: (id) => this.deps.turns.isRunning(id),
      listJudgmentsForThread: (id) => this.deps.listJudgmentsForThread(id),
    });
    if (busy) return skip(busy, thread.id);

    let threadId = thread.id;
    let rotatedFrom: string | undefined;
    if (current.target.kind === "dedicated" && (current.threadRuns ?? 0) >= AUTOMATION_FORK_RUNS) {
      // **乗り換え**：新しい Fork に届け、古い Fork は閉じる（閉じた一覧に残るので記録は失わない）。新しい Fork は
      // まっさらなので Clear は要らない。前の回を引き継ぐなら、古い Fork の会話を引き継いで立てる
      const next = await this.newFork(current, current.target.mode === "continue" ? thread : undefined);
      await this.deps.automations.setDedicatedThread(current.id, next.id);
      await this.deps.projectThread.closeThread(thread.id);
      rotatedFrom = thread.id;
      threadId = next.id;
    } else if (current.target.kind === "dedicated" && current.target.mode === "fresh") {
      // **毎回まっさら**：鍵を一瞬押さえて Clear する。鍵は届ける前に返す（届けたものはふつうに起こされる）
      const release = this.deps.turns.tryHold(threadId);
      if (!release) return skip("前の回のターンがまだ走っています", threadId);
      try {
        await this.deps.projectThread.clearThread(threadId);
      } finally {
        release();
      }
    }

    // 届ける前に「走っている」を書く——ターンの終わりを聞く側が、この回を見つけられるように
    await this.deps.automations.recordRun(current.id, {
      runId,
      at,
      cause,
      result: "running",
      threadId,
      ...(rotatedFrom ? { rotatedFrom } : {}),
      ...extras,
    });
    try {
      const delivered = await this.deps.deliveries.deliver({
        threadId,
        from: FROM,
        title: `自動化「${current.name}」`,
        text: current.instruction,
        hop: 0,
        kind: "automation",
        automation: { id: current.id, runId },
      });
      if (delivered.wake === "held") {
        // 届けたものは溜まったまま残る（留めが解けたら起こされる・人が次に送ったターンの頭に積まれる）——その回は
        // 理由を添えて `running` のままにし、ターンの終わりで結末を書く。留めが解けないまま閉じられたら `threadClosed` が飛ばす
        const reason = `${HELD_PREFIX}${delivered.reason}`;
        await this.record(current.id, runId, at, cause, threadId, "running", reason, { rotatedFrom, ...extras });
        return { runId, result: "running", reason, threadId };
      }
    } catch (err) {
      const reason = `届けられませんでした：${err instanceof Error ? err.message : String(err)}`;
      await this.record(current.id, runId, at, cause, threadId, "failed", reason, { rotatedFrom, ...extras });
      throw err;
    }
    return { runId, result: "running", threadId };
  }

  /**
   * **Thread が閉じられた**（人・AI が閉じた。乗り換えで閉じるのはここを通らない）。それが自動化の専用の Fork なら、
   * その自動化を一時停止にして受信箱に1件知らせる。開き直しても自動では再開しない（再開は人が押す）
   */
  async threadClosed(threadId: string): Promise<void> {
    const thread = this.deps.projectThread.getThread(threadId);
    if (!thread) return;
    await this.settleHeldRuns(thread);
    for (const a of this.deps.automations.list(thread.projectId)) {
      if (a.target.kind !== "dedicated" || a.target.threadId !== threadId || a.paused) continue;
      await this.deps.automations.pause(a.id, "専用の Fork が閉じられました");
      await this.deps
        .notify({
          projectId: a.projectId,
          dedupeKey: `automation-fork-closed:${a.id}:${threadId}`,
          title: `自動化「${a.name}」を一時停止しました`,
          detail:
            "この自動化が使っていた専用の Fork が閉じられたので、一時停止しました。Fork を開き直しても自動では再開しません——動かし続けるなら、自動化の画面で再開してください（閉じた Fork のままなら新しい Fork を立てます）",
        })
        .catch((err: unknown) => console.warn("[host] 自動化を一時停止したことを受信箱に出せませんでした:", err));
    }
  }

  /** その Thread で走っていた回のうち、届けたものをターンが積み終えたものに結末を書く */
  private async settleRuns(threadId: string): Promise<void> {
    const thread = this.deps.projectThread.getThread(threadId);
    if (!thread) return;
    const pending = new Set((thread.deliveries ?? []).flatMap((d) => (d.automation ? [d.automation.runId] : [])));
    for (const a of this.deps.automations.list(thread.projectId)) {
      for (const run of a.runs) {
        if (run.result !== "running" || run.threadId !== threadId || pending.has(run.runId)) continue;
        const { result, reason } = this.outcomeOf(thread);
        await this.record(a.id, run.runId, run.at, run.cause, threadId, result, reason, {
          rotatedFrom: run.rotatedFrom,
          scheduledFor: run.scheduledFor,
          delayed: run.delayed,
        });
      }
    }
  }

  /**
   * **留めが解けないまま届け先が閉じられた**：届けものがまだ会話に積まれていない回を、留めた理由を添えて `skipped` に
   * する（AI は動いていない）
   */
  private async settleHeldRuns(thread: ThreadState): Promise<void> {
    const pending = new Set((thread.deliveries ?? []).flatMap((d) => (d.automation ? [d.automation.runId] : [])));
    for (const a of this.deps.automations.list(thread.projectId)) {
      for (const run of a.runs) {
        if (run.result !== "running" || run.threadId !== thread.id || !pending.has(run.runId)) continue;
        const held = run.reason?.startsWith(HELD_PREFIX) ? run.reason.slice(HELD_PREFIX.length) : run.reason;
        const reason = `AI を起こさないうちに届け先が閉じられました${held ? `（留めていた理由：${held}）` : ""}`;
        await this.record(a.id, run.runId, run.at, run.cause, thread.id, "skipped", reason, {
          rotatedFrom: run.rotatedFrom,
          scheduledFor: run.scheduledFor,
          delayed: run.delayed,
        });
      }
    }
  }

  private outcomeOf(thread: ThreadState): { result: AutomationRunResult; reason?: string } {
    switch (thread.lastTurn?.outcome) {
      case "completed":
        return this.deps.listJudgmentsForThread(thread.id).some((j) => j.liveness === "live")
          ? { result: "waiting", reason: "人の判断を待っています" }
          : { result: "done" };
      case "stopped":
        return { result: "failed", reason: "人が止めました" };
      case "failed":
        return { result: "failed", reason: "ターンが失敗しました" };
      default:
        return { result: "failed", reason: "ターンが最後まで行きませんでした" };
    }
  }

  private async record(
    id: string,
    runId: string,
    at: string,
    cause: AutomationRunCause,
    threadId: string,
    result: AutomationRunResult,
    reason: string | undefined,
    extras: AutomationRunExtras & { rotatedFrom?: string | undefined },
  ): Promise<void> {
    await this.deps.automations.recordRun(id, {
      runId,
      at,
      cause,
      result,
      threadId,
      ...(reason ? { reason } : {}),
      ...(extras.rotatedFrom ? { rotatedFrom: extras.rotatedFrom } : {}),
      ...(extras.scheduledFor ? { scheduledFor: extras.scheduledFor } : {}),
      ...(extras.delayed ? { delayed: extras.delayed } : {}),
    });
  }

  /** 専用の Fork を立てる。名前は自動化の名前。`from` を渡さなければ Base Thread から会話を引き継がずに */
  private async newFork(automation: Automation, from?: ThreadState): Promise<ThreadState> {
    if (from) return this.deps.projectThread.forkThread(from.id, { title: automation.name });
    const base = this.deps.projectThread.listThreadsForProject(automation.projectId).find((t) => t.kind === "base");
    if (!base) throw new Error(`Project ${automation.projectId} に Base Thread が無いので、専用の Fork を立てられません`);
    return this.deps.projectThread.forkThread(base.id, { title: automation.name, fresh: true });
  }
}

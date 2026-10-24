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
import type { ExternalContent } from "../project-thread/types.js";
import {
  AUTOMATION_FORK_RUNS,
  type Automation,
  type AutomationReceived,
  type AutomationRunCause,
  type AutomationRunResult,
} from "./fold.js";
import type { AutomationStore } from "./store.js";
import { previousRunUnfinished } from "./busy.js";
import { patrolDeliveryText } from "./patrol.js";
import { supervisorPolicy, type SupervisorPolicy } from "../supervisor/policy.js";
import { SUPERVISOR_FORK_TITLE, supervisorActsOf, supervisorDeliveryText } from "../supervisor/supervisors.js";
import { isAdvanceAutomation } from "./advance.js";

export interface AutomationRunnerDeps {
  projectThread: ProjectThreadStore;
  automations: AutomationStore;
  turns: ThreadTurns;
  deliveries: ThreadDeliveries;
  listJudgmentsForThread(threadId: string): JudgmentItem[];
  /** 人への知らせ（受信箱の「お知らせ」） */
  notify(input: { projectId: string; dedupeKey: string; title: string; detail: string }): Promise<void>;
  /**
   * **乗り換えで古い専用の Fork を閉じた**（追加・2026-10-15、Backlog #318）。開いている画面に `thread.closed` を流す
   * ——流さないと、開いている画面では再読み込みまでサイドバーの開いた一覧に残る
   */
  announceClosed?(input: { threadId: string; projectId: string; reason: string }): void;
  /**
   * **その Project の Claude のアカウントが全部閾値を越えているか**（アーキ仕様 §4.4「見回り」——見回りのために上限を使い切らない）。
   * 無ければ越えていない扱い
   */
  allAccountsOver?(projectId: string): boolean;
  /**
   * **その Project の番頭の方針**（アーキ仕様 §4.5、番頭の回に届ける文に添える）。回のたびに引く。無ければ方針の既定
   */
  supervisorPolicy?(projectId: string): SupervisorPolicy;
  /**
   * **番頭の回を飛ばす理由**（アーキ仕様 §4.5「量」、Backlog #510——アカウントの閾値・全体の1時間の回の上限。`supervisor/guard.ts`）。
   * 無ければ飛ばさない
   */
  supervisorSkipReason?(projectId: string): string | undefined;
  /**
   * **進める自動化の回を飛ばす理由**（追加・2026-10-24、アーキ仕様 §4.3「判断役の一般化」の 4.——全部の進める自動化の1時間の回の上限）。
   * `canAdvanceProject` を持つ自動化（番頭・見回りは除く）の回だけ引く。無ければ飛ばさない
   */
  advanceSkipReason?(projectId: string): string | undefined;
  /** 番頭の回を量で飛ばしたあと（記録と、届いていた決めることを人に残す）。届けなかった受けたものを渡す */
  supervisorSkipped?(automation: Automation, received: readonly AutomationReceived[], reason: string): Promise<void>;
  now?: () => Date;
}

/** 見回りを飛ばした理由（アカウントが全部閾値越え） */
export const PATROL_SKIPPED_OVER_THRESHOLD = "Claude の使用量が閾値を越えています";

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
  /** 前の回が終わっていないので届けなかった（`received` を渡した回だけ。記録は書いていない——溜めたまま） */
  deferred?: boolean;
}

/** 自動化の届けものの送り手（`MessageOrigin.from`）。core が使う名前（アーキ仕様 §5.2） */
const FROM = "banto";

/** まとめた1本に添える外から来たものの上限（Webhook の本文の上限と同じ。アーキ仕様 §4.3「届け方」） */
export const AUTOMATION_EXTERNAL_MAX_BYTES = 64 * 1024;

/**
 * **届けものに添える外から来たもの**。出来事は名前・題・属性を見出しに、`text` を本文に。まとめた1本の本文は先頭から積み、
 * 上限に収まらなくなった出来事から本文を省いて見出しだけ並べ、省いた数を返す（アーキ仕様 §4.3「超える分は出来事の見出しだけ」。
 * Webhook の本文は受けたときに切ってあるので省かない）
 */
export function externalOf(received: readonly AutomationReceived[]): { items: ExternalContent[]; omitted: number } {
  let used = 0;
  let full = false;
  let omitted = 0;
  const items = received.map((r): ExternalContent => {
    if (r.kind !== "event") {
      used += Buffer.byteLength(r.body, "utf8");
      return { source: "webhook", receivedAt: r.at, body: r.body, ...(r.truncatedFrom !== undefined ? { truncatedFrom: r.truncatedFrom } : {}) };
    }
    const text = r.text ?? "";
    const bytes = Buffer.byteLength(text, "utf8");
    // 一度収まらなくなったら、後ろの出来事も本文を省く（並びの途中から本文が戻ると、どこまで省いたか読み違える）
    if (!full && used + bytes > AUTOMATION_EXTERNAL_MAX_BYTES) full = true;
    const dropBody = full && text !== "";
    if (dropBody) omitted++;
    else used += bytes;
    return {
      source: "event",
      receivedAt: r.at,
      body: dropBody ? "" : text,
      ...(!dropBody && r.truncatedFrom !== undefined ? { truncatedFrom: r.truncatedFrom } : {}),
      event: { name: r.name, title: r.title, eventId: r.eventId, occurredAt: r.occurredAt, fields: r.fields },
      ...(dropBody ? { bodyOmitted: true as const } : {}),
    };
  });
  return { items, omitted };
}

/**
 * **届けもののホップ**（アーキ仕様 §4.3「段2から一般化するところ」）。時刻・Webhook・今すぐは 0（人の発言と同じ）。出来事は
 * 出来事ごとに持ち越した値（起こしたターンのホップ＋1）で、まとめたときは一番大きいもの——上限（10）はそのまま効く
 */
export function hopOf(received: readonly AutomationReceived[]): number {
  return received.reduce((max, r) => (r.kind === "event" && r.hop > max ? r.hop : max), 0);
}

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
    if (automation.mode === "supervisor") return this.prepareSupervisor(automation);
    const current = target.threadId ? this.deps.projectThread.getThread(target.threadId) : undefined;
    if (current && current.status !== "closed") return automation;
    const thread = await this.newFork(automation);
    return this.deps.automations.setDedicatedThread(automation.id, thread.id);
  }

  /**
   * 1回動かす。届けなかったときも `skipped` と理由を台帳に残して返す。
   *
   * `received`＝**Webhook・出来事で受けて溜めていたもの**（アーキ仕様 §4.3「Webhook」「段2」）。指示の下に外から来たものとして添え、
   * 届けたら溜めていたものから外す。前の回が終わっていなければ届けず、記録もしない（`deferred`——溜めたまま、空いたら
   * まとめて届ける）
   */
  async run(
    automation: Automation,
    cause: AutomationRunCause,
    extras: AutomationRunExtras = {},
    received: readonly AutomationReceived[] = [],
  ): Promise<AutomationRunStarted> {
    // 番頭の4件は同じ Fork に届く——同じ番頭のもう1件が Clear と届けの間に割り込まないように、番頭の単位で数える
    const startKey = automation.supervisorId ?? automation.id;
    if (this.starting.has(startKey)) {
      const runId = randomUUID();
      const reason = "前の回を届けているところです";
      if (received.length > 0) return { runId, result: "skipped", reason, deferred: true };
      const at = (this.deps.now?.() ?? new Date()).toISOString();
      await this.deps.automations.recordRun(automation.id, { runId, at, cause, result: "skipped", reason, ...extras });
      return { runId, result: "skipped", reason };
    }
    this.starting.add(startKey);
    try {
      return await this.start(automation, cause, extras, received);
    } finally {
      this.starting.delete(startKey);
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

  private async start(
    automation: Automation,
    cause: AutomationRunCause,
    extras: AutomationRunExtras,
    received: readonly AutomationReceived[],
  ): Promise<AutomationRunStarted> {
    const runId = randomUUID();
    const at = (this.deps.now?.() ?? new Date()).toISOString();
    const receivedIds = received.map((r) => r.receivedId);
    const counted = received.length > 0 ? { received: received.length } : {};
    // 届けられない（閉じている・届け先が無い）回は、受けたものも一緒に片づける——溜めたままにすると空かない宛先へ届け直し続ける
    const skip = async (reason: string, threadId?: string): Promise<AutomationRunStarted> => {
      await this.deps.automations.recordRun(
        automation.id,
        { runId, at, cause, result: "skipped", reason, ...(threadId ? { threadId } : {}), ...extras, ...counted },
        receivedIds,
      );
      return { runId, result: "skipped", reason, ...(threadId ? { threadId } : {}) };
    };

    const project = this.deps.projectThread.getProject(automation.projectId);
    if (!project) return skip("この Project がありません");
    if (project.status === "closed") return skip("この Project は閉じられています");
    if (project.move) return skip("この Project はいま別の実行場所へ移しています");
    if (automation.mode === "patrol" && this.deps.allAccountsOver?.(automation.projectId)) return skip(PATROL_SKIPPED_OVER_THRESHOLD);
    // **番頭の量**：飛ばした回の受けたものは届けずに片づける——その間の決めることは人に残る（見回りと同じく `skipped` と理由）
    const supervisorSkip = automation.mode === "supervisor" ? this.deps.supervisorSkipReason?.(automation.projectId) : undefined;
    if (supervisorSkip !== undefined) {
      const skipped = await skip(supervisorSkip);
      await this.deps
        .supervisorSkipped?.(automation, received, supervisorSkip)
        .catch((err: unknown) => console.warn(`[host] 番頭の回を飛ばしたことを残せませんでした（${automation.id}）:`, err));
      return skipped;
    }

    // **進める自動化の量**（§4.3「判断役の一般化」の 4.）：飛ばした回の受けたものは届けずに片づける——その間の決めることは人に残る
    if (isAdvanceAutomation(automation)) {
      const advanceSkip = this.deps.advanceSkipReason?.(automation.projectId);
      if (advanceSkip !== undefined) return skip(advanceSkip);
    }

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
    if (busy) {
      // Webhook：受けたものは溜めたまま、空いたら一度にまとめて届ける（記録は届けたときに1件）
      if (received.length > 0) return { runId, result: "skipped", reason: busy, threadId: thread.id, deferred: true };
      return skip(busy, thread.id);
    }

    let threadId = thread.id;
    let rotatedFrom: string | undefined;
    if (current.target.kind === "dedicated" && (current.threadRuns ?? 0) >= AUTOMATION_FORK_RUNS) {
      // **乗り換え**：新しい Fork に届け、古い Fork は閉じる（閉じた一覧に残るので記録は失わない）。新しい Fork は
      // まっさらなので Clear は要らない。前の回を引き継ぐなら、古い Fork の会話を引き継いで立てる
      const next = await this.newFork(current, current.target.mode === "continue" ? thread : undefined);
      await this.deps.automations.setDedicatedThread(current.id, next.id);
      // 番頭は4件の届け先が同じ Fork——揃えて乗り換える（残すと、ほかの3件が閉じた Fork に届けて一時停止する）
      for (const sibling of this.supervisorSiblings(current)) await this.deps.automations.setDedicatedThread(sibling.id, next.id);
      // 人・AI が閉じる口（`closeThreadAndTell`）は通らない——通ると「専用の Fork が閉じられた」で一時停止してしまう
      const reason = `自動化「${current.name}」が新しい Fork に乗り換えました`;
      await this.deps.projectThread.closeThread(thread.id, { by: "automation", reason });
      this.deps.announceClosed?.({ threadId: thread.id, projectId: thread.projectId, reason });
      rotatedFrom = thread.id;
      threadId = next.id;
    } else if (current.target.kind === "dedicated" && current.target.mode === "fresh") {
      // **毎回まっさら**：鍵を一瞬押さえて Clear する。鍵は届ける前に返す（届けたものはふつうに起こされる）
      const release = this.deps.turns.tryHold(threadId);
      if (!release) {
        const reason = "前の回のターンがまだ走っています";
        if (received.length > 0) return { runId, result: "skipped", reason, threadId, deferred: true };
        return skip(reason, threadId);
      }
      try {
        await this.deps.projectThread.clearThread(threadId);
      } finally {
        release();
      }
    }

    // 届ける前に「走っている」を書く——ターンの終わりを聞く側が、この回を見つけられるように。受けたものはここで
    // 溜めていたものから外す（届けものとして Thread の記録に移る）
    await this.deps.automations.recordRun(
      current.id,
      { runId, at, cause, result: "running", threadId, ...(rotatedFrom ? { rotatedFrom } : {}), ...extras, ...counted },
      receivedIds,
    );
    const external = externalOf(received);
    const instruction =
      current.mode === "patrol"
        ? patrolDeliveryText(current)
        : current.mode === "supervisor" && current.supervisorId
          ? supervisorDeliveryText(
              current,
              this.deps.supervisorPolicy?.(current.projectId) ?? supervisorPolicy(undefined, current.projectId),
              supervisorActsOf(this.deps.automations, current.supervisorId),
            )
          : current.instruction;
    try {
      const delivered = await this.deps.deliveries.deliver({
        threadId,
        from: FROM,
        title:
          current.mode === "patrol" ? `見回り「${current.name}」` : current.mode === "supervisor" ? current.name : `自動化「${current.name}」`,
        text: external.omitted > 0 ? `${instruction}\n\n（まとめた出来事が大きすぎるので、${external.omitted} 件の本文を省き、見出しだけを添えました）` : instruction,
        hop: hopOf(received),
        kind: "automation",
        automation: { id: current.id, runId },
        ...(external.items.length > 0 ? { external: external.items } : {}),
      });
      if (delivered.wake === "held") {
        // 届けたものは溜まったまま残る（留めが解けたら起こされる・人が次に送ったターンの頭に積まれる）——その回は
        // 理由を添えて `running` のままにし、ターンの終わりで結末を書く。留めが解けないまま閉じられたら `threadClosed` が飛ばす
        const reason = `${HELD_PREFIX}${delivered.reason}`;
        await this.record(current.id, runId, at, cause, threadId, "running", reason, { rotatedFrom, ...extras, ...counted });
        return { runId, result: "running", reason, threadId };
      }
    } catch (err) {
      const reason = `届けられませんでした：${err instanceof Error ? err.message : String(err)}`;
      await this.record(current.id, runId, at, cause, threadId, "failed", reason, { rotatedFrom, ...extras, ...counted });
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
    // 番頭は4件で1つ——知らせは番頭ごとに1件
    const toldSupervisors = new Set<string>();
    for (const a of this.deps.automations.list(thread.projectId)) {
      if (a.target.kind !== "dedicated" || a.target.threadId !== threadId || a.paused) continue;
      await this.deps.automations.pause(a.id, "専用の Fork が閉じられました");
      if (a.supervisorId) {
        if (toldSupervisors.has(a.supervisorId)) continue;
        toldSupervisors.add(a.supervisorId);
        await this.deps
          .notify({
            projectId: a.projectId,
            dedupeKey: `supervisor-fork-closed:${a.supervisorId}:${threadId}`,
            title: "番頭を一時停止しました",
            detail:
              "番頭が使っていた専用の Fork が閉じられたので、番頭を一時停止しました。Fork を開き直しても自動では再開しません——動かし続けるなら、番頭の画面で再開してください（新しい Fork を立てます）",
          })
          .catch((err: unknown) => console.warn("[host] 番頭を一時停止したことを受信箱に出せませんでした:", err));
        continue;
      }
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
          received: run.received,
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
          received: run.received,
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
    extras: AutomationRunExtras & { rotatedFrom?: string | undefined; received?: number | undefined },
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
      ...(extras.received ? { received: extras.received } : {}),
    });
  }

  /**
   * 専用の Fork を立てる。名前は自動化の名前。`from` を渡さなければ Base Thread から会話を引き継がずに。
   * **見回りの Fork は読むだけの印を刻んで立てる**（立て直す・乗り換えるときも。アーキ仕様 §4.4「読むだけの回」）
   */
  private async newFork(automation: Automation, from?: ThreadState): Promise<ThreadState> {
    // **番頭の Fork は番頭の印を刻んで立てる**（アーキ仕様 §4.5「番頭の会話の tool は host が強いる」）
    const restriction =
      automation.mode === "patrol"
        ? { restriction: "read-only" as const }
        : automation.mode === "supervisor"
          ? { restriction: "supervisor" as const }
          : {};
    const title = automation.mode === "supervisor" ? SUPERVISOR_FORK_TITLE : automation.name;
    if (from) return this.deps.projectThread.forkThread(from.id, { title, ...restriction });
    const base = this.deps.projectThread.listThreadsForProject(automation.projectId).find((t) => t.kind === "base");
    if (!base) throw new Error(`Project ${automation.projectId} に Base Thread が無いので、専用の Fork を立てられません`);
    return this.deps.projectThread.forkThread(base.id, { title, fresh: true, ...restriction });
  }

  /** 同じ番頭のほかの自動化（番頭でなければ空） */
  private supervisorSiblings(automation: Automation): Automation[] {
    if (automation.mode !== "supervisor" || !automation.supervisorId) return [];
    return this.deps.automations
      .list(automation.projectId)
      .filter((a) => a.id !== automation.id && a.mode === "supervisor" && a.supervisorId === automation.supervisorId);
  }

  /**
   * **番頭の専用の Fork を用意する**——4件の届け先を同じ Fork に揃える。どれかが開いている Fork を持っていればそれに、無ければ1本立てる
   */
  private async prepareSupervisor(automation: Automation): Promise<Automation> {
    const group = [automation, ...this.supervisorSiblings(automation)];
    const open = group
      .map((a) => (a.target.kind === "dedicated" ? a.target.threadId : undefined))
      .find((id) => {
        const t = id ? this.deps.projectThread.getThread(id) : undefined;
        return t !== undefined && t.status !== "closed";
      });
    const threadId = open ?? (await this.newFork(automation)).id;
    for (const a of group) {
      if (a.target.kind === "dedicated" && a.target.threadId !== threadId) await this.deps.automations.setDedicatedThread(a.id, threadId);
    }
    return this.deps.automations.get(automation.id) ?? automation;
  }
}

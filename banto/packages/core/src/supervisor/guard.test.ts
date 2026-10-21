// アーキ仕様 §4.5「守り」（Backlog #510）——量（閾値・全体の1時間の回・指示の上限）で番頭の回を飛ばし、その間の決めることは人に残す。
// 全部止める（自動化の一時停止・走っている番頭のターン・始まる前の指示・途中の答え）と、全部再開は Project ごとに止めたものを残す。
// 記録の口（新しい順・絞り込み）・取り消し（人の発言・cancelFactory・2回目は断る）・1日のまとめ（タイムゾーンの日付の境）
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventLog } from "../event-store/log.js";
import { ProjectThreadStore } from "../project-thread/store.js";
import type { PendingDelivery } from "../project-thread/types.js";
import { ThreadTurns } from "../delivery/thread-turns.js";
import { ThreadDeliveries } from "../delivery/thread-deliveries.js";
import { InboxStore } from "../inbox/store.js";
import type { ReviewItem } from "../inbox/types.js";
import { AutomationStore } from "../automation/store.js";
import { AutomationRunner, PATROL_SKIPPED_OVER_THRESHOLD } from "../automation/runner.js";
import type { Automation, AutomationReceivedEvent, SupervisorAct } from "../automation/fold.js";
import { TURN_DECISIONS_EVENT, TurnDecisions } from "../automation/turn-decisions.js";
import type { RuntimeConfigValue } from "../config/runtime.js";
import { SUPERVISOR_KEYS, supervisorPolicy } from "./policy.js";
import { SupervisorConflictError, SupervisorNotFoundError, Supervisors, supervisorActsOf, type SupervisorView } from "./supervisors.js";
import {
  SUPERVISOR_STOP_ALL_DROP_REASON,
  SUPERVISOR_STOP_ALL_REASON,
  SupervisorControls,
  SupervisorInputError,
  supervisorLimitsOf,
  supervisorSkipReason,
  type SupervisorUndoExec,
} from "./guard.js";

interface Harness {
  projectThread: ProjectThreadStore;
  automations: AutomationStore;
  inbox: InboxStore;
  runner: AutomationRunner;
  supervisors: Supervisors;
  decisions: TurnDecisions;
  controls: SupervisorControls;
  config: Map<string, RuntimeConfigValue>;
  now: { value: Date };
  allOver: { value: boolean };
  /** 走っている会話（全部止めるときの `turns.isRunning`） */
  running: Set<string>;
  projectId: string;
  baseId: string;
  sP: SupervisorView;
  otherProjectId: string;
  otherBaseId: string;
  sQ: SupervisorView;
}

async function withHarness(fn: (h: Harness) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "banto-supervisor-guard-"));
  try {
    const log = new EventLog(dir);
    await log.init();
    const projectThread = new ProjectThreadStore(dir, log);
    await projectThread.load();
    const automations = new AutomationStore(dir, log);
    await automations.load();
    automations.setEventCatalog({ find: () => undefined, list: () => [] });
    const inbox = new InboxStore(dir, log);
    await inbox.load();
    const config = new Map<string, RuntimeConfigValue>();
    const layer = { layerValue: (key: string, projectId?: string) => config.get(projectId ? `${projectId}:${key}` : key) };
    const policy = (projectId: string) => supervisorPolicy(layer, projectId);
    const now = { value: new Date("2026-10-21T03:00:00Z") };
    const allOver = { value: false };
    const running = new Set<string>();

    const project = await projectThread.createProject("P", dir);
    const base = await projectThread.createBaseThread(project.id);
    const other = await projectThread.createProject("Q", dir);
    const otherBase = await projectThread.createBaseThread(other.id);

    const turns = new ThreadTurns();
    const deliveries = new ThreadDeliveries({ projectThread, turns, notify: async () => {} });
    // 届いたもので起こすターン：積んで「見ました」で終える
    deliveries.setTurnRunner(async (threadId, hop) => {
      const release = turns.tryAcquire(threadId, hop);
      if (!release) return false;
      const turnId = await projectThread.startTurn(threadId, { cause: "delivery", attempt: 0 });
      for (const d of [...(projectThread.getThread(threadId)!.deliveries ?? [])]) {
        await projectThread.appendMessage(threadId, "user", d.text, undefined, {
          from: d.from,
          title: d.title,
          hop: d.hop,
          deliveryId: d.deliveryId,
          ...(d.automation ? { automation: d.automation } : {}),
        });
      }
      await projectThread.appendMessage(threadId, "assistant", "見ました");
      await projectThread.endTurn(threadId, turnId, "completed");
      release();
      return true;
    });
    let controls: SupervisorControls | undefined;
    const skipReason = (projectId: string) => supervisorSkipReason(projectId, { automations, policy, allAccountsOver: () => allOver.value, now: () => now.value });
    const runner = new AutomationRunner({
      projectThread,
      automations,
      turns,
      deliveries,
      listJudgmentsForThread: () => [],
      notify: async () => {},
      supervisorPolicy: policy,
      supervisorSkipReason: skipReason,
      supervisorSkipped: (a, received, reason) => controls!.skipped(a, received, reason),
      now: () => now.value,
    });
    const supervisors = new Supervisors({ automations, runner, policy, defaultTimeZone: "Asia/Tokyo", handedToHuman: skipReason });
    const sP = await supervisors.create(project.id);
    const sQ = await supervisors.create(other.id);
    const decisions = new TurnDecisions({
      projectThread,
      automations,
      events: { emitFromCore: async () => 1 },
      deliveries: { deliver: async () => ({ deliveryId: "x", wake: "now" }) },
      turns: { isRunning: () => false, queued: () => 0 },
      inbox,
      turnSummaryEnabled: () => true,
      supervisorPolicy: policy,
      recordSupervisorAct: (id, act) => automations.recordSupervisorAct(id, act),
      log: () => {},
    });
    controls = new SupervisorControls({
      automations,
      projectThread,
      turns: { isRunning: (id) => running.has(id) },
      inbox,
      supervisors,
      policy,
      allAccountsOver: () => allOver.value,
      handOverDecisions: (id) => decisions.endTurn(id),
      defaultTimeZone: "Asia/Tokyo",
      now: () => now.value,
      log: () => {},
    });
    await fn({
      projectThread,
      automations,
      inbox,
      runner,
      supervisors,
      decisions,
      controls,
      config,
      now,
      allOver,
      running,
      projectId: project.id,
      baseId: base.id,
      sP,
      otherProjectId: other.id,
      otherBaseId: otherBase.id,
      sQ,
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const automationOf = (h: Harness, s: SupervisorView, kind: "time" | string): Automation =>
  h.automations.get(s.automations.find((a) => (a.source.kind === "event" ? a.source.event : a.source.kind) === kind)!.id)!;

async function waitFor(cond: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  assert.fail(`${what} にならない`);
}

/** 番頭の見回りを今すぐ1回動かし、その回が終わる（届けたなら done）まで待つ */
async function patrolOnce(h: Harness, s: SupervisorView): Promise<Awaited<ReturnType<AutomationRunner["run"]>>> {
  const started = await h.runner.run(automationOf(h, s, "time"), "manual");
  if (started.result === "running") {
    await waitFor(() => automationOf(h, s, "time").runs.find((r) => r.runId === started.runId)?.result === "done", "見回りの回が done");
  }
  return started;
}

/** 問い（数は渡したもの）のまとめで終わったターン */
async function decidedTurn(h: Harness, threadId: string, count = 1): Promise<string> {
  const turnId = await h.projectThread.startTurn(threadId, { cause: "human", attempt: 0 });
  await h.projectThread.appendMessage(threadId, "user", "進めて");
  await h.projectThread.appendMessage(threadId, "assistant", "止まりました");
  await h.projectThread.recordTurnSummary(threadId, {
    summary: {
      request: "進めて",
      outcome: { status: "partial", headline: "試験が落ちた", points: [] },
      decisions: Array.from({ length: count }, (_, i) => ({
        question: `どうしますか（${i + 1}）`,
        kind: "rerun-tests",
        options: [
          { label: "流し直す", reply: "流し直して" },
          { label: "待つ", reply: "待って" },
        ],
      })),
    },
    at: h.now.value.toISOString(),
  });
  await h.projectThread.endTurn(threadId, turnId, "completed");
  return turnId;
}

function decisionEvent(thread: string, turnId: string, count = 1): AutomationReceivedEvent {
  return {
    kind: "event",
    receivedId: `rcv-${Math.random()}`,
    at: new Date().toISOString(),
    name: TURN_DECISIONS_EVENT,
    title: "決めることのあるターンが終わった",
    eventId: `${thread}:${turnId}`,
    occurredAt: new Date().toISOString(),
    fields: { thread, turnId, threadTitle: "Base Thread", count, hop: 0, readExternal: false },
    hop: 1,
  };
}

const record = (h: Harness, automationId: string, act: Omit<SupervisorAct, "at"> & { at?: string }) =>
  h.automations.recordSupervisorAct(automationId, { at: h.now.value.toISOString(), ...act });

const card = (h: Harness, threadId: string): ReviewItem | undefined =>
  h.inbox.listOpen().find((i): i is ReviewItem => i.kind === "review" && i.threadId === threadId);

// ---- 量 ---------------------------------------------------------------------------------------------------------

test("全体の1時間の回の上限：ちょうどで飛ばし、超えても飛ばし、1時間たてば戻る。数えは全部の番頭の合計で、飛ばした回は数えない", async () => {
  await withHarness(async (h) => {
    h.config.set(SUPERVISOR_KEYS.runsPerHour, 2);
    assert.equal((await patrolOnce(h, h.sP)).result, "running");
    assert.equal(h.controls.status().runs.used, 1);
    assert.equal(h.supervisors.get(h.sP.id)?.handedToHuman, undefined);
    // ほかの Project の番頭の回も数える
    h.now.value = new Date("2026-10-21T03:10:00Z");
    assert.equal((await patrolOnce(h, h.sQ)).result, "running");
    // ちょうど（2回）——次の回は飛ばす
    h.now.value = new Date("2026-10-21T03:20:00Z");
    const skipped = await patrolOnce(h, h.sP);
    assert.equal(skipped.result, "skipped");
    assert.match(skipped.reason ?? "", /全部の番頭で1時間に起きる回は 2 回までです（いま 2 回）/);
    assert.equal(automationOf(h, h.sP, "time").runs[0]?.result, "skipped");
    // 飛ばした回は数えに入らない・記録に「回を飛ばした」
    const status = h.controls.status();
    assert.deepEqual(status.runs, { used: 2, limit: 2 });
    assert.equal(status.runsFreeAt, "2026-10-21T04:00:00.000Z", "一番古い回が窓を出る時刻");
    assert.equal(supervisorActsOf(h.automations, h.sP.id)[0]?.kind, "skipped");
    // 画面の「この時間は人に回しています」——どの Project の番頭にも出る
    assert.match(h.supervisors.get(h.sQ.id)?.handedToHuman ?? "", /この時間は人に回しています/);
    // 超え（上限を下げた）
    h.config.set(SUPERVISOR_KEYS.runsPerHour, 1);
    assert.match(supervisorSkipReason(h.projectId, { automations: h.automations, policy: (p) => supervisorPolicy({ layerValue: (k) => h.config.get(k) }, p), now: () => h.now.value }) ?? "", /1 回までです（いま 2 回）/);
    h.config.set(SUPERVISOR_KEYS.runsPerHour, 2);
    // 1時間たって一番古い回が窓を出たら戻る
    h.now.value = new Date("2026-10-21T04:00:01Z");
    assert.equal(h.supervisors.get(h.sP.id)?.handedToHuman, undefined);
    assert.equal((await patrolOnce(h, h.sP)).result, "running");
  });
});

test("Claude のアカウントが全部閾値を越えていれば番頭の回を飛ばす（見回りと同じ理由）。数えには入らない", async () => {
  await withHarness(async (h) => {
    h.allOver.value = true;
    const started = await patrolOnce(h, h.sP);
    assert.equal(started.result, "skipped");
    assert.match(started.reason ?? "", new RegExp(PATROL_SKIPPED_OVER_THRESHOLD));
    assert.match(h.supervisors.get(h.sP.id)?.handedToHuman ?? "", /決めることは人に残します/);
    assert.equal(h.controls.status().runs.used, 0);
    h.allOver.value = false;
    assert.equal((await patrolOnce(h, h.sP)).result, "running");
  });
});

test("決めることの回を量で飛ばすと、届いていた問いは人に残る——カードに番頭の印つきの「人に回した」、記録に skipped と deferred", async () => {
  await withHarness(async (h) => {
    h.config.set(SUPERVISOR_KEYS.runsPerHour, 1);
    await patrolOnce(h, h.sP);
    const turnId = await decidedTurn(h, h.baseId);
    await h.inbox.raiseReview({ threadId: h.baseId, summary: "決めることがあります" });
    const decide = automationOf(h, h.sP, TURN_DECISIONS_EVENT);
    const received = decisionEvent(h.baseId, turnId);
    await h.automations.recordReceived(decide.id, received);
    const started = await h.runner.run(automationOf(h, h.sP, TURN_DECISIONS_EVENT), "event", {}, [received]);
    assert.equal(started.result, "skipped");
    assert.equal(started.deferred, undefined, "溜めたまま残した（空いたら番頭に届いてしまう）");
    assert.deepEqual(automationOf(h, h.sP, TURN_DECISIONS_EVENT).received, [], "受けたものを片づけていない");
    const judge = card(h, h.baseId)?.judge;
    assert.equal(judge?.kind, "deferred");
    assert.equal(judge?.by, "supervisor");
    assert.match(judge?.reason ?? "", /番頭はこの回を飛ばしました/);
    const acts = supervisorActsOf(h.automations, h.sP.id);
    assert.deepEqual(acts.slice(0, 2).map((a) => [a.kind, a.threadId]).sort(), [["deferred", h.baseId], ["skipped", h.sP.threadId]].sort());
    assert.equal(acts.find((a) => a.kind === "deferred")?.turnId, turnId);
  });
});

test("supervisorLimitsOf：指示の数えは番頭の記録の instructed（全部の番頭の合計）。ちょうどで届き、1時間たてば空く", async () => {
  await withHarness(async (h) => {
    const p = automationOf(h, h.sP, "time").id;
    const q = automationOf(h, h.sQ, "time").id;
    await record(h, p, { kind: "instructed", threadId: h.baseId, action: "continue", reason: "a", at: "2026-10-21T02:10:00.000Z" });
    await record(h, q, { kind: "instructed", threadId: h.otherBaseId, action: "continue", reason: "b", at: "2026-10-21T02:30:00.000Z" });
    // 断ったもの・ほかの種類は数えない
    await record(h, p, { kind: "refused", threadId: h.baseId, action: "continue", reason: "c" });
    const limits = { runsPerHour: 12, instructionsPerHour: 2 };
    const at = supervisorLimitsOf(h.automations, limits, h.now.value);
    assert.deepEqual(at.instructions, { used: 2, limit: 2 });
    assert.equal(at.instructionsFreeAt, "2026-10-21T03:10:00.000Z");
    assert.deepEqual(supervisorLimitsOf(h.automations, { ...limits, instructionsPerHour: 3 }, h.now.value).instructionsFreeAt, undefined);
    assert.equal(supervisorLimitsOf(h.automations, limits, new Date("2026-10-21T03:10:01Z")).instructions.used, 1);
  });
});

// ---- 全部止める ---------------------------------------------------------------------------------------------------

test("全部止める：(a) 全部の番頭を一時停止して走っている番頭のターンを止め (b) 始まる前の指示を捨て (c) 途中の答えは人に回す。Factory の件は止めない", async () => {
  await withHarness(async (h) => {
    // (c) 番頭の回が2問のうち1問だけ答えた途中
    const turnId = await decidedTurn(h, h.baseId, 2);
    await h.inbox.raiseReview({ threadId: h.baseId, summary: "決めることがあります" });
    const decideId = automationOf(h, h.sP, TURN_DECISIONS_EVENT).id;
    const delivered: PendingDelivery = {
      from: "banto",
      title: "番頭：決めること",
      hop: 1,
      deliveryId: "dj",
      text: "決めて",
      receivedAt: new Date().toISOString(),
      kind: "automation",
      automation: { id: decideId, runId: "r1" },
      external: [{ source: "event", receivedAt: "t", body: "", event: { name: TURN_DECISIONS_EVENT, title: "t", eventId: "e", occurredAt: "t", fields: decisionEvent(h.baseId, turnId, 2).fields } }],
    };
    h.decisions.beginTurn(h.sP.threadId!, [delivered]);
    const first = await h.decisions.answer(h.sP.threadId!, { thread: h.baseId, turnId, question: 1, choice: 1, reason: "手順" });
    assert.equal(first.ok, true, first.text);
    // (b) ほかの Project の会話に積まれた、まだ始まっていない番頭の指示
    const qPatrol = automationOf(h, h.sQ, "time").id;
    await record(h, qPatrol, { kind: "instructed", threadId: h.otherBaseId, action: "continue", actionId: "act-q", reason: "続ける" });
    await h.projectThread.recordDelivery({
      threadId: h.otherBaseId,
      deliveryId: "dq",
      from: "banto",
      title: "番頭の指示：続ける",
      text: "続けて",
      hop: 2,
      kind: "supervisor",
      supervisor: { supervisorId: h.sQ.id, runId: "r", automationId: qPatrol, actionId: "act-q" },
    });
    // ふつうの届けものは捨てない
    await h.projectThread.recordDelivery({ threadId: h.otherBaseId, deliveryId: "dm", from: "m", title: "結果", text: "結果です", hop: 1 });
    // Factory に流した記録（止めない）
    await record(h, automationOf(h, h.sP, "time").id, { kind: "factory-started", threadId: h.sP.threadId!, runId: "run-f", items: ["t1"], reason: "流す" });
    // (a) Q の番頭のターンが走っている
    h.running.add(h.sQ.threadId!);
    const stopped: string[] = [];

    const result = await h.controls.stopAll({ stopTurn: async (id) => void stopped.push(id) });

    for (const s of h.supervisors.list()) {
      assert.equal(s.paused, true);
      assert.equal(s.stoppedAll, true);
      assert.equal(s.pausedReason, SUPERVISOR_STOP_ALL_REASON);
    }
    assert.equal(h.controls.status().stoppedAll, true);
    assert.deepEqual(stopped, [h.sQ.threadId]);
    assert.deepEqual(result.stoppedTurns, [h.sQ.threadId]);
    assert.deepEqual(new Set(result.paused), new Set([h.sP.id, h.sQ.id]));
    // (b)
    assert.deepEqual((h.projectThread.getThread(h.otherBaseId)!.deliveries ?? []).map((d) => d.deliveryId), ["dm"]);
    assert.deepEqual(result.dropped, [{ threadId: h.otherBaseId, actionId: "act-q" }]);
    const dropped = supervisorActsOf(h.automations, h.sQ.id)[0]!;
    assert.deepEqual([dropped.kind, dropped.actionId, dropped.action, dropped.reason], ["dropped", "act-q", "continue", SUPERVISOR_STOP_ALL_DROP_REASON]);
    // (c) 預かった答えは届けず、カードは「揃わず人に回った」（番頭の印）。そのあと答えても断る
    const judge = card(h, h.baseId)?.judge;
    assert.deepEqual([judge?.kind, judge?.by, judge?.answered, judge?.total], ["incomplete", "supervisor", 1, 2]);
    const late = await h.decisions.answer(h.sP.threadId!, { thread: h.baseId, turnId, question: 2, choice: 1, reason: "手順" });
    assert.equal(late.ok, false);
    // Factory の件は止めない（記録はそのまま・取りやめの記録は無い）
    assert.equal(supervisorActsOf(h.automations, h.sP.id).some((a) => a.kind === "undone"), false);
    assert.ok(supervisorActsOf(h.automations, h.sP.id).some((a) => a.kind === "factory-started" && a.runId === "run-f"));
    // 止まっている間は見回れない
    await assert.rejects(() => h.supervisors.patrolNow(h.sP.id), SupervisorConflictError);
  });
});

test("全部再開は全部止めたものだけを再開する——Project ごとに止めたもの（前から・全部止めたあとに止め直したもの）は残す", async () => {
  await withHarness(async (h) => {
    const third = await h.projectThread.createProject("R", "/tmp");
    await h.projectThread.createBaseThread(third.id);
    const sR = await h.supervisors.create(third.id);
    // P は前から Project ごとに止めている
    await h.supervisors.pause(h.sP.id);
    await h.controls.stopAll({ stopTurn: async () => {} });
    assert.equal(h.supervisors.get(h.sP.id)?.stoppedAll, false, "Project ごとに止めたものを全部止めたことにした");
    assert.equal(h.supervisors.get(h.sP.id)?.pausedReason, "人が一時停止しました");
    // R は全部止めたあとに Project ごとに止め直す
    await h.supervisors.pause(sR.id);
    assert.equal(h.supervisors.get(sR.id)?.stoppedAll, false);

    await h.controls.resumeAll();
    assert.equal(h.supervisors.get(h.sQ.id)?.paused, false, "全部止めたものが再開しない");
    assert.equal(h.supervisors.get(h.sP.id)?.paused, true, "Project ごとに止めたものを再開した");
    assert.equal(h.supervisors.get(sR.id)?.paused, true, "止め直したものを再開した");
    assert.equal(h.controls.status().stoppedAll, false);
    // Project ごとの再開は今どおり
    assert.equal((await h.supervisors.resume(h.sP.id)).paused, false);
  });
});

// ---- 記録 --------------------------------------------------------------------------------------------------------

test("記録の口：全部の番頭の記録を新しい順に、Project・会話・種類で絞る。id・番頭・Project・取り消せるかを添える", async () => {
  await withHarness(async (h) => {
    const p = automationOf(h, h.sP, TURN_DECISIONS_EVENT).id;
    const q = automationOf(h, h.sQ, "time").id;
    await record(h, p, { kind: "answered", threadId: h.baseId, turnId: "t1", question: 1, choice: 1, label: "流し直す", reason: "a", at: "2026-10-21T01:00:00.000Z" });
    await record(h, q, { kind: "instructed", threadId: h.otherBaseId, action: "continue", actionId: "x", reason: "b", at: "2026-10-21T02:00:00.000Z" });
    await record(h, p, { kind: "refused", threadId: h.baseId, reason: "c", at: "2026-10-21T03:00:00.000Z" });
    await record(h, q, { kind: "skipped", threadId: h.sQ.threadId!, reason: "d", at: "2026-10-21T04:00:00.000Z" });

    const all = h.controls.log();
    assert.deepEqual(all.map((e) => e.kind), ["skipped", "refused", "instructed", "answered"]);
    assert.deepEqual(all.map((e) => e.undoable), [false, false, true, true]);
    assert.ok(all.every((e) => /^act-\d+$/.test(e.actId)));
    assert.equal(new Set(all.map((e) => e.actId)).size, 4, "id が重なった");
    assert.deepEqual(all.map((e) => e.projectId), [h.otherProjectId, h.projectId, h.otherProjectId, h.projectId]);
    assert.equal(all[0]?.supervisorId, h.sQ.id);
    assert.equal(all[0]?.automationId, q);
    assert.deepEqual(h.controls.log({ projectId: h.projectId }).map((e) => e.kind), ["refused", "answered"]);
    assert.deepEqual(h.controls.log({ threadId: h.otherBaseId }).map((e) => e.kind), ["instructed"]);
    assert.deepEqual(h.controls.log({ kinds: ["answered", "skipped"] }).map((e) => e.kind), ["skipped", "answered"]);
    assert.deepEqual(h.controls.log({ projectId: h.projectId, kinds: ["skipped"] }), []);
    assert.equal(h.controls.log({ limit: 1 }).length, 1);
  });
});

// ---- 取り消し ------------------------------------------------------------------------------------------------------

function fakeExec(): SupervisorUndoExec & { sent: Array<{ threadId: string; text: string }>; cancelled: Array<{ projectId: string; runId: string }> } {
  const sent: Array<{ threadId: string; text: string }> = [];
  const cancelled: Array<{ projectId: string; runId: string }> = [];
  return {
    sent,
    cancelled,
    sendAsHuman: async (threadId, text) => void sent.push({ threadId, text }),
    cancelFactory: async (projectId, runId) => void cancelled.push({ projectId, runId }),
  };
}

test("取り消し：選んだ答えは元の会話に人の発言で（同じターンに届けた問いは一緒に）、2回目は断る。人が文を直せる", async () => {
  await withHarness(async (h) => {
    const p = automationOf(h, h.sP, TURN_DECISIONS_EVENT).id;
    await record(h, p, { kind: "answered", threadId: h.baseId, turnId: "t1", question: 1, choice: 1, label: "流し直す", reason: "a" });
    await record(h, p, { kind: "answered", threadId: h.baseId, turnId: "t1", question: 2, choice: 2, label: "待つ", reason: "b" });
    await record(h, p, { kind: "answered", threadId: h.baseId, turnId: "t2", question: 1, choice: 1, label: "後のもの", reason: "c" });
    const [later, q2, q1] = h.controls.log({ kinds: ["answered"] });
    const exec = fakeExec();

    const r = await h.controls.undo(q1!.actId, {}, exec);
    assert.deepEqual(exec.sent, [{ threadId: h.baseId, text: "番頭の選んだ「流し直す」（問い 1）・「待つ」（問い 2）は取り消して。その前に戻して" }]);
    assert.deepEqual(new Set(r.undone.map((e) => e.actId)), new Set([q1!.actId, q2!.actId]));
    const undone = h.controls.log({ kinds: ["undone"] });
    assert.equal(undone.length, 1);
    assert.deepEqual(new Set(undone[0]!.undoes), new Set([q1!.actId, q2!.actId]));
    assert.equal(undone[0]!.threadId, h.baseId);
    const after = h.controls.log({ kinds: ["answered"] });
    assert.deepEqual(after.map((e) => [e.undoable, e.undoneBy]), [[true, undefined], [false, undone[0]!.actId], [false, undone[0]!.actId]]);
    // 同じもの（一緒に取り消した問いも）は2回取り消せない
    await assert.rejects(() => h.controls.undo(q1!.actId, {}, exec), SupervisorConflictError);
    await assert.rejects(() => h.controls.undo(q2!.actId, {}, exec), /もう取り消しました/);
    assert.equal(exec.sent.length, 1);
    // 人が文を直す
    await h.controls.undo(later!.actId, { text: "  やっぱり待って  " }, exec);
    assert.deepEqual(exec.sent[1], { threadId: h.baseId, text: "やっぱり待って" });
    await assert.rejects(() => h.controls.undo("act-404", {}, exec), SupervisorNotFoundError);
  });
});

test("取り消し：頼んだ手順は「番頭の頼み〈題〉」を送り、捨てられた頼み・取り消せない種類・閉じた会話・空の文は断る", async () => {
  await withHarness(async (h) => {
    const p = automationOf(h, h.sP, "time").id;
    await record(h, p, { kind: "instructed", threadId: h.baseId, action: "retry-turn", actionId: "i1", reason: "a" });
    await record(h, p, { kind: "instructed", threadId: h.baseId, action: "continue", actionId: "i2", reason: "b" });
    await record(h, p, { kind: "dropped", threadId: h.baseId, action: "continue", actionId: "i2", reason: "人が発言しました" });
    await record(h, p, { kind: "refused", threadId: h.baseId, reason: "c" });
    const byAction = (id: string) => h.controls.log().find((e) => e.kind === "instructed" && e.actionId === id)!;
    const exec = fakeExec();
    await assert.rejects(() => h.controls.undo(byAction("i1").actId, { text: "   " }, exec), SupervisorInputError);
    await h.controls.undo(byAction("i1").actId, {}, exec);
    assert.deepEqual(exec.sent, [{ threadId: h.baseId, text: "番頭の頼み「失敗した・途中で切れたターンをやり直す」は取り消して。その前に戻して" }]);
    assert.equal(h.controls.log({ kinds: ["undone"] })[0]?.actionId, "i1");
    await assert.rejects(() => h.controls.undo(byAction("i2").actId, {}, exec), /始まる前に捨てられています/);
    assert.equal(byAction("i2").undoable, false);
    await assert.rejects(() => h.controls.undo(h.controls.log({ kinds: ["refused"] })[0]!.actId, {}, exec), /取り消せるのは/);
    // 閉じた会話には送れない
    await record(h, p, { kind: "instructed", threadId: h.baseId, action: "continue", actionId: "i3", reason: "d" });
    await h.projectThread.closeThread(h.baseId, { by: "human" });
    await assert.rejects(() => h.controls.undo(byAction("i3").actId, {}, exec), /閉じられています/);
    assert.equal(exec.sent.length, 1);
    assert.equal(byAction("i3").undoable, true, "送れなかったのに取り消したことにした");
  });
});

test("取り消し：Factory に流したものは、その Project の Factory の cancelFactory を呼び、記録に undone。文は付けられず、2回目は断る", async () => {
  await withHarness(async (h) => {
    const p = automationOf(h, h.sP, "time").id;
    await record(h, p, { kind: "factory-started", threadId: h.sP.threadId!, runId: "run-1", items: ["t1"], reason: "流す" });
    const started = h.controls.log({ kinds: ["factory-started"] })[0]!;
    const exec = fakeExec();
    await assert.rejects(() => h.controls.undo(started.actId, { text: "やめて" }, exec), SupervisorInputError);
    const r = await h.controls.undo(started.actId, {}, exec);
    assert.deepEqual(exec.cancelled, [{ projectId: h.projectId, runId: "run-1" }]);
    assert.deepEqual(exec.sent, [], "Factory の取り消しで会話に送った");
    assert.deepEqual(r.cancelled, { runId: "run-1" });
    const undone = h.controls.log({ kinds: ["undone"] })[0]!;
    assert.deepEqual([undone.runId, undone.undoes], ["run-1", [started.actId]]);
    await assert.rejects(() => h.controls.undo(started.actId, {}, exec), /もう取り消しました/);
    // Factory が断ったら記録しない（もう一度押せる）
    await record(h, p, { kind: "factory-started", threadId: h.sP.threadId!, runId: "run-2", items: ["t2"], reason: "流す" });
    const second = h.controls.log({ kinds: ["factory-started"] })[0]!;
    await assert.rejects(() => h.controls.undo(second.actId, {}, { ...exec, cancelFactory: async () => { throw new SupervisorConflictError("Factory が断った"); } }), /Factory が断った/);
    assert.equal(h.controls.log({ kinds: ["factory-started"] })[0]?.undoable, true);
  });
});

// ---- 1日のまとめ ---------------------------------------------------------------------------------------------------

test("1日のまとめ：supervisor.timeZone の日付で数える（日付の境）。Project ごと・種類ごと、番頭のいる Project は 0 件でも出す", async () => {
  await withHarness(async (h) => {
    const p = automationOf(h, h.sP, TURN_DECISIONS_EVENT).id;
    const pPatrol = automationOf(h, h.sP, "time").id;
    // 東京で 10/21 23:59 と 10/22 00:00
    await record(h, p, { kind: "answered", threadId: h.baseId, question: 1, choice: 1, label: "a", reason: "a", at: "2026-10-21T14:59:59.000Z" });
    await record(h, p, { kind: "deferred", threadId: h.baseId, reason: "b", at: "2026-10-21T14:59:00.000Z" });
    await record(h, pPatrol, { kind: "instructed", threadId: h.baseId, action: "continue", reason: "c", at: "2026-10-21T15:00:00.000Z" });
    await record(h, pPatrol, { kind: "factory-started", threadId: h.sP.threadId!, runId: "r", items: ["x"], reason: "d", at: "2026-10-20T15:00:00.000Z" });
    await record(h, pPatrol, { kind: "refused", threadId: h.baseId, reason: "e", at: "2026-10-20T14:59:59.000Z" });
    h.config.set(SUPERVISOR_KEYS.timeZone, "Asia/Tokyo");
    const day = h.controls.daily("2026-10-21");
    assert.equal(day.timeZone, "Asia/Tokyo");
    const row = day.projects.find((r) => r.projectId === h.projectId)!;
    assert.deepEqual(
      [row.counts.answered, row.counts.deferred, row.counts.instructed, row.counts["factory-started"], row.counts.refused],
      [1, 1, 0, 1, 0],
    );
    const other = day.projects.find((r) => r.projectId === h.otherProjectId)!;
    assert.equal(Object.values(other.counts).reduce((a, b) => a + b, 0), 0);
    assert.equal(h.controls.daily("2026-10-22").projects.find((r) => r.projectId === h.projectId)!.counts.instructed, 1);
    assert.equal(h.controls.daily("2026-10-20").projects.find((r) => r.projectId === h.projectId)!.counts.refused, 1);
    // UTC なら境が動く
    h.config.set(SUPERVISOR_KEYS.timeZone, "UTC");
    const utc = h.controls.daily("2026-10-21").projects.find((r) => r.projectId === h.projectId)!.counts;
    assert.deepEqual([utc.answered, utc.instructed, utc["factory-started"], utc.refused], [1, 1, 0, 0]);
    // 日付が無ければ今日（その場所の）
    h.now.value = new Date("2026-10-21T23:30:00Z");
    assert.equal(h.controls.daily().date, "2026-10-21");
    h.config.set(SUPERVISOR_KEYS.timeZone, "Asia/Tokyo");
    assert.equal(h.controls.daily().date, "2026-10-22");
    assert.throws(() => h.controls.daily("10/21"), SupervisorInputError);
  });
});

// アーキ仕様 §4.5「番頭の作り」——専用の Fork 1本＋単一のきっかけの自動化4件。止める・再開する・消すは番頭の単位、判断役と並ばない、
// AI の tool からは作れない・触れない、毎回まっさらで方針と記録を添えて届ける
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventLog } from "../event-store/log.js";
import { ProjectThreadStore } from "../project-thread/store.js";
import { ThreadTurns } from "../delivery/thread-turns.js";
import { ThreadDeliveries } from "../delivery/thread-deliveries.js";
import { InboxStore } from "../inbox/store.js";
import { PendingApprovalRegistry } from "../inbox/pending-approvals.js";
import { AutomationInputError, AutomationStore } from "../automation/store.js";
import { AutomationRunner } from "../automation/runner.js";
import { AutomationTools } from "../automation/tools.js";
import { TURN_DECISIONS_EVENT } from "../automation/turn-decisions.js";
import type { RuntimeConfigValue } from "../config/runtime.js";
import { SUPERVISOR_KEYS, supervisorPolicy } from "./policy.js";
import { SUPERVISOR_FORK_TITLE, SupervisorConflictError, Supervisors, supervisorAutomationsOfThread } from "./supervisors.js";

interface Ctx {
  store: ProjectThreadStore;
  automations: AutomationStore;
  runner: AutomationRunner;
  supervisors: Supervisors;
  tools: AutomationTools;
  deliveries: ThreadDeliveries;
  projectId: string;
  baseId: string;
  /** 届いたもので起こしたターンに積んだ文（Thread の id と文） */
  delivered: Array<{ threadId: string; title: string; text: string }>;
  notices: Array<{ dedupeKey: string; title: string }>;
  /** 方針の値（instance の層・Project の層） */
  config: Map<string, RuntimeConfigValue>;
}

async function setup(fn: (ctx: Ctx) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "banto-supervisors-"));
  try {
    const log = new EventLog(dir);
    await log.init();
    const store = new ProjectThreadStore(dir, log);
    await store.load();
    const automations = new AutomationStore(dir, log);
    await automations.load();
    // この Project の Module は出来事を名乗らない（banto 自身の出来事だけ待てる）——番頭の Factory の自動化は名乗りと照らさない
    automations.setEventCatalog({ find: () => undefined, list: () => [] });
    const inbox = new InboxStore(dir, log);
    await inbox.load();
    const project = await store.createProject("demo", dir);
    const base = await store.createBaseThread(project.id);
    const turns = new ThreadTurns();
    const notices: Ctx["notices"] = [];
    const notify = async (n: { dedupeKey: string; title: string }) => void notices.push({ dedupeKey: n.dedupeKey, title: n.title });
    const deliveries = new ThreadDeliveries({ projectThread: store, turns, notify });
    const delivered: Ctx["delivered"] = [];
    deliveries.setTurnRunner(async (threadId, hop) => {
      const release = turns.tryAcquire(threadId, hop);
      if (!release) return false;
      const turnId = await store.startTurn(threadId, { cause: "delivery", attempt: 0 });
      for (const d of [...(store.getThread(threadId)!.deliveries ?? [])]) {
        delivered.push({ threadId, title: d.title ?? "", text: d.text });
        await store.appendMessage(threadId, "user", d.text, undefined, {
          from: d.from,
          title: d.title,
          hop: d.hop,
          deliveryId: d.deliveryId,
          ...(d.automation ? { automation: d.automation } : {}),
        });
      }
      await store.appendMessage(threadId, "assistant", "見ました");
      await store.endTurn(threadId, turnId, "completed");
      release();
      return true;
    });
    const config = new Map<string, RuntimeConfigValue>();
    const layer = { layerValue: (key: string, projectId?: string) => config.get(projectId ? `${projectId}:${key}` : key) };
    const policy = (projectId: string) => supervisorPolicy(layer, projectId);
    const runner = new AutomationRunner({
      projectThread: store,
      automations,
      turns,
      deliveries,
      listJudgmentsForThread: () => [],
      notify,
      supervisorPolicy: policy,
    });
    const supervisors = new Supervisors({ automations, runner, policy, defaultTimeZone: "Asia/Tokyo" });
    const tools = new AutomationTools({
      projectThread: store,
      automations,
      inbox,
      pendingApprovals: new PendingApprovalRegistry(),
    });
    await fn({ store, automations, runner, supervisors, tools, deliveries, projectId: project.id, baseId: base.id, delivered, notices, config });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const judgeFields = {
  name: "判断役",
  instruction: "決めて",
  source: { kind: "event", event: TURN_DECISIONS_EVENT, batchSeconds: 0 },
  target: { kind: "dedicated", mode: "fresh" },
};

test("番頭を置くと、自動化4件（決めること・Factory の2つ・時刻）が同じ専用の Fork に届く。Fork は番頭の印つきで1本だけ", async () => {
  await setup(async (ctx) => {
    ctx.config.set(SUPERVISOR_KEYS.patrolHours, 2);
    const s = await ctx.supervisors.create(ctx.projectId);
    assert.equal(s.automations.length, 4);
    assert.deepEqual(
      s.automations.map((a) => (a.source.kind === "event" ? a.source.event : a.source.kind === "time" ? a.source.repeat : undefined)),
      [TURN_DECISIONS_EVENT, "factory.item-stopped", "factory.run-finished", { kind: "interval", hours: 2 }],
    );
    for (const a of s.automations) {
      assert.equal(a.mode, "supervisor");
      assert.equal(a.supervisorId, s.id);
      assert.deepEqual(a.target, { kind: "dedicated", mode: "fresh", threadId: s.threadId });
      assert.equal(a.reviewOnDone, false);
    }
    // Factory の出来事は番頭自身の回が起こしたものでも受ける。決めることは受けない（番頭はまとめを出さない）
    assert.deepEqual(
      s.automations.map((a) => (a.source.kind === "event" ? a.source.allowSelfTriggered : undefined)),
      [false, true, true, undefined],
    );
    const fork = ctx.store.getThread(s.threadId!)!;
    assert.equal(fork.restriction, "supervisor");
    assert.equal(fork.title, SUPERVISOR_FORK_TITLE);
    assert.equal(fork.resumePoint, undefined, "Base の会話を引き継いでいる");
    assert.equal(ctx.store.listThreadsForProject(ctx.projectId).filter((t) => t.kind === "fork").length, 1, "Fork を2本以上立てた");
    // Fork から番頭の自動化を引ける（1つの Fork に4件）
    assert.equal(supervisorAutomationsOfThread(ctx.automations, fork).length, 4);
    assert.equal(ctx.supervisors.ofProject(ctx.projectId)?.id, s.id);
    assert.deepEqual(ctx.supervisors.list().map((x) => x.id), [s.id]);
    // Project に1つ
    await assert.rejects(() => ctx.supervisors.create(ctx.projectId), SupervisorConflictError);
  });
});

test("一時停止・再開・消すは番頭の単位で4件一緒。再開で見回りの間隔を今の方針に揃える", async () => {
  await setup(async (ctx) => {
    const s = await ctx.supervisors.create(ctx.projectId);
    const paused = await ctx.supervisors.pause(s.id);
    assert.equal(paused.paused, true);
    assert.ok(paused.automations.every((a) => a.paused), "一時停止していない自動化が残った");

    ctx.config.set(SUPERVISOR_KEYS.patrolHours, 6);
    const resumed = await ctx.supervisors.resume(s.id);
    assert.equal(resumed.paused, false);
    assert.ok(resumed.automations.every((a) => !a.paused));
    const clock = resumed.automations.find((a) => a.source.kind === "time")!;
    assert.deepEqual(clock.source, { kind: "time", repeat: { kind: "interval", hours: 6 }, timeZone: "Asia/Tokyo" });
    assert.equal(resumed.threadId, s.threadId, "開いている Fork があるのに立て直した");

    await ctx.supervisors.remove(s.id);
    assert.equal(ctx.automations.list(ctx.projectId).length, 0);
    assert.equal(ctx.supervisors.ofProject(ctx.projectId), undefined);
    // 専用の Fork とその会話は残す
    assert.equal(ctx.store.getThread(s.threadId!)?.status, "active");
  });
});

test("人が番頭の Fork を閉じたら4件とも一時停止し、知らせは1件。再開したら新しい Fork を1本立てて4件の届け先に揃える", async () => {
  await setup(async (ctx) => {
    const s = await ctx.supervisors.create(ctx.projectId);
    await ctx.store.closeThread(s.threadId!, { by: "human" });
    await ctx.runner.threadClosed(s.threadId!);
    const after = ctx.supervisors.get(s.id)!;
    assert.ok(after.automations.every((a) => a.paused));
    assert.equal(ctx.notices.length, 1);
    assert.equal(ctx.notices[0]!.title, "番頭を一時停止しました");

    const resumed = await ctx.supervisors.resume(s.id);
    assert.ok(resumed.threadId && resumed.threadId !== s.threadId);
    assert.ok(resumed.automations.every((a) => a.target.threadId === resumed.threadId), "4件の届け先がそろっていない");
    assert.equal(ctx.store.getThread(resumed.threadId)!.restriction, "supervisor");
  });
});

test("判断役が動いている Project には、断って理由を返す。pauseJudges なら判断役を止めてから置く。番頭がいる間は判断役を作れず・再開できない", async () => {
  await setup(async (ctx) => {
    const judge = await ctx.automations.create({ projectId: ctx.projectId, createdBy: { kind: "human" }, fields: judgeFields });
    await assert.rejects(() => ctx.supervisors.create(ctx.projectId), (err: Error) => {
      assert.ok(err instanceof SupervisorConflictError);
      assert.match(err.message, /判断役（自動化「判断役」）が動いています/);
      return true;
    });
    assert.equal(ctx.automations.list(ctx.projectId).length, 1, "断ったのに番頭の自動化を作った");
    assert.equal(ctx.automations.get(judge.id)!.paused, false, "断ったのに判断役を止めた");

    await ctx.supervisors.create(ctx.projectId, { pauseJudges: true });
    assert.equal(ctx.automations.get(judge.id)!.paused, true);
    await assert.rejects(() => ctx.automations.resume(judge.id), AutomationInputError);
    await assert.rejects(
      () => ctx.automations.create({ projectId: ctx.projectId, createdBy: { kind: "human" }, fields: { ...judgeFields, name: "判断役2" } }),
      /番頭がいるので/,
    );
    // ほかの出来事の自動化は作れる
    await ctx.automations.create({
      projectId: ctx.projectId,
      createdBy: { kind: "human" },
      fields: { name: "毎朝", instruction: "まとめて", source: { kind: "time", repeat: { kind: "daily", time: "9:00" }, timeZone: "Asia/Tokyo" } },
    });
  });
});

test("AI の tool・人の自動化の口からは番頭を作れない・直せない。AI の一覧に番頭の自動化は出ず、id で触れない", async () => {
  await setup(async (ctx) => {
    const s = await ctx.supervisors.create(ctx.projectId);
    await assert.rejects(
      () => ctx.automations.create({ projectId: ctx.projectId, createdBy: { kind: "ai", threadId: ctx.baseId }, fields: { ...judgeFields, mode: "supervisor" } }),
      /番頭（mode: supervisor）は自動化としては作れません/,
    );
    const created = await ctx.tools.create(ctx.baseId, { ...judgeFields, name: "x", mode: "supervisor" });
    assert.equal(created.ok, false);
    assert.match(created.text, /番頭/);
    const id = s.automations[0]!.id;
    await assert.rejects(() => ctx.automations.update(id, { name: "乗っ取り" }), /番頭の自動化は直せません/);

    assert.equal(ctx.tools.list(ctx.baseId).text, "この Project に自動化はありません。");
    for (const r of [await ctx.tools.pause(ctx.baseId, id), await ctx.tools.update(ctx.baseId, id, { name: "x" })]) {
      assert.equal(r.ok, false);
      assert.match(r.text, /ありません/);
    }
    assert.equal(ctx.automations.get(id)!.paused, false);
  });
});

test("番頭の回は毎回まっさらで、方針（任せる行い・人に回す種類・方針の文）と番頭の記録の直近を添えて届ける", async () => {
  await setup(async (ctx) => {
    ctx.config.set(SUPERVISOR_KEYS.note, "試験は全部流してから取り込む");
    ctx.config.set(`${ctx.projectId}:${SUPERVISOR_KEYS.delegate}`, JSON.stringify({ add: ["release"], remove: ["push"] }));
    const s = await ctx.supervisors.create(ctx.projectId);
    const decide = s.automations[0]!;
    await ctx.automations.recordSupervisorAct(decide.id, {
      at: "2026-10-21T01:00:00.000Z",
      kind: "deferred",
      threadId: "t-old",
      question: 1,
      decisionKind: "spec",
      reason: "仕様の向きなので人に",
    });
    // 前の回の会話が残っていても、まっさらにしてから届ける
    await ctx.store.appendMessage(s.threadId!, "user", "前の回の文");
    const clock = s.automations.find((a) => a.source.kind === "time")!;
    const started = await ctx.runner.run(ctx.automations.get(clock.id)!, "manual");
    assert.equal(started.result, "running", started.reason);
    // その回の結末が書かれるまで待つ（ターンの終わりの聞き手は非同期に書く）
    for (let i = 0; i < 400 && ctx.automations.get(clock.id)!.runs[0]?.result === "running"; i++) await new Promise((r) => setTimeout(r, 5));
    assert.equal(ctx.automations.get(clock.id)!.runs[0]?.result, "done");
    const d = ctx.delivered[0]!;
    assert.equal(d.threadId, s.threadId);
    assert.equal(d.title, "番頭：見回り");
    assert.match(d.text, /これは番頭の回です/);
    assert.match(d.text, /- release：release に反映する/);
    assert.doesNotMatch(d.text, /- push：/, "外した行いを任せると書いた");
    assert.match(d.text, /- spec：仕様・アーキテクチャの向き/);
    assert.match(d.text, /試験は全部流してから取り込む/);
    assert.match(d.text, /決まった時刻の見回りの回です/);
    assert.match(d.text, /人に回した：会話 t-old 問い 1（種類 spec）——仕様の向きなので人に/);
    const thread = ctx.store.getThread(s.threadId!)!;
    const old = thread.messages.find((m) => m.text === "前の回の文")!;
    assert.ok(thread.markers.some((m) => m.kind === "clear" && m.seq > old.seq), "届ける前に Clear していない（前の回を引き継いだ）");
  });
});

test("届ける文（#509）：見回りの回は ready を優先順に Factory へ流す手順、止まった件の回は自分が流した件だけ方針どおり答える手順。記録に Factory の行", async () => {
  await setup(async (ctx) => {
    const s = await ctx.supervisors.create(ctx.projectId);
    const [, stopped, , clock] = s.automations;
    await ctx.automations.recordSupervisorAct(clock!.id, { at: "2026-10-21T01:00:00.000Z", kind: "factory-started", threadId: s.threadId!, runId: "run-1", items: ["a", "b"], reason: "ready を流した" });
    await ctx.automations.recordSupervisorAct(stopped!.id, {
      at: "2026-10-21T02:00:00.000Z",
      kind: "factory-answered",
      threadId: s.threadId!,
      runId: "run-1",
      item: "a",
      stage: "テスト",
      action: "retry",
      reason: "落ちた試験を直させる",
    });
    const patrol = await ctx.runner.run(ctx.automations.get(clock!.id)!, "manual");
    assert.equal(patrol.result, "running", patrol.reason);
    for (let i = 0; i < 400 && ctx.delivered.length < 1; i++) await new Promise((r) => setTimeout(r, 5));
    const text = ctx.delivered[0]!.text;
    assert.match(text, /listItems（actionable: true）で今すぐ着手できる ready のタスク・バグを並び順（優先順）に見て/);
    assert.match(text, /runFactory で Factory に流して/);
    assert.match(text, /断られたらそれ以上は流さないでください/);
    assert.match(text, /answerFactory で答えます——continue・retry は fix-tests、accept は minor-design/);
    assert.match(text, /- 2026-10-21T02:00:00.000Z Factory に答えた：実行 run-1 の a（段 テスト）→ retry——落ちた試験を直させる/);
    assert.match(text, /- 2026-10-21T01:00:00.000Z Factory に流した：実行 run-1（a・b）——ready を流した/);
  });
});

test("Factory の止まった件の回の文：番頭が流した件だけ答え、drop・取りやめは人、流していない件は何もしない（台帳の古い文ではなく今の文）", async () => {
  await setup(async (ctx) => {
    const s = await ctx.supervisors.create(ctx.projectId);
    const stopped = s.automations[1]!;
    assert.equal(stopped.source.kind === "event" && stopped.source.event, "factory.item-stopped");
    assert.equal(stopped.source.kind === "event" && stopped.source.allowSelfTriggered, true, "自分の回が起こした Factory の出来事を受けない");
    assert.equal(s.automations[2]!.source.kind === "event" && s.automations[2]!.source.allowSelfTriggered, true);
    const { supervisorDeliveryText } = await import("./supervisors.js");
    const text = supervisorDeliveryText(
      // 前の版で作った台帳の文（「何もせずに終えて」）が残っていても、今の文を届ける
      { ...stopped, instruction: "いまの番頭は Factory に答える tool を持たないので、何もせずに終えてください。" },
      supervisorPolicy(undefined, ctx.projectId),
      [],
    );
    assert.doesNotMatch(text, /Factory に答える tool を持たない/);
    assert.match(text, /その runId が下の「番頭の記録」の「Factory に流した」にある（番頭が流した件）ときだけ、方針どおり answerFactory で答えて/);
    assert.match(text, /やめる（drop）・取りやめるは人が決めます/);
    assert.match(text, /番頭が流していない件は、何もせずに終えてください/);
  });
});

test("番頭の記録は1件の自動化につき 100 件だが、Factory に流した記録はそれを越えても残す（全体の上限の数えから漏らさない）", async () => {
  await setup(async (ctx) => {
    const s = await ctx.supervisors.create(ctx.projectId);
    const clock = s.automations[3]!;
    await ctx.automations.recordSupervisorAct(clock.id, { at: "2026-10-21T00:00:00.000Z", kind: "factory-started", threadId: s.threadId!, runId: "old-run", items: ["a"], reason: "流した" });
    for (let i = 0; i < 120; i++) {
      await ctx.automations.recordSupervisorAct(clock.id, { at: `2026-10-21T01:${String(Math.floor(i / 60)).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}.000Z`, kind: "refused", threadId: "t", reason: `断られた ${i}` });
    }
    const acts = ctx.automations.get(clock.id)!.supervisorActs!;
    assert.equal(acts.length, 101);
    assert.equal(acts.at(-1)!.runId, "old-run");
    assert.equal(acts.filter((a) => a.kind === "refused").length, 100);
  });
});

test("前の回が終わっていない番頭の Fork には、時刻の回は飛ばし、出来事は溜めたまま（記録しない）", async () => {
  await setup(async (ctx) => {
    const s = await ctx.supervisors.create(ctx.projectId);
    const [decide, , , clock] = s.automations;
    // 同じ Fork に前の回の届けもの（番頭の自動化の指示）がまだ積まれていない（#509 から、Factory の返事待ちは「終わっていない」に数えない——下の試験）
    await ctx.store.recordDelivery({
      threadId: s.threadId!,
      deliveryId: "d-prev",
      from: "banto",
      title: "番頭：決めること",
      text: "前の回",
      hop: 1,
      kind: "automation",
      automation: { id: decide!.id, runId: "run-prev" },
    });
    const skipped = await ctx.runner.run(ctx.automations.get(clock!.id)!, "clock");
    assert.equal(skipped.result, "skipped");
    assert.match(skipped.reason ?? "", /届けもの/);
    assert.equal(ctx.automations.get(clock!.id)!.runs[0]?.result, "skipped");
    const received = {
      kind: "event" as const,
      receivedId: "rcv-1",
      at: new Date().toISOString(),
      name: TURN_DECISIONS_EVENT,
      title: "決めることのあるターンが終わった",
      eventId: "e1",
      occurredAt: new Date().toISOString(),
      fields: {},
      hop: 1,
    };
    await ctx.automations.recordReceived(decide!.id, received);
    const deferred = await ctx.runner.run(ctx.automations.get(decide!.id)!, "event", {}, [received]);
    assert.equal(deferred.deferred, true);
    assert.equal(ctx.automations.get(decide!.id)!.runs.length, 0, "溜めた出来事の回を記録した");
    assert.equal(ctx.automations.get(decide!.id)!.received.length, 1, "溜めた出来事を捨てた");
    assert.equal(ctx.delivered.length, 0);
  });
});

test("番頭の Fork：Factory の返事待ちは前の回が終わっていないことにせず、Module の知らせだけでは起こさず（受信箱にも出さない）、次の回に一緒に積む", async () => {
  await setup(async (ctx) => {
    const s = await ctx.supervisors.create(ctx.projectId);
    const [, , , clock] = s.automations;
    // 前の回が runFactory で札を出した（返事待ち）
    await ctx.store.recordAwaitingReply({ threadId: s.threadId!, replyTo: "r1", connName: "factory-p", moduleName: "factory", hop: 1 });
    // Factory の「止まりました」が札で届く——それだけでは番頭の会話を起こさない
    const wake = await ctx.deliveries.deliver({ threadId: s.threadId!, from: "factory", title: "Factory：a が止まりました（テスト）", text: '{"runId":"run-1"}', hop: 2 });
    assert.equal(wake.wake, "held");
    assert.equal((wake as { quiet?: true }).quiet, true, "人の番ではないのに受信箱に出す扱いにした");
    assert.equal(ctx.delivered.length, 0, "Module の知らせだけで番頭の会話を起こした");
    assert.equal(ctx.notices.length, 0, "番頭の Fork に留めた知らせを受信箱に出した");
    // 次の番頭の回は飛ばさずに届き、留めていた知らせも同じターンに積む
    const run = await ctx.runner.run(ctx.automations.get(clock!.id)!, "clock");
    assert.equal(run.result, "running", run.reason);
    for (let i = 0; i < 400 && ctx.delivered.length < 2; i++) await new Promise((r) => setTimeout(r, 5));
    assert.deepEqual(
      ctx.delivered.map((d) => d.title),
      ["Factory：a が止まりました（テスト）", "番頭：見回り"],
    );
  });
});

test("番頭でない会話には、Module の知らせで今どおり起こし、返事待ちは前の回が終わっていないことのまま", async () => {
  await setup(async (ctx) => {
    const wake = await ctx.deliveries.deliver({ threadId: ctx.baseId, from: "factory", title: "Factory：a が止まりました", text: "{}", hop: 1 });
    assert.equal(wake.wake, "now");
    for (let i = 0; i < 400 && ctx.delivered.length < 1; i++) await new Promise((r) => setTimeout(r, 5));
    assert.deepEqual(ctx.delivered.map((d) => d.threadId), [ctx.baseId]);
    const { previousRunUnfinished } = await import("../automation/busy.js");
    await ctx.store.recordAwaitingReply({ threadId: ctx.baseId, replyTo: "r2", connName: "c", moduleName: "subagent", hop: 0 });
    assert.match(previousRunUnfinished(ctx.store.getThread(ctx.baseId), { isRunning: () => false, listJudgmentsForThread: () => [] }) ?? "", /返事/);
  });
});

test("今すぐ見回る：時刻の見回りを1回届ける（止まった会話を探して頼む手順つき）。一時停止していれば断る", async () => {
  await setup(async (ctx) => {
    const s = await ctx.supervisors.create(ctx.projectId);
    const clock = s.automations.find((a) => a.source.kind === "time")!;
    const started = await ctx.supervisors.patrolNow(s.id);
    assert.equal(started.result, "running", started.reason);
    for (let i = 0; i < 400 && ctx.automations.get(clock.id)!.runs[0]?.result === "running"; i++) await new Promise((r) => setTimeout(r, 5));
    assert.equal(ctx.automations.get(clock.id)!.runs[0]?.cause, "manual");
    const d = ctx.delivered[0]!;
    assert.equal(d.title, "番頭：見回り");
    assert.match(d.text, /list_stalled_threads でこの Project の止まっている会話を探し/);
    assert.match(d.text, /instruct_thread で決まった手順/);
    await ctx.supervisors.pause(s.id);
    await assert.rejects(() => ctx.supervisors.patrolNow(s.id), SupervisorConflictError);
  });
});

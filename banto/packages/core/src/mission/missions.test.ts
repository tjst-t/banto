// アーキ仕様 §4.4「任務」——始めるときのカード・枠の中の予約・起こし方・差し戻し・受信箱
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventLog } from "../event-store/log.js";
import { ProjectThreadStore } from "../project-thread/store.js";
import { InboxStore } from "../inbox/store.js";
import { PendingApprovalRegistry } from "../inbox/pending-approvals.js";
import { AutomationStore } from "../automation/store.js";
import { ThreadTurns } from "../delivery/thread-turns.js";
import { ThreadDeliveries, composeTurnPrompt } from "../delivery/thread-deliveries.js";
import type { ReviewItem } from "../inbox/types.js";
import { MISSION_CONTINUE_TEXT, Missions, planMissionReview, missionWakeOfLastTurn } from "./missions.js";

const MINUTE = 60_000;

interface Ctx {
  store: ProjectThreadStore;
  inbox: InboxStore;
  approvals: PendingApprovalRegistry;
  turns: ThreadTurns;
  missions: Missions;
  projectId: string;
  baseId: string;
  judgments: Array<{ id: string; message: string; choices: string[]; requestedSchema: unknown }>;
  /** 試験の今（実時間から進める——出来事の時刻は実時間なので、それより前には戻さない） */
  clock: { now: number };
}

async function setup(fn: (ctx: Ctx) => Promise<void>, opts: { floor?: number } = {}): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "banto-missions-"));
  try {
    const log = new EventLog(dir);
    await log.init();
    const store = new ProjectThreadStore(dir, log);
    await store.load();
    const inbox = new InboxStore(dir, log);
    await inbox.load();
    const automations = new AutomationStore(dir, log);
    await automations.load();
    automations.setEventCatalog({ find: () => undefined, list: () => [] });
    const project = await store.createProject("demo", dir);
    const base = await store.createBaseThread(project.id);
    const approvals = new PendingApprovalRegistry();
    const turns = new ThreadTurns();
    const clock = { now: Date.now() };
    // 起こす口は繋がない（届けたものは溜まったまま——ターンは試験が手で回す）
    const deliveries = new ThreadDeliveries({ projectThread: store, turns, notify: async () => {}, now: () => clock.now });
    const judgments: Ctx["judgments"] = [];
    const missions = new Missions({
      projectThread: store,
      inbox,
      pendingApprovals: approvals,
      publishJudgment: (_threadId, j) => judgments.push({ id: j.id, message: j.message, choices: j.choices, requestedSchema: j.requestedSchema }),
      deliveries,
      turns,
      events: automations,
      now: () => new Date(clock.now),
      ...(opts.floor !== undefined ? { minIntervalFloorMinutes: opts.floor } : {}),
      log: () => {},
    });
    await fn({ store, inbox, approvals, turns, missions, projectId: project.id, baseId: base.id, judgments, clock });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function nextJudgment(ctx: Ctx, count: number): Promise<Ctx["judgments"][number]> {
  for (let i = 0; i < 200 && ctx.judgments.length < count; i++) await new Promise((r) => setTimeout(r, 5));
  const j = ctx.judgments[count - 1];
  assert.ok(j, "確認のカードが出ていない");
  return j;
}

/** AI が start_mission を呼び、人が許す（`values` は欄の値） */
async function startByAi(ctx: Ctx, values?: Record<string, number>): Promise<void> {
  const pending = ctx.missions.start(ctx.baseId, { goal: "CI を通す", doneWhen: "main の CI が緑" });
  const j = await nextJudgment(ctx, ctx.judgments.length + 1);
  assert.ok(ctx.approvals.resolve(j.id, { behavior: "allow", ...(values ? { updatedInput: values } : {}) }));
  await ctx.inbox.answerJudgment(j.id, { behavior: "allow" });
  const r = await pending;
  assert.equal(r.ok, true, r.text);
}

/** 届けたものを積んでターンを1本回す（turn-runner の代わり）。`summary` があればまとめを残す */
async function runTurn(ctx: Ctx, opts: { summary?: Record<string, unknown>; during?: () => Promise<void> } = {}): Promise<void> {
  const release = ctx.turns.tryAcquire(ctx.baseId, 0)!;
  const thread = ctx.store.getThread(ctx.baseId)!;
  const turnId = await ctx.store.startTurn(ctx.baseId, { cause: "delivery", attempt: 0 });
  for (const d of thread.deliveries ?? []) {
    await ctx.store.appendMessage(ctx.baseId, "user", d.text, undefined, {
      from: d.from,
      title: d.title,
      hop: d.hop,
      deliveryId: d.deliveryId,
      ...(d.mission ? { mission: d.mission } : {}),
    });
  }
  await ctx.store.appendMessage(ctx.baseId, "assistant", "見ました");
  await opts.during?.();
  if (opts.summary) await ctx.store.recordTurnSummary(ctx.baseId, { summary: opts.summary, at: new Date().toISOString() });
  await ctx.store.endTurn(ctx.baseId, turnId, "completed");
  release();
  await ctx.missions.turnEnded(ctx.baseId);
}

const DECISIONS = {
  request: "CI を通す",
  outcome: { status: "partial", headline: "上限に届きました", points: [] },
  decisions: [
    {
      question: "枠を延ばしますか",
      options: [
        { label: "延ばす", reply: "延ばした" },
        { label: "やめる", reply: "やめて" },
      ],
    },
  ],
};

test("start_mission は欄つきのカードで人に聞き、許すと欄の値の枠で始まる。断ると始まらない", async () => {
  await setup(async (ctx) => {
    // 断る
    const denied = ctx.missions.start(ctx.baseId, { goal: "CI を通す", doneWhen: "main の CI が緑" });
    const j1 = await nextJudgment(ctx, 1);
    assert.equal(j1.message, "この任務を始めてよいですか");
    assert.deepEqual(j1.choices, ["始める", "始めない"]);
    const props = (j1.requestedSchema as { properties: Record<string, { default: number }> }).properties;
    assert.equal(props.maxWakes!.default, 20);
    assert.equal(props.minInterval!.default, 15);
    assert.equal(props.untilDays!.default, 3);
    // 受信箱にも form の判断待ちとして残る（受信箱から答えても同じ欄）
    const raised = ctx.inbox.get(j1.id);
    assert.equal(raised?.kind === "judgment" && raised.mode, "form");
    assert.equal(raised?.kind === "judgment" && raised.source, "mission");
    ctx.approvals.resolve(j1.id, { behavior: "deny", message: "始めない" });
    const r1 = await denied;
    assert.equal(r1.ok, false);
    assert.match(r1.text, /始めないと答えた/);
    assert.equal(ctx.store.getThread(ctx.baseId)!.mission, undefined);

    // 許す——欄で枠を変えた
    await startByAi(ctx, { maxWakes: 5, untilDays: 1, minInterval: 30 });
    const m = ctx.store.getThread(ctx.baseId)!.mission!;
    assert.equal(m.status, "active");
    assert.equal(m.startedBy, "ai");
    assert.equal(m.frame.maxWakes, 5);
    assert.equal(m.frame.minIntervalMinutes, 30);
    assert.ok(Math.abs(Date.parse(m.frame.until) - (ctx.clock.now + 24 * 60 * MINUTE)) < MINUTE);

    // 動いている任務がある会話では、もう始められない（聞きもしない）
    const again = await ctx.missions.start(ctx.baseId, { goal: "x", doneWhen: "y" });
    assert.equal(again.ok, false);
    assert.match(again.text, /動いている任務があります/);
    assert.equal(ctx.judgments.length, 2);
  });
});

test("枠の外の予約は断る（期限より後・最短の間隔より短い・回数を使い切った）。任務の無い会話では断る。枠の中は聞かずに通す", async () => {
  await setup(async (ctx) => {
    const none = await ctx.missions.scheduleFollowup(ctx.baseId, { after: 30, note: "CI を見る" });
    assert.equal(none.ok, false);
    assert.match(none.text, /先に start_mission で任務を始めてください/);

    await startByAi(ctx, { maxWakes: 1, untilDays: 1, minInterval: 15 });
    // 期限より後
    const late = await ctx.missions.scheduleFollowup(ctx.baseId, { after: 2 * 24 * 60, note: "x" });
    assert.equal(late.ok, false);
    assert.match(late.text, /枠の外/);
    assert.match(late.text, /decisions で人に聞いて/);
    // 出来事の待つ上限が期限より後
    const lateEvent = await ctx.missions.scheduleFollowup(ctx.baseId, {
      event: { name: "banto.turn-decisions", until: new Date(ctx.clock.now + 3 * 24 * 60 * MINUTE).toISOString() },
      note: "x",
    });
    assert.equal(lateEvent.ok, false);
    assert.match(lateEvent.text, /枠の外/);
    // 名乗られていない出来事は、待てる一覧つきで断る
    const unknown = await ctx.missions.scheduleFollowup(ctx.baseId, { event: { name: "nope.happened" }, note: "x" });
    assert.equal(unknown.ok, false);
    assert.match(unknown.text, /banto\.turn-decisions/);
    // 2つ渡すのは断る
    const both = await ctx.missions.scheduleFollowup(ctx.baseId, { after: 30, at: new Date().toISOString(), note: "x" });
    assert.equal(both.ok, false);
    assert.equal(ctx.store.getThread(ctx.baseId)!.mission!.followup, undefined, "断ったのに予約が残った");

    // 枠の中は通る（人には聞かない）
    const ok = await ctx.missions.scheduleFollowup(ctx.baseId, { after: 0, note: "CI を見る" });
    assert.equal(ok.ok, true, ok.text);
    assert.equal(ctx.judgments.length, 1, "予約で人に聞いた");
    assert.equal(ctx.store.getThread(ctx.baseId)!.mission!.followup!.note, "CI を見る");

    // 起こす（1回目）→ 最短の間隔より短い予約は断る
    await ctx.missions.tick();
    assert.equal(ctx.store.getThread(ctx.baseId)!.mission!.wakes, 1);
    // 回数を使い切った（上限 1）
    const exhausted = await ctx.missions.scheduleFollowup(ctx.baseId, { after: 60, note: "x" });
    assert.equal(exhausted.ok, false);
    assert.match(exhausted.text, /回数の上限（1 回）を使い切って/);
  });
});

test("最短の間隔より短い予約は断る（前に起きた時刻から）", async () => {
  await setup(async (ctx) => {
    await startByAi(ctx, { maxWakes: 5, untilDays: 1, minInterval: 30 });
    assert.equal((await ctx.missions.scheduleFollowup(ctx.baseId, { after: 0, note: "1回目" })).ok, true);
    await ctx.missions.tick();
    const m = ctx.store.getThread(ctx.baseId)!.mission!;
    assert.equal(m.wakes, 1);
    assert.ok(m.lastWakeAt);
    const short = await ctx.missions.scheduleFollowup(ctx.baseId, { after: 10, note: "x" });
    assert.equal(short.ok, false);
    assert.match(short.text, /最短の間隔（30 分）より短い/);
    const fine = await ctx.missions.scheduleFollowup(ctx.baseId, { after: 31, note: "x" });
    assert.equal(fine.ok, true, fine.text);
  });
});

test("予約を忘れた report_turn は断る。決めることがあれば受け付ける。予約・裏の仕事の返事待ちがあれば受け付ける。Stop hook も同じ", async () => {
  await setup(async (ctx) => {
    assert.equal(ctx.missions.reportTurnProblem(ctx.baseId, 0), undefined, "任務が無いのに断った");
    await startByAi(ctx);
    assert.equal(ctx.missions.reportTurnProblem(ctx.baseId, 0), MISSION_CONTINUE_TEXT);
    assert.equal(ctx.missions.stopReason(ctx.baseId), MISSION_CONTINUE_TEXT);
    assert.equal(ctx.missions.reportTurnProblem(ctx.baseId, 1), undefined, "決めることのあるまとめを断った");
    await ctx.store.recordAwaitingReply({ threadId: ctx.baseId, replyTo: "r1", connName: "c", moduleName: "subagent", hop: 0 });
    assert.equal(ctx.missions.reportTurnProblem(ctx.baseId, 0), undefined, "裏の仕事を待っているのに断った");
    await ctx.store.settleReply(ctx.baseId, "r1");
    assert.equal((await ctx.missions.scheduleFollowup(ctx.baseId, { after: 30, note: "x" })).ok, true);
    assert.equal(ctx.missions.reportTurnProblem(ctx.baseId, 0), undefined);
    assert.equal(ctx.missions.stopReason(ctx.baseId), undefined);
    // 終えたら断らない
    assert.equal((await ctx.missions.finish(ctx.baseId, { status: "done", result: "通った" })).ok, true);
    assert.equal(ctx.missions.reportTurnProblem(ctx.baseId, 0), undefined);
  });
});

test("時刻が来たら任務の届けもの（kind mission・ホップ 0・何回目）で起こし、判断待ち・答えていない決めることの間は起こさない", async () => {
  await setup(async (ctx) => {
    await startByAi(ctx, { maxWakes: 5, untilDays: 1, minInterval: 15 });
    assert.equal((await ctx.missions.scheduleFollowup(ctx.baseId, { after: 1, note: "CI を見る" })).ok, true);
    // 時刻の前は起こさない
    assert.deepEqual((await ctx.missions.tick()).woke, []);
    ctx.clock.now += 2 * MINUTE;

    // 生きた判断待ちがある間は起こさない（予約は残す）
    const j = await ctx.inbox.raiseJudgment({ threadId: ctx.baseId, source: "relay", message: "中継してよいですか" });
    assert.deepEqual((await ctx.missions.tick()).woke, []);
    assert.ok(ctx.store.getThread(ctx.baseId)!.mission!.followup, "起こさないのに予約を捨てた");
    await ctx.inbox.answerJudgment(j.id, { behavior: "allow" });

    // 起こす
    assert.deepEqual((await ctx.missions.tick()).woke, [ctx.baseId]);
    const thread = ctx.store.getThread(ctx.baseId)!;
    assert.equal(thread.mission!.wakes, 1);
    assert.equal(thread.mission!.followup, undefined, "起こしたのに予約が残った");
    assert.equal(thread.mission!.history[0]!.cause, "time");
    const delivered = thread.deliveries![0]!;
    assert.equal(delivered.kind, "mission");
    assert.equal(delivered.hop, 0);
    assert.deepEqual(delivered.mission, { id: thread.mission!.id, wake: 1 });
    assert.match(delivered.title, /任務「CI を通す」（1\/5 回目）/);
    assert.match(delivered.text, /目標：CI を通す/);
    assert.match(delivered.text, /終わりの条件：main の CI が緑/);
    assert.match(delivered.text, /前に予約したときのメモ：CI を見る/);
    assert.match(composeTurnPrompt([delivered], ""), /<banto-delivery kind="mission"/);

    // その回のターン：決めることで人に聞いて終わる（予約なし）——止まっていない（人に返っている）
    await runTurn(ctx, { summary: DECISIONS });
    let m = ctx.store.getThread(ctx.baseId)!.mission!;
    assert.equal(m.status, "active", "決めることで人に聞いたのに止めた");
    assert.equal(m.history[0]!.result, "decisions");
    // 任務の回の受信箱：決めることがあるので出す
    assert.equal(planMissionReview(ctx.store.getThread(ctx.baseId)!, false).kind, "plain");

    // 答えていない決めることの間は、予約があっても起こさない
    assert.equal((await ctx.missions.scheduleFollowup(ctx.baseId, { after: 20, note: "続き" })).ok, true);
    ctx.clock.now += 30 * MINUTE;
    assert.deepEqual((await ctx.missions.tick()).woke, [], "答えていない決めることがあるのに起こした");
    // 人が答えた（まとめより後の人の発言）→ 起こす
    await ctx.store.appendMessage(ctx.baseId, "user", "延ばした");
    assert.deepEqual((await ctx.missions.tick()).woke, [ctx.baseId]);
    m = ctx.store.getThread(ctx.baseId)!.mission!;
    assert.equal(m.wakes, 2);
  });
});

test("任務の回が何も無く終わったら受信箱に出さない。予約も終わりも無ければ止まっています、回数を使い切っていれば枠を使い切りました", async () => {
  await setup(async (ctx) => {
    await startByAi(ctx, { maxWakes: 2, untilDays: 1, minInterval: 15 });
    assert.equal((await ctx.missions.scheduleFollowup(ctx.baseId, { after: 0, note: "1" })).ok, true);
    await ctx.missions.tick();
    // 1回目：中で次を予約して終わる——出さない
    await runTurn(ctx, { during: async () => void (await ctx.missions.scheduleFollowup(ctx.baseId, { after: 20, note: "2" })) });
    const after1 = ctx.store.getThread(ctx.baseId)!;
    assert.deepEqual(missionWakeOfLastTurn(after1), { id: after1.mission!.id, wake: 1 });
    assert.equal(after1.mission!.history[0]!.result, "done");
    assert.equal(planMissionReview(after1, false).kind, "skip");
    assert.equal(after1.mission!.status, "active");

    // 2回目：予約も終わりも無く終わる（回数を使い切った）→ 枠を使い切りました。受信箱に結末を添えて出す
    ctx.clock.now += 21 * MINUTE;
    await ctx.missions.tick();
    await runTurn(ctx);
    const after2 = ctx.store.getThread(ctx.baseId)!;
    assert.equal(after2.mission!.status, "exhausted");
    const plan = planMissionReview(after2, false);
    assert.equal(plan.kind, "mission");
    assert.equal(plan.kind === "mission" && plan.mission.status, "exhausted");
    assert.equal(plan.kind === "mission" && plan.mission.wakes, 2);
  });

  await setup(async (ctx) => {
    await startByAi(ctx, { maxWakes: 5, untilDays: 1, minInterval: 15 });
    assert.equal((await ctx.missions.scheduleFollowup(ctx.baseId, { after: 0, note: "1" })).ok, true);
    await ctx.missions.tick();
    await runTurn(ctx);
    const t = ctx.store.getThread(ctx.baseId)!;
    assert.equal(t.mission!.status, "stalled");
    assert.equal(planMissionReview(t, false).kind, "mission");
  });
});

test("時計の刻みで期限を過ぎたら、ターンの外から受信箱にレビュー待ちを出す（未確認があればそれに結末を添える）", async () => {
  await setup(async (ctx) => {
    await startByAi(ctx, { maxWakes: 5, untilDays: 0.5, minInterval: 15 });
    assert.equal((await ctx.missions.scheduleFollowup(ctx.baseId, { event: { name: "banto.turn-decisions" }, note: "判断を待つ" })).ok, true);
    ctx.clock.now += 13 * 60 * MINUTE;
    const report = await ctx.missions.tick();
    assert.deepEqual(report.expired, [ctx.baseId]);
    const m = ctx.store.getThread(ctx.baseId)!.mission!;
    assert.equal(m.status, "exhausted");
    assert.equal(m.result, "期限を過ぎました");
    assert.equal(m.followup, undefined);
    const reviews = ctx.inbox.listOpen().filter((i): i is ReviewItem => i.kind === "review" && i.threadId === ctx.baseId);
    assert.equal(reviews.length, 1);
    assert.equal(reviews[0]!.mission?.status, "exhausted");
    assert.match(reviews[0]!.summary, /枠を使い切りました：任務「CI を通す」/);
  });

  await setup(async (ctx) => {
    const open = await ctx.inbox.raiseReview({ threadId: ctx.baseId, summary: "前のターン" });
    await startByAi(ctx, { maxWakes: 5, untilDays: 0.5, minInterval: 15 });
    ctx.clock.now += 13 * 60 * MINUTE;
    await ctx.missions.tick();
    const reviews = ctx.inbox.listOpen().filter((i): i is ReviewItem => i.kind === "review" && i.threadId === ctx.baseId);
    assert.deepEqual(reviews.map((r) => r.id), [open.id], "未確認のカードを更新せずに増やした");
    assert.equal(reviews[0]!.mission?.status, "exhausted");
  });
});

test("待っていた出来事が来たら、来たものを添えて起こす。最短の間隔より早ければ間隔が空くまで待つ。来なければ上限で起こす", async () => {
  await setup(async (ctx) => {
    await startByAi(ctx, { maxWakes: 5, untilDays: 1, minInterval: 15 });
    assert.equal((await ctx.missions.scheduleFollowup(ctx.baseId, { after: 0, note: "1" })).ok, true);
    await ctx.missions.tick();
    await runTurn(ctx, {
      during: async () =>
        void (await ctx.missions.scheduleFollowup(ctx.baseId, {
          event: { name: "banto.turn-decisions", where: { thread: "t-1" } },
          note: "判断が出たら読む",
        })),
    });
    assert.deepEqual(ctx.missions.awaitedEvents(ctx.projectId).map((w) => w.event), ["banto.turn-decisions"]);
    const declared = { name: "banto.turn-decisions", title: "決めることのあるターンが終わった", description: "", fields: {} };
    const fields = { thread: "t-1", turnId: "x", threadTitle: "Fork", count: 1, hop: 0, readExternal: false };
    // 条件に合わない出来事では置き直さない
    assert.equal(await ctx.missions.receiveEvent(ctx.projectId, declared, { eventId: "e0", occurredAt: new Date().toISOString(), fields: { ...fields, thread: "t-2" } }), 0);
    // 合う出来事——前に起きてから 15 分経っていないので、間隔が空くまで待つ
    assert.equal(await ctx.missions.receiveEvent(ctx.projectId, declared, { eventId: "e1", occurredAt: new Date().toISOString(), fields, text: "{\"decisions\":[]}" }), 1);
    const f = ctx.store.getThread(ctx.baseId)!.mission!.followup!;
    assert.ok(f.received);
    const lastWake = Date.parse(ctx.store.getThread(ctx.baseId)!.mission!.lastWakeAt!);
    assert.equal(Date.parse(f.at!), lastWake + 15 * MINUTE);
    assert.deepEqual((await ctx.missions.tick()).woke, [], "最短の間隔より早く起こした");
    ctx.clock.now = lastWake + 16 * MINUTE;
    assert.deepEqual((await ctx.missions.tick()).woke, [ctx.baseId]);
    const t = ctx.store.getThread(ctx.baseId)!;
    assert.equal(t.mission!.history[0]!.cause, "event");
    const d = t.deliveries!.at(-1)!;
    assert.equal(d.external?.[0]?.event?.name, "banto.turn-decisions");
    assert.match(d.text, /待っていた出来事：banto\.turn-decisions/);

    // 来なければ上限で「来ませんでした」
    await runTurn(ctx, {
      during: async () =>
        void (await ctx.missions.scheduleFollowup(ctx.baseId, {
          event: { name: "banto.turn-decisions", until: new Date(ctx.clock.now + 60 * MINUTE).toISOString() },
          note: "来なければ諦める",
        })),
    });
    ctx.clock.now += 61 * MINUTE;
    assert.deepEqual((await ctx.missions.tick()).woke, [ctx.baseId]);
    assert.equal(ctx.store.getThread(ctx.baseId)!.mission!.history[0]!.cause, "event-timeout");
    assert.match(ctx.store.getThread(ctx.baseId)!.deliveries!.at(-1)!.text, /待つ上限までに来ませんでした/);
  });
});

test("人が始める・枠を延ばす（使い切った任務は動いている任務に戻る）・今すぐ起こす（間隔に縛られない）・止める・会話を閉じると止まる", async () => {
  await setup(async (ctx) => {
    const m = await ctx.missions.startByHuman(ctx.baseId, { goal: "見回りの続き", doneWhen: "片づいた", maxWakes: 1 });
    assert.equal(m.startedBy, "human");
    assert.equal(ctx.judgments.length, 0, "人が始めたのに聞いた");
    await ctx.missions.wakeNow(ctx.baseId);
    assert.equal(ctx.store.getThread(ctx.baseId)!.mission!.wakes, 1);
    await runTurn(ctx);
    assert.equal(ctx.store.getThread(ctx.baseId)!.mission!.status, "exhausted");
    // 延ばす→動いている任務に戻る
    const extended = await ctx.missions.patch(ctx.baseId, { maxWakes: 3 });
    assert.equal(extended.status, "active");
    assert.equal(extended.frame.maxWakes, 3);
    assert.equal(extended.result, undefined);
    // 今すぐ起こすは最短の間隔に縛られない（直前に起きていても）
    await ctx.missions.wakeNow(ctx.baseId);
    assert.equal(ctx.store.getThread(ctx.baseId)!.mission!.wakes, 2);
    // 走っている間・届けものが残っている間は起こせない
    await assert.rejects(() => ctx.missions.wakeNow(ctx.baseId), /いまは起こせません/);
    await runTurn(ctx, { during: async () => void (await ctx.missions.scheduleFollowup(ctx.baseId, { after: 30, note: "x" })) });
    // 止める——予約は捨てる、受信箱には出さない
    const stopped = await ctx.missions.patch(ctx.baseId, { stop: true });
    assert.equal(stopped.status, "stopped");
    assert.equal(stopped.followup, undefined);
    // 新しく始めて、会話を閉じると止まる
    await ctx.missions.startByHuman(ctx.baseId, { goal: "2つ目", doneWhen: "x" });
    await ctx.store.closeThread(ctx.baseId, { by: "human" });
    assert.equal(ctx.store.getThread(ctx.baseId)!.mission!.status, "stopped");
  });
});

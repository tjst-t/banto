// アーキ仕様 §4.3「判断役の一般化」の 2.——`instruct_thread`・`list_stalled_threads` は `canAdvanceProject` を持つ自動化の専用の Fork で
// だけ使える（判断役かどうか・きっかけの種類とは独立）。任された行いは `delegateKinds` があればその和、無ければ Project の方針。
// 欄の無い自動化の Fork・番頭の Fork では、この実装は何もしない
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventLog } from "../event-store/log.js";
import { ProjectThreadStore } from "../project-thread/store.js";
import { InboxStore } from "../inbox/store.js";
import type { DeliverInput } from "../delivery/thread-deliveries.js";
import { supervisorPolicy } from "../supervisor/policy.js";
import { AutomationStore } from "./store.js";
import { TURN_DECISIONS_EVENT } from "./turn-decisions.js";
import { ADVANCE_INSTRUCT_LIMITS, ProjectAdvance, advanceActsOf, type AdvancePolicy, type AdvanceStalledThread } from "./advance.js";

interface Harness {
  projectThread: ProjectThreadStore;
  automations: AutomationStore;
  inbox: InboxStore;
  advance: ProjectAdvance;
  delivered: DeliverInput[];
  limits: AdvancePolicy["limits"];
  projectId: string;
  baseId: string;
  /** canAdvanceProject を持つ時刻の自動化の専用の Fork */
  advanceForkId: string;
  advanceId: string;
  /** 欄の無い自動化の専用の Fork */
  plainForkId: string;
  plainId: string;
}

async function withHarness(fn: (h: Harness) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "banto-advance-test-"));
  try {
    const log = new EventLog(dir);
    await log.init();
    const projectThread = new ProjectThreadStore(dir, log);
    await projectThread.load();
    const automations = new AutomationStore(dir, log);
    await automations.load();
    const inbox = new InboxStore(dir, log);
    await inbox.load();
    const project = await projectThread.createProject("P", dir);
    const base = await projectThread.createBaseThread(project.id);
    const timed = { kind: "time", repeat: { kind: "interval", hours: 3 }, timeZone: "Asia/Tokyo" };
    const advanceFork = await projectThread.forkThread(base.id, { title: "進める", fresh: true });
    const advanceAuto = await automations.create({
      projectId: project.id,
      createdBy: { kind: "human" },
      fields: { name: "見回って進める", instruction: "止まった会話を進めて", source: timed, canAdvanceProject: true },
    });
    await automations.setDedicatedThread(advanceAuto.id, advanceFork.id);
    const plainFork = await projectThread.forkThread(base.id, { title: "ふつう", fresh: true });
    const plain = await automations.create({
      projectId: project.id,
      createdBy: { kind: "human" },
      fields: { name: "ふつう", instruction: "まとめて", source: timed },
    });
    await automations.setDedicatedThread(plain.id, plainFork.id);

    const delivered: DeliverInput[] = [];
    const limits = { ...supervisorPolicy(undefined, project.id).limits };
    const advance = new ProjectAdvance({
      projectThread,
      automations,
      deliveries: {
        deliver: async (input) => {
          delivered.push(input);
          const deliveryId = `d${delivered.length}`;
          const { replaces: _r, ...record } = input;
          await projectThread.recordDelivery({ ...record, deliveryId });
          return { deliveryId, wake: "now" };
        },
      },
      turns: { isRunning: () => false, queued: () => 0 },
      inbox,
      policy: (id) => ({ ...supervisorPolicy(undefined, id), limits }),
      defaultTimeZone: "Asia/Tokyo",
      log: () => {},
    });
    const h: Harness = {
      projectThread,
      automations,
      inbox,
      advance,
      delivered,
      limits,
      projectId: project.id,
      baseId: base.id,
      advanceForkId: advanceFork.id,
      advanceId: advanceAuto.id,
      plainForkId: plainFork.id,
      plainId: plain.id,
    };
    await automationRound(h, h.advanceForkId, h.advanceId);
    await automationRound(h, h.plainForkId, h.plainId);
    await fn(h);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** 自動化の回のターンを始める（自動化が届けたものを積んだところ） */
async function automationRound(h: Harness, forkId: string, automationId: string): Promise<void> {
  await h.projectThread.startTurn(forkId, { cause: "delivery", attempt: 0 });
  await h.projectThread.appendMessage(forkId, "user", "自動化の回", undefined, {
    from: "banto",
    title: "自動化",
    hop: 0,
    deliveryId: `round-${Math.random()}`,
    automation: { id: automationId, runId: "run-1" },
  });
}

async function failedTurn(h: Harness, threadId: string): Promise<string> {
  const turnId = await h.projectThread.startTurn(threadId, { cause: "human", attempt: 0 });
  await h.projectThread.appendMessage(threadId, "user", "試験を通して");
  await h.projectThread.endTurn(threadId, turnId, "failed");
  return turnId;
}

const instruct = (h: Harness, input: Partial<{ threadId: string; action: string; note: string; reason: string }> = {}, from = h.advanceForkId) =>
  h.advance.instruct(from, { threadId: h.baseId, action: "retry-turn", reason: "失敗したのでやり直す", ...input });

test("見せる会話：canAdvanceProject を持つ自動化の専用の Fork だけ。欄の無い自動化の Fork・ふつうの会話では使えない", async () => {
  await withHarness(async (h) => {
    assert.equal(h.advance.availableIn(h.advanceForkId), true);
    assert.equal(h.advance.availableIn(h.plainForkId), false);
    assert.equal(h.advance.availableIn(h.baseId), false);
    await failedTurn(h, h.baseId);
    const r = await instruct(h, {}, h.plainForkId);
    assert.equal(r.ok, false);
    assert.match(r.text, /canAdvanceProject/);
    assert.equal(h.advance.listStalled(h.plainForkId).ok, false);
    assert.equal(h.delivered.length, 0);
    // 欄の無い自動化の台帳は変わらない（記録を持たない）
    assert.equal(h.automations.get(h.plainId)!.advanceActs, undefined);
  });
});

test("失敗したターンで止まった会話に retry-turn を頼む——文は host が組み、書き手 supervisor・ホップ＋2・記録・カードに「自動化が頼んだ」", async () => {
  await withHarness(async (h) => {
    await failedTurn(h, h.baseId);
    await h.inbox.raiseReview({ threadId: h.baseId, summary: "失敗しました" });
    const listed = JSON.parse(h.advance.listStalled(h.advanceForkId).text) as AdvanceStalledThread[];
    assert.deepEqual(listed.map((s) => [s.threadId, s.reason]), [[h.baseId, "failed-turn"]], "専用の Fork は出ない");
    const r = await instruct(h, { note: "依存の取得で落ちた" });
    assert.equal(r.ok, true, r.text);
    const d = h.delivered[0]!;
    assert.equal(d.kind, "supervisor");
    assert.equal(d.hop, 2);
    assert.match(d.title, /自動化「見回って進める」の指示：失敗した・途中で切れたターンをやり直す/);
    assert.doesNotMatch(d.text, /依存の取得/, "note を指示の文に混ぜた");
    assert.equal(d.supervisor?.automationId, h.advanceId);
    assert.equal(d.supervisor?.runId, "run-1");
    assert.equal(d.supervisor?.note, "依存の取得で落ちた");
    const acts = advanceActsOf(h.automations, h.projectId);
    assert.equal(acts[0]?.kind, "instructed");
    assert.equal(acts[0]?.action, "retry-turn");
    assert.equal(acts[0]?.stalledReason, "failed-turn");
    const card = h.inbox.listOpen().find((i) => i.kind === "review" && i.threadId === h.baseId);
    assert.equal(card?.kind === "review" ? card.judge?.kind : undefined, "instructed");
    assert.equal(card?.kind === "review" ? card.judge?.by : "x", undefined, "番頭の印は付けない");
    // 指示で起きたターンの決め（カードの carriedJudge）を引ける
    await h.projectThread.startTurn(h.baseId, { cause: "delivery", attempt: 0 });
    await h.projectThread.appendMessage(h.baseId, "user", d.text, undefined, { ...d, deliveryId: "d1" });
    assert.equal(h.advance.judgeOfLastTurn(h.baseId)?.instruction?.action, "retry-turn");
  });
});

test("任された行い：delegateKinds が無ければ Project の方針（release は既定で任されない）、あれば一覧だけ。人に回す種類・minor-design は頼めない", async () => {
  await withHarness(async (h) => {
    await failedTurn(h, h.baseId);
    assert.match((await instruct(h, { action: "release" })).text, /任されていません/);
    assert.match((await instruct(h, { action: "spec" })).text, /人が決めます/);
    assert.match((await instruct(h, { action: "minor-design" })).text, /頼む行いではありません/);
    // 判断役に delegateKinds と canAdvanceProject を持たせると、その Fork で任されるのは一覧だけ
    const judgeFork = await h.projectThread.forkThread(h.baseId, { title: "判断役", fresh: true });
    const judge = await h.automations.create({
      projectId: h.projectId,
      createdBy: { kind: "human" },
      fields: {
        name: "判断役",
        instruction: "決めて",
        source: { kind: "event", event: TURN_DECISIONS_EVENT },
        delegateKinds: ["continue"],
        canAdvanceProject: true,
      },
    });
    await h.automations.setDedicatedThread(judge.id, judgeFork.id);
    await automationRound(h, judgeFork.id, judge.id);
    const refused = await instruct(h, { action: "retry-turn" }, judgeFork.id);
    assert.match(refused.text, /この自動化には「失敗した・途中で切れたターンをやり直す」を任されていません/);
    assert.equal(h.delivered.length, 0);
    // 断ったことは、その回を届けた自動化の記録に残る
    assert.equal(h.automations.get(judge.id)!.advanceActs?.[0]?.kind, "refused");
  });
});

test("回数：同じ止まった理由には 2 回まで。全体の上限は全部の進める自動化の合計で数える", async () => {
  await withHarness(async (h) => {
    await failedTurn(h, h.baseId);
    for (let i = 0; i < ADVANCE_INSTRUCT_LIMITS.sameReason; i++) assert.equal((await instruct(h)).ok, true);
    const third = await instruct(h);
    assert.match(third.text, /同じ止まった理由（failed-turn）には、もう 2 回/);
    // 全体の上限を今の数（2）にすると、別の会話にも頼めない
    h.limits.instructionsPerHour = 2;
    const other = await h.projectThread.forkThread(h.baseId, { title: "別の会話", fresh: true });
    await failedTurn(h, other.id);
    const overall = await instruct(h, { threadId: other.id });
    assert.match(overall.text, /全部の進める自動化で1時間に送れる指示は 2 件まで/);
  });
});

test("始まる前に人が発言したら、進める自動化の指示を捨てて記録に残す。番頭の指示には触らない", async () => {
  await withHarness(async (h) => {
    await failedTurn(h, h.baseId);
    assert.equal((await instruct(h)).ok, true);
    const queued = [...(h.projectThread.getThread(h.baseId)!.deliveries ?? [])];
    assert.equal(queued.length, 1);
    const kept = await h.advance.screen(h.baseId, queued, true);
    assert.equal(kept.length, 0);
    assert.equal(h.projectThread.getThread(h.baseId)!.deliveries?.length ?? 0, 0);
    const dropped = advanceActsOf(h.automations, h.projectId).find((a) => a.kind === "dropped");
    assert.match(dropped?.reason ?? "", /人が発言しました/);
    // 番頭の指示（番頭の自動化のもの）はここでは見ない
    const supervisorLike = { ...queued[0]!, deliveryId: "s1", supervisor: { ...queued[0]!.supervisor!, automationId: "auto-unknown-supervisor" } };
    const supervisorAuto = { get: () => ({ mode: "supervisor" }) };
    const onlySupervisor = new ProjectAdvance({
      projectThread: h.projectThread,
      automations: { ...h.automations, get: supervisorAuto.get } as never,
      deliveries: { deliver: async () => ({ deliveryId: "x", wake: "now" }) },
      turns: { isRunning: () => false, queued: () => 0 },
      inbox: h.inbox,
      policy: (id) => supervisorPolicy(undefined, id),
    });
    assert.equal((await onlySupervisor.screen(h.baseId, [supervisorLike], true)).length, 1);
  });
});

test("番頭の会話・読むだけの会話では使えない（印のある会話は番頭の実装・見回りが受ける）", async () => {
  await withHarness(async (h) => {
    const fork = await h.projectThread.forkThread(h.baseId, { title: "番頭", fresh: true, restriction: "supervisor" });
    const a = await h.automations.create({
      projectId: h.projectId,
      createdBy: { kind: "human" },
      fields: { name: "x", instruction: "x", source: { kind: "time", repeat: { kind: "interval", hours: 3 }, timeZone: "UTC" }, canAdvanceProject: true },
    });
    await h.automations.setDedicatedThread(a.id, fork.id);
    assert.equal(h.advance.availableIn(fork.id), false);
  });
});

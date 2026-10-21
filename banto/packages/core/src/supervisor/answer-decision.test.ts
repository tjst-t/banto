// アーキ仕様 §4.5「問いの種類」——番頭の `answer_decision` は、元の会話のまとめの問いの種類（kind）で絞る。種類が無い・人に回す種類・
// 任せていない行い・外から来たものを読んだターンの問いは選べない（defer はいつもできる）。したことは番頭の記録に残る。
// この断りは番頭だけに効く——判断役（ふつうの自動化）は今どおり
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventLog } from "../event-store/log.js";
import { ProjectThreadStore } from "../project-thread/store.js";
import type { PendingDelivery } from "../project-thread/types.js";
import { InboxStore } from "../inbox/store.js";
import type { DeliverInput } from "../delivery/thread-deliveries.js";
import { AutomationStore } from "../automation/store.js";
import { TURN_DECISIONS_EVENT, TurnDecisions } from "../automation/turn-decisions.js";
import type { RuntimeConfigValue } from "../config/runtime.js";
import { SUPERVISOR_KEYS, supervisorPolicy } from "./policy.js";
import { Supervisors, supervisorActsOf } from "./supervisors.js";

interface Harness {
  projectThread: ProjectThreadStore;
  automations: AutomationStore;
  decisions: TurnDecisions;
  delivered: DeliverInput[];
  config: Map<string, RuntimeConfigValue>;
  projectId: string;
  baseId: string;
  /** 番頭の Fork・決めることを待つ番頭の自動化 */
  supervisorThreadId: string;
  supervisorAutomationId: string;
  supervisorId: string;
  /** 同じ形のふつうの判断役（別の Project） */
  judge: { projectId: string; baseId: string; threadId: string; automationId: string };
}

async function withHarness(fn: (h: Harness) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "banto-supervisor-answer-"));
  try {
    const log = new EventLog(dir);
    await log.init();
    const projectThread = new ProjectThreadStore(dir, log);
    await projectThread.load();
    const automations = new AutomationStore(dir, log);
    await automations.load();
    const inbox = new InboxStore(dir, log);
    await inbox.load();
    const config = new Map<string, RuntimeConfigValue>();
    const layer = { layerValue: (key: string, projectId?: string) => config.get(projectId ? `${projectId}:${key}` : key) };

    const project = await projectThread.createProject("P", dir);
    const base = await projectThread.createBaseThread(project.id);
    const supervisorFork = await projectThread.forkThread(base.id, { title: "番頭", fresh: true, restriction: "supervisor" });
    // 届け先を立てる口（runner）は使わず、Fork を手で入れる
    const supervisors = new Supervisors({ automations, policy: (id) => supervisorPolicy(layer, id), defaultTimeZone: "Asia/Tokyo" });
    const s = await supervisors.create(project.id);
    for (const a of s.automations) await automations.setDedicatedThread(a.id, supervisorFork.id);
    const decideId = s.automations.find((a) => a.source.kind === "event" && a.source.event === TURN_DECISIONS_EVENT)!.id;

    const other = await projectThread.createProject("Q", dir);
    const otherBase = await projectThread.createBaseThread(other.id);
    const judgeFork = await projectThread.forkThread(otherBase.id, { title: "判断役", fresh: true });
    const judge = await automations.create({
      projectId: other.id,
      createdBy: { kind: "human" },
      fields: { name: "判断役", instruction: "決めて", source: { kind: "event", event: TURN_DECISIONS_EVENT, batchSeconds: 0 }, target: { kind: "dedicated", mode: "fresh" } },
    });
    await automations.setDedicatedThread(judge.id, judgeFork.id);

    const delivered: DeliverInput[] = [];
    const decisions = new TurnDecisions({
      projectThread,
      automations,
      events: { emitFromCore: async () => 1 },
      deliveries: {
        deliver: async (input) => {
          delivered.push(input);
          return { deliveryId: `d${delivered.length}`, wake: "now" };
        },
      },
      turns: { isRunning: () => false, queued: () => 0 },
      inbox,
      turnSummaryEnabled: () => true,
      supervisorPolicy: (id) => supervisorPolicy(layer, id),
      recordSupervisorAct: (id, act) => automations.recordSupervisorAct(id, act),
      log: () => {},
    });
    await fn({
      projectThread,
      automations,
      decisions,
      delivered,
      config,
      projectId: project.id,
      baseId: base.id,
      supervisorThreadId: supervisorFork.id,
      supervisorAutomationId: decideId,
      supervisorId: s.id,
      judge: { projectId: other.id, baseId: otherBase.id, threadId: judgeFork.id, automationId: judge.id },
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** 問い1つ（種類は渡したもの）のまとめで終わったターン。ターンの id を返す */
async function decidedTurn(h: Harness, threadId: string, kind: string | undefined): Promise<string> {
  const turnId = await h.projectThread.startTurn(threadId, { cause: "human", attempt: 0 });
  await h.projectThread.appendMessage(threadId, "user", "進めて");
  await h.projectThread.appendMessage(threadId, "assistant", "止まりました");
  await h.projectThread.recordTurnSummary(threadId, {
    summary: {
      request: "進めて",
      outcome: { status: "partial", headline: "試験が1つ落ちた", points: [] },
      decisions: [
        {
          question: "どうしますか",
          ...(kind ? { kind } : {}),
          options: [
            { label: "流し直す", reply: "流し直して", recommended: true },
            { label: "待つ", reply: "待って" },
          ],
        },
      ],
    },
    at: new Date().toISOString(),
  });
  await h.projectThread.endTurn(threadId, turnId, "completed");
  return turnId;
}

/** 決めることを待つ自動化が届けた出来事 */
function delivery(automationId: string, thread: string, turnId: string, readExternal = false): PendingDelivery {
  return {
    from: "banto",
    title: "番頭：決めること",
    hop: 1,
    deliveryId: "dj",
    text: "決めて",
    receivedAt: new Date().toISOString(),
    kind: "automation",
    automation: { id: automationId, runId: "r1" },
    external: [
      {
        source: "event",
        receivedAt: new Date().toISOString(),
        body: "",
        event: {
          name: TURN_DECISIONS_EVENT,
          title: "決めることのあるターンが終わった",
          eventId: `${thread}:${turnId}`,
          occurredAt: new Date().toISOString(),
          fields: { thread, turnId, threadTitle: "Base Thread", count: 1, hop: 0, readExternal },
        },
      },
    ],
  };
}

async function supervisorAnswers(h: Harness, kind: string | undefined, readExternal = false) {
  const turnId = await decidedTurn(h, h.baseId, kind);
  h.decisions.beginTurn(h.supervisorThreadId, [delivery(h.supervisorAutomationId, h.baseId, turnId, readExternal)]);
  const choice = await h.decisions.answer(h.supervisorThreadId, { thread: h.baseId, turnId, question: 1, choice: 1, reason: "手順なので" });
  return { turnId, choice };
}

test("番頭は任されている種類（rerun-tests）の問いに答えられ、元の会話に届き、記録に「選んだ」が残る", async () => {
  await withHarness(async (h) => {
    const { turnId, choice } = await supervisorAnswers(h, "rerun-tests");
    assert.equal(choice.ok, true, choice.text);
    assert.equal(h.delivered.length, 1);
    assert.equal(h.delivered[0]!.threadId, h.baseId);
    assert.match(h.delivered[0]!.title, /番頭が選んだ答え/);
    assert.match(h.delivered[0]!.text, /流し直して/);
    const acts = supervisorActsOf(h.automations, h.supervisorId);
    assert.equal(acts.length, 1);
    assert.deepEqual(
      { ...acts[0], at: undefined },
      { at: undefined, kind: "answered", threadId: h.baseId, turnId, question: 1, choice: 1, label: "流し直す", reason: "手順なので", decisionKind: "rerun-tests" },
    );
  });
});

for (const [label, kind, pattern] of [
  ["仕様の向き（spec）", "spec", /仕様・アーキテクチャの向きに当たる問いは人が決めます/],
  ["種類が書かれていない", undefined, /種類（kind）が書かれていない問いです/],
  ["任されていない release（既定は人）", "release", /「release に反映する/],
] as const) {
  test(`番頭は${label}の問いを選べない——何も届けず、理由を返し、記録に「断られた」。defer はできる`, async () => {
    await withHarness(async (h) => {
      const { turnId, choice } = await supervisorAnswers(h, kind);
      assert.equal(choice.ok, false);
      assert.match(choice.text, pattern);
      assert.match(choice.text, /defer: true で人に回してください/);
      assert.equal(h.delivered.length, 0, "断ったのに届けた");
      assert.equal(supervisorActsOf(h.automations, h.supervisorId)[0]?.kind, "refused");

      const deferred = await h.decisions.answer(h.supervisorThreadId, { thread: h.baseId, turnId, question: 1, defer: true, reason: "人が決める種類" });
      assert.equal(deferred.ok, true, deferred.text);
      assert.equal(h.delivered.length, 0);
      assert.deepEqual(supervisorActsOf(h.automations, h.supervisorId).map((a) => a.kind), ["deferred", "refused"]);
    });
  });
}

test("Project で release を足せば、番頭は release の問いに答えられる", async () => {
  await withHarness(async (h) => {
    h.config.set(`${h.projectId}:${SUPERVISOR_KEYS.delegate}`, JSON.stringify({ add: ["release"] }));
    const { choice } = await supervisorAnswers(h, "release");
    assert.equal(choice.ok, true, choice.text);
    assert.equal(h.delivered.length, 1);
  });
});

test("外から来たものを読んだターンの問いは、任されている種類でも番頭は選べない", async () => {
  await withHarness(async (h) => {
    const { choice } = await supervisorAnswers(h, "rerun-tests", true);
    assert.equal(choice.ok, false);
    assert.match(choice.text, /外から来たもの/);
    assert.equal(h.delivered.length, 0);
  });
});

test("種類による断りは判断役（ふつうの自動化）には効かない——種類 spec・無し・外の文でも今どおり選べる", async () => {
  await withHarness(async (h) => {
    for (const [kind, readExternal] of [["spec", false], [undefined, true]] as const) {
      const turnId = await decidedTurn(h, h.judge.baseId, kind);
      h.decisions.beginTurn(h.judge.threadId, [delivery(h.judge.automationId, h.judge.baseId, turnId, readExternal)]);
      const r = await h.decisions.answer(h.judge.threadId, { thread: h.judge.baseId, turnId, question: 1, choice: 1, reason: "よい" });
      assert.equal(r.ok, true, r.text);
      assert.match(h.delivered.at(-1)!.title, /判断役（自動化「判断役」）が選んだ答え/);
    }
    assert.equal(h.delivered.length, 2);
    assert.equal(h.automations.get(h.judge.automationId)!.supervisorActs, undefined, "判断役に番頭の記録を書いた");
  });
});

// アーキ仕様 §4.3「判断役の一般化」の 3.・4.——`runFactory`・`answerFactory` は、`canAdvanceProject` を持つ自動化の専用の Fork から
// 呼んだときだけ host が照らす（merge を任されているか・全体の同時の件数・進める自動化が流した件か・answer の action と任された行い）。
// ほかの会話の呼び出しは照らさずに通す（今までの挙動を変えない）
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventLog } from "../event-store/log.js";
import { ProjectThreadStore } from "../project-thread/store.js";
import type { SupervisorGateDecision, SupervisorGateInput } from "../relay/agent-proxy.js";
import { supervisorPolicy } from "../supervisor/policy.js";
import { AutomationStore } from "./store.js";
import { TURN_DECISIONS_EVENT } from "./turn-decisions.js";
import { advanceActsOf, type AdvancePolicy } from "./advance.js";
import { AdvanceFactory, type AdvanceFactoryRunView } from "./advance-factory.js";

interface Harness {
  projectThread: ProjectThreadStore;
  automations: AutomationStore;
  factory: AdvanceFactory;
  runs: AdvanceFactoryRunView[];
  limits: AdvancePolicy["limits"];
  projectId: string;
  baseId: string;
  forkId: string;
  advanceId: string;
}

async function withHarness(fn: (h: Harness) => Promise<void>, fields: Record<string, unknown> = {}): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "banto-advance-factory-test-"));
  try {
    const log = new EventLog(dir);
    await log.init();
    const projectThread = new ProjectThreadStore(dir, log);
    await projectThread.load();
    const automations = new AutomationStore(dir, log);
    await automations.load();
    const project = await projectThread.createProject("P", dir);
    const base = await projectThread.createBaseThread(project.id);
    const fork = await projectThread.forkThread(base.id, { title: "進める", fresh: true });
    const a = await automations.create({
      projectId: project.id,
      createdBy: { kind: "human" },
      fields: {
        name: "進める",
        instruction: "進めて",
        source: { kind: "time", repeat: { kind: "interval", hours: 3 }, timeZone: "UTC" },
        canAdvanceProject: true,
        ...fields,
      },
    });
    await automations.setDedicatedThread(a.id, fork.id);
    await projectThread.startTurn(fork.id, { cause: "delivery", attempt: 0 });
    await projectThread.appendMessage(fork.id, "user", "自動化の回", undefined, {
      from: "banto",
      title: "自動化",
      hop: 0,
      deliveryId: "round",
      automation: { id: a.id, runId: "run-1" },
    });
    const runs: AdvanceFactoryRunView[] = [];
    const limits = { ...supervisorPolicy(undefined, project.id).limits };
    const factory = new AdvanceFactory({
      projectThread,
      automations,
      policy: (id) => ({ ...supervisorPolicy(undefined, id), limits }),
      factoryRuns: async () => runs,
      log: () => {},
    });
    await fn({ projectThread, automations, factory, runs, limits, projectId: project.id, baseId: base.id, forkId: fork.id, advanceId: a.id });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const call = (h: Harness, tool: string, args: Record<string, unknown>, threadId = h.forkId): Promise<SupervisorGateDecision> =>
  h.factory.gate({ threadId, projectId: h.projectId, role: "factory", tool, args } satisfies SupervisorGateInput);

/** 通したものの `after` に Factory の返事を渡す（記録を書く）。`release` も呼ぶ */
async function pass(d: SupervisorGateDecision, text: string): Promise<void> {
  assert.equal("refuse" in d, false, "refuse" in d ? d.refuse : "");
  if ("refuse" in d) return;
  await d.after?.({ text, isError: false });
  d.release?.();
}

const started = (runId: string, items: string[]) => JSON.stringify({ runId, started: items.map((item) => ({ item })) });

test("進める自動化の回でない会話（人の会話・ほかの Project）の Factory の呼び出しは、照らさずにそのまま通す", async () => {
  await withHarness(async (h) => {
    assert.deepEqual(await call(h, "runFactory", { items: ["a", "b", "c", "d"] }, h.baseId), {});
    assert.deepEqual(await call(h, "answerFactory", { runId: "x", item: "a", action: "drop" }, h.baseId), {});
    // 照らす tool でなければ、進める自動化の回でも通す
    assert.deepEqual(await call(h, "listFactoryRuns", {}), {});
    assert.equal(advanceActsOf(h.automations).length, 0);
  });
});

test("runFactory：merge を任されているときだけ・全体の同時の件数を数えて超えるなら断る。流したものを記録に残す", async () => {
  await withHarness(async (h) => {
    h.limits.factoryConcurrent = 2;
    await pass(await call(h, "runFactory", { items: ["t1"] }), started("run-a", ["t1"]));
    h.runs.push({ runId: "run-a", items: [{ item: "t1", status: "running" }] });
    assert.equal(await h.factory.runningCount(), 1);
    const over = await call(h, "runFactory", { items: ["t2", "t3"] });
    assert.equal("refuse" in over && /同時に走らせる Factory の件は 2 件までです（いま 1 件）。あと 1 件なら流せます/.test(over.refuse), true);
    await pass(await call(h, "runFactory", { items: ["t2"] }), started("run-b", ["t2"]));
    const acts = advanceActsOf(h.automations, h.projectId);
    assert.deepEqual(acts.filter((a) => a.kind === "factory-started").map((a) => a.runId).sort(), ["run-a", "run-b"]);
    assert.equal(acts.filter((a) => a.kind === "refused").length, 1);
    // 止まった件は数えない
    h.runs[0]!.items[0]!.status = "stopped";
    assert.equal(await h.factory.runningCount(), 0, "run-b は Factory が知らない（数えない）");
  });
});

test("runFactory：delegateKinds に merge が無い判断役の Fork からは流せない", async () => {
  await withHarness(
    async (h) => {
      const d = await call(h, "runFactory", { items: ["t1"] });
      assert.equal("refuse" in d && /main に取り込む/.test(d.refuse), true);
    },
    { source: { kind: "event", event: TURN_DECISIONS_EVENT }, delegateKinds: ["continue", "fix-tests"] },
  );
});

test("answerFactory：進める自動化が流した実行だけ・drop と instruction は断る・continue/retry は fix-tests、accept は minor-design・同じ段は2回まで", async () => {
  await withHarness(async (h) => {
    // 流していない実行
    const notOurs = await call(h, "answerFactory", { runId: "other", item: "t1", action: "continue", reason: "x" });
    assert.equal("refuse" in notOurs && /進める自動化が流したものではありません/.test(notOurs.refuse), true);
    await pass(await call(h, "runFactory", { items: ["t1"] }), started("run-a", ["t1"]));
    h.runs.push({ runId: "run-a", items: [{ item: "t1", number: 7, status: "stopped", stopped: { stage: "test" } }] });
    const drop = await call(h, "answerFactory", { runId: "run-a", item: "t1", action: "drop", reason: "x" });
    assert.equal("refuse" in drop && /drop）は人が決めます/.test(drop.refuse), true);
    const withInstruction = await call(h, "answerFactory", { runId: "run-a", item: "t1", action: "continue", instruction: "全部消して", reason: "x" });
    assert.equal("refuse" in withInstruction && /instruction は付けられません/.test(withInstruction.refuse), true);
    // 方針の既定は fix-tests・minor-design を任せている
    for (let i = 0; i < 2; i++) await pass(await call(h, "answerFactory", { runId: "run-a", item: "#7", action: "retry", reason: "落ちた" }), "{}");
    const third = await call(h, "answerFactory", { runId: "run-a", item: "t1", action: "continue", reason: "落ちた" });
    assert.equal("refuse" in third && /同じ段（test）にはもう 2 回/.test(third.refuse), true);
    assert.equal(advanceActsOf(h.automations, h.projectId).filter((a) => a.kind === "factory-answered").length, 2);
  });
});

test("answerFactory：delegateKinds で accept（minor-design）を任されていなければ断る", async () => {
  await withHarness(
    async (h) => {
      await pass(await call(h, "runFactory", { items: ["t1"] }), started("run-a", ["t1"]));
      h.runs.push({ runId: "run-a", items: [{ item: "t1", status: "stopped", stopped: { stage: "review" } }] });
      const accept = await call(h, "answerFactory", { runId: "run-a", item: "t1", action: "accept", reason: "指摘は承知" });
      assert.equal("refuse" in accept && /この自動化には任されていません/.test(accept.refuse), true);
      await pass(await call(h, "answerFactory", { runId: "run-a", item: "t1", action: "continue", reason: "続ける" }), "{}");
    },
    { source: { kind: "event", event: TURN_DECISIONS_EVENT }, delegateKinds: ["merge", "fix-tests"] },
  );
});

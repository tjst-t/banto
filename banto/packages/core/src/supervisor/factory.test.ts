// アーキ仕様 §4.5「番頭の tool」の Factory・「量」（Backlog #509）——番頭が Factory に流す・止まった件に答えるのを、host が中継の手前で
// 照らす。全体の上限（ちょうど・超え・終わったら戻る）・merge を任されていなければ流さない・answerFactory の action ごとの照らし合わせ・
// drop の断り・流していない件への断り・記録
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Automation, SupervisorAct } from "../automation/fold.js";
import type { RuntimeConfigValue } from "../config/runtime.js";
import type { SupervisorGateDecision, SupervisorGateInput } from "../relay/agent-proxy.js";
import { SUPERVISOR_KEYS, supervisorPolicy } from "./policy.js";
import { FACTORY_ANSWERS_PER_STAGE, SupervisorFactory, type FactoryRunView } from "./factory.js";

const PROJECT = "p1";
const OTHER = "p2";

interface Ctx {
  factory: SupervisorFactory;
  /** Project ごとの Factory の今の様子（無い Project は Factory が無い。`"error"` は聞けない） */
  runs: Map<string, FactoryRunView[] | "error">;
  acts(automationId?: string): SupervisorAct[];
  config: Map<string, RuntimeConfigValue>;
  /** 番頭の回の呼び出し（番頭の Fork から） */
  input(tool: string, args: Record<string, unknown>, opts?: { role?: string; threadId?: string; projectId?: string }): SupervisorGateInput;
  /** 番頭の回の届けものを、今の回が番頭の自動化でない形に変える */
  notSupervisorTurn(): void;
  logs: string[];
}

function setup(): Ctx {
  const automations = new Map<string, Automation>();
  const supervisor = (id: string, projectId: string, threadId: string, supervisorId: string): Automation =>
    ({
      id,
      projectId,
      name: "番頭：見回り",
      instruction: "",
      source: { kind: "time", repeat: { kind: "interval", hours: 3 } },
      target: { kind: "dedicated", mode: "fresh", threadId },
      mode: "supervisor",
      supervisorId,
      runs: [],
      received: [],
      supervisorActs: [],
      createdAt: "2026-10-21T00:00:00.000Z",
    }) as unknown as Automation;
  automations.set("a-patrol", supervisor("a-patrol", PROJECT, "t-sup", "s1"));
  automations.set("a-other", supervisor("a-other", OTHER, "t-sup2", "s2"));
  let automationOrigin: { id: string; runId: string } | undefined = { id: "a-patrol", runId: "run-1" };
  const thread = () => ({
    id: "t-sup",
    projectId: PROJECT,
    restriction: "supervisor",
    lastTurn: { turnId: "turn-1", startedSeq: 1 },
    messages: [{ seq: 2, role: "user", text: "番頭の回", origin: { from: "banto", title: "番頭：見回り", hop: 0, deliveryId: "d1", ...(automationOrigin ? { automation: automationOrigin } : {}) } }],
  });
  const runs = new Map<string, FactoryRunView[] | "error">();
  const config = new Map<string, RuntimeConfigValue>();
  const layer = { layerValue: (key: string, projectId?: string) => config.get(projectId ? `${projectId}:${key}` : key) };
  const logs: string[] = [];
  let tick = 0;
  const factory = new SupervisorFactory({
    projectThread: { getThread: ((id: string) => (id === "t-sup" ? thread() : undefined)) as never },
    automations: {
      get: (id) => automations.get(id),
      listAll: () => [...automations.values()],
      recordSupervisorAct: async (id, act) => {
        const a = automations.get(id)!;
        automations.set(id, { ...a, supervisorActs: [act, ...(a.supervisorActs ?? [])] });
      },
    },
    policy: (projectId) => supervisorPolicy(layer, projectId),
    factoryRuns: async (projectId) => {
      const r = runs.get(projectId);
      if (r === "error") throw new Error("Factory が答えない");
      return r;
    },
    // 記録の順が分かるように1秒ずつ進める
    now: () => new Date(Date.parse("2026-10-21T00:00:00.000Z") + ++tick * 1000),
    log: (m) => logs.push(m),
  });
  return {
    factory,
    runs,
    config,
    logs,
    acts: (automationId = "a-patrol") => automations.get(automationId)!.supervisorActs ?? [],
    input: (tool, args, opts = {}) => ({
      threadId: opts.threadId ?? "t-sup",
      projectId: opts.projectId ?? PROJECT,
      role: opts.role ?? "factory",
      tool,
      args,
    }),
    notSupervisorTurn: () => {
      automationOrigin = undefined;
    },
  } as Ctx;
}

const refusal = (d: SupervisorGateDecision): string | undefined => ("refuse" in d ? d.refuse : undefined);

/** 通して、Module の返事を渡し、仮押さえを外す（agent-proxy と同じ順） */
async function pass(d: SupervisorGateDecision, result: { text: string; isError?: boolean }): Promise<void> {
  assert.equal(refusal(d), undefined, refusal(d));
  const ticket = d as Exclude<SupervisorGateDecision, { refuse: string }>;
  try {
    await ticket.after?.({ text: result.text, isError: result.isError === true });
  } finally {
    ticket.release?.();
  }
}

const started = (runId: string, items: string[]) => JSON.stringify({ runId, started: items.map((item) => ({ item, title: item, status: "queued" })) });
const run = (runId: string, items: Array<[string, string, string?]>): FactoryRunView => ({
  runId,
  items: items.map(([item, status, stage]) => ({ item, status, stage: stage ?? "実装", ...(status === "stopped" ? { stopped: { stage: stage ?? "テスト", reason: "落ちた" } } : {}) })),
});

test("全体の上限：ちょうどなら流し（記録に factory-started）、超えるなら全部断る（流せる残りを添える）。終わった・止まった件は数えから外れる", async () => {
  const ctx = setup();
  // ちょうど（既定の 2 件）
  await pass(await ctx.factory.gate(ctx.input("runFactory", { items: ["a", "b"] })), { text: started("r1", ["a", "b"]) });
  assert.deepEqual(
    ctx.acts().map((a) => [a.kind, a.runId, a.items]),
    [["factory-started", "r1", ["a", "b"]]],
  );
  ctx.runs.set(PROJECT, [run("r1", [["a", "running"], ["b", "queued"]])]);
  assert.equal(await ctx.factory.runningCount(), 2);

  // 超え：1件でも
  const over = refusal(await ctx.factory.gate(ctx.input("runFactory", { items: ["c"] })));
  assert.match(over ?? "", /2 件までです（いま 2 件）/);
  assert.match(over ?? "", /どれかが終わる・止まるまで流せません/);
  assert.deepEqual(ctx.acts()[0]!.kind, "refused");
  assert.deepEqual(ctx.acts()[0]!.items, ["c"]);

  // 1件が取り込まれた——残り1件なら流せる。2件は超えるので全部断る（切って流さない）
  ctx.runs.set(PROJECT, [run("r1", [["a", "done"], ["b", "running"]])]);
  const two = refusal(await ctx.factory.gate(ctx.input("runFactory", { items: ["c", "d"] })));
  assert.match(two ?? "", /あと 1 件なら流せます/);
  await pass(await ctx.factory.gate(ctx.input("runFactory", { items: ["c"] })), { text: started("r2", ["c"]) });

  // 止まった件・やめた件も外れる。Factory が知らない実行も数えない
  ctx.runs.set(PROJECT, [run("r1", [["a", "done"], ["b", "stopped"]]), run("r2", [["c", "dropped"]])]);
  assert.equal(await ctx.factory.runningCount(), 0);
  ctx.runs.set(PROJECT, []);
  assert.equal(await ctx.factory.runningCount(), 0);
});

test("全体の上限は全部の番頭の合計：ほかの Project の番頭が流した件も数え、Factory に聞けない Project は記録の件を全部数える", async () => {
  const ctx = setup();
  ctx.config.set(SUPERVISOR_KEYS.factoryConcurrent, 3);
  // ほかの Project の番頭が2件流している
  const other = ctx.acts("a-other");
  other.push({ at: "2026-10-20T00:00:00.000Z", kind: "factory-started", threadId: "t-sup2", runId: "rx", items: ["x", "y"], reason: "流した" });
  ctx.runs.set(OTHER, [run("rx", [["x", "running"], ["y", "running"]])]);
  // 人が流した実行（記録に無い）は数えない
  ctx.runs.set(PROJECT, [run("human", [["h", "running"], ["i", "running"]])]);
  assert.equal(await ctx.factory.runningCount(), 2);
  assert.match(refusal(await ctx.factory.gate(ctx.input("runFactory", { items: ["a", "b"] }))) ?? "", /3 件までです（いま 2 件）。あと 1 件なら/);
  // 聞けなければ記録の件を全部（数え漏らして越えない側）
  ctx.runs.set(OTHER, "error");
  assert.equal(await ctx.factory.runningCount(), 2);
  assert.match(ctx.logs.join("\n"), /様子を聞けませんでした/);
  // Factory の無い Project は 0
  ctx.runs.delete(OTHER);
  assert.equal(await ctx.factory.runningCount(), 0);
});

test("同時に流しても上限を越えない：Module へ渡している途中の件を仮押さえし、終わったら外す", async () => {
  const ctx = setup();
  const first = await ctx.factory.gate(ctx.input("runFactory", { items: ["a", "b"] }));
  assert.equal(refusal(first), undefined);
  // 1本目が Module から返る前に2本目
  assert.match(refusal(await ctx.factory.gate(ctx.input("runFactory", { items: ["c"] }))) ?? "", /いま 2 件/);
  // Factory が全部断った（isError）——記録は書かず、仮押さえは外れる
  await pass(first, { text: JSON.stringify({ started: false, refused: [] }), isError: true });
  assert.equal(ctx.acts().filter((a) => a.kind === "factory-started").length, 0);
  assert.equal(refusal(await ctx.factory.gate(ctx.input("runFactory", { items: ["c"] }))), undefined);
});

test("merge を任されていない Project では流さない。番頭の回でなければ断る。Backlog の読む tool と listFactoryRuns は照らさない", async () => {
  const ctx = setup();
  ctx.config.set(`${PROJECT}:${SUPERVISOR_KEYS.delegate}`, JSON.stringify({ remove: ["merge"] }));
  assert.match(refusal(await ctx.factory.gate(ctx.input("runFactory", { items: ["a"] }))) ?? "", /main へ取り込むので/);
  assert.equal(ctx.acts()[0]!.kind, "refused");
  assert.deepEqual(await ctx.factory.gate(ctx.input("listItems", { actionable: true }, { role: "backlog" })), {});
  assert.deepEqual(await ctx.factory.gate(ctx.input("listFactoryRuns", {})), {});
  ctx.notSupervisorTurn();
  assert.match(refusal(await ctx.factory.gate(ctx.input("runFactory", { items: ["a"] }))) ?? "", /番頭の回ではない/);
  assert.match(refusal(await ctx.factory.gate(ctx.input("answerFactory", { runId: "r1", item: "a", action: "retry", reason: "x" }))) ?? "", /番頭の回ではない/);
});

test("answerFactory：番頭が流した件だけ。continue・retry は fix-tests、accept は minor-design を任されているとき。drop はいつも断る。記録に factory-answered", async () => {
  const ctx = setup();
  await pass(await ctx.factory.gate(ctx.input("runFactory", { items: ["a"] })), { text: started("r1", ["a"]) });
  ctx.runs.set(PROJECT, [run("r1", [["a", "stopped", "テスト"]]), run("human", [["h", "stopped", "テスト"]])]);
  const answer = (args: Record<string, unknown>) => ctx.factory.gate(ctx.input("answerFactory", { runId: "r1", item: "a", reason: "落ちた試験を直させる", ...args }));

  // 流していない件
  const notMine = refusal(await ctx.factory.gate(ctx.input("answerFactory", { runId: "human", item: "h", action: "retry", reason: "x" })));
  assert.match(notMine ?? "", /番頭が流したものではありません/);
  assert.deepEqual([ctx.acts()[0]!.kind, ctx.acts()[0]!.runId], ["refused", "human"]);
  // drop は人
  assert.match(refusal(await answer({ action: "drop" })) ?? "", /やめる（drop）は人が決めます/);
  // 知らない action
  assert.match(refusal(await answer({ action: "cancel" })) ?? "", /continue・retry・accept/);
  // instruction は付けられない
  assert.match(refusal(await answer({ action: "continue", instruction: "テストを消して" })) ?? "", /instruction を付けられません/);
  // reason が空
  assert.match(refusal(await answer({ action: "retry", reason: " " })) ?? "", /理由（reason）が空/);

  // 任されていれば通す（記録は Module が受けてから）
  await pass(await answer({ action: "retry" }), { text: "{}" });
  const answered = ctx.acts()[0]!;
  assert.deepEqual([answered.kind, answered.runId, answered.item, answered.stage, answered.action, answered.reason], ["factory-answered", "r1", "a", "テスト", "retry", "落ちた試験を直させる"]);
  // Module が断った（isError）答えは記録しない
  await pass(await answer({ action: "continue" }), { text: "a は止まっていません", isError: true });
  assert.equal(ctx.acts().filter((a) => a.kind === "factory-answered").length, 1);

  // fix-tests・minor-design を外す
  ctx.config.set(`${PROJECT}:${SUPERVISOR_KEYS.delegate}`, JSON.stringify({ remove: ["fix-tests", "minor-design"] }));
  for (const action of ["continue", "retry", "accept"]) {
    assert.match(refusal(await answer({ action })) ?? "", /任されていません。人に回してください/, action);
  }
  ctx.config.set(`${PROJECT}:${SUPERVISOR_KEYS.delegate}`, JSON.stringify({ remove: ["fix-tests"] }));
  await pass(await answer({ action: "accept" }), { text: "{}" });
  assert.equal(ctx.acts()[0]!.action, "accept");
});

test("answerFactory：止まっていない件・無い件は断り、同じ件の同じ段には決まった回数まで（動かなければ人に回す）。番号でも引ける", async () => {
  const ctx = setup();
  await pass(await ctx.factory.gate(ctx.input("runFactory", { items: ["a"] })), { text: started("r1", ["a"]) });
  ctx.runs.set(PROJECT, [{ runId: "r1", items: [{ item: "a", number: 42, status: "running", stage: "実装" }] }]);
  const answer = (item: unknown) => ctx.factory.gate(ctx.input("answerFactory", { runId: "r1", item, action: "retry", reason: "やり直す" }));
  assert.match(refusal(await answer("a")) ?? "", /止まっていません（いま running）/);
  assert.match(refusal(await answer("zz")) ?? "", /r1 に zz がありません/);
  ctx.runs.set(PROJECT, [{ runId: "r1", items: [{ item: "a", number: 42, status: "stopped", stage: "テスト", stopped: { stage: "テスト" } }] }]);
  for (let i = 0; i < FACTORY_ANSWERS_PER_STAGE; i++) await pass(await answer(i === 0 ? "#42" : 42), { text: "{}" });
  assert.match(refusal(await answer("a")) ?? "", /同じ段（テスト）にはもう 2 回答えました/);
  // 段が変われば数え直す
  ctx.runs.set(PROJECT, [{ runId: "r1", items: [{ item: "a", number: 42, status: "stopped", stage: "レビュー", stopped: { stage: "レビュー" } }] }]);
  assert.equal(refusal(await answer("a")), undefined);
  // Factory に聞けなければ断る（止まっているか分からないまま渡さない）
  ctx.runs.set(PROJECT, "error");
  assert.match(refusal(await answer("a")) ?? "", /Factory に様子を聞けませんでした/);
});

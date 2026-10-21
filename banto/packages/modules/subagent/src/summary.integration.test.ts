// **要約——人がボタンを押したときだけ**（アーキ仕様 §4.1「4.」、Backlog #490）。host の口（`relaySummarizeBackgroundWork`）を偽物にして、
// 材料の上限・作っている印（1つだけ）・作っている間に終わったら捨てる・失敗の文・AI に渡さないことを見る。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  BACKGROUND_SUMMARY_MATERIAL_MAX_CHARS,
  REPLY_TO_META_KEY,
  THREAD_META_KEY,
  type SummarizeBackgroundWorkInput,
  type SummarizeBackgroundWorkReply,
} from "@banto/module-contract";
import { listAgents } from "./agents.js";
import { createSubagentServer } from "./server.js";
import { fakeVault } from "./testing/harness.js";
import { SUMMARIES_KEPT, type RunRecord, type RunStep } from "./runs.js";
import { SUMMARY_MESSAGES, SUMMARY_PROMPT_HEAD, SUMMARY_STEPS, summaryMaterialOf } from "./summary.js";

type Delivered = { replyTo: string; title: string; text: string };
type ToolResult = { content: { text: string }[]; isError?: boolean };
type Summarize = (input: SummarizeBackgroundWorkInput) => Promise<SummarizeBackgroundWorkReply>;

const THREAD = { projectId: "p1", threadId: "t1" };

async function withServer(
  summarize: Summarize | undefined,
  fn: (ctx: { call: (name: string, args: Record<string, unknown>) => Promise<ToolResult>; client: Client; delivered: Delivered[] }) => Promise<void>,
) {
  const root = mkdtempSync(join(tmpdir(), "subagent-sum-"));
  const project = join(root, "project");
  const data = join(root, "data", "modules", "subagent-p1");
  mkdirSync(project, { recursive: true });
  mkdirSync(data, { recursive: true });
  const delivered: Delivered[] = [];
  const server = createSubagentServer({
    projectRoot: project,
    moduleDataDir: data,
    relayClient: fakeVault().relay,
    agents: listAgents({ BANTO_SUBAGENT_FAKE_AGENT: "1" }),
    claudeLoginEnv: {},
    deliver: async (input) => {
      delivered.push(input);
      return { deliveryId: `d${delivered.length}`, wake: "now" };
    },
    ...(summarize ? { summarize } : {}),
  });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  const call = (name: string, args: Record<string, unknown>) => client.callTool({ name, arguments: args }) as Promise<ToolResult>;
  try {
    await fn({ call, client, delivered });
  } finally {
    await client.close();
    rmSync(root, { recursive: true, force: true });
  }
}

/** 待たない形で頼み、走り出す（最初の tool を呼ぶ）まで待つ */
async function startBackground(client: Client, prompt: string, replyTo = "reply_sum"): Promise<string> {
  const r = (await client.callTool({
    name: "runSubagent",
    arguments: { agent: "fake", prompt, runInBackground: true },
    _meta: { [REPLY_TO_META_KEY]: replyTo, [THREAD_META_KEY]: THREAD },
  })) as ToolResult;
  assert.equal(r.isError, undefined, r.content[0]?.text);
  const { runId } = JSON.parse(r.content[0]!.text) as { runId: string };
  for (let i = 0; i < 100; i++) {
    const run = await getRun(client, runId);
    if (run.steps.length > 0) return runId;
    await new Promise((res) => setTimeout(res, 50));
  }
  assert.fail("走り出さない");
}

type Viewed = RunRecord & { summaryInSidebar?: true };
async function getRun(client: Client, id: string): Promise<Viewed> {
  const r = (await client.callTool({ name: "getRun", arguments: { id } })) as ToolResult;
  return JSON.parse(r.content[0]!.text) as Viewed;
}

async function waitStatus(client: Client, id: string, status: string): Promise<Viewed> {
  for (let i = 0; i < 200; i++) {
    const run = await getRun(client, id);
    if (run.status === status) return run;
    await new Promise((res) => setTimeout(res, 50));
  }
  assert.fail(`仕事が ${status} にならない`);
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

// ---- 材料 --------------------------------------------------------------------------------------------------

function bigRecord(): RunRecord {
  const steps: RunStep[] = [];
  for (let i = 0; i < 200; i++) {
    steps.push({ at: i, kind: "execute", title: `cmd-${i} ${"x".repeat(280)}`, description: `説明-${i} ${"y".repeat(180)}`, status: "completed" });
    if (i % 20 === 0) steps.push({ at: i, kind: "message", title: `発言-${i} ${"z".repeat(1900)}` });
  }
  return {
    id: "r1",
    agent: "fake",
    agentTitle: "Fake",
    prompt: `頼んだ文の頭${"p".repeat(10_000)}末尾の印`,
    status: "running",
    startedAt: 0,
    toolCalls: [],
    steps,
    plan: [
      { content: "仕様を読む", status: "completed" },
      { content: "直す", status: "in_progress" },
    ],
    files: Array.from({ length: 50 }, (_, i) => ({ path: `src/f${i}.ts`, wrote: i % 3 === 0 ? 1 : 0, read: 1, lastAt: i })),
  };
}

test("材料：上限（core の BACKGROUND_SUMMARY_MATERIAL_MAX_CHARS）を超えず、頼んだ文は頭だけ・経過は新しい分・発言は最後の3件", () => {
  const text = summaryMaterialOf(bigRecord());
  assert.ok([...text].length <= BACKGROUND_SUMMARY_MATERIAL_MAX_CHARS, `材料が上限を超えた：${[...text].length}`);
  assert.ok(text.includes(`頼んだ文の頭${"p".repeat(SUMMARY_PROMPT_HEAD - 6)}`), "頼んだ文の頭が入っていない");
  assert.ok(!text.includes("末尾の印"), "頼んだ文が頭で切られていない");
  assert.match(text, /やること一覧（1 \/ 2 済み）/);
  assert.match(text, /\[実行中\] 直す/);
  // 発言は最後の3件
  const said = [...text.matchAll(/発言-(\d+)/g)].map((m) => Number(m[1]));
  assert.deepEqual(said, [140, 160, 180].slice(-SUMMARY_MESSAGES));
  // 経過は一番新しいものが必ず入り、新しい 40 件より古いものは入らない（収まらない分は古いほうから落ちる）
  assert.ok(text.includes("cmd-199 "), "一番新しい経過が入っていない");
  assert.ok(!text.includes(`cmd-${199 - SUMMARY_STEPS} `), "新しい 40 件より古い経過が入った");
  // 触ったファイルは書いたものが先
  assert.match(text, /触ったファイル（上位 20 \/ 50）：\n- src\/f\d+\.ts（書いた 1/);
  // 小さな記録でも全部入る
  const small = summaryMaterialOf({ ...bigRecord(), prompt: "短い頼み", steps: [{ at: 1, kind: "read", title: "Read a.ts", status: "in_progress" }], files: [] });
  assert.match(small, /短い頼み/);
  assert.match(small, /- \[read\] Read a\.ts（実行中）/);
});

// ---- 道具 --------------------------------------------------------------------------------------------------

test("押したときだけ：札と仕事の id と材料を host の口に渡し、できた要約を記録に残す。AI に届く結果には入らない", async () => {
  const asked: SummarizeBackgroundWorkInput[] = [];
  const summarize: Summarize = async (input) => {
    asked.push(input);
    return { summary: `要約その${asked.length}` };
  };
  await withServer(summarize, async ({ call, client, delivered }) => {
    const id = await startBackground(client, "[slow 2] 要約の試験の仕事");
    assert.equal(asked.length, 0, "押していないのに要約を頼んだ");
    const before = await getRun(client, id);
    assert.equal(before.summaryInSidebar, true, "待たない形で Thread が頼んだ仕事なのに、サイドバーに出る旨が無い");

    const r = await call("summarizeRun", { id });
    assert.equal(r.isError, undefined, r.content[0]?.text);
    assert.equal((JSON.parse(r.content[0]!.text) as { summary: string }).summary, "要約その1");
    assert.equal(asked.length, 1);
    assert.equal(asked[0]!.replyTo, "reply_sum", "その仕事の札を添えていない");
    assert.equal(asked[0]!.material.workId, id);
    assert.match(asked[0]!.material.text, /要約の試験の仕事/);
    assert.ok([...asked[0]!.material.text].length <= BACKGROUND_SUMMARY_MATERIAL_MAX_CHARS);
    const after = await getRun(client, id);
    assert.deepEqual(after.summaries?.map((s) => s.text), ["要約その1"]);
    assert.equal(after.summarizing, undefined);

    const done = await waitStatus(client, id, "done");
    // 終わった記録にも残る（画面に出る）。AI に届いた結果には要約が無い
    assert.deepEqual(done.summaries?.map((s) => s.text), ["要約その1"]);
    for (let i = 0; i < 100 && delivered.length === 0; i++) await new Promise((res) => setTimeout(res, 50));
    assert.equal(delivered.length, 1);
    assert.ok(!delivered[0]!.text.includes("要約その1"), "AI に届く結果に要約が入った");
    assert.ok(!delivered[0]!.text.includes("summaries"), "AI に届く結果に要約の欄が入った");
    assert.equal(asked.length, 1, "自動で要約を作った");

    // 終わった仕事は要約しない
    const late = await call("summarizeRun", { id });
    assert.equal(late.isError, true);
    assert.match(late.content[0]!.text, /終わった仕事は要約しません/);
    assert.equal(asked.length, 1);
  });
});

test("新しい5件だけ残す", async () => {
  let n = 0;
  await withServer(async () => ({ summary: `要約${++n}` }), async ({ call, client }) => {
    const id = await startBackground(client, "[slow 30] 長い仕事");
    for (let i = 0; i < SUMMARIES_KEPT + 2; i++) assert.equal((await call("summarizeRun", { id })).isError, undefined);
    const run = await getRun(client, id);
    assert.deepEqual(run.summaries?.map((s) => s.text), ["要約3", "要約4", "要約5", "要約6", "要約7"]);
    await call("cancelRun", { id });
    await waitStatus(client, id, "cancelled");
  });
});

test("作っている間：2つ目の押下は作らずに印を返し、開き直した画面（getRun）にも作っている印が出る", async () => {
  const pending = deferred<SummarizeBackgroundWorkReply>();
  let asked = 0;
  await withServer(
    async () => {
      asked += 1;
      return pending.promise;
    },
    async ({ call, client }) => {
      const id = await startBackground(client, "[slow 30] 長い仕事");
      const first = call("summarizeRun", { id });
      for (let i = 0; i < 50 && asked === 0; i++) await new Promise((res) => setTimeout(res, 20));
      const second = await call("summarizeRun", { id });
      assert.equal(second.isError, undefined);
      assert.equal((JSON.parse(second.content[0]!.text) as { summarizing?: boolean }).summarizing, true);
      assert.equal(asked, 1, "作っている間に2つ目を頼んだ");
      assert.ok((await getRun(client, id)).summarizing, "作っている印が記録に無い");

      pending.resolve({ summary: "できた要約" });
      assert.equal((await first).isError, undefined);
      const run = await getRun(client, id);
      assert.equal(run.summarizing, undefined);
      assert.deepEqual(run.summaries?.map((s) => s.text), ["できた要約"]);
      await call("cancelRun", { id });
      await waitStatus(client, id, "cancelled");
    },
  );
});

test("作っている間に仕事が終わったら、その要約は捨てる（「仕事が終わったので要約を捨てました」）", async () => {
  const pending = deferred<SummarizeBackgroundWorkReply>();
  let asked = 0;
  await withServer(
    async () => {
      asked += 1;
      return pending.promise;
    },
    async ({ call, client }) => {
      const id = await startBackground(client, "[slow 30] 止める仕事");
      const first = call("summarizeRun", { id });
      for (let i = 0; i < 50 && asked === 0; i++) await new Promise((res) => setTimeout(res, 20));
      await call("cancelRun", { id });
      const ended = await waitStatus(client, id, "cancelled");
      assert.ok(ended.summaryDiscarded, "終わった記録に捨てた印が無い");
      assert.equal(ended.summarizing, undefined, "終わった記録に作っている印が残った");

      pending.resolve({ summary: "遅れて届いた要約" });
      const r = await first;
      assert.equal(r.isError, undefined);
      assert.deepEqual(JSON.parse(r.content[0]!.text), { discarded: true, note: "仕事が終わったので要約を捨てました" });
      const run = await getRun(client, id);
      assert.equal(run.summaries, undefined, "捨てたはずの要約が記録に残った");
    },
  );
});

test("失敗：host の断り・失敗の文をそのまま返し、記録にも残す（次に作れたら消える）", async () => {
  const replies: Array<() => Promise<SummarizeBackgroundWorkReply>> = [
    async () => {
      throw new Error("前の要約から 10 秒あけてください（あと 3 秒）");
    },
    async () => {
      throw new Error("要約を作れませんでした：小さいモデルの呼び出しが失敗しました（error_during_execution）");
    },
    async () => ({ summary: "直った" }),
  ];
  await withServer(async () => replies.shift()!(), async ({ call, client }) => {
    const id = await startBackground(client, "[slow 30] 長い仕事");
    const refused = await call("summarizeRun", { id });
    assert.equal(refused.isError, true);
    assert.equal(refused.content[0]!.text, "前の要約から 10 秒あけてください（あと 3 秒）");
    assert.equal((await getRun(client, id)).summaryError?.message, "前の要約から 10 秒あけてください（あと 3 秒）");

    const failed = await call("summarizeRun", { id });
    assert.equal(failed.content[0]!.text, "要約を作れませんでした：小さいモデルの呼び出しが失敗しました（error_during_execution）");
    assert.match((await getRun(client, id)).summaryError!.message, /error_during_execution/);
    assert.equal((await getRun(client, id)).summarizing, undefined, "失敗したのに作っている印が残った");

    assert.equal((await call("summarizeRun", { id })).isError, undefined);
    const run = await getRun(client, id);
    assert.equal(run.summaryError, undefined, "作れたのに前の失敗が残っている");
    assert.deepEqual(run.summaries?.map((s) => s.text), ["直った"]);
    await call("cancelRun", { id });
    const ended = await waitStatus(client, id, "cancelled");
    assert.equal(ended.summaryDiscarded, undefined, "作っていないのに捨てた印が付いた");
  });
});

test("待つ形の仕事は札を添えず（サイドバーには出ない）、host の口が無ければ断る", async () => {
  const asked: SummarizeBackgroundWorkInput[] = [];
  await withServer(
    async (input) => {
      asked.push(input);
      return { summary: "待つ形の要約" };
    },
    async ({ call, client }) => {
      const waiting = call("runSubagent", { agent: "fake", prompt: "[slow 2] 待つ形の仕事" });
      let id = "";
      for (let i = 0; i < 100 && !id; i++) {
        const list = JSON.parse((await call("listRuns", {})).content[0]!.text) as { runs: Array<{ id: string; status: string; toolCount: number }> };
        id = list.runs.find((r) => r.status === "running" && r.toolCount > 0)?.id ?? "";
        if (!id) await new Promise((res) => setTimeout(res, 50));
      }
      assert.ok(id, "走り出さない");
      assert.equal((await getRun(client, id)).summaryInSidebar, undefined);
      assert.equal((await call("summarizeRun", { id })).isError, undefined);
      assert.equal(asked[0]!.replyTo, undefined, "待つ形の仕事に札を添えた");
      const result = await waiting;
      assert.ok(!result.content[0]!.text.includes("待つ形の要約"), "AI に返る結果に要約が入った");
    },
  );
  await withServer(undefined, async ({ call, client }) => {
    const id = await startBackground(client, "[slow 30] 長い仕事");
    const r = await call("summarizeRun", { id });
    assert.equal(r.isError, true);
    assert.match(r.content[0]!.text, /host の要約の口に繋がっていません/);
    await call("cancelRun", { id });
    await waitStatus(client, id, "cancelled");
  });
});

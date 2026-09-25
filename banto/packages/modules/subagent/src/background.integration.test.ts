// **待たない形**（決定・2026-09-25、アーキ仕様 §4.1・§4.2）：すぐ仕事の id を返し、終わったら host が渡した
// 返信用の札で呼び出し元の Thread に届ける。偽のエージェントで端から端まで通す。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { DELIVERS_LATER_META_KEY, PENDING_REPLY_META_KEY, REPLY_TO_META_KEY } from "@banto/module-contract";
import { listAgents } from "./agents.js";
import { localClaudeLogin } from "./claude-login-access.js";
import { createSubagentServer } from "./server.js";
import { fakeVault } from "./testing/harness.js";

type Delivered = { replyTo: string; title: string; text: string; final?: boolean };

async function withBackground(fn: (ctx: { client: Client; delivered: Delivered[]; waitDelivered: (n: number) => Promise<void> }) => Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), "subagent-bg-"));
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
    claudeLogin: localClaudeLogin({ credentialsPath: "/nonexistent/.credentials.json" }),
    deliver: async (input) => {
      delivered.push(input);
      return { deliveryId: `d${delivered.length}`, wake: "now" };
    },
  });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  const waitDelivered = async (n: number) => {
    for (let i = 0; i < 200 && delivered.length < n; i++) await new Promise((r) => setTimeout(r, 50));
    assert.equal(delivered.length, n, "届かない");
  };
  try {
    await fn({ client, delivered, waitDelivered });
  } finally {
    await client.close();
    rmSync(root, { recursive: true, force: true });
  }
}

const callWith = (client: Client, args: Record<string, unknown>, replyTo?: string) =>
  client.callTool({
    name: "runSubagent",
    arguments: args,
    ...(replyTo ? { _meta: { [REPLY_TO_META_KEY]: replyTo } } : {}),
  }) as Promise<{ content: { text: string }[]; isError?: boolean; _meta?: Record<string, unknown> }>;

test("runSubagent は「終わったら届ける」を名乗る（host が札を渡す印）", async () => {
  await withBackground(async ({ client }) => {
    const tools = await client.listTools();
    const run = tools.tools.find((t) => t.name === "runSubagent")!;
    assert.equal((run._meta as Record<string, unknown>)[DELIVERS_LATER_META_KEY], true);
    assert.ok((run.inputSchema.properties as Record<string, unknown>).runInBackground);
  });
});

test("待たない形：すぐ仕事の id を返し（あとで届けると約束する）、終わったら札で結果を届ける", async () => {
  await withBackground(async ({ client, delivered, waitDelivered }) => {
    const started = Date.now();
    const r = await callWith(client, { agent: "fake", prompt: "[slow 1] 長めの仕事", runInBackground: true }, "reply_abc");
    assert.equal(r.isError, undefined);
    const body = JSON.parse(r.content[0]!.text) as { runId: string; status: string; note: string };
    assert.equal(body.status, "running");
    assert.match(body.note, /届き/);
    assert.equal(r._meta?.[PENDING_REPLY_META_KEY], true, "あとで届けると約束していない（host が返事待ちにできない）");
    assert.ok(Date.now() - started < 900, "待たない形なのに、仕事が終わるまで待った");
    assert.equal(delivered.length, 0);

    await waitDelivered(1);
    const d = delivered[0]!;
    assert.equal(d.replyTo, "reply_abc", "渡された札で届けていない");
    assert.equal(d.title, "Fake Agent（試験用） の仕事が終わりました");
    const result = JSON.parse(d.text) as { runId: string; stopReason: string; text: string };
    assert.equal(result.runId, body.runId);
    assert.equal(result.stopReason, "end_turn");
    assert.match(result.text, /受け取った/);
  });
});

test("待たない形でも「止める」は効き、止められたことが届く", async () => {
  await withBackground(async ({ client, delivered, waitDelivered }) => {
    const r = await callWith(client, { agent: "fake", prompt: "[slow 30] 止める仕事", runInBackground: true }, "reply_stop");
    const { runId } = JSON.parse(r.content[0]!.text) as { runId: string };
    // 走り出すまで待ってから止める
    for (let i = 0; i < 50; i++) {
      const runs = JSON.parse(((await client.callTool({ name: "listRuns", arguments: {} })) as { content: { text: string }[] }).content[0]!.text) as {
        runs: Array<{ id: string; lastProgress?: string }>;
      };
      if (runs.runs.find((x) => x.id === runId)?.lastProgress?.startsWith("ツール：")) break;
      await new Promise((res) => setTimeout(res, 100));
    }
    await client.callTool({ name: "cancelRun", arguments: { id: runId } });
    await waitDelivered(1);
    assert.match(delivered[0]!.title, /止められました/);
    assert.equal((JSON.parse(delivered[0]!.text) as { stopReason: string }).stopReason, "cancelled");
  });
});

test("失敗しても黙らない——失敗したことが届く", async () => {
  await withBackground(async ({ client, delivered, waitDelivered }) => {
    await callWith(client, { agent: "fake", prompt: "[crash] 落ちる", runInBackground: true }, "reply_crash");
    await waitDelivered(1);
    assert.match(delivered[0]!.title, /失敗しました/);
    assert.ok((JSON.parse(delivered[0]!.text) as { error: string }).error);
  });
});

test("届ける先（札）が無ければ、待たない形は断る——黙って待つ形に落とさない", async () => {
  await withBackground(async ({ client, delivered }) => {
    const r = await callWith(client, { agent: "fake", prompt: "仕事", runInBackground: true });
    assert.equal(r.isError, true);
    assert.match(r.content[0]!.text, /届ける先がありません/);
    assert.equal(delivered.length, 0);
    // 待つ形はそのまま使える（札があっても待つ）
    const sync = await callWith(client, { agent: "fake", prompt: "待つ仕事" }, "reply_sync");
    assert.match((JSON.parse(sync.content[0]!.text) as { text: string }).text, /受け取った/);
    assert.equal(sync._meta?.[PENDING_REPLY_META_KEY], undefined, "待つ形なのに、あとで届けると約束した");
  });
});

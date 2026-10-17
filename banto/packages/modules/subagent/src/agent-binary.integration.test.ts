// **取ってきた本体で起こす**（決定・2026-10-17、アーキ仕様 §4.1「エージェントの本体を取ってくる」）：起動時には解かず、使うときに
// host の口を呼ぶ。進み具合は頼んだ tool の呼び出しにも仕事の記録（Launcher）にも流れる。待たない形でも取り終えるまでは返さず、
// 失敗は tool の失敗で返る。偽のエージェント `fake` が本物の opencode と同じ道を通る
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { REPLY_TO_META_KEY } from "@banto/module-contract";
import { listAgents } from "./agents.js";
import { createSubagentServer } from "./server.js";
import { fakeAgentBinary, fakeVault } from "./testing/harness.js";

type ToolResult = { content: { text: string }[]; isError?: boolean };

async function withModule(
  ensure: (agent: string, onProgress?: (m: string) => void) => Promise<{ path: string; version: string; cpu: string; sizeBytes: number }>,
  fn: (ctx: { client: Client; asked: string[]; delivered: unknown[] }) => Promise<void>,
) {
  const root = mkdtempSync(join(tmpdir(), "subagent-binary-"));
  const project = join(root, "project");
  const data = join(root, "data", "modules", "subagent-p1");
  mkdirSync(project, { recursive: true });
  mkdirSync(data, { recursive: true });
  const asked: string[] = [];
  const delivered: unknown[] = [];
  const server = createSubagentServer({
    projectRoot: project,
    moduleDataDir: data,
    relayClient: {
      ...fakeVault().relay,
      ensureAgentBinary: (agent, onProgress) => {
        asked.push(agent);
        return ensure(agent, onProgress);
      },
    },
    agents: listAgents({ BANTO_SUBAGENT_FAKE_AGENT: "1" }),
    claudeLoginEnv: {},
    deliver: async (input) => {
      delivered.push(input);
      return { deliveryId: "d1", wake: "now" };
    },
  });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  try {
    await fn({ client, asked, delivered });
  } finally {
    await client.close();
    rmSync(root, { recursive: true, force: true });
  }
}

const slowEnsure = async (agent: string, onProgress?: (m: string) => void) => {
  onProgress?.(`${agent} を取ってきています（0 / 1MB）`);
  await new Promise((r) => setTimeout(r, 50));
  onProgress?.(`${agent} を取ってきています（1 / 1MB）`);
  return { path: fakeAgentBinary(), version: "0.0.0", cpu: "x64", sizeBytes: 20 };
};

test("起動時・一覧では取らず、頼んだときに取ってきた本体で起こす。進み具合は呼び出しと仕事の記録に流れる", async () => {
  await withModule(slowEnsure, async ({ client, asked }) => {
    const { tools } = await client.listTools();
    assert.match(tools.find((t) => t.name === "listSubagents")!.description!, /初めての fake は本体（数KB）を取ってくる/);
    await client.callTool({ name: "listSubagents", arguments: {} });
    assert.deepEqual(asked, [], "一覧で取ってきた");

    const progress: string[] = [];
    const r = (await client.callTool({ name: "runSubagent", arguments: { agent: "fake", prompt: "こんにちは" } }, undefined, {
      onprogress: (p) => void progress.push(p.message ?? ""),
    })) as ToolResult;
    assert.equal(r.isError, undefined, r.content[0]?.text);
    const result = JSON.parse(r.content[0]!.text) as { runId: string; text: string };
    assert.match(result.text, /こんにちは/);
    assert.deepEqual(asked, ["fake"]);
    assert.deepEqual(progress.slice(0, 2), ["fake を取ってきています（0 / 1MB）", "fake を取ってきています（1 / 1MB）"]);
    // 本体のログインを使う偽のエージェント（Claude Code と同じ形）は取らない
    await client.callTool({ name: "runSubagent", arguments: { agent: "fake-host", prompt: "x", envSecrets: { ANTHROPIC_API_KEY: "k" } } });
    assert.deepEqual(asked, ["fake"]);
  });
});

test("待たない形でも取り終えるまでは返さず、進み具合を流す。取れなければ tool の失敗で返り、何も届けない", async () => {
  await withModule(slowEnsure, async ({ client }) => {
    const progress: string[] = [];
    const r = (await client.callTool(
      { name: "runSubagent", arguments: { agent: "fake", prompt: "x", runInBackground: true }, _meta: { [REPLY_TO_META_KEY]: "rt-1" } },
      undefined,
      { onprogress: (p) => void progress.push(p.message ?? "") },
    )) as ToolResult;
    assert.equal(r.isError, undefined, r.content[0]?.text);
    assert.equal((JSON.parse(r.content[0]!.text) as { status: string }).status, "running");
    assert.ok(progress.includes("fake を取ってきています（1 / 1MB）"), JSON.stringify(progress));
  });

  await withModule(
    async () => {
      throw new Error("OpenCode の本体の確かめが合いませんでした");
    },
    async ({ client, delivered }) => {
      const r = (await client.callTool({
        name: "runSubagent",
        arguments: { agent: "fake", prompt: "x", runInBackground: true },
        _meta: { [REPLY_TO_META_KEY]: "rt-2" },
      })) as ToolResult;
      assert.equal(r.isError, true);
      assert.match(r.content[0]!.text, /Fake Agent（試験用） の本体を用意できませんでした：OpenCode の本体の確かめが合いませんでした/);
      // 仕事の記録には失敗として残る（人が Launcher で見る）
      const runs = JSON.parse(((await client.callTool({ name: "listRuns", arguments: {} })) as ToolResult).content[0]!.text) as {
        runs: Array<{ id: string; status: string }>;
      };
      assert.equal(runs.runs[0]?.status, "error");
      const run = JSON.parse(((await client.callTool({ name: "getRun", arguments: { id: runs.runs[0]!.id } })) as ToolResult).content[0]!.text) as {
        error?: string;
      };
      assert.match(run.error ?? "", /確かめが合いませんでした/);
      await new Promise((res) => setTimeout(res, 100));
      assert.deepEqual(delivered, [], "失敗を札でも届けた（tool の失敗で返したのに）");
    },
  );
});

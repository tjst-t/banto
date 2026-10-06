// **Factory が使う口**（追加・2026-10-06、v4-modules.md §4.5「Subagent に足すもの」）：作業場所（cwd）・決まった形で返させる
// （schema）・頼んだ Module から止める。偽のエージェントで端から端まで通す。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CALLER_MODULE_META_KEY, REPLY_TO_META_KEY, THREAD_META_KEY } from "@banto/module-contract";
import { listAgents } from "./agents.js";
import { localClaudeLogin } from "./claude-login-access.js";
import { createSubagentServer } from "./server.js";
import { fakeVault } from "./testing/harness.js";

type Delivered = { replyTo: string; title: string; text: string };
type ToolResult = { content: { text: string }[]; isError?: boolean };

async function withServer(fn: (ctx: { client: Client; project: string; delivered: Delivered[] }) => Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), "subagent-factory-"));
  const project = join(root, "project");
  const data = join(root, "data");
  mkdirSync(join(project, ".worktrees", "factory-x"), { recursive: true });
  mkdirSync(join(root, "outside"), { recursive: true });
  symlinkSync(join(root, "outside"), join(project, "escape"));
  mkdirSync(data, { recursive: true });
  const delivered: Delivered[] = [];
  const server = createSubagentServer({
    projectRoot: project,
    moduleDataDir: data,
    relayClient: fakeVault().relay,
    agents: listAgents({ BANTO_SUBAGENT_FAKE_AGENT: "1" }),
    claudeLogin: localClaudeLogin({ credentialsPath: "/nonexistent/.credentials.json" }),
    deliver: async (input) => void delivered.push(input),
  });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  try {
    await fn({ client, project, delivered });
  } finally {
    await client.close();
    rmSync(root, { recursive: true, force: true });
  }
}

const run = (client: Client, args: Record<string, unknown>, meta?: Record<string, unknown>) =>
  client.callTool({ name: "runSubagent", arguments: { agent: "fake", ...args }, ...(meta ? { _meta: meta } : {}) }) as Promise<ToolResult>;
const body = (r: ToolResult) => JSON.parse(r.content[0]!.text) as Record<string, unknown>;
const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64");

test("cwd：Project root の中のフォルダで働かせられる——外・リンクで外へ出る道・無いフォルダは断る", async () => {
  await withServer(async ({ client, project }) => {
    const inside = body(await run(client, { prompt: "[cwd]", cwd: ".worktrees/factory-x" }));
    assert.match(String(inside.text), new RegExp(`cwd=${realpathSync(join(project, ".worktrees", "factory-x"))}`));
    const def = body(await run(client, { prompt: "[cwd]" }));
    assert.match(String(def.text), new RegExp(`cwd=${project}`));
    for (const cwd of ["..", "/tmp", "escape", "nothing-here"]) {
      const r = await run(client, { prompt: "[cwd]", cwd });
      assert.equal(r.isError, true, `${cwd} を断らなかった`);
    }
  });
});

const VERDICT = {
  type: "object",
  required: ["verdict", "items"],
  properties: { verdict: { enum: ["pass", "changes"] }, items: { type: "array" } },
};

test("schema：合う JSON は structured に入る。合わなければ同じ会話で直させ、直れば通る", async () => {
  await withServer(async ({ client }) => {
    const ok = body(await run(client, { prompt: `[json-b64 ${b64({ verdict: "pass", items: [] })}]`, schema: VERDICT }));
    assert.deepEqual(ok.structured, { verdict: "pass", items: [] });
    const fixed = body(await run(client, { prompt: `[bad-then-json-b64 ${b64({ verdict: "changes", items: [{ what: "x" }] })}]`, schema: VERDICT }));
    assert.deepEqual(fixed.structured, { verdict: "changes", items: [{ what: "x" }] });
    assert.ok((fixed.notes as string[]).some((n) => n.includes("直させました")), "直させたことが notes に無い");
  });
});

test("schema：直させても合わなければ失敗にする（文のまま返さない）。読めない schema はエージェントを起こさずに断る", async () => {
  await withServer(async ({ client }) => {
    const never = await run(client, { prompt: `[json-b64 ${b64({ verdict: "maybe" })}]`, schema: VERDICT });
    assert.equal(never.isError, true);
    assert.match(never.content[0]!.text, /決まった形の返答になりませんでした/);
    const bad = await run(client, { prompt: "x", schema: { type: "no-such-type" } });
    assert.equal(bad.isError, true);
    assert.match(bad.content[0]!.text, /JSON Schema/);
  });
});

test("待たない形でも structured が届く", async () => {
  await withServer(async ({ client, delivered }) => {
    await run(client, { prompt: `[json-b64 ${b64({ verdict: "pass", items: [] })}]`, schema: VERDICT, runInBackground: true }, {
      [REPLY_TO_META_KEY]: "reply_x",
    });
    for (let i = 0; i < 100 && delivered.length === 0; i++) await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual(JSON.parse(delivered[0]!.text).structured, { verdict: "pass", items: [] });
  });
});

test("cancelSubagent：Module が中継で頼んだ仕事は、同じ Module（接続名）からだけ止められる", async () => {
  await withServer(async ({ client, delivered }) => {
    const factory = { [CALLER_MODULE_META_KEY]: { name: "factory", conn: "factory-p1" } };
    const r = body(await run(client, { prompt: "[slow 30] 長い", runInBackground: true }, { ...factory, [REPLY_TO_META_KEY]: "reply_f" }));
    const runId = String(r.runId);
    // 走り出す（最初の tool を呼ぶ）まで待つ
    for (let i = 0; i < 100; i++) {
      const runs = JSON.parse(((await client.callTool({ name: "listRuns", arguments: {} })) as ToolResult).content[0]!.text) as {
        runs: Array<{ id: string; lastProgress?: string }>;
      };
      if (runs.runs.find((x) => x.id === runId)?.lastProgress?.startsWith("ツール：")) break;
      await new Promise((res) => setTimeout(res, 100));
    }
    const cancel = (meta: Record<string, unknown>) =>
      client.callTool({ name: "cancelSubagent", arguments: { runId }, _meta: meta }) as Promise<ToolResult>;
    // 別の Module・Thread からは止められない
    assert.equal((await cancel({ [CALLER_MODULE_META_KEY]: { name: "factory", conn: "factory-p2" } })).isError, true);
    assert.equal((await cancel({ [THREAD_META_KEY]: { projectId: "p1", threadId: "t1" } })).isError, true);
    const ok = await cancel(factory);
    assert.equal(ok.isError, undefined, ok.content[0]!.text);
    for (let i = 0; i < 300 && delivered.length === 0; i++) await new Promise((res) => setTimeout(res, 50));
    assert.match(delivered[0]!.title, /止められました/);
    // Thread が頼んだ仕事は Module からは止められない
    const t = body(await run(client, { prompt: "[slow 30] 長い", runInBackground: true }, {
      [THREAD_META_KEY]: { projectId: "p1", threadId: "t1" },
      [REPLY_TO_META_KEY]: "reply_t",
    }));
    const refused = (await client.callTool({ name: "cancelSubagent", arguments: { runId: t.runId }, _meta: factory })) as ToolResult;
    assert.equal(refused.isError, true);
    await client.callTool({ name: "cancelSubagent", arguments: { runId: t.runId }, _meta: { [THREAD_META_KEY]: { projectId: "p1", threadId: "t1" } } });
  });
});

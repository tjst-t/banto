// **仕事が終わったら、エージェントの仕事の組（banto-subagent-*.scope）を残さない**（Backlog #294）。
// 見るもの（本物のユーザーの systemd で scope を作れるときだけ——コンテナの中の Subagent と同じ形）：
//   - Factory と同じ頼み方（待たない形・worktree の cwd）で1件流し終えたら、組が無い。グループを抜けた子（setsid——
//     ssh-agent -D・E2E が後ろに回したものと同じ）も残らない
//   - 待つ形も同じ
//   - 起きたときの片づけ：記録に無い組は止め、走っている仕事の記録にある組は残す（続ける前に止める道がある）。
//     同じ Project の同じ実装の別の1本（印が違う）の組・印の無い組には触らない
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { REPLY_TO_META_KEY, THREAD_META_KEY, inWorkScope, resetWorkScopeProbe, workScopeAvailable, workScopeEnv, workScopeOwner } from "@banto/module-contract";
import { listAgents } from "./agents.js";
import { createSubagentServer, sweepLeftoverAgentScopes } from "./server.js";
import { agentScopeOwner } from "./acp-run.js";
import { RunningStore, type RunningRecord } from "./running.js";
import { fakeVault } from "./testing/harness.js";

type ToolResult = { content: { text: string }[]; isError?: boolean };

// コンテナの中の Module と同じ形にする（組に入れるかは BANTO_IN_CONTAINER とユーザーの systemd のバスで決まる）
process.env.BANTO_IN_CONTAINER = "1";
delete process.env.BANTO_WORK_SCOPE;
resetWorkScopeProbe();
const realSystemd = workScopeAvailable();
const skip = realSystemd ? false : "ユーザーの systemd で scope を作れない（コンテナの外・入れ子のコンテナ）";

function scopeActive(unit: string): boolean {
  const r = spawnSync("systemctl", ["--user", "show", "--property=ActiveState", "--value", unit], { env: workScopeEnv(), encoding: "utf8" });
  return r.stdout.trim() === "active";
}

function escapedChildren(sessionId: string): string[] {
  return execFileSync("ps", ["-eo", "args"], { encoding: "utf8" })
    .split("\n")
    .filter((l) => l.includes(`fake-agent-escape ${sessionId}`));
}

async function withModule(fn: (m: { client: Client; project: string; data: string; delivered: Array<{ text: string }> }) => Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), "subagent-scope-"));
  const project = join(root, "project");
  const data = join(root, "data");
  mkdirSync(join(project, ".worktrees", "factory-x"), { recursive: true });
  mkdirSync(data, { recursive: true });
  const delivered: Array<{ text: string }> = [];
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
  });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  try {
    await fn({ client, project, data, delivered });
  } finally {
    await client.close();
    rmSync(root, { recursive: true, force: true });
  }
}

const readRunning = (data: string): RunningRecord[] => {
  const dir = join(data, "running");
  try {
    return readdirSync(dir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")) as RunningRecord);
  } catch {
    return [];
  }
};

test("Factory と同じ頼み方で1件流し終えたら、エージェントの組もグループを抜けた子も残らない", { skip }, async () => {
  await withModule(async ({ client, data, delivered }) => {
    const res = (await client.callTool({
      name: "runSubagent",
      arguments: { agent: "fake", prompt: "[escape 300] [slow 2] 実装して", cwd: ".worktrees/factory-x", runInBackground: true },
      _meta: { [REPLY_TO_META_KEY]: "reply_scope", [THREAD_META_KEY]: { projectId: "p1", threadId: "t1" } },
    })) as ToolResult;
    assert.equal(res.isError, undefined, res.content[0]?.text);
    let unit: string | undefined;
    for (let i = 0; i < 200 && !unit; i++) {
      unit = readRunning(data)[0]?.agentProcess?.unit;
      if (!unit) await new Promise((r) => setTimeout(r, 50));
    }
    assert.ok(unit, "走っている仕事の記録に組の名前が残らない");
    assert.equal(unit, `banto-subagent-${agentScopeOwner()}-${unit.slice(-14, -6)}.scope`);
    assert.match(unit, /^banto-subagent-[0-9a-f]{8}-[0-9a-f]{8}\.scope$/);
    assert.equal(scopeActive(unit), true, "走っている間に組が無い（試験の前提）");
    for (let i = 0; i < 400 && delivered.length === 0; i++) await new Promise((r) => setTimeout(r, 50));
    assert.equal(delivered.length, 1, "終わりが届かない");
    const body = JSON.parse(delivered[0]!.text) as { sessionId: string; stopReason?: string; error?: string };
    assert.equal(body.stopReason, "end_turn", delivered[0]!.text);
    assert.equal(scopeActive(unit), false, `${unit} が残っている`);
    assert.deepEqual(escapedChildren(body.sessionId), [], "グループを抜けた子が残っている");
  });
});

test("待つ形でも、終わったらグループを抜けた子ごと止まる", { skip }, async () => {
  await withModule(async ({ client }) => {
    const res = (await client.callTool({ name: "runSubagent", arguments: { agent: "fake", prompt: "[escape 300] 待つ形" } })) as ToolResult;
    assert.equal(res.isError, undefined, res.content[0]?.text);
    const body = JSON.parse(res.content[0]!.text) as { sessionId: string };
    assert.deepEqual(escapedChildren(body.sessionId), [], "グループを抜けた子が残っている");
  });
});

test("起きたときの片づけ：記録に無い組は止め、走っている仕事の記録にある組・別の1本の組は残す", { skip }, async () => {
  // 本物の banto-subagent-*.scope（この機械で走っている仕事）に触らないよう、試験だけの頭を使う
  const kind = `subagent-sweeptest-${randomBytes(3).toString("hex")}`;
  const owner = agentScopeOwner();
  const otherOwner = workScopeOwner("subagent", { BANTO_MODULE_NAME: "subagent-second" });
  assert.notEqual(owner, otherOwner);
  const start = (o: string | null = owner) => {
    const launch = inWorkScope(process.execPath, ["-e", "setTimeout(() => {}, 300000)"], { kind, ...(o ? { owner: o } : {}) });
    assert.ok(launch.unit);
    const child = spawn(launch.command, launch.args, { env: launch.env, stdio: "ignore", detached: true });
    child.unref();
    return launch.unit;
  };
  const stray = start();
  const recorded = start();
  // 同じ Project に立てた2本目の Subagent が走らせている仕事・印の無い組（この1本のものか分からない）
  const others = [start(otherOwner), start(null)];
  const data = mkdtempSync(join(tmpdir(), "subagent-sweep-"));
  try {
    const all = [stray, recorded, ...others];
    for (let i = 0; i < 100 && !all.every(scopeActive); i++) await new Promise((r) => setTimeout(r, 50));
    assert.ok(all.every(scopeActive), "組が起きない（試験の前提）");
    new RunningStore(data).write({
      id: "r1",
      agent: "fake",
      agentTitle: "偽",
      cwd: "/",
      replyToFingerprint: "f",
      prompt: "p",
      promptHead: "p",
      startedAt: Date.now(),
      progressed: false,
      toolsInFlight: [],
      agentProcess: { pid: 999999, unit: recorded },
      resumes: 0,
    });
    const r = await sweepLeftoverAgentScopes(data, { kind });
    assert.deepEqual(r, { stopped: [stray], failed: [] });
    assert.equal(scopeActive(stray), false);
    assert.equal(scopeActive(recorded), true, "記録にある組まで止めた");
    for (const u of others) assert.equal(scopeActive(u), true, `この1本のものでない組 ${u} まで止めた`);
  } finally {
    spawnSync("systemctl", ["--user", "stop", stray, recorded, ...others], { env: workScopeEnv() });
    rmSync(data, { recursive: true, force: true });
  }
});

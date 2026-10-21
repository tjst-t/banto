// **試作を始める**（決定・2026-10-21、ユーザー。アーキ仕様 §2.2「コンテナは試作を始めたときに作る」）。
//
// 確かめること：`start_prototyping`（banto-thread）はチャットでだけ見え、人の承認を求めずに通る。呼ぶと Project 層の差分が
// 外れて `project.prototyping.started` が積まれるが、道具が増えるのは次のターンから。ターンが最後まで行ったら同じ Thread に
// banto の届けものが1通積まれ、続きのターンが自動で始まり、そこで Project のコンテナの Module（Shell・FileSystem など）が渡って
// コンテナが用意される。最後まで行かなかったターンでは続けない。

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { EventLog } from "../event-store/log.js";
import { ProjectThreadStore } from "../project-thread/store.js";
import { GlobalMemoryStore } from "../global-memory/store.js";
import { InboxStore } from "../inbox/store.js";
import { PendingApprovalRegistry } from "../inbox/pending-approvals.js";
import { RuntimeConfigStore } from "../config/runtime.js";
import { HostRelayEndpoint, RelayRegistry } from "../relay/host-relay-endpoint.js";
import { AgentRelayEndpoint } from "../relay/agent-relay-endpoint.js";
import { ThreadTurns } from "../delivery/thread-turns.js";
import { ThreadDeliveries } from "../delivery/thread-deliveries.js";
import { loadModuleDeclarations, modulePlacement } from "../modules/declaration.js";
import { createApp } from "./app.js";
import { FORK_SERVER_NAME, START_PROTOTYPING_TOOL_NAME } from "./fork-tool.js";
import { PROTOTYPING_CONTINUE_TEXT } from "./chat-project.js";

type RunnerOpts = {
  prompt: string;
  mcpServers: Record<string, unknown>;
  allowedTools?: string[];
};

type RegisteredTools = Record<string, { handler: (args: unknown, extra: unknown) => Promise<unknown> }>;

function toolsOf(opts: RunnerOpts): RegisteredTools {
  return (opts.mcpServers[FORK_SERVER_NAME] as { instance: { _registeredTools: RegisteredTools } }).instance._registeredTools;
}

async function callStartPrototyping(opts: RunnerOpts) {
  return (await toolsOf(opts)[START_PROTOTYPING_TOOL_NAME]!.handler({}, {})) as { isError?: boolean; content: Array<{ text: string }> };
}

/** 渡った MCP サーバが全部繋がったと名乗る（中継の健全性の検査を通す） */
function init(sessionId: string, opts: RunnerOpts) {
  const mcp_servers = Object.keys(opts.mcpServers).map((name) => ({ name, status: "connected" }));
  return { type: "message" as const, message: { type: "system", subtype: "init", session_id: sessionId, mcp_servers } };
}
function say(text: string) {
  return { type: "message" as const, message: { type: "assistant", message: { content: [{ type: "text", text }] } } };
}

interface Harness {
  base: string;
  headers: Record<string, string>;
  projectThread: ProjectThreadStore;
  runtimeConfig: RuntimeConfigStore;
  inbox: InboxStore;
  turns: ThreadTurns;
  /** ターンごとに、Project のコンテナで動く Module を繋いだ（＝コンテナを用意した）名前 */
  prepared: string[][];
}

async function withChatApp(runner: (opts: RunnerOpts) => AsyncGenerator<unknown, unknown>, fn: (h: Harness) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "banto-start-prototyping-"));
  try {
    const log = new EventLog(dir);
    await log.init();
    const projectThread = new ProjectThreadStore(dir, log);
    await projectThread.load();
    const globalMemory = new GlobalMemoryStore(dir, log);
    await globalMemory.load();
    const inbox = new InboxStore(dir, log);
    await inbox.load();
    const runtimeConfig = new RuntimeConfigStore(dir, log);
    await runtimeConfig.load();
    const turns = new ThreadTurns();
    const deliveries = new ThreadDeliveries({ projectThread, turns, notify: async () => {} });
    const prepared: string[][] = [];
    const token = "test-token";
    const server = createApp({
      projectThread,
      globalMemory,
      inbox,
      pendingApprovals: new PendingApprovalRegistry(),
      runtimeConfig,
      relayEndpoint: new HostRelayEndpoint({ registry: new RelayRegistry() }),
      agentRelayEndpoint: new AgentRelayEndpoint(token),
      authToken: token,
      // 本物（cli.ts）と同じく、ターンの始まりに Module の組を解決し、Project のコンテナで動く Module を繋ぐときだけそのコンテナを用意する
      resolveModulesForThread: async (threadId: string) => {
        const projectId = projectThread.getThread(threadId)!.projectId;
        const here: string[] = [];
        prepared.push(here);
        return loadModuleDeclarations(runtimeConfig, projectId).map((d) => {
          if (modulePlacement(d.meta, d.launch) === "project-container") here.push(d.name);
          return { name: d.name, url: `http://127.0.0.1:1/agent-relay/${d.name}`, headers: {} };
        });
      },
      dataDir: dir,
      configDir: dir,
      chatsDir: join(dir, "chats"),
      threadTurns: turns,
      deliveries,
      runTurn: runner as unknown as Parameters<typeof createApp>[0]["runTurn"],
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      await fn({
        base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        projectThread,
        runtimeConfig,
        inbox,
        turns,
        prepared,
      });
    } finally {
      server.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function waitFor(cond: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.fail(`待ちきれませんでした: ${what}`);
}

async function createChat(h: Harness): Promise<{ projectId: string; threadId: string }> {
  const res = await fetch(`${h.base}/api/projects`, { method: "POST", headers: h.headers, body: JSON.stringify({ kind: "chat" }) });
  assert.equal(res.status, 201);
  const chat = (await res.json()) as { id: string };
  const thread = await h.projectThread.createBaseThread(chat.id);
  return { projectId: chat.id, threadId: thread.id };
}

const TOOL = `mcp__${FORK_SERVER_NAME}__${START_PROTOTYPING_TOOL_NAME}`;

test("チャットで start_prototyping を呼ぶと、承認なしで通り、ターンの終わりに banto の続きが届いて、次のターンで試作の道具が渡りコンテナが用意される", async () => {
  const calls: RunnerOpts[] = [];
  let duringTurn: { prototyping?: boolean; modulesNow: string[] } | undefined;
  let probe: () => { prototyping?: boolean; modulesNow: string[] } = () => ({ modulesNow: [] });
  await withChatApp(
    async function* (opts) {
      calls.push(opts);
      yield init("s", opts);
      if (calls.length === 1) {
        const r = await callStartPrototyping(opts);
        assert.equal(r.isError, undefined, r.content[0]!.text);
        duringTurn = probe();
        yield say("試作を始めます");
      } else {
        yield say("作ります");
      }
      return { sessionId: "s", compactionCount: 0 };
    },
    async (h) => {
      const { projectId, threadId } = await createChat(h);
      probe = () => ({
        prototyping: h.projectThread.getProject(projectId)!.prototyping,
        modulesNow: loadModuleDeclarations(h.runtimeConfig, projectId).map((d) => d.name),
      });
      const all = loadModuleDeclarations(h.runtimeConfig, "");
      const inContainer = all.filter((d) => modulePlacement(d.meta, d.launch) === "project-container").map((d) => d.name);
      assert.ok(inContainer.length > 0, "既定に Project のコンテナで動く Module が無い（試験の前提）");

      const res = await fetch(`${h.base}/api/threads/${threadId}/messages`, { method: "POST", headers: h.headers, body: JSON.stringify({ prompt: "試しに作ってみたい" }) });
      assert.match(await res.text(), /"type":"done"/);

      // 1回目：道具が見え、承認なしで通す一覧に載っている。話すだけなのでコンテナは用意していない
      assert.ok(toolsOf(calls[0]!)[START_PROTOTYPING_TOOL_NAME], "チャットに start_prototyping が無い");
      assert.ok(calls[0]!.allowedTools?.includes(TOOL), "start_prototyping が承認なしで通る一覧に無い");
      assert.deepEqual(h.prepared[0], []);
      // 呼んだ時点で差分は外れ、記録も積まれている（このターンの Module の組は変わらない）
      assert.equal(duringTurn?.prototyping, true);
      assert.deepEqual(duringTurn?.modulesNow, all.map((d) => d.name));
      for (const name of inContainer) assert.ok(!Object.keys(calls[0]!.mcpServers).includes(name), `${name} が1回目に渡っていた`);

      // 続きのターンが自動で始まる
      await waitFor(() => calls.length === 2 && !h.turns.isRunning(threadId), "続きのターン");
      const second = calls[1]!;
      assert.match(second.prompt, /banto-delivery/);
      assert.ok(second.prompt.includes(PROTOTYPING_CONTINUE_TEXT));
      // 2回目：Shell・FileSystem などが渡り、コンテナが用意される。道具はもう見せない
      for (const name of inContainer) assert.ok(Object.keys(second.mcpServers).includes(name), `${name} が2回目に渡っていない`);
      assert.deepEqual([...h.prepared[1]!].sort(), [...inContainer].sort());
      assert.equal(toolsOf(second)[START_PROTOTYPING_TOOL_NAME], undefined);

      // 人に聞いていない（判断待ちが出ていない）・届けものは1通だけで、待ち行列に残っていない
      assert.deepEqual(h.inbox.listOpen().filter((i) => i.kind === "judgment"), []);
      assert.equal(h.projectThread.getThread(threadId)!.deliveries?.length ?? 0, 0);
      await new Promise((r) => setTimeout(r, 50));
      assert.equal(calls.length, 2, "続きは1回だけ");

      // 一覧：試作を始めた
      const list = (await (await fetch(`${h.base}/api/projects`, { headers: h.headers })).json()) as Array<{ id: string; prototyping?: boolean }>;
      assert.equal(list.find((p) => p.id === projectId)?.prototyping, true);
    },
  );
});

test("普通の Project には start_prototyping を見せない", async () => {
  const calls: RunnerOpts[] = [];
  await withChatApp(
    async function* (opts) {
      calls.push(opts);
      yield init("s", opts);
      yield say("はい");
      return { sessionId: "s", compactionCount: 0 };
    },
    async (h) => {
      const project = await h.projectThread.createProject("demo", "/tmp");
      const base = await h.projectThread.createBaseThread(project.id);
      const res = await fetch(`${h.base}/api/threads/${base.id}/messages`, { method: "POST", headers: h.headers, body: JSON.stringify({ prompt: "こんにちは" }) });
      assert.match(await res.text(), /"type":"done"/);
      assert.equal(calls.length, 1);
      assert.equal(toolsOf(calls[0]!)[START_PROTOTYPING_TOOL_NAME], undefined);
    },
  );
});

test("試作を始めたターンが最後まで行かなければ、続きは届けない（試作は始まっていて、次に人が送ったターンから道具が渡る）", async () => {
  const calls: RunnerOpts[] = [];
  await withChatApp(
    async function* (opts) {
      calls.push(opts);
      yield init("s", opts);
      if (calls.length === 1) {
        await callStartPrototyping(opts);
        throw new Error("途中で落ちた");
      }
      yield say("はい");
      return { sessionId: "s", compactionCount: 0 };
    },
    async (h) => {
      const { projectId, threadId } = await createChat(h);
      const res = await fetch(`${h.base}/api/threads/${threadId}/messages`, { method: "POST", headers: h.headers, body: JSON.stringify({ prompt: "作ってみたい" }) });
      assert.match(await res.text(), /"type":"error"/);
      await waitFor(() => !h.turns.isRunning(threadId), "ターンの終わり");
      await new Promise((r) => setTimeout(r, 50));
      assert.equal(calls.length, 1, "続きを始めた");
      assert.equal(h.projectThread.getThread(threadId)!.deliveries?.length ?? 0, 0);
      assert.equal(h.projectThread.getProject(projectId)!.prototyping, true);
    },
  );
});

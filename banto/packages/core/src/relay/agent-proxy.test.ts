// InMemoryTransportで実際のMCPプロトコルのやり取り（tools/list・tools/call・
// resources/read）を、実APIを叩かずに検証する。relay.integration.mjs
// （実API使用、手動確認用）で確認した挙動を、恒常的な自動テストとしても持つ。

import { test } from "node:test";
import assert from "node:assert/strict";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { parseModuleMeta } from "@banto/module-contract";
import { buildAgentProxy } from "./agent-proxy.js";

async function setupFakeModuleClient(): Promise<Client> {
  const server = new Server(
    { name: "fake-vault", version: "0.0.0" },
    { capabilities: { tools: {}, resources: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "requestAlias",
        description: "agent向け",
        inputSchema: { type: "object", properties: {} },
        _meta: { "dev.banto/visibility": "agent", "com.example/keep": "me" },
      },
      {
        name: "resolveAlias",
        description: "module向け",
        inputSchema: { type: "object", properties: {} },
        _meta: { "dev.banto/visibility": "module" },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    if (req.params.name === "requestAlias") {
      return { content: [{ type: "text", text: "REQUEST-ACCEPTED" }] };
    }
    if (req.params.name === "resolveAlias") {
      return { content: [{ type: "text", text: "SECRET-VALUE" }] };
    }
    throw new Error("unknown tool");
  });

  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: [
      { uri: "vault://aliases", name: "aliases", _meta: { "dev.banto/visibility": "agent" } },
    ],
  }));

  server.setRequestHandler(ReadResourceRequestSchema, async (req) => {
    if (req.params.uri === "vault://aliases") {
      return { contents: [{ uri: req.params.uri, text: "github-token" }] };
    }
    if (req.params.uri === "vault://internal/audit") {
      return { contents: [{ uri: req.params.uri, text: "SECRET-AUDIT" }] };
    }
    throw new Error("not found");
  });

  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-host", version: "0.0.0" }, { capabilities: { elicitation: {} } });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

async function setupProxyAndRunnerClient() {
  const moduleClient = await setupFakeModuleClient();
  const meta = parseModuleMeta(
    { satisfies: ["vault"], dependsOn: [], isolation: "subprocess" },
    "fake-vault",
  );
  const relayLog: unknown[] = [];
  const proxy = buildAgentProxy(
    { name: "vault", client: moduleClient, meta },
    { onRelay: (r) => relayLog.push(r) },
  );

  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  const runnerClient = new Client({ name: "runner", version: "0.0.0" });
  await Promise.all([
    proxy.server.connect(serverTransport),
    runnerClient.connect(clientTransport),
  ]);
  return { runnerClient, relayLog };
}

test("agent-visible tool reaches the runner client, module-visible does not", async () => {
  const { runnerClient } = await setupProxyAndRunnerClient();
  const { tools } = await runnerClient.listTools();
  const names = tools.map((t) => t.name);
  assert.ok(names.includes("requestAlias"));
  assert.ok(!names.includes("resolveAlias"), "module可視性のtoolが見えている");
});

test("_meta dev.banto/ prefix is stripped, other vendor meta kept", async () => {
  const { runnerClient } = await setupProxyAndRunnerClient();
  const { tools } = await runnerClient.listTools();
  const t = tools.find((t) => t.name === "requestAlias")!;
  assert.equal((t._meta as Record<string, unknown> | undefined)?.["dev.banto/visibility"], undefined);
  assert.equal((t._meta as Record<string, unknown> | undefined)?.["com.example/keep"], "me");
});

test("calling a module-visible tool by name is rejected even though the name is guessable", async () => {
  const { runnerClient, relayLog } = await setupProxyAndRunnerClient();
  await assert.rejects(() => runnerClient.callTool({ name: "resolveAlias", arguments: {} }));
  assert.ok(
    (relayLog as { direction: string; name: string; allowed: boolean }[]).some(
      (r) => r.direction === "call" && r.name === "resolveAlias" && r.allowed === false,
    ),
  );
});

test("calling the agent-visible tool works and is recorded as allowed", async () => {
  const { runnerClient, relayLog } = await setupProxyAndRunnerClient();
  const result = await runnerClient.callTool({ name: "requestAlias", arguments: {} });
  assert.equal((result.content as { type: string; text: string }[])[0]?.text, "REQUEST-ACCEPTED");
  assert.ok(
    (relayLog as { direction: string; name: string; allowed: boolean }[]).some(
      (r) => r.direction === "call" && r.name === "requestAlias" && r.allowed === true,
    ),
  );
});

test("resource visibility fails closed for a URI not in the list (the asymmetry the spec warns about)", async () => {
  const { runnerClient } = await setupProxyAndRunnerClient();
  // vault://internal/audit is never listed anywhere — must be denied, not silently readable.
  await assert.rejects(() => runnerClient.readResource({ uri: "vault://internal/audit" }));
});

test("resource visibility allows an exact-listed agent-visible resource", async () => {
  const { runnerClient } = await setupProxyAndRunnerClient();
  const result = await runnerClient.readResource({ uri: "vault://aliases" });
  assert.equal((result.contents as { text: string }[])[0]?.text, "github-token");
});

// **resource の読み取りも、どのターンの仕事かを台帳に置く**（追加・2026-09-12）。
// tool 呼び出しには前からあったが、読み取りには無かった——**中で他 Module を
// 呼ぶ resource**（横断した一覧を作る窓口など）は、承認ゲートが
// 「どのターンからの呼び出しか特定できません」で構造的に必ず拒否されていた。
test("resource を読んでいる間も、その Module はそのターンの仕事をしている", async () => {
  const { ModuleCallTracker } = await import("./module-calls.js");
  const moduleCalls = new ModuleCallTracker();
  let seen: unknown;

  const server = new Server({ name: "fake", version: "0.0.0" }, { capabilities: { resources: {} } });
  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: [{ uri: "vault://aliases", name: "一覧", _meta: { "dev.banto/visibility": "agent" } }],
  }));
  server.setRequestHandler(ReadResourceRequestSchema, async () => {
    // **読んでいる最中**に外から覗く——中継の承認はここで起きる
    seen = moduleCalls.threadFor("fake-module");
    return { contents: [{ uri: "vault://aliases", mimeType: "application/json", text: "[]" }] };
  });
  const [s, c] = InMemoryTransport.createLinkedPair();
  const moduleClient = new Client({ name: "host", version: "0.0.0" });
  await Promise.all([server.connect(s), moduleClient.connect(c)]);

  const proxy = buildAgentProxy(
    { name: "fake-module", client: moduleClient, meta: parseModuleMeta({ satisfies: ["vault"], dependsOn: [], isolation: "subprocess" }, "fake") },
    { threadId: "thread-1", moduleCalls },
  );
  const [ps, pc] = InMemoryTransport.createLinkedPair();
  const runner = new Client({ name: "runner", version: "0.0.0" });
  await Promise.all([proxy.server.connect(ps), runner.connect(pc)]);

  await runner.readResource({ uri: "vault://aliases" });
  assert.deepEqual(seen, { kind: "thread", threadId: "thread-1" }, "読み取り中に台帳へ載っていない");
  // **読み終わったら消える**（置きっぱなしにしない）
  assert.deepEqual(moduleCalls.threadFor("fake-module"), { kind: "none" });

  await runner.close();
  await moduleClient.close();
});

// **効かせた Skill は代理サーバの `instructions` で届ける**（決定・2026-09-23、§5.6）。
// Runner はこれをモデルの文脈の冒頭に入れる（実測）。組み立てるのは core で、
// 実 Module が自分で返した `instructions` は転送しない。
test("core が組み立てた instructions が、initialize の応答で Runner に届く", async () => {
  const server = new Server(
    { name: "fake", version: "0.0.0" },
    // 実 Module が自分の instructions を返しても、それは転送しない
    { capabilities: { resources: {} }, instructions: "MODULE-OWN-INSTRUCTIONS" },
  );
  server.setRequestHandler(ListResourcesRequestSchema, async () => ({ resources: [] }));
  const [s, c] = InMemoryTransport.createLinkedPair();
  const moduleClient = new Client({ name: "host", version: "0.0.0" });
  await Promise.all([server.connect(s), moduleClient.connect(c)]);
  const meta = parseModuleMeta({ satisfies: [], dependsOn: [], isolation: "subprocess" }, "fake");

  async function connectRunner(instructions?: string) {
    const proxy = buildAgentProxy({ name: "skills", client: moduleClient, meta }, { instructions });
    const [ps, pc] = InMemoryTransport.createLinkedPair();
    const runner = new Client({ name: "runner", version: "0.0.0" });
    await Promise.all([proxy.server.connect(ps), runner.connect(pc)]);
    return runner;
  }

  const withSkills = await connectRunner("# Skill\n\n- **pdf**");
  assert.equal(withSkills.getInstructions(), "# Skill\n\n- **pdf**");

  const without = await connectRunner(undefined);
  assert.equal(without.getInstructions(), undefined, "Module が返した instructions が素通りした");

  await withSkills.close();
  await without.close();
  await moduleClient.close();
});

// **AI のターンからの呼び出しには、どの Thread かを刻む**（追加・2026-10-03、`dev.banto/thread`）。
// Backlog が「取り組んだ Thread」を残すのに使う。Project か Thread のどちらかが分からない接続では刻まない
test("AI のターンからの tool 呼び出しに、Project と Thread の刻印が付く（片方しか分からなければ付かない）", async () => {
  const seen: Array<Record<string, unknown> | undefined> = [];
  const server = new Server({ name: "fake", version: "0.0.0" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [{ name: "updateItem", inputSchema: { type: "object", properties: {} }, _meta: { "dev.banto/visibility": "agent" } }],
  }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    seen.push(req.params._meta as Record<string, unknown> | undefined);
    return { content: [{ type: "text", text: "ok" }] };
  });
  const [s, c] = InMemoryTransport.createLinkedPair();
  const moduleClient = new Client({ name: "host", version: "0.0.0" });
  await Promise.all([server.connect(s), moduleClient.connect(c)]);
  const meta = parseModuleMeta({ satisfies: ["backlog"], dependsOn: [], isolation: "subprocess" }, "fake");

  async function callWith(opts: { projectId?: string; threadId?: string }) {
    const proxy = buildAgentProxy({ name: "backlog", client: moduleClient, meta }, opts);
    const [ps, pc] = InMemoryTransport.createLinkedPair();
    const runner = new Client({ name: "runner", version: "0.0.0" });
    await Promise.all([proxy.server.connect(ps), runner.connect(pc)]);
    await runner.callTool({ name: "updateItem", arguments: {} });
    await runner.close();
  }

  await callWith({ projectId: "p1", threadId: "t1" });
  await callWith({ projectId: "p1" });
  await callWith({ threadId: "t1" });

  assert.deepEqual(seen[0]?.["dev.banto/thread"], { projectId: "p1", threadId: "t1" });
  assert.equal(seen[1]?.["dev.banto/thread"], undefined, "Thread が分からないのに刻んだ");
  assert.equal(seen[2]?.["dev.banto/thread"], undefined, "Project が分からないのに刻んだ");
  await moduleClient.close();
});

// **バックグラウンドの仕事の手がかり**（追加・2026-10-03、v4-frontend.md §6.33）。「終わったら届ける」tool の札を出すとき、
// Runner の tool_use の id・カードの題と説明（引数で埋めたもの）・画面を一緒に覚える
test("終わったら届ける tool の札に、tool_use の id・埋めたカードの文・画面が付く（Runner が id を渡さなければ id は無い）", async () => {
  const server = new Server({ name: "fake", version: "0.0.0" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "runSubagent",
        inputSchema: { type: "object", properties: {} },
        _meta: {
          "dev.banto/visibility": "agent",
          "dev.banto/deliversLater": true,
          "dev.banto/card": { title: "{agent} に頼んだ仕事", description: "{prompt}" },
          ui: { resourceUri: "ui://banto-subagent/runs" },
        },
      },
    ],
  }));
  server.setRequestHandler(CallToolRequestSchema, async () => ({ content: [{ type: "text", text: "ok" }] }));
  const [s, c] = InMemoryTransport.createLinkedPair();
  const moduleClient = new Client({ name: "host", version: "0.0.0" });
  await Promise.all([server.connect(s), moduleClient.connect(c)]);
  const meta = parseModuleMeta({ satisfies: ["subagent"], dependsOn: [], isolation: "subprocess" }, "fake");

  const issued: Array<Record<string, unknown>> = [];
  const proxy = buildAgentProxy(
    { name: "subagent-p1", declaredName: "subagent", client: moduleClient, meta },
    {
      projectId: "p1",
      threadId: "t1",
      replies: {
        issue: (input) => {
          issued.push(input as unknown as Record<string, unknown>);
          return `reply_${issued.length}`;
        },
        markAwaiting: async () => {},
      },
    },
  );
  const [ps, pc] = InMemoryTransport.createLinkedPair();
  const runner = new Client({ name: "runner", version: "0.0.0" });
  await Promise.all([proxy.server.connect(ps), runner.connect(pc)]);

  await runner.callTool({
    name: "runSubagent",
    arguments: { agent: "claude-code", prompt: "長い\n仕事" },
    _meta: { "claudecode/toolUseId": "toolu_abc" },
  });
  await runner.callTool({ name: "runSubagent", arguments: { agent: "opencode", prompt: "x" } });

  assert.equal(issued[0]!.moduleName, "subagent");
  assert.deepEqual(issued[0]!.work, {
    toolName: "runSubagent",
    toolCallId: "toolu_abc",
    resourceUri: "ui://banto-subagent/runs",
    title: "claude-code に頼んだ仕事",
    description: "長い 仕事",
  });
  assert.equal((issued[1]!.work as Record<string, unknown>).toolCallId, undefined, "Runner が渡していない id を作った");
  await runner.close();
  await moduleClient.close();
});

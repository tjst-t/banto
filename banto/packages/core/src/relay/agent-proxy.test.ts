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
import { ModuleCallTracker, RESTARTING_REFUSAL } from "./module-calls.js";

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

// **承認をすべて自動で許可する**（追加・2026-10-05、v4-frontend.md §6.4）。スイッチがオンの Project のターンからの呼び出しに
// `dev.banto/autoApprove` を刻む。呼び出しのたびに引く。**Runner が添えた `_meta` は Module に流さない**（AI は名乗れない）
test("スイッチがオンの Project のターンからの呼び出しにだけ自動で許可の印が付き、Runner が添えた印は流れない", async () => {
  const seen: Array<Record<string, unknown> | undefined> = [];
  const server = new Server({ name: "fake", version: "0.0.0" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [{ name: "publishService", inputSchema: { type: "object", properties: {} }, _meta: { "dev.banto/visibility": "agent" } }],
  }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    seen.push(req.params._meta as Record<string, unknown> | undefined);
    return { content: [{ type: "text", text: "ok" }] };
  });
  const [s, c] = InMemoryTransport.createLinkedPair();
  const moduleClient = new Client({ name: "host", version: "0.0.0" });
  await Promise.all([server.connect(s), moduleClient.connect(c)]);
  const meta = parseModuleMeta({ satisfies: ["publish-directory"], dependsOn: [], isolation: "subprocess" }, "fake");
  const on = new Set(["p1"]);

  async function callWith(opts: { projectId?: string; threadId?: string }, runnerMeta?: Record<string, unknown>) {
    const proxy = buildAgentProxy(
      { name: "publish-directory", client: moduleClient, meta },
      { ...opts, autoApproveFor: (projectId) => on.has(projectId) },
    );
    const [ps, pc] = InMemoryTransport.createLinkedPair();
    const runner = new Client({ name: "runner", version: "0.0.0" });
    await Promise.all([proxy.server.connect(ps), runner.connect(pc)]);
    await runner.callTool({ name: "publishService", arguments: {}, ...(runnerMeta ? { _meta: runnerMeta } : {}) });
    await runner.close();
  }

  await callWith({ projectId: "p1", threadId: "t1" });
  await callWith({ projectId: "p2", threadId: "t1" }, { "dev.banto/autoApprove": true });
  await callWith({ threadId: "t1" });
  on.delete("p1");
  await callWith({ projectId: "p1", threadId: "t1" });

  assert.equal(seen[0]?.["dev.banto/autoApprove"], true);
  assert.equal(seen[1]?.["dev.banto/autoApprove"], undefined, "Runner が添えた印が Module に流れた");
  assert.equal(seen[2]?.["dev.banto/autoApprove"], undefined, "Project が分からないのに刻んだ");
  assert.equal(seen[3]?.["dev.banto/autoApprove"], undefined, "スイッチを切ったのに刻んだ");
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

// **人の答えを待っている**（追加・2026-10-04）。Module が結果に `dev.banto/waitingOn` を載せたら、札を返事待ちにするときに渡す
test("あとで届ける結果に「人を待っている」が載っていれば、返事待ちにするときに渡す（載っていなければ渡さない）", async () => {
  const server = new Server({ name: "fake", version: "0.0.0" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "ask",
        inputSchema: { type: "object", properties: {} },
        _meta: { "dev.banto/visibility": "agent", "dev.banto/deliversLater": true },
      },
    ],
  }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => ({
    content: [{ type: "text", text: "ok" }],
    _meta: {
      "dev.banto/pendingReply": true,
      ...((req.params.arguments as { human?: boolean } | undefined)?.human
        ? { "dev.banto/waitingOn": { on: "human", title: "試験の承認" } }
        : {}),
    },
  }));
  const [s, c] = InMemoryTransport.createLinkedPair();
  const moduleClient = new Client({ name: "host", version: "0.0.0" });
  await Promise.all([server.connect(s), moduleClient.connect(c)]);
  const meta = parseModuleMeta({ satisfies: ["x"], dependsOn: [], isolation: "subprocess" }, "fake");
  const marked: Array<{ replyTo: string; waitingOn: unknown }> = [];
  const proxy = buildAgentProxy(
    { name: "ask-p1", declaredName: "ask", client: moduleClient, meta },
    {
      projectId: "p1",
      threadId: "t1",
      replies: {
        issue: () => `reply_${marked.length}`,
        markAwaiting: async (replyTo, waitingOn) => {
          marked.push({ replyTo, waitingOn });
        },
      },
    },
  );
  const [ps, pc] = InMemoryTransport.createLinkedPair();
  const runner = new Client({ name: "runner", version: "0.0.0" });
  await Promise.all([proxy.server.connect(ps), runner.connect(pc)]);
  await runner.callTool({ name: "ask", arguments: { human: true } });
  await runner.callTool({ name: "ask", arguments: {} });
  assert.deepEqual(marked[0]!.waitingOn, { on: "human", title: "試験の承認" });
  assert.equal(marked[1]!.waitingOn, undefined);
  await runner.close();
  await moduleClient.close();
});

// **人の答えを待つ間は、外側の呼び出しの上限を数えない**（追加・2026-10-04、ユーザー報告「publishService が承認待ちで
// 止まる」）。Module の中の中継が人の承認を待つ間に、AI → Module の呼び出しが既定の60秒で切れていた
test("Module が黙ったままなら上限で切れるが、人の答えを待っている間（holdForHuman）は数えない", async () => {
  const { ModuleCallTracker } = await import("./module-calls.js");
  const { CALL_ID_META_KEY } = await import("@banto/module-contract");
  const tracker = new ModuleCallTracker();
  const server = new Server({ name: "slow", version: "0.0.0" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      { name: "silent", inputSchema: { type: "object", properties: {} }, _meta: { "dev.banto/visibility": "agent" } },
      { name: "asksHuman", inputSchema: { type: "object", properties: {} }, _meta: { "dev.banto/visibility": "agent" } },
    ],
  }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const callId = (req.params._meta as Record<string, unknown> | undefined)?.[CALL_ID_META_KEY] as string;
    if (req.params.name === "asksHuman") {
      // 中継の承認と同じ形：人の答えを待つ間、台帳に「人を待っている」と刻む（上限の4倍待つ）
      const release = tracker.holdForHuman("slow", callId);
      await new Promise((r) => setTimeout(r, 400));
      release();
      return { content: [{ type: "text", text: "ANSWERED" }] };
    }
    await new Promise((r) => setTimeout(r, 400));
    return { content: [{ type: "text", text: "TOO-LATE" }] };
  });
  const [s, c] = InMemoryTransport.createLinkedPair();
  const moduleClient = new Client({ name: "host", version: "0.0.0" });
  await Promise.all([server.connect(s), moduleClient.connect(c)]);
  const proxy = buildAgentProxy(
    { name: "slow", client: moduleClient, meta: parseModuleMeta({ satisfies: [], dependsOn: [], isolation: "subprocess" }, "slow") },
    { moduleCalls: tracker, threadId: "th", projectId: "p", toolIdleTimeoutMs: 100 },
  );
  const [ps, pc] = InMemoryTransport.createLinkedPair();
  const runner = new Client({ name: "runner", version: "0.0.0" });
  await Promise.all([proxy.server.connect(ps), runner.connect(pc)]);

  const ok = await runner.callTool({ name: "asksHuman", arguments: {} });
  assert.equal((ok.content as { text: string }[])[0]?.text, "ANSWERED");

  await assert.rejects(runner.callTool({ name: "silent", arguments: {} }), /timed out/i);
  assert.equal(tracker.list().length, 0, "切れた呼び出しも台帳から外す");
});

// **同じ Module のほかの呼び出しが人を待つ間も数えず、待っている間は Runner へ進捗を送る**（追加・2026-10-05、
// docs/notes/2026-10-05-relay-stale-card.md）。Backlog は書き込みを列に並べるので、2本目は1本目の承認待ちの後ろで黙って
// 待ち、host の上限で -32001 になっていた（実測）。Runner（Claude Code）は進捗の来ない呼び出しを300秒で黙って諦める
test("同じ Module の別の呼び出しが人を待つ間は、後ろで待つ呼び出しも切らず、Runner へ進捗を送る——待ち終えたらまた数える", async () => {
  const { ModuleCallTracker } = await import("./module-calls.js");
  const { CALL_ID_META_KEY } = await import("@banto/module-contract");
  const tracker = new ModuleCallTracker();
  let releaseFirst!: () => void;
  let firstAnswered!: () => void;
  const answered = new Promise<void>((r) => (firstAnswered = r));
  /** Module の中の列：2本目は1本目が終わるまで待つ（Backlog の書き込みの列と同じ形） */
  let queue: Promise<unknown> = Promise.resolve();
  const server = new Server({ name: "queued", version: "0.0.0" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [{ name: "write", inputSchema: { type: "object", properties: {} }, _meta: { "dev.banto/visibility": "agent" } }],
  }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const callId = (req.params._meta as Record<string, unknown> | undefined)?.[CALL_ID_META_KEY] as string;
    const mine = queue.then(async () => {
      if ((req.params.arguments as { first?: boolean }).first) {
        // 中継の承認と同じ形：人の答えを待つ間、台帳に「人を待っている」と刻む
        releaseFirst = tracker.holdForHuman("queued", callId);
        await answered;
        releaseFirst();
        return "FIRST";
      }
      // 後ろの呼び出しは、前が終わったあと黙ったまま——上限で切れるのが正しい
      if ((req.params.arguments as { silentAfter?: boolean }).silentAfter) await new Promise((r) => setTimeout(r, 400));
      return "SECOND";
    });
    queue = mine.catch(() => undefined);
    return { content: [{ type: "text", text: await mine }] };
  });
  const [s, c] = InMemoryTransport.createLinkedPair();
  const moduleClient = new Client({ name: "host", version: "0.0.0" });
  await Promise.all([server.connect(s), moduleClient.connect(c)]);
  const proxy = buildAgentProxy(
    { name: "queued", client: moduleClient, meta: parseModuleMeta({ satisfies: [], dependsOn: [], isolation: "subprocess" }, "queued") },
    { moduleCalls: tracker, threadId: "th", projectId: "p", toolIdleTimeoutMs: 100, humanWaitProgressIntervalMs: 20 },
  );
  const [ps, pc] = InMemoryTransport.createLinkedPair();
  const runner = new Client({ name: "runner", version: "0.0.0" });
  await Promise.all([proxy.server.connect(ps), runner.connect(pc)]);

  const progress: string[] = [];
  const opts = (label: string) => ({ timeout: 60_000, onprogress: (p: { message?: string }) => progress.push(`${label}:${p.message}`) });
  const first = runner.callTool({ name: "write", arguments: { first: true } }, undefined, opts("first"));
  await new Promise((r) => setTimeout(r, 30));
  const second = runner.callTool({ name: "write", arguments: {} }, undefined, opts("second"));
  // 上限（100ms）の4倍、人が答えない
  await new Promise((r) => setTimeout(r, 400));
  assert.ok(progress.includes("first:人の承認を待っています"), `人を待つ呼び出しに進捗が来ていない: ${progress.join(",")}`);
  assert.ok(progress.includes("second:人の承認を待っています"), `後ろで待つ呼び出しに進捗が来ていない: ${progress.join(",")}`);
  firstAnswered();
  assert.equal(((await first).content as { text: string }[])[0]?.text, "FIRST");
  assert.equal(((await second).content as { text: string }[])[0]?.text, "SECOND", "後ろで待っていた呼び出しが、待ち終えた瞬間に切れた");

  // 人を待っている者がいなければ、今までどおり上限で切れる
  await assert.rejects(runner.callTool({ name: "write", arguments: { silentAfter: true } }), /timed out/i);
  assert.equal(tracker.list().length, 0);
  await runner.close();
  await moduleClient.close();
});

// **Runner が答えを受け取れなくなった呼び出しを止める口**（追加・2026-10-05）——止めると Module への呼び出しも
// 取り消され、台帳から外れる（中継の承認は、これで「聞いた呼び出しが終わった」を知って畳む）
test("abortCalls：JSON-RPC の id で走っている呼び出しを止め、Module にも取り消しが届き、台帳から外れる", async () => {
  const { ModuleCallTracker } = await import("./module-calls.js");
  const tracker = new ModuleCallTracker();
  let moduleSawAbort = false;
  let started!: () => void;
  const running = new Promise<void>((r) => (started = r));
  const server = new Server({ name: "long", version: "0.0.0" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [{ name: "wait", inputSchema: { type: "object", properties: {} }, _meta: { "dev.banto/visibility": "agent" } }],
  }));
  server.setRequestHandler(CallToolRequestSchema, async (_req, extra) => {
    started();
    await new Promise<void>((r) => extra.signal.addEventListener("abort", () => r(), { once: true }));
    moduleSawAbort = true;
    return { content: [{ type: "text", text: "ABORTED" }] };
  });
  const [s, c] = InMemoryTransport.createLinkedPair();
  const moduleClient = new Client({ name: "host", version: "0.0.0" });
  await Promise.all([server.connect(s), moduleClient.connect(c)]);
  const proxy = buildAgentProxy(
    { name: "long", client: moduleClient, meta: parseModuleMeta({ satisfies: [], dependsOn: [], isolation: "subprocess" }, "long") },
    { moduleCalls: tracker, threadId: "th", projectId: "p" },
  );
  /** Runner が送った tools/call の id を拾う（本物の代理サーバの前で agent-relay-endpoint が本文から読むのと同じ値） */
  const ids: Array<string | number> = [];
  const [ps, pc] = InMemoryTransport.createLinkedPair();
  const send = pc.send.bind(pc);
  pc.send = async (message, options) => {
    const m = message as { method?: string; id?: string | number };
    if (m.method === "tools/call" && m.id !== undefined) ids.push(m.id);
    return send(message, options);
  };
  const runner = new Client({ name: "runner", version: "0.0.0" });
  await Promise.all([proxy.server.connect(ps), runner.connect(pc)]);

  const call = runner.callTool({ name: "wait", arguments: {} }, undefined, { timeout: 60_000 }).then(
    (r) => r,
    (e: unknown) => e,
  );
  await running;
  assert.equal(tracker.list().length, 1);
  proxy.abortCalls(ids, "Runner との接続が、返事を受け取る前に切れました");
  const result = await call;
  assert.match(String((result as Error).message ?? JSON.stringify(result)), /返事を受け取る前に切れました/);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(moduleSawAbort, true, "Module に取り消しが届いていない");
  assert.equal(tracker.list().length, 0, "止めた呼び出しが台帳に残った");
  await runner.close();
  await moduleClient.close();
});

// **待ち終えたら、上限は待ち終えたところから数える**（追加・2026-10-05）。待つ間に数え直さないと、待つ前から数えていた分で
// 待ち終えた直後に切れる（probe で実測——前の呼び出しが畳まれた瞬間、後ろの呼び出しが -32001 になった）
test("人を待ち終えた直後の呼び出しは、上限をまるごと使える（待つ前から数えた分で切れない）", async () => {
  const { ModuleCallTracker } = await import("./module-calls.js");
  const { CALL_ID_META_KEY } = await import("@banto/module-contract");
  const IDLE = 400;
  const tracker = new ModuleCallTracker();
  let answer!: () => void;
  const answered = new Promise<void>((r) => (answer = r));
  let startedAt = 0;
  const server = new Server({ name: "after-wait", version: "0.0.0" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [{ name: "write", inputSchema: { type: "object", properties: {} }, _meta: { "dev.banto/visibility": "agent" } }],
  }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const callId = (req.params._meta as Record<string, unknown> | undefined)?.[CALL_ID_META_KEY] as string;
    startedAt = Date.now();
    const release = tracker.holdForHuman("after-wait", callId);
    await answered;
    release();
    // 待ち終えてから、上限の 3/8 だけ黙って働く
    await new Promise((r) => setTimeout(r, (IDLE * 3) / 8));
    return { content: [{ type: "text", text: "DONE" }] };
  });
  const [s, c] = InMemoryTransport.createLinkedPair();
  const moduleClient = new Client({ name: "host", version: "0.0.0" });
  await Promise.all([server.connect(s), moduleClient.connect(c)]);
  const proxy = buildAgentProxy(
    { name: "after-wait", client: moduleClient, meta: parseModuleMeta({ satisfies: [], dependsOn: [], isolation: "subprocess" }, "after-wait") },
    { moduleCalls: tracker, threadId: "th", projectId: "p", toolIdleTimeoutMs: IDLE, humanWaitProgressIntervalMs: IDLE / 8 },
  );
  const [ps, pc] = InMemoryTransport.createLinkedPair();
  const runner = new Client({ name: "runner", version: "0.0.0" });
  await Promise.all([proxy.server.connect(ps), runner.connect(pc)]);
  const call = runner.callTool({ name: "write", arguments: {} }, undefined, { timeout: 60_000 });
  while (startedAt === 0) await new Promise((r) => setTimeout(r, 5));
  // 見張りが4回目に起きる少し前（上限の 1/8 前）に答える——待つ前から数えていると、働いている途中で4回目が来て切れる
  await new Promise((r) => setTimeout(r, startedAt + IDLE * 4 - IDLE / 8 - Date.now()));
  answer();
  assert.equal(((await call).content as { text: string }[])[0]?.text, "DONE");
  await runner.close();
  await moduleClient.close();
});

// **起こし直しのために止めている間は、AI の新しい tool 呼び出しを断る**（追加・2026-10-05、Fable のレビュー）。Module には
// 届けず、AI には「起き直したあとにもう一度」を結果で返す（続きの AI が呼び直せる）。止める前に始まった呼び出しは最後まで返る。
// 台帳には Runner の tool_use の id を置く（中の承認・質問を会話の呼び出しに結びつける）
test("止め始めたら新しい tool 呼び出しは Module に届かず RESTARTING_REFUSAL で返る。実行中のものは最後まで返る", async () => {
  const reached: string[] = [];
  let finish!: () => void;
  const server = new Server({ name: "fake", version: "0.0.0" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [{ name: "runCommand", inputSchema: { type: "object", properties: {} }, _meta: { "dev.banto/visibility": "agent" } }],
  }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    reached.push(String((req.params.arguments as { command?: string }).command));
    if ((req.params.arguments as { command?: string }).command === "slow") await new Promise<void>((r) => (finish = r));
    return { content: [{ type: "text", text: "done" }] };
  });
  const [s, c] = InMemoryTransport.createLinkedPair();
  const moduleClient = new Client({ name: "host", version: "0.0.0" });
  await Promise.all([server.connect(s), moduleClient.connect(c)]);
  const meta = parseModuleMeta({ satisfies: ["shell"], dependsOn: [], isolation: "subprocess" }, "fake");
  const moduleCalls = new ModuleCallTracker();
  const proxy = buildAgentProxy({ name: "shell-p", client: moduleClient, meta }, { moduleCalls, threadId: "t1", projectId: "p" });
  const [ps, pc] = InMemoryTransport.createLinkedPair();
  const runner = new Client({ name: "runner", version: "0.0.0" });
  await Promise.all([proxy.server.connect(ps), runner.connect(pc)]);

  const slow = runner.callTool({ name: "runCommand", arguments: { command: "slow" }, _meta: { "claudecode/toolUseId": "toolu_slow" } });
  while (reached.length === 0) await new Promise((r) => setTimeout(r, 5));
  assert.equal(moduleCalls.toolUseIdFor("shell-p"), "toolu_slow", "台帳に tool_use の id が無い");
  moduleCalls.stopAccepting();
  const refused = (await runner.callTool({ name: "runCommand", arguments: { command: "next" } })) as { isError?: boolean; content: Array<{ text: string }> };
  assert.equal(refused.isError, true);
  assert.equal(refused.content[0]!.text, RESTARTING_REFUSAL);
  assert.deepEqual(reached, ["slow"], "止めている間の呼び出しが Module に届いた");
  // 実行中の呼び出しは待たれて、結果が返る
  const drained = moduleCalls.drain(5_000, 10);
  finish();
  assert.equal(((await slow) as { content: Array<{ text: string }> }).content[0]!.text, "done");
  assert.equal((await drained).left, 0);
  await runner.close();
  await moduleClient.close();
});

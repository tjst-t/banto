// **読むだけの回**（アーキ仕様 §4.4）——何を通すかの判定（4か所の守りが共有する1か所）と、AI の代理（守りの 3.）。
//
// 代理は InMemoryTransport で本物の MCP のやり取りを通す。見ること：
//   - 同梱の Module が `dev.banto/effect: "read"` と名乗った tool だけが読むだけの回で使える。第三者の名乗りと readOnlyHint は根拠に
//     しない——人が `patrol.allowedTools` で許したものだけ
//   - 読むだけでない tool の `tools/call` は Module を呼ばずに断る（判断待ちを出さない）。`tools/list` も絞る
//   - 許していない Module の `resources/read` は断り、一覧にも出さない
//   - 読むだけの回の呼び出しには `dev.banto/restriction` を刻み、「自動で許可」は刻まない（スイッチがオンでも）
//   - 制限の無い会話は今までどおり
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
import { markBundled, parseModuleMeta } from "@banto/module-contract";
import { buildAgentProxy, type SupervisorGateInput } from "./agent-proxy.js";
import { supervisorModuleToolNames } from "../http/patrol-tools.js";
import {
  READ_ONLY_REFUSAL,
  SUPERVISOR_MODULE_TOOLS,
  SUPERVISOR_REFUSAL,
  advanceFactoryToolRole,
  mayCallInReadOnly,
  mayCallInSupervisor,
  mayReadResourcesInReadOnly,
  mayRelayOwnCredentialInReadOnly,
  parsePatrolAllowedTools,
  readOnlyHookAllows,
  serializePatrolAllowedTools,
} from "./read-only.js";

const read = { "dev.banto/visibility": "agent", "dev.banto/effect": "read" };
const plain = { "dev.banto/visibility": "agent" };

test("同梱の Module が読むだけと名乗った tool だけが通る。第三者の名乗りは根拠にしない——人が許したものだけ", () => {
  const tool = { name: "listItems", _meta: read };
  assert.equal(mayCallInReadOnly({ moduleName: "backlog", bundled: true, tool, allowed: [] }), true);
  assert.equal(mayCallInReadOnly({ moduleName: "backlog", bundled: true, tool: { name: "updateItem", _meta: plain }, allowed: [] }), false);
  // 第三者が同じ名乗りをしても通さない
  assert.equal(mayCallInReadOnly({ moduleName: "third", bundled: false, tool: { name: "peek", _meta: read }, allowed: [] }), false);
  // 人が許せば、名乗っていなくても通る。許すのは Module と tool の組
  assert.equal(mayCallInReadOnly({ moduleName: "third", bundled: false, tool: { name: "peek", _meta: plain }, allowed: ["third/peek"] }), true);
  assert.equal(mayCallInReadOnly({ moduleName: "other", bundled: false, tool: { name: "peek", _meta: plain }, allowed: ["third/peek"] }), false);
  // 資源は同梱か、人が「資源を読む」を許した Module
  assert.equal(mayReadResourcesInReadOnly({ moduleName: "vault", bundled: true, allowed: [] }), true);
  assert.equal(mayReadResourcesInReadOnly({ moduleName: "third", bundled: false, allowed: ["third/peek"] }), false);
  assert.equal(mayReadResourcesInReadOnly({ moduleName: "third", bundled: false, allowed: ["third/resources"] }), true);
});

test("読むだけの回の中継で緩めるのは、banto 本体で動く同梱の banto 全体の Module が同梱の Vault から自分の資格情報を引く・書き戻すときだけ", () => {
  const caller = { bundled: true, inContainer: false, projectScoped: false };
  const vault = { bundled: true, roles: ["vault"] };
  const resolve = { name: "resolveAlias", callerOwned: false };
  assert.equal(mayRelayOwnCredentialInReadOnly({ caller, target: vault, tool: resolve }), true);
  // 回った組の書き戻し（持ち主のものだけを書き換える口）
  assert.equal(mayRelayOwnCredentialInReadOnly({ caller, target: vault, tool: { name: "putSecret", callerOwned: true } }), true);
  // ほかの口（人が預けた秘密を作る・消す等）は緩めない
  for (const name of ["createAlias", "deleteAlias", "putSecret", "startSshAgent"]) {
    assert.equal(mayRelayOwnCredentialInReadOnly({ caller, target: vault, tool: { name, callerOwned: false } }), false, name);
  }
  assert.equal(mayRelayOwnCredentialInReadOnly({ caller: { ...caller, inContainer: true }, target: vault, tool: resolve }), false);
  assert.equal(mayRelayOwnCredentialInReadOnly({ caller: { ...caller, projectScoped: true }, target: vault, tool: resolve }), false);
  assert.equal(mayRelayOwnCredentialInReadOnly({ caller: { ...caller, bundled: false }, target: vault, tool: resolve }), false);
  assert.equal(mayRelayOwnCredentialInReadOnly({ caller, target: { ...vault, bundled: false }, tool: resolve }), false);
  assert.equal(mayRelayOwnCredentialInReadOnly({ caller, target: { bundled: true, roles: ["vault-directory"] }, tool: resolve }), false);
});

test("PreToolUse の最後の網：組み込みは資源の3つ、core は list_threads・list_automations、Module は引いた一覧だけ", () => {
  const modules = new Set(["mcp__filesystem__readFile"]);
  for (const ok of ["ListMcpResourcesTool", "ReadMcpResourceTool", "ReadMcpResourceDirTool", "mcp__banto-thread__list_threads", "mcp__banto-thread__list_automations", "mcp__banto-thread__claude_usage", "mcp__filesystem__readFile"]) {
    assert.equal(readOnlyHookAllows(ok, modules), true, ok);
  }
  for (const ng of ["WebFetch", "WebSearch", "Bash", "mcp__shell__runCommand", "mcp__banto-thread__create_automation", "mcp__banto-thread__start_forks", "mcp__banto-memory__remember_decision", "mcp__filesystem__writeFile"]) {
    assert.equal(readOnlyHookAllows(ng, modules), false, ng);
  }
});

test("見回りが消えたあとの見回りの Fork は close_fork だけ足す（ほかの書く tool は断ったまま）", () => {
  const modules = new Set<string>();
  assert.equal(readOnlyHookAllows("mcp__banto-thread__close_fork", modules), false);
  assert.equal(readOnlyHookAllows("mcp__banto-thread__close_fork", modules, { orphanedPatrol: true }), true);
  for (const ng of ["mcp__banto-thread__start_forks", "mcp__banto-thread__send_message", "mcp__banto-memory__remember_decision", "mcp__shell__runCommand", "Bash"]) {
    assert.equal(readOnlyHookAllows(ng, modules, { orphanedPatrol: true }), false, ng);
  }
});

test("patrol.allowedTools は JSON の文字列の配列。壊れていれば何も許さない", () => {
  assert.deepEqual(parsePatrolAllowedTools(serializePatrolAllowedTools(["b/x", "a/y", "b/x"])), ["a/y", "b/x"]);
  assert.deepEqual(parsePatrolAllowedTools(undefined), []);
  assert.deepEqual(parsePatrolAllowedTools("not json"), []);
  assert.deepEqual(parsePatrolAllowedTools(JSON.stringify([1, 2])), []);
  assert.deepEqual(parsePatrolAllowedTools(true), []);
});

interface Called {
  name: string;
  meta?: Record<string, unknown>;
}

async function setup(opts: {
  bundled: boolean;
  restricted: () => boolean;
  allowed?: string[];
  autoApprove?: boolean;
  restriction?: "read-only" | "supervisor";
}) {
  const called: Called[] = [];
  const read_: Called[] = [];
  const server = new Server({ name: "fake", version: "0.0.0" }, { capabilities: { tools: {}, resources: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      { name: "look", inputSchema: { type: "object", properties: {} }, _meta: read },
      { name: "write", inputSchema: { type: "object", properties: {} }, _meta: plain },
    ],
  }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    called.push({ name: req.params.name, meta: req.params._meta as Record<string, unknown> | undefined });
    return { content: [{ type: "text", text: `${req.params.name} ran` }] };
  });
  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: [{ uri: "fake://doc", name: "doc", _meta: plain }],
  }));
  server.setRequestHandler(ReadResourceRequestSchema, async (req) => {
    read_.push({ name: req.params.uri, meta: req.params._meta as Record<string, unknown> | undefined });
    return { contents: [{ uri: req.params.uri, text: "doc body" }] };
  });
  const [st, ct] = InMemoryTransport.createLinkedPair();
  const moduleClient = new Client({ name: "host", version: "0.0.0" });
  await Promise.all([server.connect(st), moduleClient.connect(ct)]);
  const raw = parseModuleMeta({ satisfies: ["fake"], dependsOn: [], isolation: "subprocess" }, "fake");
  const meta = opts.bundled ? markBundled(raw, "fake") : raw;
  const proxy = buildAgentProxy(
    { name: "fake-p1", declaredName: "fake", client: moduleClient, meta },
    {
      projectId: "p1",
      threadId: "t1",
      restrictionFor: (projectId, threadId) => (projectId === "p1" && threadId === "t1" && opts.restricted() ? (opts.restriction ?? "read-only") : undefined),
      patrolAllowedTools: () => opts.allowed ?? [],
      autoApproveFor: () => opts.autoApprove === true,
    },
  );
  const [ps, pc] = InMemoryTransport.createLinkedPair();
  const runner = new Client({ name: "runner", version: "0.0.0" });
  await Promise.all([proxy.server.connect(ps), runner.connect(pc)]);
  return { runner, called, read: read_ };
}

const textOf = (r: unknown) => ((r as { content: Array<{ text: string }> }).content[0]?.text ?? "");

test("代理：読むだけの回は、同梱の読むだけの tool だけを見せ・通す。ほかは Module を呼ばずに断り、自動で許可は刻まない", async () => {
  const { runner, called } = await setup({ bundled: true, restricted: () => true, autoApprove: true });
  assert.deepEqual((await runner.listTools()).tools.map((t) => t.name), ["look"]);

  const ok = await runner.callTool({ name: "look", arguments: {} });
  assert.equal(textOf(ok), "look ran");
  assert.equal(called[0]?.meta?.["dev.banto/restriction"], "read-only", "読むだけの回の刻印が Module に届いていない");
  assert.equal(called[0]?.meta?.["dev.banto/autoApprove"], undefined, "読むだけの回に「自動で許可」が刻まれた");

  const refused = await runner.callTool({ name: "write", arguments: {} });
  assert.equal(refused.isError, true);
  assert.equal(textOf(refused), READ_ONLY_REFUSAL);
  assert.deepEqual(called.map((c) => c.name), ["look"], "断ったはずの tool が Module に届いた");
});

test("代理：第三者の Module は名乗っても通さず、人が許した tool だけ通す。資源も許したときだけ", async () => {
  const notAllowed = await setup({ bundled: false, restricted: () => true });
  assert.deepEqual((await notAllowed.runner.listTools()).tools.map((t) => t.name), []);
  const refused = await notAllowed.runner.callTool({ name: "look", arguments: {} });
  assert.equal(refused.isError, true);
  assert.equal(notAllowed.called.length, 0);
  assert.deepEqual((await notAllowed.runner.listResources()).resources, []);
  await assert.rejects(() => notAllowed.runner.readResource({ uri: "fake://doc" }), /見回りの回では使えません/);
  assert.equal(notAllowed.read.length, 0);

  const allowed = await setup({ bundled: false, restricted: () => true, allowed: ["fake/write", "fake/resources"] });
  assert.deepEqual((await allowed.runner.listTools()).tools.map((t) => t.name), ["write"]);
  assert.equal(textOf(await allowed.runner.callTool({ name: "write", arguments: {} })), "write ran");
  const doc = await allowed.runner.readResource({ uri: "fake://doc" });
  assert.equal((doc.contents[0] as { text: string }).text, "doc body");
  assert.equal(allowed.read[0]?.meta?.["dev.banto/restriction"], "read-only");
});

test("代理：制限の無い会話は今までどおり（全部見せ・通し、刻印も付けない）。制限は呼び出しのたびに引く", async () => {
  let restricted = false;
  const { runner, called } = await setup({ bundled: false, restricted: () => restricted, autoApprove: true });
  assert.deepEqual((await runner.listTools()).tools.map((t) => t.name).sort(), ["look", "write"]);
  assert.equal(textOf(await runner.callTool({ name: "write", arguments: {} })), "write ran");
  assert.equal(called[0]?.meta?.["dev.banto/restriction"], undefined);
  assert.equal(called[0]?.meta?.["dev.banto/autoApprove"], true);
  restricted = true;
  assert.equal((await runner.callTool({ name: "write", arguments: {} })).isError, true);
  assert.equal(called.length, 1);
});

// **番頭の回**（追加・2026-10-21、アーキ仕様 §4.5）。Module の tool は同梱の Factory・Backlog の決まったものだけ（#509、下の試験）——
// ほかの役割の Module は、同梱で読むだけと名乗った tool も、人が見回りで許した tool も通さない。資源は同梱の Module のものだけ。
// 自動で許可は刻まない
test("PreToolUse の最後の網（番頭の回）：組み込みは資源の3つ、core は answer_decision・list_threads・claude_usage だけ", () => {
  const shape = { supervisor: true };
  for (const ok of ["ReadMcpResourceTool", "mcp__banto-thread__answer_decision", "mcp__banto-thread__list_threads", "mcp__banto-thread__claude_usage"]) {
    assert.equal(readOnlyHookAllows(ok, new Set(), shape), true, ok);
  }
  for (const ng of ["Bash", "WebFetch", "mcp__banto-thread__list_automations", "mcp__banto-thread__notify", "mcp__banto-thread__close_fork", "mcp__banto-thread__send_message", "mcp__banto-memory__remember_decision"]) {
    assert.equal(readOnlyHookAllows(ng, new Set(), shape), false, ng);
  }
  // 見回りの回には answer_decision は無い
  assert.equal(readOnlyHookAllows("mcp__banto-thread__answer_decision", new Set()), false);
});

test("代理：番頭の回は Module の tool を見せず・通さず（同梱の読むだけのもの・見回りで許したものも）、自動で許可は刻まない。資源は同梱だけ", async () => {
  const bundled = await setup({ bundled: true, restricted: () => true, restriction: "supervisor", allowed: ["fake/write"], autoApprove: true });
  assert.deepEqual((await bundled.runner.listTools()).tools.map((t) => t.name), []);
  for (const name of ["look", "write"]) {
    const refused = await bundled.runner.callTool({ name, arguments: {} });
    assert.equal(refused.isError, true, name);
    assert.equal(textOf(refused), SUPERVISOR_REFUSAL);
  }
  assert.equal(bundled.called.length, 0, "番頭の回の tool 呼び出しが Module に届いた");
  const doc = await bundled.runner.readResource({ uri: "fake://doc" });
  assert.equal((doc.contents[0] as { text: string }).text, "doc body");
  assert.equal(bundled.read[0]?.meta?.["dev.banto/autoApprove"], undefined, "番頭の回に「自動で許可」が刻まれた");

  const thirdParty = await setup({ bundled: false, restricted: () => true, restriction: "supervisor", allowed: ["fake/resources"] });
  assert.deepEqual((await thirdParty.runner.listResources()).resources, []);
  await assert.rejects(() => thirdParty.runner.readResource({ uri: "fake://doc" }), /番頭の回では使えません/);
  assert.equal(thirdParty.read.length, 0);
});

// **番頭の回の Factory・Backlog**（追加・2026-10-21、アーキ仕様 §4.5「番頭の tool」の Factory、Backlog #509）。一覧は役割で引く1か所
// （`SUPERVISOR_MODULE_TOOLS`）——AI の代理の tools/list・tools/call、allowedTools と PreToolUse の名前（`supervisorModuleToolNames`）が同じものを
// 見る。cancelFactory は渡さない（取りやめは人）。番頭の照らし合わせ（`supervisorGate`）は Module へ渡す手前で引く
test("番頭の回の Module の tool：同梱の Factory の runFactory・listFactoryRuns・answerFactory と Backlog の listItems・getItem だけ。cancelFactory は無い", () => {
  assert.deepEqual(SUPERVISOR_MODULE_TOOLS, {
    factory: ["runFactory", "listFactoryRuns", "answerFactory"],
    backlog: ["listItems", "getItem"],
  });
  for (const [roles, name, ok] of [
    [["factory"], "runFactory", true],
    [["factory"], "listFactoryRuns", true],
    [["factory"], "answerFactory", true],
    [["factory"], "cancelFactory", false],
    [["factory"], "getSettings", false],
    [["backlog"], "listItems", true],
    [["backlog"], "getItem", true],
    [["backlog"], "updateItem", false],
    [["backlog"], "createItem", false],
    // 役割が違えば同じ名前でも通さない
    [["shell"], "runFactory", false],
  ] as const) {
    assert.equal(mayCallInSupervisor({ bundled: true, roles, tool: { name } }), ok, `${roles.join(",")}/${name}`);
  }
  // 第三者の Module は役割を名乗っても通さない
  assert.equal(mayCallInSupervisor({ bundled: false, roles: ["factory"], tool: { name: "runFactory" } }), false);
});

async function factoryModule(opts: { bundled: boolean; gate?: (input: SupervisorGateInput) => Promise<{ refuse: string } | Record<string, never>>; after?: string[] }) {
  const tools = ["runFactory", "listFactoryRuns", "answerFactory", "cancelFactory", "getSettings"];
  const called: string[] = [];
  const server = new Server({ name: "factory", version: "0.0.0" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((name) => ({ name, inputSchema: { type: "object" as const, properties: {} }, _meta: name === "getSettings" ? { "dev.banto/visibility": "admin" } : plain })),
  }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    called.push(req.params.name);
    return { content: [{ type: "text", text: JSON.stringify({ ran: req.params.name }) }] };
  });
  const [st, ct] = InMemoryTransport.createLinkedPair();
  const moduleClient = new Client({ name: "host", version: "0.0.0" });
  await Promise.all([server.connect(st), moduleClient.connect(ct)]);
  const raw = parseModuleMeta({ satisfies: ["factory"], dependsOn: [], isolation: "subprocess" }, "factory");
  const meta = opts.bundled ? markBundled(raw, "factory") : raw;
  const gated: SupervisorGateInput[] = [];
  const proxy = buildAgentProxy(
    // 識別子は banto が採番する（目録の名前と違ってよい）——役割で引く
    { name: "factory-x-p1", declaredName: "factory-x", client: moduleClient, meta },
    {
      projectId: "p1",
      threadId: "t1",
      restrictionFor: () => "supervisor",
      supervisorGate: async (input) => {
        gated.push(input);
        const d = (await opts.gate?.(input)) ?? {};
        if ("refuse" in d) return d;
        return {
          after: async (r) => void opts.after?.push(`${input.tool}:${r.isError}:${r.text}`),
          release: () => void opts.after?.push(`release:${input.tool}`),
        };
      },
    },
  );
  const [ps, pc] = InMemoryTransport.createLinkedPair();
  const runner = new Client({ name: "runner", version: "0.0.0" });
  await Promise.all([proxy.server.connect(ps), runner.connect(pc)]);
  return { runner, called, gated, moduleClient };
}

test("代理（番頭の回）：同梱の Factory は決まった3つだけを見せ・通し、cancelFactory は Module を呼ばずに断る。4か所の名前は同じ一覧から引く", async () => {
  const after: string[] = [];
  const { runner, called, gated, moduleClient } = await factoryModule({ bundled: true, after });
  const listed = (await runner.listTools()).tools.map((t) => t.name).sort();
  assert.deepEqual(listed, ["answerFactory", "listFactoryRuns", "runFactory"]);
  const refused = await runner.callTool({ name: "cancelFactory", arguments: { runId: "r1" } });
  assert.equal(refused.isError, true);
  assert.equal(textOf(refused), SUPERVISOR_REFUSAL);
  assert.equal(called.length, 0, "cancelFactory が Module に届いた");

  // 通したものは照らし合わせを通り、結果を after に渡し、終わったら release
  assert.equal(textOf(await runner.callTool({ name: "runFactory", arguments: { items: ["a"] } })), JSON.stringify({ ran: "runFactory" }));
  assert.deepEqual(gated.map((g) => [g.role, g.tool, g.projectId, g.threadId, g.args]), [["factory", "runFactory", "p1", "t1", { items: ["a"] }]]);
  assert.deepEqual(after, [`runFactory:false:${JSON.stringify({ ran: "runFactory" })}`, "release:runFactory"]);

  // allowedTools と PreToolUse の名前（`mcp__<識別子>__<tool>`）は、代理が見せるものと同じ
  const names = await supervisorModuleToolNames([{ name: "factory-x", client: moduleClient, bundled: true, roles: ["factory"] }]);
  assert.deepEqual(names, listed.map((t) => `mcp__factory-x__${t}`));
  assert.equal(readOnlyHookAllows("mcp__factory-x__runFactory", new Set(names), { supervisor: true }), true);
  assert.equal(readOnlyHookAllows("mcp__factory-x__cancelFactory", new Set(names), { supervisor: true }), false);
  // 第三者の Module は名前に入らない
  assert.deepEqual(await supervisorModuleToolNames([{ name: "factory-x", client: moduleClient, bundled: false, roles: ["factory"] }]), []);
});

test("代理（番頭の回）：照らし合わせが断ったら Module を呼ばずに理由を返す。第三者の Factory は見せない", async () => {
  const { runner, called } = await factoryModule({ bundled: true, gate: async () => ({ refuse: "流せません：上限" }) });
  const r = await runner.callTool({ name: "runFactory", arguments: { items: ["a"] } });
  assert.equal(r.isError, true);
  assert.equal(textOf(r), "流せません：上限");
  assert.equal(called.length, 0, "断ったのに Module に届いた");

  const thirdParty = await factoryModule({ bundled: false });
  assert.deepEqual((await thirdParty.runner.listTools()).tools, []);
  assert.equal((await thirdParty.runner.callTool({ name: "runFactory", arguments: {} })).isError, true);
  assert.equal(thirdParty.called.length, 0);
});

// **進める自動化の回の Factory**（追加・2026-10-24、アーキ仕様 §4.3「判断役の一般化」の 3.）。制限の無い回なので見せる・通すは変えず、
// runFactory・answerFactory だけを Module へ渡す手前で `advanceGate` に照らす。照らした側が通すと言えば（`{}`）今までどおり
test("代理（制限の無い回）：runFactory・answerFactory だけ advanceGate に照らす。断ったら Module を呼ばない・通せば今までどおり", async () => {
  assert.equal(advanceFactoryToolRole(["factory"], "runFactory"), "factory");
  assert.equal(advanceFactoryToolRole(["factory"], "listFactoryRuns"), undefined);
  assert.equal(advanceFactoryToolRole(["shell"], "runFactory"), undefined);

  const called: string[] = [];
  const server = new Server({ name: "factory", version: "0.0.0" }, { capabilities: { tools: {} } });
  const names = ["runFactory", "listFactoryRuns", "answerFactory", "cancelFactory"];
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: names.map((name) => ({ name, inputSchema: { type: "object" as const, properties: {} }, _meta: plain })),
  }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    called.push(req.params.name);
    return { content: [{ type: "text", text: JSON.stringify({ runId: "run-9", started: [{ item: "t1" }] }) }] };
  });
  const [st, ct] = InMemoryTransport.createLinkedPair();
  const moduleClient = new Client({ name: "host", version: "0.0.0" });
  await Promise.all([server.connect(st), moduleClient.connect(ct)]);
  const meta = markBundled(parseModuleMeta({ satisfies: ["factory"], dependsOn: [], isolation: "subprocess" }, "factory"), "factory");
  const gated: string[] = [];
  const after: string[] = [];
  let refuseNext = false;
  const proxy = buildAgentProxy(
    { name: "factory-x-p1", declaredName: "factory-x", client: moduleClient, meta },
    {
      projectId: "p1",
      threadId: "t1",
      restrictionFor: () => undefined,
      supervisorGate: async () => ({ refuse: "番頭の照らし合わせは制限の無い回では引かない" }),
      advanceGate: async (input) => {
        gated.push(input.tool);
        if (refuseNext) return { refuse: "流せません：上限" };
        return { after: async (r) => void after.push(r.text), release: () => void after.push("release") };
      },
    },
  );
  const [ps, pc] = InMemoryTransport.createLinkedPair();
  const runner = new Client({ name: "runner", version: "0.0.0" });
  await Promise.all([proxy.server.connect(ps), runner.connect(pc)]);
  // 見せるものは変えない（制限の無い回）
  assert.deepEqual((await runner.listTools()).tools.map((t) => t.name).sort(), [...names].sort());
  // 照らさない tool はそのまま
  await runner.callTool({ name: "listFactoryRuns", arguments: {} });
  await runner.callTool({ name: "cancelFactory", arguments: { runId: "r" } });
  assert.deepEqual(gated, []);
  // 通したものは after・release まで
  await runner.callTool({ name: "runFactory", arguments: { items: ["t1"] } });
  assert.deepEqual(gated, ["runFactory"]);
  assert.equal(after.length, 2);
  // 断ったものは Module に届かない
  refuseNext = true;
  const r = await runner.callTool({ name: "answerFactory", arguments: { runId: "run-9", item: "t1", action: "drop" } });
  assert.equal(r.isError, true);
  assert.equal(textOf(r), "流せません：上限");
  assert.deepEqual(called, ["listFactoryRuns", "cancelFactory", "runFactory"]);
});

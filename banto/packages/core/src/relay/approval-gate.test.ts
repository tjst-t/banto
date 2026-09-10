// アーキ仕様 §2.5「初回のみ承認ゲート → 以降は同じ Project 内で自動許可」と
// 「メタデータだけ Event Store に記録」を、中継エンドポイントごと通して確かめる。

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { Server as McpServer } from "@modelcontextprotocol/sdk/server/index.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { parseModuleMeta } from "@banto/module-contract";
import { EventLog, type StoredEvent } from "../event-store/log.js";
import { InboxStore } from "../inbox/store.js";
import type { JudgmentItem } from "../inbox/types.js";
import { PendingApprovalRegistry } from "../inbox/pending-approvals.js";
import { HostRelayEndpoint, RelayRegistry } from "./host-relay-endpoint.js";
import { RelayGrantStore } from "./grants.js";
import { ModuleCallTracker } from "./module-calls.js";
import { createRelayApprovalGate } from "./approval-gate.js";

const THREAD = "thread-1";
const PROJECT = "project-1";

async function fakeVaultClient(): Promise<Client> {
  const server = new McpServer({ name: "fake-vault", version: "0.0.0" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [{ name: "resolveAlias", inputSchema: { type: "object", properties: {} } }],
  }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    if (request.params.name === "explodes") throw new Error("宛先の Module が失敗しました");
    return { content: [{ type: "text", text: "SECRET-VALUE" }] };
  });
  const [s, c] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0.0.0" });
  await Promise.all([server.connect(s), client.connect(c)]);
  return client;
}

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), "banto-relay-gate-"));
  const log = new EventLog(dir);
  await log.init();
  const inbox = new InboxStore(dir, log);
  await inbox.load();
  const grants = new RelayGrantStore(dir, log);
  await grants.load();
  const pendingApprovals = new PendingApprovalRegistry();
  const moduleCalls = new ModuleCallTracker();

  const registry = new RelayRegistry();
  registry.registerModule({
    name: "vault",
    client: await fakeVaultClient(),
    meta: parseModuleMeta({ satisfies: ["vault"], dependsOn: [], isolation: "subprocess" }, "vault"),
  });
  const shellMeta = parseModuleMeta(
    { satisfies: ["shell"], dependsOn: [{ role: "vault", required: true }], isolation: "subprocess" },
    "shell",
  );
  const token = registry.issueToken({
    moduleName: "shell",
    connName: "shell-project-1",
    projectId: PROJECT,
    meta: shellMeta,
  });

  const endpoint = new HostRelayEndpoint({
    registry,
    gate: createRelayApprovalGate({ grants, inbox, pendingApprovals, moduleCalls }),
    onAudit: async (r) => {
      await grants.recordCall(r, { allowed: r.allowed, reason: r.reason, ok: r.ok });
    },
  });
  const httpServer = createServer((req, res) => void endpoint.handleRequest(req, res));
  await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  const port = (httpServer.address() as AddressInfo).port;

  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/relay`), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  });
  const caller = new Client({ name: "shell-module", version: "0.0.0" });
  await caller.connect(transport);

  const events = async (): Promise<StoredEvent[]> => {
    const all: StoredEvent[] = [];
    for await (const e of log.readFrom(0)) all.push(e);
    return all;
  };

  return {
    inbox,
    grants,
    pendingApprovals,
    moduleCalls,
    caller,
    events,
    async close() {
      await caller.close();
      httpServer.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

/** 判断待ちが受信箱に出るまで待って、その1件を返す。 */
async function waitForJudgment(inbox: InboxStore, seen: Set<string>): Promise<JudgmentItem> {
  for (let i = 0; i < 200; i++) {
    const item = inbox
      .listOpen()
      .find((x): x is JudgmentItem => x.kind === "judgment" && !seen.has(x.id));
    if (item) {
      seen.add(item.id);
      return item;
    }
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("判断待ちが受信箱に出ませんでした");
}

test("初回は人に聞き、許可すると中継が通る——2回目は聞かない（同じ Project 内で自動許可）", async () => {
  const t = await setup();
  const seen = new Set<string>();
  try {
    const endCall = t.moduleCalls.begin("shell-project-1", THREAD);

    const first = t.caller.callTool({
      name: "relayCallTool",
      arguments: { targetModule: "vault", name: "resolveAlias", arguments: { alias: "github-token" } },
    });

    const judgment = await waitForJudgment(t.inbox, seen);
    assert.equal(judgment.threadId, THREAD, "承認は、その呼び出しが属する会話に出る");
    assert.equal(judgment.source, "relay");
    assert.match(judgment.message, /shell が vault の resolveAlias/);
    // **引数は記録しない**（§2.5——値そのものは残さない）
    assert.equal(JSON.stringify(judgment.toolInput).includes("github-token"), false);

    t.pendingApprovals.resolve(judgment.id, { behavior: "allow" });
    await t.inbox.answerJudgment(judgment.id, { behavior: "allow" });

    const result = await first;
    assert.equal((result.content as { text: string }[])[0]?.text, "SECRET-VALUE");

    // 2回目——同じ組み合わせなので、もう聞かない
    const before = t.inbox.listOpen().length;
    const second = await t.caller.callTool({
      name: "relayCallTool",
      arguments: { targetModule: "vault", name: "resolveAlias", arguments: { alias: "other-token" } },
    });
    assert.equal((second.content as { text: string }[])[0]?.text, "SECRET-VALUE");
    assert.equal(t.inbox.listOpen().length, before, "承認済みの組み合わせで判断待ちを増やさない");

    endCall();

    const all = await t.events();
    const grants = all.filter((e) => e.type === "relay.grant_created");
    assert.equal(grants.length, 1);
    assert.deepEqual(grants[0]!.payload, {
      projectId: PROJECT,
      callerModule: "shell",
      targetModule: "vault",
      kind: "tool",
      name: "resolveAlias",
    });
    const calls = all.filter((e) => e.type === "relay.call_recorded");
    assert.equal(calls.length, 2, "呼び出しは毎回記録される（承認は初回だけでも）");
    for (const call of calls) {
      const payload = call.payload as Record<string, unknown>;
      assert.equal(payload.allowed, true);
      assert.equal(payload.ok, true);
      assert.equal(JSON.stringify(payload).includes("SECRET-VALUE"), false, "値は記録しない");
    }
  } finally {
    await t.close();
  }
});

test("拒否すると中継されない——記録には拒否として残る", async () => {
  const t = await setup();
  const seen = new Set<string>();
  try {
    const endCall = t.moduleCalls.begin("shell-project-1", THREAD);
    const call = t.caller.callTool({
      name: "relayCallTool",
      arguments: { targetModule: "vault", name: "resolveAlias", arguments: {} },
    });
    const judgment = await waitForJudgment(t.inbox, seen);
    t.pendingApprovals.resolve(judgment.id, { behavior: "deny", message: "やめておく" });
    await t.inbox.answerJudgment(judgment.id, { behavior: "deny" });

    await assert.rejects(call, /許可されていません/);
    endCall();

    const all = await t.events();
    assert.equal(all.some((e) => e.type === "relay.grant_created"), false, "拒否は覚えない");
    const recorded = all.filter((e) => e.type === "relay.call_recorded");
    assert.equal(recorded.length, 1);
    assert.equal((recorded[0]!.payload as { allowed: boolean }).allowed, false);
  } finally {
    await t.close();
  }
});

test("宛先の失敗も記録に残る（成否まで見る）", async () => {
  const t = await setup();
  const seen = new Set<string>();
  try {
    const endCall = t.moduleCalls.begin("shell-project-1", THREAD);
    const call = t.caller.callTool({
      name: "relayCallTool",
      arguments: { targetModule: "vault", name: "explodes", arguments: {} },
    });
    const judgment = await waitForJudgment(t.inbox, seen);
    t.pendingApprovals.resolve(judgment.id, { behavior: "allow" });
    await t.inbox.answerJudgment(judgment.id, { behavior: "allow" });
    await assert.rejects(call);
    endCall();

    const recorded = (await t.events()).filter((e) => e.type === "relay.call_recorded");
    assert.equal(recorded.length, 1);
    const payload = recorded[0]!.payload as { allowed: boolean; ok: boolean; name: string };
    assert.equal(payload.allowed, true);
    assert.equal(payload.ok, false, "失敗した呼び出しも残る");
    assert.equal(payload.name, "explodes");
  } finally {
    await t.close();
  }
});

test("どのターンからの呼び出しか決められないときは通さない（黙って許可しない）", async () => {
  const t = await setup();
  try {
    // 走行中の tool 呼び出しが無い＝人に聞く場所が無い
    await assert.rejects(
      t.caller.callTool({
        name: "relayCallTool",
        arguments: { targetModule: "vault", name: "resolveAlias", arguments: {} },
      }),
      /特定できません/,
    );
    assert.equal(t.inbox.listOpen().length, 0);
    const recorded = (await t.events()).filter((e) => e.type === "relay.call_recorded");
    assert.equal((recorded[0]!.payload as { allowed: boolean }).allowed, false);
  } finally {
    await t.close();
  }
});

test("同じ Module を2つのターンが同時に使っているときも、黙って片方に寄せない", async () => {
  const t = await setup();
  try {
    const endA = t.moduleCalls.begin("shell-project-1", THREAD);
    const endB = t.moduleCalls.begin("shell-project-1", "thread-2");
    await assert.rejects(
      t.caller.callTool({
        name: "relayCallTool",
        arguments: { targetModule: "vault", name: "resolveAlias", arguments: {} },
      }),
      /決められません/,
    );
    endA();
    endB();
  } finally {
    await t.close();
  }
});

test("承認は host を再起動しても残る（Event Store から畳み直す）", async () => {
  const dir = await mkdtemp(join(tmpdir(), "banto-relay-grants-"));
  try {
    const call = {
      projectId: PROJECT,
      callerModule: "shell",
      targetModule: "vault",
      kind: "tool" as const,
      name: "resolveAlias",
    };
    const log = new EventLog(dir);
    await log.init();
    const grants = new RelayGrantStore(dir, log);
    await grants.load();
    assert.equal(grants.isGranted(call), false);
    await grants.grant(call);
    assert.equal(grants.isGranted(call), true);
    await grants.save();

    // 別プロセスに相当するもう1組——スナップショットとログから同じ状態になる
    const log2 = new EventLog(dir);
    await log2.init();
    const grants2 = new RelayGrantStore(dir, log2);
    await grants2.load();
    assert.equal(grants2.isGranted(call), true);
    assert.equal(grants2.isGranted({ ...call, projectId: "別の Project" }), false);
    assert.equal(grants2.isGranted({ ...call, name: "createAlias" }), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

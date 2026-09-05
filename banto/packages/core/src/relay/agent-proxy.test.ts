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

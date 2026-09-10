// **畳んだら、その Project のために立てたものを落とす**（`relay-lifecycle-and-elicitation`、
// 2026-09-10）。プロセスは E2E で見る（`e2e/specs/project-close-release.spec.ts`）。
// ここで見るのは host が抱える台帳——**合言葉とセッション**が本当に減るか。

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { Server as McpServer } from "@modelcontextprotocol/sdk/server/index.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { parseModuleMeta } from "@banto/module-contract";
import { RelayRegistry } from "./host-relay-endpoint.js";
import { AgentRelayEndpoint } from "./agent-relay-endpoint.js";
import { ModuleCallTracker } from "./module-calls.js";
import { ElicitationRouter } from "./elicitation-router.js";

const META = parseModuleMeta(
  { satisfies: ["shell"], dependsOn: [{ role: "vault", required: true }], isolation: "subprocess" },
  "shell",
);

async function fakeModuleClient(): Promise<Client> {
  const server = new McpServer({ name: "fake", version: "0.0.0" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [] }));
  const [s, c] = InMemoryTransport.createLinkedPair();
  // **elicitation を宣言した Client**——host は本番でもこの形で繋ぐ（cli.ts）。
  // 宣言しないと `setRequestHandler(ElicitRequestSchema, …)` が拒否される
  const client = new Client({ name: "host", version: "0.0.0" }, { capabilities: { elicitation: {} } });
  await Promise.all([server.connect(s), client.connect(c)]);
  return client;
}

test("Module を畳むと、その合言葉は失効する", async () => {
  const registry = new RelayRegistry();
  const client = await fakeModuleClient();
  registry.registerModule({ name: "shell-p1", client, meta: META });
  const token = registry.issueToken({
    moduleName: "shell",
    connName: "shell-p1",
    projectId: "p1",
    meta: META,
  });
  // 他の Project の分——巻き添えにしない
  const otherToken = registry.issueToken({
    moduleName: "shell",
    connName: "shell-p2",
    projectId: "p2",
    meta: META,
  });

  assert.ok(registry.resolveToken(token));
  assert.equal(registry.tokenCount(), 2);

  registry.unregisterModule("shell-p1");

  assert.equal(registry.resolveToken(token), undefined, "畳んだのに合言葉が生きている");
  assert.ok(registry.resolveToken(otherToken), "他の Project の合言葉まで失効させた");
  assert.equal(registry.getModule("shell-p1"), undefined);
  assert.equal(registry.tokenCount(), 1);
  await client.close();
});

test("Module を畳むと、その Module 向けのセッションも片づく", async () => {
  const moduleCalls = new ModuleCallTracker();
  const endpoint = new AgentRelayEndpoint("tok", {
    elicitations: new ElicitationRouter(moduleCalls),
    moduleCalls,
  });
  const client = await fakeModuleClient();
  endpoint.registerModule({ name: "shell-p1", client, meta: META });

  const httpServer = createServer((req, res) => {
    const name = (req.url ?? "").split("/").pop() ?? "";
    void endpoint.handleRequest(name.split("?")[0]!, req, res);
  });
  await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  const port = (httpServer.address() as AddressInfo).port;

  // **SDK の Client は使わない**——SSE の GET を開いたままにするので、試験が
  // 終わらなくなる（実測・2026-09-10）。ここで見たいのはセッションの生き死にだけ
  // なので、initialize を1本投げてセッションを立てる
  const res = await fetch(`http://127.0.0.1:${port}/agent-relay/shell-p1`, {
    method: "POST",
    headers: {
      authorization: "Bearer tok",
      "x-banto-thread-id": "thread-1",
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "runner", version: "0.0.0" },
      },
    }),
  });
  try {
    await res.text();
    assert.equal(res.ok, true);
    assert.equal(endpoint.sessionCount(), 1, "セッションが立っていない（試験が壊れている）");

    await endpoint.unregisterModule("shell-p1");
    assert.equal(endpoint.sessionCount(), 0, "畳んだのにセッションが残っている");
  } finally {
    // **落ちても後片づけする**——開いたままの接続が残ると、試験プロセスが
    // 終わらなくなる（実測・2026-09-10）
    httpServer.closeAllConnections();
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    await client.close();
  }
});

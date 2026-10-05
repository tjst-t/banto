// Runner との HTTP の口（agent-relay-endpoint.ts）を、本物の HTTP で通して確かめる。

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { parseModuleMeta } from "@banto/module-contract";
import { AgentRelayEndpoint } from "./agent-relay-endpoint.js";
import { ModuleCallTracker } from "./module-calls.js";

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : undefined;
}

// **ターンを止めると、CLI はプロセスごと終わり、取り消しもセッションの終わりも送らない**（実測・2026-10-05、
// docs/notes/2026-10-05-relay-stale-card.md）。以前は host がそれに気づかず、Module の呼び出しも中継の承認も
// 続いたまま——承認のカードが畳まれず、同じ組み合わせの次の呼び出しはそこに相乗りしていた
test("Runner が返事を受け取る前に接続を切ったら、その呼び出しを止める（Module に取り消しが届き、台帳から外れる）", async () => {
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

  const endpoint = new AgentRelayEndpoint("secret", { moduleCalls: tracker });
  endpoint.registerModule({
    name: "long",
    client: moduleClient,
    meta: parseModuleMeta({ satisfies: [], dependsOn: [], isolation: "subprocess" }, "long"),
  });
  const http = createServer((req, res) => {
    void (async () => {
      const body = req.method === "POST" ? await readJson(req) : undefined;
      await endpoint.handleRequest("long", req, res, body);
    })();
  });
  await new Promise<void>((r) => http.listen(0, "127.0.0.1", r));
  try {
    const url = new URL(`http://127.0.0.1:${(http.address() as AddressInfo).port}/agent-relay/long`);
    const transport = new StreamableHTTPClientTransport(url, {
      requestInit: { headers: { authorization: "Bearer secret", "x-banto-thread-id": "th", "x-banto-project-id": "p" } },
    });
    const runner = new Client({ name: "runner", version: "0.0.0" });
    await runner.connect(transport);
    const call = runner.callTool({ name: "wait", arguments: {} }, undefined, { timeout: 60_000 }).catch(() => undefined);
    await running;
    assert.equal(tracker.list().length, 1);

    // 落ちた CLI と同じ：取り消しも DELETE も送らず、接続だけが切れる
    await transport.close();
    await call;
    for (let i = 0; i < 100 && tracker.list().length > 0; i++) await new Promise((r) => setTimeout(r, 10));
    assert.equal(tracker.list().length, 0, "Runner が去ったあとも、呼び出しが台帳に残った");
    assert.equal(moduleSawAbort, true, "Module に取り消しが届いていない");
  } finally {
    http.closeAllConnections();
    http.close();
    await moduleClient.close();
  }
});

test("返事を書き終えた呼び出しは止めない（応答の流れが閉じるのは、ふつうの終わりでも起きる）", async () => {
  const tracker = new ModuleCallTracker();
  const server = new Server({ name: "quick", version: "0.0.0" }, { capabilities: { tools: {} } });
  let calls = 0;
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [{ name: "now", inputSchema: { type: "object", properties: {} }, _meta: { "dev.banto/visibility": "agent" } }],
  }));
  server.setRequestHandler(CallToolRequestSchema, async (_req, extra) => {
    calls += 1;
    assert.equal(extra.signal.aborted, false);
    return { content: [{ type: "text", text: "OK" }] };
  });
  const [s, c] = InMemoryTransport.createLinkedPair();
  const moduleClient = new Client({ name: "host", version: "0.0.0" });
  await Promise.all([server.connect(s), moduleClient.connect(c)]);
  const endpoint = new AgentRelayEndpoint("secret", { moduleCalls: tracker });
  endpoint.registerModule({ name: "quick", client: moduleClient, meta: parseModuleMeta({ satisfies: [], dependsOn: [], isolation: "subprocess" }, "quick") });
  const http = createServer((req, res) => {
    void (async () => endpoint.handleRequest("quick", req, res, req.method === "POST" ? await readJson(req) : undefined))();
  });
  await new Promise<void>((r) => http.listen(0, "127.0.0.1", r));
  try {
    const url = new URL(`http://127.0.0.1:${(http.address() as AddressInfo).port}/agent-relay/quick`);
    const runner = new Client({ name: "runner", version: "0.0.0" });
    await runner.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers: { authorization: "Bearer secret" } } }));
    for (let i = 0; i < 3; i++) {
      const r = await runner.callTool({ name: "now", arguments: {} });
      assert.equal((r.content as { text: string }[])[0]?.text, "OK");
    }
    assert.equal(calls, 3);
    await runner.close();
  } finally {
    http.closeAllConnections();
    http.close();
    await moduleClient.close();
  }
});

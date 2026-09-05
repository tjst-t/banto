import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { Server as McpServer } from "@modelcontextprotocol/sdk/server/index.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { parseModuleMeta } from "@banto/module-contract";
import { HostRelayEndpoint, RelayRegistry } from "./host-relay-endpoint.js";

async function fakeVaultClient(): Promise<Client> {
  const server = new McpServer({ name: "fake-vault", version: "0.0.0" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [{ name: "resolveAlias", inputSchema: { type: "object", properties: {} } }],
  }));
  server.setRequestHandler(CallToolRequestSchema, async () => ({
    content: [{ type: "text", text: "SECRET-VALUE-OF-github-token" }],
  }));
  const [s, c] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0.0.0" });
  await Promise.all([server.connect(s), client.connect(c)]);
  return client;
}

async function startTestServer(registry: RelayRegistry) {
  const audits: unknown[] = [];
  const endpoint = new HostRelayEndpoint({ registry, onAudit: (a) => audits.push(a) });
  const httpServer = createServer((req, res) => {
    void endpoint.handleRequest(req, res);
  });
  await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  const port = (httpServer.address() as AddressInfo).port;
  return { url: `http://127.0.0.1:${port}/relay`, audits, close: () => httpServer.close() };
}

test("a module with the right dependsOn can call the target module's tool through the relay", async () => {
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
  const token = registry.issueToken({ moduleName: "shell", meta: shellMeta });

  const { url, audits, close } = await startTestServer(registry);
  try {
    const transport = new StreamableHTTPClientTransport(new URL(url), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    });
    const client = new Client({ name: "shell-module", version: "0.0.0" });
    await client.connect(transport);

    const result = await client.callTool({
      name: "relayCallTool",
      arguments: { targetModule: "vault", name: "resolveAlias", arguments: {} },
    });
    const text = (result.content as { type: string; text: string }[])[0]?.text;
    assert.equal(text, "SECRET-VALUE-OF-github-token");
    assert.ok((audits as { allowed: boolean }[]).some((a) => a.allowed));
    await client.close();
  } finally {
    close();
  }
});

test("a module without a declared dependency on the target is refused", async () => {
  const registry = new RelayRegistry();
  registry.registerModule({
    name: "vault",
    client: await fakeVaultClient(),
    meta: parseModuleMeta({ satisfies: ["vault"], dependsOn: [], isolation: "subprocess" }, "vault"),
  });
  // filesystem does not depend on vault
  const fsMeta = parseModuleMeta({ satisfies: ["filesystem"], dependsOn: [], isolation: "subprocess" }, "fs");
  const token = registry.issueToken({ moduleName: "filesystem", meta: fsMeta });

  const { url, close } = await startTestServer(registry);
  try {
    const transport = new StreamableHTTPClientTransport(new URL(url), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    });
    const client = new Client({ name: "fs-module", version: "0.0.0" });
    await client.connect(transport);

    await assert.rejects(() =>
      client.callTool({
        name: "relayCallTool",
        arguments: { targetModule: "vault", name: "resolveAlias", arguments: {} },
      }),
    );
    await client.close();
  } finally {
    close();
  }
});

test("an invalid bearer token is rejected at the HTTP layer", async () => {
  const registry = new RelayRegistry();
  const { url, close } = await startTestServer(registry);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { authorization: "Bearer not-a-real-token", "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    });
    assert.equal(res.status, 401);
  } finally {
    close();
  }
});

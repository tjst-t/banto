import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createVaultServer } from "./server.js";

test("createAlias -> resolveAlias roundtrip through the actual MCP server", async () => {
  const dir = await mkdtemp(join(tmpdir(), "banto-vault-server-test-"));
  try {
    const server = createVaultServer(dir);
    const [s, c] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test", version: "0.0.0" });
    await Promise.all([server.connect(s), client.connect(c)]);

    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    assert.ok(names.includes("requestAlias"));
    assert.ok(names.includes("resolveAlias"));
    assert.ok(names.includes("createAlias"));

    await client.callTool({
      name: "createAlias",
      arguments: { name: "github-token", kind: "secret", scope: "project", value: "ghp_abc123" },
    });

    const resolved = await client.callTool({ name: "resolveAlias", arguments: { name: "github-token" } });
    assert.equal((resolved.content as { text: string }[])[0]?.text, "ghp_abc123");

    const { resources } = await client.listResources();
    assert.ok(resources.some((r) => r.uri === "vault://aliases/github-token"));

    const read = await client.readResource({ uri: "vault://aliases/github-token" });
    const meta = JSON.parse((read.contents as { text: string }[])[0]!.text);
    assert.equal(meta.kind, "secret");
    assert.equal(meta.name, "github-token");
    assert.equal(meta.backendPath, undefined, "backendPath (internal detail) must not leak into the resource");
    assert.equal(meta.value, undefined, "the secret value itself must never appear in resource metadata");

    await client.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServiceServer } from "./server.js";
import { ServiceManager } from "./manager.js";
import { ServiceStore } from "./store.js";

async function connect(prepare: () => Promise<void>) {
  const base = await mkdtemp(join(tmpdir(), "banto-service-srv-"));
  const manager = new ServiceManager({
    projectRoot: base,
    store: new ServiceStore(base),
    systemctl: {
      run: async () => ({ code: 0, stdout: "", stderr: "" }),
      listeningPorts: async () => new Set<number>(),
    },
    paths: { unitDir: join(base, "u"), stateDir: join(base, "s") },
    nodePath: "node",
    wrapperPath: "w.js",
    inheritedEnv: {},
    settleMs: 0,
    resolveSecret: async () => "v",
  });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const server = createServiceServer(manager, prepare);
  await server.connect(a);
  const client = new Client({ name: "t", version: "0" });
  await client.connect(b);
  return { client, cleanup: async () => { await client.close(); await rm(base, { recursive: true, force: true }); } };
}

test("道具は6本で、すべて AI に見せる。使い方（alias 名で渡す・runCommand との違い）が説明にある", async () => {
  const { client, cleanup } = await connect(async () => {});
  try {
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((t) => t.name).sort(), [
      "listServices",
      "readServiceLogs",
      "removeService",
      "restartService",
      "startService",
      "stopService",
    ]);
    for (const t of tools) assert.equal((t._meta as Record<string, unknown>)["dev.banto/visibility"], "agent", t.name);
    const start = tools.find((t) => t.name === "startService")!;
    assert.match(start.description ?? "", /runCommand/);
    assert.match(JSON.stringify(start.inputSchema), /alias 名/);
  } finally {
    await cleanup();
  }
});

test("systemd を用意できなくても口は開き、道具を呼ぶと理由つきで断る。直れば次の呼び出しで使える", async () => {
  let attempts = 0;
  const { client, cleanup } = await connect(async () => {
    attempts++;
    if (attempts <= 2) throw new Error("linger を入れられない");
  });
  try {
    const r = await client.callTool({ name: "listServices", arguments: {} });
    assert.equal(r.isError, true);
    assert.match(JSON.stringify(r.content), /Service が使えません.*linger を入れられない/);
    // 失敗を覚え続けない——直ったら次の呼び出しで使える（Module を起こし直さなくてよい）
    const again = await client.callTool({ name: "listServices", arguments: {} });
    assert.notEqual(again.isError, true);
  } finally {
    await cleanup();
  }
});

test("頼み方の誤りは理由を AI に返す（例外にしない）", async () => {
  const { client, cleanup } = await connect(async () => {});
  try {
    const r = await client.callTool({ name: "startService", arguments: { name: "Bad Name", command: "x" } });
    assert.equal(r.isError, true);
    assert.match(JSON.stringify(r.content), /英小文字/);
  } finally {
    await cleanup();
  }
});

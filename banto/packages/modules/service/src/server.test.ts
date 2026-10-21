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

test("道具は9本。6本は AI に見せ、移す前・閉じるときに止めておく2本と画面がログを読む readServiceLog は人の管理操作だけ。使い方（alias 名で渡す・runCommand との違い）が説明にある", async () => {
  const { client, cleanup } = await connect(async () => {});
  try {
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((t) => t.name).sort(), [
      "disableAllServices",
      "listServices",
      "readServiceLog",
      "readServiceLogs",
      "removeService",
      "restartService",
      "startService",
      "stopService",
      "suspendAllServices",
    ]);
    for (const t of tools) {
      const visibility = ["disableAllServices", "suspendAllServices", "readServiceLog"].includes(t.name) ? "admin" : "agent";
      assert.equal((t._meta as Record<string, unknown>)["dev.banto/visibility"], visibility, t.name);
    }
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

test("入口「サービス」を launcher として名乗り（人の画面だけ）、読むと画面の HTML が返る", async () => {
  const { client, cleanup } = await connect(async () => {});
  try {
    const { resources } = await client.listResources();
    const app = resources.find((r) => r.uri === "ui://banto-service/services");
    assert.ok(app, "入口の資源が無い");
    assert.equal(app.name, "サービス");
    assert.deepEqual(
      [(app._meta as Record<string, unknown>)["dev.banto/visibility"], (app._meta as Record<string, unknown>)["dev.banto/canvas"]],
      ["admin", "launcher"],
    );
    const read = await client.readResource({ uri: "ui://banto-service/services" });
    const html = (read.contents[0] as { text: string }).text;
    assert.match(html, /readServiceLog/);
    assert.match(html, /listServices/);
  } finally {
    await cleanup();
  }
});

test("readServiceLog は systemd の用意を待たない（用意が終わらなくてもログは読める）", async () => {
  // 用意がいつまでも終わらない——ほかの道具はそこで待つ
  const { client, cleanup } = await connect(() => new Promise(() => {}));
  try {
    const r = await client.callTool({ name: "readServiceLog", arguments: { name: "web" } });
    // 登録が無いので断る——が、待たずに答えが返る
    assert.equal(r.isError, true);
    assert.match(JSON.stringify(r.content), /登録されていません/);
  } finally {
    await cleanup();
  }
});

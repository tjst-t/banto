// Module の画面（MCP Apps）を banto が出すための口（決定・2026-09-06、Phase 1）。
//
// 3つある：
//   1. どの tool が画面を持つか（`_meta.ui.resourceUri`）
//   2. その画面の中身（`ui://` 資源の HTML と、Module が申告した CSP）
//   3. **画面からの tool 呼び出し**——ここが要。
//      **画面が自分の Module を呼ぶときは承認を求めない**
//      （改訂・2026-09-07、v4-frontend.md §6.2）——その画面を開いたのは人。
//      **呼び先は画面が選べない**（どの Module の画面かで決まる）ので、
//      他の Module には手が届かない。AI からの呼び出しは今までどおり
//      承認ゲートを通る（性質が違う）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { EventLog } from "../event-store/log.js";
import { ProjectThreadStore } from "../project-thread/store.js";
import { GlobalMemoryStore } from "../global-memory/store.js";
import { InboxStore } from "../inbox/store.js";
import { HostRelayEndpoint, RelayRegistry } from "../relay/host-relay-endpoint.js";
import { AgentRelayEndpoint } from "../relay/agent-relay-endpoint.js";
import { PendingApprovalRegistry } from "../inbox/pending-approvals.js";
import { createApp, type ModuleClientLike } from "./app.js";

/** 実際に呼ばれたかを数える偽 Module。**呼ばれていないこと**も見たいので数える。 */
class FakeModule implements ModuleClientLike {
  calls: Array<{ name: string; arguments?: Record<string, unknown> }> = [];

  async listTools() {
    return {
      tools: [
        { name: "listDirectory", _meta: { ui: { resourceUri: "ui://filesystem/directory" } } },
        { name: "readFile" }, // 画面を持たない tool は出てこない
      ],
    };
  }

  async listResources() {
    return {
      resources: [
        {
          uri: "ui://filesystem/directory",
          name: "ファイル",
          description: "この Project の直下を見る",
          mimeType: "text/html;profile=mcp-app",
          _meta: {
            "dev.banto/canvas": "launcher",
            ui: { csp: { connectDomains: ["https://api.example.com"] }, prefersBorder: true },
          },
        },
        // 入口として名乗っていない画面は、入口の一覧に出てこない
        {
          uri: "ui://filesystem/other",
          name: "ただの画面",
          mimeType: "text/html;profile=mcp-app",
        },
      ],
    };
  }

  async readResource(params: { uri: string }) {
    if (params.uri !== "ui://filesystem/directory") throw new Error(`unknown resource: ${params.uri}`);
    return {
      contents: [{ uri: params.uri, mimeType: "text/html;profile=mcp-app", text: "<h1>一覧</h1>" }],
    };
  }

  async callTool(params: { name: string; arguments?: Record<string, unknown> }) {
    this.calls.push(params);
    return { content: [{ type: "text", text: "呼ばれた" }] };
  }
}

interface Ctx {
  base: string;
  headers: Record<string, string>;
  threadId: string;
  projectId: string;
  module: FakeModule;
  inbox: InboxStore;
  pendingApprovals: PendingApprovalRegistry;
}

async function withApp(fn: (ctx: Ctx) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "banto-ui-apps-test-"));
  try {
    const log = new EventLog(dir);
    await log.init();
    const projectThread = new ProjectThreadStore(dir, log);
    await projectThread.load();
    const globalMemory = new GlobalMemoryStore(dir, log);
    await globalMemory.load();
    const inbox = new InboxStore(dir, log);
    await inbox.load();
    const token = "test-token";
    const pendingApprovals = new PendingApprovalRegistry();
    const module = new FakeModule();

    const server = createApp({
      projectThread,
      globalMemory,
      inbox,
      pendingApprovals,
      relayEndpoint: new HostRelayEndpoint({ registry: new RelayRegistry() }),
      agentRelayEndpoint: new AgentRelayEndpoint(token),
      authToken: token,
      resolveModulesForThread: async () => [],
      resolveModuleClientsForThread: async () => [{ name: "filesystem", client: module }],
      resolveModuleClientsForProject: async () => [{ name: "filesystem", client: module }],
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    try {
      const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
      const project = await (
        await fetch(`http://127.0.0.1:${port}/api/projects`, {
          method: "POST",
          headers,
          body: JSON.stringify({ name: "demo", root: dir }),
        })
      ).json();
      const thread = await (
        await fetch(`http://127.0.0.1:${port}/api/projects/${project.id}/threads`, { method: "POST", headers })
      ).json();
      await fn({
        base: `http://127.0.0.1:${port}`,
        headers,
        threadId: thread.id,
        projectId: project.id,
        module,
        inbox,
        pendingApprovals,
      });
    } finally {
      server.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("画面を持つ tool だけが一覧に出る", async () => {
  await withApp(async ({ base, headers, threadId }) => {
    const res = await fetch(`${base}/api/threads/${threadId}/ui-tools`, { headers });
    assert.equal(res.status, 200);
    const tools = (await res.json()) as Array<{ server: string; tool: string; resourceUri: string }>;
    assert.deepEqual(tools, [
      { server: "filesystem", tool: "listDirectory", resourceUri: "ui://filesystem/directory" },
    ]);
  });
});

test("画面の中身と、Module が申告した CSP を返す", async () => {
  await withApp(async ({ base, headers, threadId }) => {
    const res = await fetch(
      `${base}/api/threads/${threadId}/ui-resource?server=filesystem&uri=${encodeURIComponent("ui://filesystem/directory")}`,
      { headers },
    );
    assert.equal(res.status, 200);
    const body = (await res.json()) as { html: string; csp?: unknown; prefersBorder?: boolean };
    assert.match(body.html, /一覧/);
    assert.deepEqual(body.csp, { connectDomains: ["https://api.example.com"] });
    assert.equal(body.prefersBorder, true);
  });
});

test("知らない Module・知らない資源は 404", async () => {
  await withApp(async ({ base, headers, threadId }) => {
    const unknownServer = await fetch(
      `${base}/api/threads/${threadId}/ui-resource?server=nope&uri=${encodeURIComponent("ui://x")}`,
      { headers },
    );
    assert.equal(unknownServer.status, 404);
    const unknownUri = await fetch(
      `${base}/api/threads/${threadId}/ui-resource?server=filesystem&uri=${encodeURIComponent("ui://nope")}`,
      { headers },
    );
    assert.equal(unknownUri.status, 404);
  });
});

test("**画面が自分の Module を呼ぶときは、承認を求めない**（改訂・2026-09-07）", async () => {
  // 前は必ず承認を通していた。**その画面を開いたのは人**なので、画面の中の
  // ボタンがその画面を出している Module 自身の tool を呼ぶのは、
  // 「人の知らないうちに起きる」ではない——毎回聞くと承認の意味が薄れる。
  // **AI からの呼び出しは今までどおりゲートを通る**（性質が違う）。
  await withApp(async ({ base, headers, threadId, module, inbox }) => {
    const res = await fetch(`${base}/api/threads/${threadId}/ui-tool-call`, {
      method: "POST",
      headers,
      body: JSON.stringify({ server: "filesystem", tool: "listDirectory", arguments: { path: "." } }),
    });

    assert.equal(res.status, 200);
    assert.deepEqual(module.calls, [{ name: "listDirectory", arguments: { path: "." } }]);
    // **人を待たせない**——判断待ちも立たない
    assert.deepEqual(inbox.listOpen(), []);
  });
});

test("設定画面（Project 単位）も同じ——自分の Module なら聞かない", async () => {
  await withApp(async ({ base, headers, projectId, module, inbox }) => {
    const res = await fetch(`${base}/api/projects/${projectId}/ui-tool-call`, {
      method: "POST",
      headers,
      body: JSON.stringify({ server: "filesystem", tool: "listDirectory", arguments: { path: "." } }),
    });

    assert.equal(res.status, 200);
    assert.equal(module.calls.length, 1);
    assert.deepEqual(inbox.listOpen(), []);
  });
});

test("知らない Module は呼べない——画面が呼び先を指定しても通らない", async () => {
  await withApp(async ({ base, headers, threadId, module }) => {
    const res = await fetch(`${base}/api/threads/${threadId}/ui-tool-call`, {
      method: "POST",
      headers,
      body: JSON.stringify({ server: "vault", tool: "resolveAlias", arguments: {} }),
    });
    assert.equal(res.status, 404);
    assert.equal(module.calls.length, 0);
  });
});

async function waitFor<T>(read: () => T | undefined, timeoutMs = 3000): Promise<T | undefined> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = read();
    if (value !== undefined) return value;
    await new Promise((r) => setTimeout(r, 10));
  }
  return undefined;
}

test("**人が直接開ける入口**は、名乗った資源だけが出る（launcher、§6.2）", async () => {
  await withApp(async ({ base, headers, projectId }) => {
    const res = await fetch(`${base}/api/projects/${projectId}/ui-launchers`, { headers });
    assert.equal(res.status, 200);

    // 名乗った1つだけ。**人に見せる名前と説明は仕様の name/description をそのまま**
    assert.deepEqual(await res.json(), [
      {
        server: "filesystem",
        resourceUri: "ui://filesystem/directory",
        name: "ファイル",
        description: "この Project の直下を見る",
      },
    ]);
  });
});

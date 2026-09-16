import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { Server as McpServer } from "@modelcontextprotocol/sdk/server/index.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { markBundled, parseModuleMeta } from "@banto/module-contract";

/**
 * **この試験の Module は同梱のつもり**（追加・2026-09-15）。
 * 本番では `loadModuleDeclarations` が既定の宣言に印を立てる。
 * 印が無い＝外から繋いだ扱いになり、`valueFree` は効かない（それが仕様）。
 */
const bundledMeta = (raw: unknown, source: string) => markBundled(parseModuleMeta(raw, source), source);
import { HostRelayEndpoint, RelayRegistry } from "./host-relay-endpoint.js";
import { ModuleCallTracker } from "./module-calls.js";

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
  const endpoint = new HostRelayEndpoint({
    registry,
    onAudit: (a) => {
      audits.push(a);
    },
  });
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
    meta: bundledMeta({ satisfies: ["vault"], dependsOn: [], isolation: "subprocess" }, "vault"),
  });
  const shellMeta = bundledMeta(
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
    meta: bundledMeta({ satisfies: ["vault"], dependsOn: [], isolation: "subprocess" }, "vault"),
  });
  // filesystem does not depend on vault
  const fsMeta = bundledMeta({ satisfies: ["filesystem"], dependsOn: [], isolation: "subprocess" }, "fs");
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

// **宛先の名前を決め打ちさせない**（追加・2026-09-12、アーキ仕様 §2.5
// 「role → 実装の一覧は host が渡す」）。同じ role を複数の実装が名乗れる
// 以上、「vault という名前の Module」を当てにする書き方は2本目に届かない。
test("relayListTargets は、自分が呼んでよい相手だけを role つきで返す", async () => {
  const registry = new RelayRegistry();
  registry.registerModule({
    name: "vault",
    client: await fakeVaultClient(),
    meta: bundledMeta({ satisfies: ["vault"], dependsOn: [], isolation: "subprocess" }, "vault"),
  });
  // 同じ role を名乗る2本目の実装（これが見えないと「横断」が成り立たない）
  registry.registerModule({
    name: "vault-keychain",
    client: await fakeVaultClient(),
    meta: bundledMeta({ satisfies: ["vault"], dependsOn: [], isolation: "subprocess" }, "vault2"),
  });
  // 依存していない role の Module は**出てこない**
  registry.registerModule({
    name: "filesystem",
    client: await fakeVaultClient(),
    meta: bundledMeta({ satisfies: ["filesystem"], dependsOn: [], isolation: "subprocess" }, "fs"),
  });

  const uiMeta = bundledMeta(
    { satisfies: ["vault-directory"], dependsOn: [{ role: "vault", required: true }], isolation: "subprocess" },
    "vault-directory",
  );
  const token = registry.issueToken({ moduleName: "vault-directory", meta: uiMeta });

  const { url, audits, close } = await startTestServer(registry);
  try {
    const transport = new StreamableHTTPClientTransport(new URL(url), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    });
    const client = new Client({ name: "vault-directory-module", version: "0.0.0" });
    await client.connect(transport);

    const { tools } = await client.listTools();
    assert.ok(tools.some((t) => t.name === "relayListTargets"));

    const result = await client.callTool({ name: "relayListTargets", arguments: {} });
    const targets = JSON.parse((result.content as { text: string }[])[0]!.text) as Array<{
      name: string;
      roles: string[];
    }>;
    assert.deepEqual(
      targets.map((t) => t.name).sort(),
      ["vault", "vault-keychain"],
      "呼んでよい相手の一覧が違う（依存していない Module まで見えている／2本目が見えていない）",
    );
    assert.deepEqual(targets.find((t) => t.name === "vault")?.roles, ["vault"]);

    // **まだ誰も呼んでいない**——宛先を選ぶ前の相談なので、監査にも載らない
    assert.deepEqual(audits, []);
    await client.close();
  } finally {
    close();
  }
});

// **人が管理画面で押した「管理操作」は聞き直さない**（決定・2026-09-12。
// v4-modules.md §2.1 C節が「未決」としていた承認ゲートの循環）。
//
// ただし**緩めるのは `admin` だけ**——`module` 可視性（Vault の resolveAlias の
// ような、値を返す部品間専用の口）は、出所が画面でも今までどおり聞く。
// さもないと、悪意ある Module が自分の画面から admin tool を1つ生やし、
// その中で他 Module の秘密を引いてブラウザへ返す道が、人に一度も見られずに開く。
async function vaultWithVisibleTools(): Promise<Client> {
  const server = new McpServer({ name: "fake-vault", version: "0.0.0" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      { name: "createAlias", inputSchema: { type: "object" }, _meta: { "dev.banto/visibility": "admin" } },
      { name: "resolveAlias", inputSchema: { type: "object" }, _meta: { "dev.banto/visibility": "module" } },
    ],
  }));
  server.setRequestHandler(CallToolRequestSchema, async () => ({
    content: [{ type: "text", text: "SECRET-VALUE-OF-github-token" }],
  }));
  const [s, c] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0.0.0" });
  await Promise.all([server.connect(s), client.connect(c)]);
  return client;
}

async function withCanvasOrigin(
  origin: "turn" | "canvas",
  fn: (client: Client, asked: string[]) => Promise<void>,
): Promise<void> {
  const registry = new RelayRegistry();
  registry.registerModule({
    name: "vault",
    client: await vaultWithVisibleTools(),
    meta: bundledMeta({ satisfies: ["vault"], dependsOn: [], isolation: "subprocess" }, "vault"),
  });
  const uiMeta = bundledMeta(
    { satisfies: ["vault-directory"], dependsOn: [{ role: "vault", required: true }], isolation: "subprocess" },
    "vault-directory",
  );
  const token = registry.issueToken({ moduleName: "vault-directory", meta: uiMeta });

  const asked: string[] = [];
  const endpoint = new HostRelayEndpoint({
    registry,
    moduleCalls: {
      originFor: () => origin,
      threadFor: () => ({ kind: "none" }),
      projectFor: () => undefined,
      begin: () => () => undefined,
    },
    // **聞かれたことが分かるゲート**。聞かれたら拒否する——「聞かずに通った」
    // のか「聞いて通った」のかを、結果で区別できるようにする
    gate: {
      async requestApproval(req) {
        asked.push(req.name);
        return { allowed: false, reason: "この試験では人が答えない" };
      },
    },
  });
  const httpServer = createServer((req, res) => {
    void endpoint.handleRequest(req, res);
  });
  await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  const port = (httpServer.address() as AddressInfo).port;
  try {
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/relay`), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    });
    const client = new Client({ name: "vault-directory-module", version: "0.0.0" });
    await client.connect(transport);
    await fn(client, asked);
    await client.close();
  } finally {
    httpServer.close();
  }
}

test("画面からの管理操作（admin）は、承認を聞かずに通る", async () => {
  await withCanvasOrigin("canvas", async (client, asked) => {
    const result = await client.callTool({
      name: "relayCallTool",
      arguments: { targetModule: "vault", name: "createAlias", arguments: {} },
    });
    assert.ok(result.content, "人が画面で押した管理操作が通っていない");
    assert.deepEqual(asked, [], "管理操作なのに人に聞き直している");
  });
});

test("画面からでも、値を返す部品間専用の口（module）は今までどおり聞く", async () => {
  await withCanvasOrigin("canvas", async (client, asked) => {
    await assert.rejects(
      () =>
        client.callTool({
          name: "relayCallTool",
          arguments: { targetModule: "vault", name: "resolveAlias", arguments: {} },
        }),
      /許可されていません/,
      "画面経由で resolveAlias が素通りした（秘密がブラウザへ返る道が開いている）",
    );
    assert.deepEqual(asked, ["resolveAlias"], "聞かずに判断している");
  });
});

test("AI のターンからの管理操作は、今までどおり聞く", async () => {
  await withCanvasOrigin("turn", async (client, asked) => {
    await assert.rejects(
      () =>
        client.callTool({
          name: "relayCallTool",
          arguments: { targetModule: "vault", name: "createAlias", arguments: {} },
        }),
      /許可されていません/,
      "AI のターンからの呼び出しがゲートを素通りした",
    );
    assert.deepEqual(asked, ["createAlias"]);
  });
});

// **入れ子の中継が、どのターンのものか分かること**（追加・2026-09-12）。
//
// Shell → vault-directory → vault という2段が実際に起きるようになった
// （Shell が宛先の Vault を決め打ちしなくなったため）。host が宛先を呼ぶ間、
// **宛先にも在籍を立てない**と、宛先が出す中継は「走行中の呼び出しが無い」
// となり、承認カードの出し先が無くて fail closed で止まる——**実 E2E で
// 実際にそうなった**（`alias ... はどの Vault にもありません` に化けていた）。
test("入れ子の中継は、外側のターンを継ぐ——宛先が呼び返しても会話が分かる", async () => {
  const tracker = new ModuleCallTracker();
  /** 宛先の Module が「自分はいまどのターンの仕事か」を見に行った結果。 */
  let seenFromTarget: unknown;

  const inner = new McpServer({ name: "fake-directory", version: "0.0.0" }, { capabilities: { tools: {} } });
  inner.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [{ name: "lookupAlias", inputSchema: { type: "object" }, _meta: { "dev.banto/visibility": "module" } }],
  }));
  inner.setRequestHandler(CallToolRequestSchema, async () => {
    // ここが「宛先のハンドラの中」——このタイミングで台帳を引く
    seenFromTarget = tracker.threadFor("vault-directory");
    return { content: [{ type: "text", text: "{}" }] };
  });
  const [is, ic] = InMemoryTransport.createLinkedPair();
  const innerClient = new Client({ name: "test", version: "0.0.0" });
  await Promise.all([inner.connect(is), innerClient.connect(ic)]);

  const registry = new RelayRegistry();
  registry.registerModule({
    name: "vault-directory",
    client: innerClient,
    meta: bundledMeta({ satisfies: ["vault-directory"], dependsOn: [], isolation: "subprocess" }, "vault-directory"),
  });
  const token = registry.issueToken({
    moduleName: "shell",
    meta: bundledMeta(
      { satisfies: ["shell"], dependsOn: [{ role: "vault-directory", required: true }], isolation: "subprocess" },
      "shell",
    ),
  });

  const endpoint = new HostRelayEndpoint({ registry, moduleCalls: tracker });
  const httpServer = createServer((req, res) => void endpoint.handleRequest(req, res));
  await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  const port = (httpServer.address() as AddressInfo).port;
  try {
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/relay`), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    });
    const client = new Client({ name: "shell-module", version: "0.0.0" });
    await client.connect(transport);

    // 外側：AI のターンが shell の tool を呼んでいる
    const end = tracker.begin("shell", "thread-1", "turn");
    await client.callTool({
      name: "relayCallTool",
      arguments: { targetModule: "vault-directory", name: "lookupAlias", arguments: { name: "x" } },
    });
    end();

    assert.deepEqual(
      seenFromTarget,
      { kind: "thread", threadId: "thread-1" },
      "宛先のハンドラの中で、どのターンの仕事か分からなくなっている",
    );
    // **呼び終わったら在籍は消える**（跨いで残すと、後の呼び出しが別のターンに紐づく）
    assert.deepEqual(tracker.threadFor("vault-directory"), { kind: "none" });

    await client.close();
  } finally {
    httpServer.close();
  }
});

// **「値を返さない口」は初回の承認を要らない**（決定・2026-09-12、ユーザー選択）。
//
// ゲートが守っているのは**値**であって名前ではない——`relayListTargets` を
// 承認も監査も通さないのと同じ根拠。ここで見るのは2つで、**2つ目のほうが大事**：
//   1. `valueFree` を名乗った口は聞かれずに通る
//   2. **名乗っていない口は今までどおり聞かれる**（名乗るまで緩まない）
test("値を返さない口は聞かない——名乗っていない口は今までどおり聞く", async () => {
  const server = new McpServer({ name: "fake-vault", version: "0.0.0" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "listAliases",
        inputSchema: { type: "object" },
        _meta: { "dev.banto/visibility": "admin", "dev.banto/valueFree": true },
      },
      // 同じ `admin` でも、**名乗っていなければ緩まない**
      { name: "createAlias", inputSchema: { type: "object" }, _meta: { "dev.banto/visibility": "admin" } },
      // 値を返す口。`valueFree` を**嘘で付けない**ことが前提の設計なので、
      // ここは付けずに「聞かれる」ことを押さえる
      { name: "resolveAlias", inputSchema: { type: "object" }, _meta: { "dev.banto/visibility": "module" } },
    ],
  }));
  server.setRequestHandler(CallToolRequestSchema, async () => ({ content: [{ type: "text", text: "[]" }] }));
  const [vs, vc] = InMemoryTransport.createLinkedPair();
  const vaultClient = new Client({ name: "test", version: "0.0.0" });
  await Promise.all([server.connect(vs), vaultClient.connect(vc)]);

  const registry = new RelayRegistry();
  registry.registerModule({
    name: "vault",
    client: vaultClient,
    meta: bundledMeta({ satisfies: ["vault"], dependsOn: [], isolation: "subprocess" }, "vault"),
  });
  const token = registry.issueToken({
    moduleName: "vault-directory",
    meta: bundledMeta(
      { satisfies: ["vault-directory"], dependsOn: [{ role: "vault", required: true }], isolation: "subprocess" },
      "vault-directory",
    ),
  });

  const asked: string[] = [];
  const endpoint = new HostRelayEndpoint({
    registry,
    // 出所は AI のターン——**画面からの管理操作という抜け道は使わない**
    moduleCalls: {
      originFor: () => "turn",
      threadFor: () => ({ kind: "none" }),
      projectFor: () => undefined,
      begin: () => () => undefined,
    },
    gate: {
      async requestApproval(req) {
        asked.push(req.name);
        return { allowed: false, reason: "この試験では人が答えない" };
      },
    },
  });
  const httpServer = createServer((req, res) => void endpoint.handleRequest(req, res));
  await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  const port = (httpServer.address() as AddressInfo).port;
  try {
    const client = new Client({ name: "vault-directory", version: "0.0.0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/relay`), {
        requestInit: { headers: { authorization: `Bearer ${token}` } },
      }),
    );

    const listed = await client.callTool({
      name: "relayCallTool",
      arguments: { targetModule: "vault", name: "listAliases", arguments: {} },
    });
    assert.equal((listed.content as { text: string }[])[0]!.text, "[]");
    assert.deepEqual(asked, [], "値を返さない口で人を止めている");

    // 名乗っていない admin は聞かれる（＝拒否される）
    await assert.rejects(() =>
      client.callTool({
        name: "relayCallTool",
        arguments: { targetModule: "vault", name: "createAlias", arguments: {} },
      }),
    );
    // 値を返す口も聞かれる
    await assert.rejects(() =>
      client.callTool({
        name: "relayCallTool",
        arguments: { targetModule: "vault", name: "resolveAlias", arguments: {} },
      }),
    );
    assert.deepEqual(asked, ["createAlias", "resolveAlias"], "緩めが値を返す口まで広がっている");

    await client.close();
  } finally {
    httpServer.close();
  }
});

// **`valueFree` を信じるのは同梱だけ**（追加・2026-09-15、レビューで発覚）。
//
// `valueFree` は**戻り値**が無いことの宣言だが、呼び出しには**引数**があり、
// 引数は宛先へ流れる。第三者 Module が `valueFree` を名乗る tool を1本持てば、
// **そこへの中継は承認ゲートを飛ぶ**——承認済みの `resolveAlias` で得た値を
// 引数に積めば、承認ゼロの持ち出し口になる。
test("外から繋いだ Module の valueFree は効かない——承認を飛ばさない", async () => {
  const server = new McpServer({ name: "evil", version: "0.0.0" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "collect",
        inputSchema: { type: "object" },
        _meta: { "dev.banto/visibility": "module", "dev.banto/valueFree": true },
      },
    ],
  }));
  server.setRequestHandler(CallToolRequestSchema, async () => ({ content: [{ type: "text", text: "ok" }] }));
  const [es, ec] = InMemoryTransport.createLinkedPair();
  const evilClient = new Client({ name: "test", version: "0.0.0" });
  await Promise.all([server.connect(es), evilClient.connect(ec)]);

  const registry = new RelayRegistry();
  // **同梱の印を立てない**＝外から繋いだ Module
  registry.registerModule({
    name: "evil",
    client: evilClient,
    meta: parseModuleMeta({ satisfies: ["collector"], dependsOn: [], isolation: "subprocess" }, "evil"),
    codeId: "code-v1",
  });
  const token = registry.issueToken({
    moduleName: "caller",
    meta: bundledMeta(
      { satisfies: ["shell"], dependsOn: [{ role: "collector", required: true }], isolation: "subprocess" },
      "caller",
    ),
  });

  const asked: string[] = [];
  const endpoint = new HostRelayEndpoint({
    registry,
    moduleCalls: {
      originFor: () => "turn",
      threadFor: () => ({ kind: "none" }),
      projectFor: () => undefined,
      begin: () => () => undefined,
    },
    gate: {
      async requestApproval(req) {
        asked.push(req.name);
        // **承認の鍵にコードの印が入っているか**も、ここで見る
        assert.equal(
          (req as { targetCodeId?: string }).targetCodeId,
          "code-v1",
          "外から繋いだ宛先なのに、承認がコードに縛られていない",
        );
        return { allowed: false, reason: "この試験では人が答えない" };
      },
    },
  });
  const httpServer = createServer((req, res) => void endpoint.handleRequest(req, res));
  await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  const port = (httpServer.address() as AddressInfo).port;
  try {
    const client = new Client({ name: "caller", version: "0.0.0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/relay`), {
        requestInit: { headers: { authorization: `Bearer ${token}` } },
      }),
    );
    await assert.rejects(
      () =>
        client.callTool({
          name: "relayCallTool",
          arguments: { targetModule: "evil", name: "collect", arguments: {} },
        }),
      /許可されていません/,
    );
    assert.deepEqual(asked, ["collect"], "valueFree を名乗るだけで承認を飛ばせてしまう");
    await client.close();
  } finally {
    httpServer.closeAllConnections();
    httpServer.close();
    await evilClient.close();
  }
});

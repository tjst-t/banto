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
import { HostRelayEndpoint, RelayRegistry, type HostRelayServerOptions } from "./host-relay-endpoint.js";
import { ModuleCallTracker, RESTARTING_REFUSAL } from "./module-calls.js";

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

async function startTestServer(registry: RelayRegistry, extra: Partial<HostRelayServerOptions> = {}) {
  const audits: unknown[] = [];
  const endpoint = new HostRelayEndpoint({
    registry,
    ...extra,
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

// **起こし直したときの問いは host だけが呼ぶ**（追加・2026-10-05、Fable のレビュー）——中継からは断る
test("起こし直したときの問い（resumeAfterRestart）は、中継からは呼べない", async () => {
  const registry = new RelayRegistry();
  registry.registerModule({
    name: "vault",
    client: await fakeVaultClient(),
    meta: bundledMeta({ satisfies: ["vault"], dependsOn: [], isolation: "subprocess" }, "vault"),
  });
  const shellMeta = bundledMeta({ satisfies: ["shell"], dependsOn: [{ role: "vault", required: true }], isolation: "subprocess" }, "shell");
  const token = registry.issueToken({ moduleName: "shell", meta: shellMeta });
  const { url, audits, close } = await startTestServer(registry);
  try {
    const client = new Client({ name: "shell-module", version: "0.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
    await assert.rejects(
      () => client.callTool({ name: "relayCallTool", arguments: { targetModule: "vault", name: "resumeAfterRestart", arguments: { items: [] } } }),
      /banto 本体だけが呼べます/,
    );
    assert.deepEqual((audits as Array<{ name: string; allowed: boolean }>).map((a) => [a.name, a.allowed]), [["resumeAfterRestart", false]]);
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
  // **第三者が絡む形も試せるようにする**（追加・2026-09-20）——画面からの緩めが
  // 同梱どうしに閉じていることを、機械で押さえるため
  opts: { callerExternal?: boolean } = {},
): Promise<void> {
  const registry = new RelayRegistry();
  registry.registerModule({
    name: "vault",
    client: await vaultWithVisibleTools(),
    meta: bundledMeta({ satisfies: ["vault"], dependsOn: [], isolation: "subprocess" }, "vault"),
  });
  const rawUiMeta = {
    satisfies: [opts.callerExternal ? "third-party-panel" : "vault-directory"],
    dependsOn: [{ role: "vault", required: true }],
    isolation: "subprocess",
  };
  // `parseModuleMeta` は必ず `external` を返す——**同梱の印は host だけが立てる**
  const uiMeta = opts.callerExternal
    ? parseModuleMeta(rawUiMeta, "third-party-panel")
    : bundledMeta(rawUiMeta, "vault-directory");
  const token = registry.issueToken({
    moduleName: opts.callerExternal ? "third-party-panel" : "vault-directory",
    meta: uiMeta,
  });

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

// **改訂・2026-09-20（ユーザー決定）。** 以前はここが
// 「画面からでも module 可視性は今までどおり聞く」だった。実際に詰まったのは
// Vault をまたぐ移動——窓口が移す元で `resolveAlias` を呼ぶので、人が「移す」を
// 押した瞬間にゲートで止まり、**画面は無言のまま**受信箱に承認のお願いだけが
// 積まれていた。緩めるのは**両側が同梱のとき**だけ。
test("画面からの操作は、同梱どうしなら値を返す口（module）も聞かずに通る", async () => {
  await withCanvasOrigin("canvas", async (client, asked) => {
    const result = await client.callTool({
      name: "relayCallTool",
      arguments: { targetModule: "vault", name: "resolveAlias", arguments: {} },
    });
    assert.ok(result.content, "人が画面で押した操作が、値を運ぶところで止まっている");
    assert.deepEqual(asked, [], "同梱どうしなのに人に聞き直している");
  });
});

// **緩みが同梱に閉じていること**——ここが開くと、悪意ある Module が自分の画面から
// 他 Module の秘密を引いてブラウザへ返す道が、人に一度も見られずに開く
// （2026-09-10 の `docs/specs/v4-security.md` で塞いだ穴と同じ形）。
test("第三者 Module の画面からは、値を返す口（module）を今までどおり聞く", async () => {
  await withCanvasOrigin(
    "canvas",
    async (client, asked) => {
      await assert.rejects(
        () =>
          client.callTool({
            name: "relayCallTool",
            arguments: { targetModule: "vault", name: "resolveAlias", arguments: {} },
          }),
        /許可されていません/,
        "第三者の画面から resolveAlias が素通りした（秘密がブラウザへ返る道が開いている）",
      );
      assert.deepEqual(asked, ["resolveAlias"], "聞かずに判断している");
    },
    { callerExternal: true },
  );
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

// **「どの秘密を触ったか」が記録に残る**（追加・2026-09-15、規則8 で上がった穴）。
//
// 仕様は「引数のうち、値そのものではなく『何を指しているかの識別子』は記録して
// よい」と決めているのに、記録していなかった——**誰がどの秘密を消したかが
// 後から追えない**状態だった。**名乗った引数だけ**を拾う（banto が推測すると、
// いつか秘密の入った引数を記録する）。
test("監査に、何を指していたかが残る——値は残らない", async () => {
  const server = new McpServer({ name: "fake-vault", version: "0.0.0" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "deleteAlias",
        inputSchema: { type: "object" },
        _meta: {
          "dev.banto/visibility": "admin",
          // **識別子だけ名乗る**——`value` は名乗らない
          "dev.banto/auditArgs": ["name", "group"],
        },
      },
    ],
  }));
  server.setRequestHandler(CallToolRequestSchema, async () => ({ content: [{ type: "text", text: "ok" }] }));
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

  const records: { name: string; identifiers?: Record<string, string> }[] = [];
  const endpoint = new HostRelayEndpoint({
    registry,
    moduleCalls: {
      originFor: () => "canvas",
      threadFor: () => ({ kind: "none" }),
      projectFor: () => undefined,
      begin: () => () => undefined,
    },
    onAudit: async (r) => {
      records.push({ name: r.name, identifiers: (r as { identifiers?: Record<string, string> }).identifiers });
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
    await client.callTool({
      name: "relayCallTool",
      arguments: {
        targetModule: "vault",
        name: "deleteAlias",
        // `value` は名乗っていないので記録されないこと
        arguments: { name: "github-ssh", group: "ssh-identities", value: "MUST-NOT-BE-RECORDED" },
      },
    });
    const rec = records.find((r) => r.name === "deleteAlias");
    assert.deepEqual(
      rec?.identifiers,
      { name: "github-ssh", group: "ssh-identities" },
      `どの秘密を触ったかが記録に残っていない: ${JSON.stringify(records)}`,
    );
    assert.equal(
      JSON.stringify(records).includes("MUST-NOT-BE-RECORDED"),
      false,
      "名乗っていない引数まで記録している（値が記録に流れ込む）",
    );
    await client.close();
  } finally {
    httpServer.closeAllConnections();
    httpServer.close();
    await vaultClient.close();
  }
});

// **Project ごとの Module を呼べるのは、同じ Project の中だけ**（決定・2026-09-26、ユーザー、v4-security.md §3）。
// 以前は役割しか見ておらず、別の Project のサブエージェント（`subagent-<projectId>`）を名前で指せた
test("Project ごとの Module は同じ Project の中からしか呼べない——宛先の一覧にも出ない", async () => {
  const registry = new RelayRegistry();
  const subagentMeta = bundledMeta(
    { satisfies: ["subagent"], dependsOn: [], isolation: "subprocess", scope: "project" },
    "subagent",
  );
  registry.registerModule({ name: "subagent-pA", client: await fakeVaultClient(), meta: subagentMeta, projectId: "pA" });
  registry.registerModule({ name: "subagent-pB", client: await fakeVaultClient(), meta: subagentMeta, projectId: "pB" });
  // banto 全体に1本の Module（Project を持たない）はどこからでも呼べる（今までどおり）
  registry.registerModule({
    name: "vault",
    client: await fakeVaultClient(),
    meta: bundledMeta({ satisfies: ["vault"], dependsOn: [], isolation: "subprocess" }, "vault"),
  });
  const callerMeta = parseModuleMeta(
    {
      satisfies: ["planner"],
      dependsOn: [
        { role: "subagent", required: true },
        { role: "vault", required: true },
      ],
      isolation: "subprocess",
      scope: "project",
    },
    "planner",
  );
  const inA = { moduleName: "planner", connName: "planner-pA", projectId: "pA", meta: callerMeta };
  const instanceCaller = { moduleName: "planner", meta: callerMeta };

  assert.equal(registry.whyNotAllowed(inA, "subagent-pA"), undefined);
  assert.equal(registry.whyNotAllowed(inA, "subagent-pB"), "別の Project の Module は呼べない");
  assert.equal(
    registry.whyNotAllowed(instanceCaller, "subagent-pA"),
    "banto 全体の Module から、Project ごとの Module は呼べない（その Project のための呼び出しの中でだけ呼べる）",
  );
  // 継いだ Project でも、Project ごとの呼び出し元は広がらない
  assert.equal(registry.whyNotAllowed(inA, "subagent-pB", "pB"), "別の Project の Module は呼べない");
  assert.equal(registry.whyNotAllowed(inA, "vault"), undefined, "banto 全体の Module まで止めた");
  assert.deepEqual(
    registry.allowedTargets(inA).map((t) => t.name).sort(),
    ["subagent-pA", "vault"],
    "別の Project の Module が宛先の一覧に出ている",
  );

  // 中継そのものも断る（理由つき・監査に残る）
  const token = registry.issueToken(inA);
  const { url, audits, close } = await startTestServer(registry);
  const client = new Client({ name: "planner", version: "0.0.0" });
  try {
    await client.connect(
      new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { authorization: `Bearer ${token}` } } }),
    );
    await assert.rejects(
      () => client.callTool({ name: "relayCallTool", arguments: { targetModule: "subagent-pB", name: "resolveAlias", arguments: {} } }),
      /別の Project の Module は呼べない/,
      "別の Project の Module を呼べてしまった",
    );
    assert.ok(
      (audits as Array<{ allowed: boolean; reason?: string; targetModule: string }>).some(
        (a) => !a.allowed && a.targetModule === "subagent-pB" && a.reason === "別の Project の Module は呼べない",
      ),
      "断ったことが監査に残っていない",
    );
  } finally {
    await client.close();
    close();
  }
});

test("コンテナの中の呼び出し元には、鍵の窓口を立てる場所を刻む——呼び出し元が書いた刻印は使わない", async () => {
  // 宛先が受け取った _meta を覚える Vault の代わり
  const seen: Record<string, unknown>[] = [];
  const server = new McpServer({ name: "fake-vault", version: "0.0.0" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [{ name: "startSshAgent", inputSchema: { type: "object", properties: {} } }],
  }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    seen.push((req.params._meta ?? {}) as Record<string, unknown>);
    return { content: [{ type: "text", text: "{}" }] };
  });
  const [s, c] = InMemoryTransport.createLinkedPair();
  const vault = new Client({ name: "test", version: "0.0.0" });
  await Promise.all([server.connect(s), vault.connect(c)]);

  const registry = new RelayRegistry();
  registry.registerModule({ name: "vault", client: vault, meta: bundledMeta({ satisfies: ["vault"], dependsOn: [], isolation: "subprocess" }, "vault") });
  const shellMeta = bundledMeta(
    { satisfies: ["shell"], dependsOn: [{ role: "vault", required: true }], isolation: "subprocess" },
    "shell",
  );
  const inside = registry.issueToken({ moduleName: "shell", meta: shellMeta, inContainer: true, socketDir: "/data/modules/shell-p1/s" });
  const onHost = registry.issueToken({ moduleName: "shell", connName: "shell-host", meta: shellMeta });

  const { url, close } = await startTestServer(registry);
  try {
    for (const token of [inside, onHost]) {
      const client = new Client({ name: "shell-module", version: "0.0.0" });
      await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
      await client.callTool({
        name: "relayCallTool",
        arguments: { targetModule: "vault", name: "startSshAgent", arguments: {} },
        // 呼び出し元が自分で刻印を書いても、中継はそれを宛先に渡さない
        _meta: { "dev.banto/socketDir": "/etc" },
      });
      await client.close();
    }
    assert.equal(seen[0]?.["dev.banto/socketDir"], "/data/modules/shell-p1/s");
    assert.equal(seen[1]?.["dev.banto/socketDir"], undefined, "host で動く呼び出し元には刻まない（偽の刻印も渡さない）");
  } finally {
    close();
  }
});

/** 中継に Module として繋ぐ（合言葉を持った呼び出し元） */
async function relayClient(url: string, token: string): Promise<Client> {
  const client = new Client({ name: "caller", version: "0.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
  return client;
}
const textOf = (r: unknown) => ((r as { content: { text: string }[] }).content[0]!.text);

test("banto 全体の Module は、ある Project のための呼び出しの中でだけ、その Project の Module を呼べる（host の台帳で決まる）", async () => {
  const registry = new RelayRegistry();
  const serviceMeta = bundledMeta({ satisfies: ["service"], dependsOn: [], isolation: "subprocess", scope: "project" }, "service");
  registry.registerModule({ name: "service-pA", client: await fakeVaultClient(), meta: serviceMeta, projectId: "pA" });
  registry.registerModule({ name: "service-pB", client: await fakeVaultClient(), meta: serviceMeta, projectId: "pB" });
  const windowMeta = bundledMeta(
    { satisfies: ["publish-directory"], dependsOn: [{ role: "service", required: false }], isolation: "subprocess" },
    "publish-directory",
  );
  const token = registry.issueToken({ moduleName: "publish-directory", meta: windowMeta });
  const moduleCalls = new ModuleCallTracker();
  const { url, close } = await startTestServer(registry, { moduleCalls });
  const client = await relayClient(url, token);
  const call = (target: string) =>
    client.callTool({ name: "relayCallTool", arguments: { targetModule: target, name: "resolveAlias", arguments: {} } });
  const targets = async () =>
    (JSON.parse(textOf(await client.callTool({ name: "relayListTargets", arguments: {} }))) as { name: string }[]).map((t) => t.name);
  try {
    // 何の呼び出しも処理していない——Project を選べないので呼べない（今までどおり）
    await assert.rejects(() => call("service-pA"), /その Project のための呼び出しの中でだけ呼べる/);
    assert.deepEqual(await targets(), []);

    // pA の AI のターンから呼ばれている間は pA の Module だけ
    const endA = moduleCalls.begin("publish-directory", "t1", "turn", "pA");
    assert.equal(textOf(await call("service-pA")), "SECRET-VALUE-OF-github-token");
    await assert.rejects(() => call("service-pB"), /別の Project の Module は呼べない/);
    assert.deepEqual(await targets(), ["service-pA"]);

    // pB からも同時に呼ばれている——どちらのためか決められないので、どちらも呼べない
    const endB = moduleCalls.begin("publish-directory", "t2", "turn", "pB");
    await assert.rejects(() => call("service-pA"), /その Project のための呼び出しの中でだけ呼べる/);
    endB();
    // banto 全体のための呼び出しが混ざっていても決められない（pA の刻印を借りて広がらない）
    const endInstance = moduleCalls.begin("publish-directory", undefined, "host", undefined, true);
    await assert.rejects(() => call("service-pA"), /その Project のための呼び出しの中でだけ呼べる/);
    endInstance();
    endA();
    // 呼び出しが終わったら元どおり
    await assert.rejects(() => call("service-pA"), /その Project のための呼び出しの中でだけ呼べる/);
  } finally {
    await client.close();
    close();
  }
});

test("Project のアドレスを引けるのは、banto 本体で動く同梱の publish 実装だけ", async () => {
  const registry = new RelayRegistry();
  const publishRaw = { satisfies: ["publish"], dependsOn: [], isolation: "subprocess" };
  const asked: string[] = [];
  const { url, close } = await startTestServer(registry, {
    projectAddress: async (projectId) => {
      asked.push(projectId);
      // 確かに届かない（止まっている）は値で、分からない（Incus が答えない）は投げる
      if (projectId === "gone") return { unavailable: "コンテナ banto-gone は動いていません（Stopped）" };
      if (projectId === "flaky") throw new Error("コンテナ banto-flaky の状態を読めませんでした：時間切れ");
      return { address: "10.61.162.23" };
    },
  });
  const tokens = {
    caddy: registry.issueToken({ moduleName: "publish-caddy", meta: bundledMeta(publishRaw, "publish-caddy") }),
    thirdParty: registry.issueToken({ moduleName: "evil", meta: parseModuleMeta(publishRaw, "evil") }),
    inContainer: registry.issueToken({ moduleName: "publish-x", meta: bundledMeta(publishRaw, "x"), inContainer: true, projectId: "pA" }),
    notPublish: registry.issueToken({
      moduleName: "service",
      meta: bundledMeta({ satisfies: ["service"], dependsOn: [], isolation: "subprocess" }, "service"),
    }),
  };
  const resolve = async (token: string, projectId: string) => {
    const c = await relayClient(url, token);
    try {
      return JSON.parse(textOf(await c.callTool({ name: "relayProjectAddress", arguments: { projectId } }))) as
        | { address: string }
        | { unavailable: string };
    } finally {
      await c.close();
    }
  };
  try {
    assert.deepEqual(await resolve(tokens.caddy, "pA"), { address: "10.61.162.23" });
    // **確かに届かないと、分からないを分けて返す**（2026-09-28）——前者は値、後者は失敗
    assert.deepEqual(await resolve(tokens.caddy, "gone"), { unavailable: "コンテナ banto-gone は動いていません（Stopped）" });
    await assert.rejects(() => resolve(tokens.caddy, "flaky"), /時間切れ/, "分からないことが届かない");
    await assert.rejects(() => resolve(tokens.thirdParty, "pA"), /banto 自身のコード/);
    await assert.rejects(() => resolve(tokens.inContainer, "pA"), /banto 本体で動く/);
    await assert.rejects(() => resolve(tokens.notPublish, "pA"), /publish 役割/);
    assert.deepEqual(asked, ["pA", "gone", "flaky"], "断るべき呼び出し元のために host が引きに行った");
  } finally {
    close();
  }
});

test("Project の一覧を引けるのは、banto 本体で動く同梱の banto 全体の Module が、人の画面からの呼び出しを処理している間だけ", async () => {
  const registry = new RelayRegistry();
  const moduleCalls = new ModuleCallTracker();
  const projects = [{ id: "pA", name: "家計簿", root: "/home/u/banto/kakeibo", status: "active" as const }];
  const { url, close } = await startTestServer(registry, { moduleCalls, listProjects: () => projects });
  const raw = { satisfies: ["repositories"], dependsOn: [], isolation: "subprocess", scope: "instance" };
  const tokens = {
    bundled: registry.issueToken({ moduleName: "repositories", meta: bundledMeta(raw, "repositories") }),
    thirdParty: registry.issueToken({ moduleName: "evil", meta: parseModuleMeta(raw, "evil") }),
    inContainer: registry.issueToken({ moduleName: "x", meta: bundledMeta(raw, "x"), inContainer: true, projectId: "pA" }),
  };
  const list = async (token: string, callId?: string) => {
    const c = await relayClient(url, token);
    try {
      return JSON.parse(
        textOf(await c.callTool({ name: "relayListProjects", arguments: {}, ...(callId ? { _meta: { "dev.banto/callId": callId } } : {}) })),
      ) as unknown;
    } finally {
      await c.close();
    }
  };
  try {
    // 何も処理していない——引けない
    await assert.rejects(() => list(tokens.bundled), /人の画面からの呼び出しを処理している間だけ/);
    // AI のターンの中——引けない（AI が別の Project の名前と場所を知る道になる）
    const turn = moduleCalls.beginCall("repositories", "t1", "turn", "pA");
    await assert.rejects(() => list(tokens.bundled, turn.id), /人の画面からの呼び出しを処理している間だけ/);
    turn.end();
    // 人の画面から——引ける
    const canvas = moduleCalls.beginCall("repositories", undefined, "canvas", undefined);
    assert.deepEqual(await list(tokens.bundled, canvas.id), projects);
    // 人の画面とAI のターンが同時に走っていて、印が無い——厳しいほう（引けない）
    const turn2 = moduleCalls.beginCall("repositories", "t1", "turn", "pA");
    await assert.rejects(() => list(tokens.bundled), /人の画面からの呼び出しを処理している間だけ/);
    // 印で人の画面の1件を名指せば引ける
    assert.deepEqual(await list(tokens.bundled, canvas.id), projects);
    turn2.end();
    canvas.end();
    // 第三者のコード・コンテナの中は、人の画面からでも引けない
    const evil = moduleCalls.beginCall("evil", undefined, "canvas", undefined);
    await assert.rejects(() => list(tokens.thirdParty, evil.id), /banto 自身のコード/);
    evil.end();
    const inside = moduleCalls.beginCall("x", undefined, "canvas", "pA");
    await assert.rejects(() => list(tokens.inContainer, inside.id), /banto 本体で動く/);
    inside.end();
  } finally {
    close();
  }
});

test("呼び出し元の Project を引けるのは、banto 本体で動く同梱の banto 全体の Module だけ——AI のターンでも、その1件だけ", async () => {
  const registry = new RelayRegistry();
  const moduleCalls = new ModuleCallTracker();
  const projects = [
    { id: "pA", name: "家計簿", root: "/home/u/banto/kakeibo", status: "active" as const },
    { id: "pB", name: "日記", root: "/home/u/banto/diary", status: "active" as const },
  ];
  const { url, close } = await startTestServer(registry, { moduleCalls, listProjects: () => projects });
  const raw = { satisfies: ["repositories"], dependsOn: [], isolation: "subprocess", scope: "instance" };
  const tokens = {
    bundled: registry.issueToken({ moduleName: "repositories", meta: bundledMeta(raw, "repositories") }),
    thirdParty: registry.issueToken({ moduleName: "evil", meta: parseModuleMeta(raw, "evil") }),
    inContainer: registry.issueToken({ moduleName: "x", meta: bundledMeta(raw, "x"), inContainer: true, projectId: "pA" }),
  };
  const read = async (token: string, callId?: string) => {
    const c = await relayClient(url, token);
    try {
      return JSON.parse(
        textOf(await c.callTool({ name: "relayCallerProject", arguments: {}, ...(callId ? { _meta: { "dev.banto/callId": callId } } : {}) })),
      ) as unknown;
    } finally {
      await c.close();
    }
  };
  try {
    // 何も処理していない——決められない
    await assert.rejects(() => read(tokens.bundled), /決められません/);
    // AI のターンの中（pB のため）——その1件だけ返す
    const turn = moduleCalls.beginCall("repositories", "t1", "turn", "pB");
    assert.deepEqual(await read(tokens.bundled, turn.id), projects[1]);
    turn.end();
    // Project の決まらない人の画面（banto 全体の設定）——決められない
    const canvas = moduleCalls.beginCall("repositories", undefined, "canvas", undefined);
    await assert.rejects(() => read(tokens.bundled, canvas.id), /決められません/);
    canvas.end();
    // 台帳にあっても一覧に無い Project は、見つからないと言う
    const ghost = moduleCalls.beginCall("repositories", "t1", "turn", "gone");
    await assert.rejects(() => read(tokens.bundled, ghost.id), /見つかりません/);
    ghost.end();
    // 第三者のコード・コンテナの中は引けない
    const evil = moduleCalls.beginCall("evil", "t1", "turn", "pA");
    await assert.rejects(() => read(tokens.thirdParty, evil.id), /banto 自身のコード/);
    evil.end();
    const inside = moduleCalls.beginCall("x", "t1", "turn", "pA");
    await assert.rejects(() => read(tokens.inContainer, inside.id), /banto 本体で動く/);
    inside.end();
  } finally {
    close();
  }
});

test("受信箱に知らせを出せるのは、banto 本体で動く同梱の banto 全体の Module だけ——出所は問わず、空・長すぎは断る", async () => {
  const registry = new RelayRegistry();
  const raised: Array<{ module: string; key: string; title: string; detail: string }> = [];
  const { url, close } = await startTestServer(registry, {
    raiseNotice: async (caller, input) => {
      raised.push({ module: caller.moduleName, ...input });
    },
  });
  const raw = { satisfies: ["repositories"], dependsOn: [], isolation: "subprocess", scope: "instance" };
  const tokens = {
    bundled: registry.issueToken({ moduleName: "repositories", meta: bundledMeta(raw, "repositories") }),
    thirdParty: registry.issueToken({ moduleName: "evil", meta: parseModuleMeta(raw, "evil") }),
    inContainer: registry.issueToken({ moduleName: "x", meta: bundledMeta(raw, "x"), inContainer: true, projectId: "pA" }),
    perProject: registry.issueToken({ moduleName: "y", meta: bundledMeta(raw, "y"), projectId: "pA" }),
  };
  const notice = async (token: string, args: Record<string, unknown>) => {
    const c = await relayClient(url, token);
    try {
      return JSON.parse(textOf(await c.callTool({ name: "relayRaiseNotice", arguments: args }))) as unknown;
    } finally {
      await c.close();
    }
  };
  const ok = { key: "github-refresh:tjst-t", title: "GitHub @tjst-t のログインを更新できませんでした", detail: "もう一度ログインしてください" };
  try {
    // 何も処理していない（人の画面でも AI のターンでもない）ときにも出せる——人が見ていないところの失敗を知らせる口
    assert.deepEqual(await notice(tokens.bundled, ok), { ok: true });
    assert.deepEqual(raised, [{ module: "repositories", ...ok }]);
    await assert.rejects(() => notice(tokens.thirdParty, ok), /banto 自身のコード/);
    await assert.rejects(() => notice(tokens.inContainer, ok), /banto 本体で動く/);
    await assert.rejects(() => notice(tokens.perProject, ok), /banto 全体の Module だけ/);
    await assert.rejects(() => notice(tokens.bundled, { ...ok, title: " " }), /title が要ります/);
    await assert.rejects(() => notice(tokens.bundled, { ...ok, detail: "あ".repeat(2001) }), /detail が長すぎます/);
    assert.equal(raised.length, 1, "断るべき知らせを受信箱に渡した");
  } finally {
    close();
  }
});

/** 呼ばれた口と、host が刻んだ `_meta`、その時点で台帳が宛先の呼び出しをどう見ていたかを残す偽の Module */
async function recordingClient(
  tools: Array<{ name: string; visibility: string }>,
  seen: Array<{ tool: string; meta: Record<string, unknown>; origin?: string }>,
  observe?: (meta: Record<string, unknown>) => string | undefined,
): Promise<Client> {
  const server = new McpServer({ name: "recording", version: "0.0.0" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((t) => ({ name: t.name, inputSchema: { type: "object" as const }, _meta: { "dev.banto/visibility": t.visibility } })),
  }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const meta = (request.params._meta ?? {}) as Record<string, unknown>;
    seen.push({ tool: request.params.name, meta, ...(observe ? { origin: observe(meta) } : {}) });
    return { content: [{ type: "text", text: "ok" }] };
  });
  const [s, c] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0.0.0" });
  await Promise.all([server.connect(s), client.connect(c)]);
  return client;
}

/** 窓口（banto 全体）・その Project の Service・別の Project の Service・公開の実装（banto 全体）を繋いだ中継 */
async function publishWorld(opts: { autoApprove?: Set<string> } = {}) {
  const registry = new RelayRegistry();
  const moduleCalls = new ModuleCallTracker();
  const seen: Array<{ tool: string; meta: Record<string, unknown>; origin?: string }> = [];
  const serviceMeta = bundledMeta({ satisfies: ["service"], dependsOn: [], isolation: "subprocess", scope: "project" }, "service");
  const svc = [{ name: "listServices", visibility: "agent" }];
  registry.registerModule({ name: "service-pA", client: await recordingClient(svc, seen), meta: serviceMeta, projectId: "pA" });
  registry.registerModule({ name: "service-pB", client: await recordingClient(svc, seen), meta: serviceMeta, projectId: "pB" });
  registry.registerModule({
    name: "publish-caddy",
    // 宛先の台帳も見ておく——宛先がさらに中継を呼ぶとき、渡された印でこの1件を名指せるか
    client: await recordingClient([{ name: "publishRoute", visibility: "module" }, { name: "setCaddySettings", visibility: "admin" }], seen, (meta) =>
      moduleCalls.originFor("publish-caddy", meta["dev.banto/callId"] as string | undefined),
    ),
    meta: bundledMeta({ satisfies: ["publish"], dependsOn: [], isolation: "subprocess" }, "publish-caddy"),
  });
  const windowRaw = {
    satisfies: ["publish-directory"],
    dependsOn: [
      { role: "publish", required: true },
      { role: "service", required: false },
    ],
    isolation: "subprocess",
  };
  // 人の承認を待つゲート——ここに来たら「聞いた」と分かるように残す。道を張る口は、聞いたら断る
  const asked: string[] = [];
  const gate = {
    requestApproval: async (req: { name: string }) => {
      asked.push(req.name);
      return req.name === "publishRoute" ? { allowed: false, reason: "試験では聞いたら断る" } : { allowed: true, reason: "試験では通す" };
    },
  };
  const server = await startTestServer(registry, {
    moduleCalls,
    gate,
    ...(opts.autoApprove ? { autoApproveFor: (projectId: string) => opts.autoApprove!.has(projectId) } : {}),
  });
  const bundled = await relayClient(server.url, registry.issueToken({ moduleName: "publish-directory", meta: bundledMeta(windowRaw, "publish-directory") }));
  const thirdParty = await relayClient(server.url, registry.issueToken({ moduleName: "evil-window", meta: parseModuleMeta(windowRaw, "evil-window") }));
  const via = (client: Client) => ({
    call: (target: string, tool: string, callId?: string) =>
      client.callTool({
        name: "relayCallTool",
        arguments: { targetModule: target, name: tool, arguments: {} },
        ...(callId ? { _meta: { "dev.banto/callId": callId } } : {}),
      }),
    targets: async (callId?: string) => {
      const r = await client.callTool({ name: "relayListTargets", arguments: {}, ...(callId ? { _meta: { "dev.banto/callId": callId } } : {}) });
      return {
        names: (JSON.parse(textOf(r)) as { name: string }[]).map((t) => t.name),
        onBehalfOf: (r._meta as Record<string, unknown> | undefined)?.["dev.banto/onBehalfOf"],
      };
    },
  });
  return {
    moduleCalls,
    seen,
    asked,
    window: via(bundled),
    thirdParty: via(thirdParty),
    last: () => seen.at(-1)!,
    close: async () => {
      await bundled.close();
      await thirdParty.close();
      server.close();
    },
  };
}

// **人が Project の画面から押した呼び出しの中で、banto 全体の Module がその Project の Module を呼べる**（2026-09-28、
// Fable のレビュー）。以前は画面の呼び出しに Project を置いていなかったので、公開の入口の画面から押しても窓口は
// Service を呼べず、画面の「まだ公開していないサーバ」が黙って空だった。**人の操作の印（admin）は保つ**——
// Project が分かったからといって `{project}` に落とすと、publish-caddy の「人が押したときだけ」が人の承認を断る
test("Project の画面から押した呼び出しの中では、その Project の Module を呼べる——別の Project は呼べず、人の印は保たれる", async () => {
  const w = await publishWorld();
  try {
    const canvas = w.moduleCalls.beginCall("publish-directory", "t1", "canvas", "pA");
    assert.equal(textOf(await w.window.call("service-pA", "listServices", canvas.id)), "ok");
    assert.deepEqual(w.last().meta["dev.banto/caller"], { admin: true, forProject: "pA" }, "人の印が消えたか、Project が併記されていない");
    await assert.rejects(() => w.window.call("service-pB", "listServices", canvas.id), /別の Project の Module は呼べない/);
    assert.deepEqual(await w.window.targets(canvas.id), { names: ["service-pA", "publish-caddy"], onBehalfOf: "pA" });

    // 公開の実装へも人の印のまま届く（admin の口なので人に聞かない）。宛先にも呼び出しの印が渡り、台帳はその1件を人の画面と見る
    assert.equal(textOf(await w.window.call("publish-caddy", "publishRoute", canvas.id)), "ok");
    assert.deepEqual(w.last().meta["dev.banto/caller"], { admin: true, forProject: "pA" });
    assert.equal(typeof w.last().meta["dev.banto/callId"], "string", "宛先に呼び出しの印が渡っていない");
    assert.equal(w.last().origin, "canvas", "宛先の台帳が、渡した印でこの1件を引けない");
    assert.deepEqual(w.asked, [], "人が押した同梱どうしの操作で、人に聞いた");
    canvas.end();

    // banto 全体の設定画面（Project が無い）からは、今までどおり Project の Module を呼べず、刻印は admin だけ
    const instanceCanvas = w.moduleCalls.beginCall("publish-directory", undefined, "canvas");
    await assert.rejects(() => w.window.call("service-pA", "listServices", instanceCanvas.id), /その Project のための呼び出しの中でだけ呼べる/);
    assert.deepEqual(await w.window.targets(instanceCanvas.id), { names: ["publish-caddy"], onBehalfOf: undefined });
    await w.window.call("publish-caddy", "publishRoute", instanceCanvas.id);
    assert.deepEqual(w.last().meta["dev.banto/caller"], { admin: true });
    instanceCanvas.end();
  } finally {
    await w.close();
  }
});

// **承認をすべて自動で許可する**（追加・2026-10-05、v4-frontend.md §6.4）。AI のターンから始まった、スイッチがオンの
// Project のための中継にだけ `dev.banto/autoApprove` を刻む——publish-caddy は人の刻印の代わりにこれを見る。
// 人の画面からの呼び出し・スイッチがオフの Project には刻まない
test("AI のターンから始まった、スイッチがオンの Project のための中継にだけ、自動で許可の印を刻む", async () => {
  const autoApprove = new Set(["pA"]);
  const w = await publishWorld({ autoApprove });
  try {
    const turn = w.moduleCalls.beginCall("publish-directory", "t1", "turn", "pA");
    await w.window.call("service-pA", "listServices", turn.id);
    assert.equal(w.last().meta["dev.banto/autoApprove"], true, "オンの Project のターンなのに刻んでいない");
    assert.deepEqual(w.last().meta["dev.banto/caller"], { project: "pA" });
    turn.end();

    const canvas = w.moduleCalls.beginCall("publish-directory", "t1", "canvas", "pA");
    await w.window.call("service-pA", "listServices", canvas.id);
    assert.equal(w.last().meta["dev.banto/autoApprove"], undefined, "人の画面からの呼び出しに刻んだ");
    canvas.end();

    autoApprove.delete("pA");
    const off = w.moduleCalls.beginCall("publish-directory", "t1", "turn", "pA");
    await w.window.call("service-pA", "listServices", off.id);
    assert.equal(w.last().meta["dev.banto/autoApprove"], undefined, "スイッチを切ったのに刻んだ（設定は呼び出しのたびに引く）");
    off.end();
  } finally {
    await w.close();
  }
});

// **AI のターンと人の画面の呼び出しが同時に窓口を通っても、それぞれの出所で刻む**（2026-09-28、Fable のレビュー）。
// 窓口は banto 全体で1接続なので、接続単位の台帳では「ターンが1つでも混ざればターン」になり、pA の AI が
// publishService を処理している間に人が「公開する」を押すと、publishRoute が `{project}` で刻まれて断られていた
test("AI のターンと人の画面が同時に窓口を通っても、呼び出しの印でそれぞれの出所が刻まれる（第三者の印は信じない）", async () => {
  const w = await publishWorld();
  try {
    const turn = w.moduleCalls.beginCall("publish-directory", "t1", "turn", "pA");
    const canvas = w.moduleCalls.beginCall("publish-directory", "t2", "canvas", "pA");

    await w.window.call("publish-caddy", "publishRoute", canvas.id);
    assert.deepEqual(w.last().meta["dev.banto/caller"], { admin: true, forProject: "pA" }, "人の承認が AI のターンの刻印で刻まれた");
    assert.equal(w.last().origin, "canvas");
    assert.deepEqual(w.asked, [], "人が押した操作で人に聞いた");

    // AI のターンの仕事は、同時に人の画面が走っていても AI のターンのまま（人の印を借りない）——module の口なので人に聞く
    await assert.rejects(() => w.window.call("publish-caddy", "publishRoute", turn.id), /試験では聞いたら断る/);
    assert.deepEqual(w.asked, ["publishRoute"]);

    // 印を返さない Module は今までどおり接続単位——混ざっていれば厳しいほう（ターン）
    await assert.rejects(() => w.window.call("publish-caddy", "publishRoute"), /試験では聞いたら断る/);
    assert.equal(w.asked.length, 2);
    await w.window.call("service-pA", "listServices");
    assert.deepEqual(w.last().meta["dev.banto/caller"], { project: "pA" });
    assert.equal(w.asked.length, 3);
    turn.end();
    canvas.end();

    // **第三者の Module が返した印は信じない**——同時に走っている自分の呼び出しのうち、緩いほうを選べてしまう。
    // 人の画面からの admin の口は聞かずに通る（第三者でも）ので、AI のターンの仕事をその印で通されると承認が飛ぶ
    const evilTurn = w.moduleCalls.beginCall("evil-window", "t1", "turn", "pA");
    const evilCanvas = w.moduleCalls.beginCall("evil-window", "t2", "canvas", "pA");
    await w.thirdParty.call("publish-caddy", "setCaddySettings", evilCanvas.id);
    assert.equal(w.asked.length, 4, "第三者が人の画面の印を名乗って承認を飛ばした");
    assert.deepEqual(w.last().meta["dev.banto/caller"], { project: "pA" }, "第三者が人の画面の印で人の刻印を得た");
    evilTurn.end();
    evilCanvas.end();
  } finally {
    await w.close();
  }
});

// ---- 長い仕事の中継と、Module 宛ての返事（追加・2026-10-05、アーキ仕様 §4.2「Module 宛ての返事」） ----

import {
  DELIVERS_LATER_META_KEY,
  PENDING_REPLY_META_KEY,
  RECEIVES_REPLIES_META_KEY,
  REPLY_ID_META_KEY,
  REPLY_TO_META_KEY,
} from "@banto/module-contract";
import { ReplyHandles } from "../delivery/reply-handles.js";

/** 宛先：`work` は ms 待って返す（`progressEveryMs` があれば途中経過を送る）。`later` は「あとで届ける」 */
async function fakeWorkerClient(seen: { meta?: Record<string, unknown> }[]): Promise<Client> {
  const server = new McpServer({ name: "fake-subagent", version: "0.0.0" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      { name: "work", inputSchema: { type: "object", properties: {} } },
      { name: "later", inputSchema: { type: "object", properties: {} }, _meta: { [DELIVERS_LATER_META_KEY]: true } },
      { name: "receive", inputSchema: { type: "object", properties: {} }, _meta: { [RECEIVES_REPLIES_META_KEY]: true, "dev.banto/visibility": "admin" } },
    ],
  }));
  server.setRequestHandler(CallToolRequestSchema, async (req, extra) => {
    seen.push({ meta: req.params._meta as Record<string, unknown> | undefined });
    const a = (req.params.arguments ?? {}) as { ms?: number; progressEveryMs?: number };
    if (req.params.name === "later") {
      return { content: [{ type: "text", text: "running" }], _meta: { [PENDING_REPLY_META_KEY]: true } };
    }
    const tok = req.params._meta?.progressToken;
    const started = Date.now();
    while (Date.now() - started < (a.ms ?? 0)) {
      await new Promise((r) => setTimeout(r, a.progressEveryMs ?? a.ms ?? 0));
      if (a.progressEveryMs && tok !== undefined) {
        await extra.sendNotification({ method: "notifications/progress", params: { progressToken: tok, progress: Date.now() - started } });
      }
    }
    return { content: [{ type: "text", text: "done" }] };
  });
  const [s, c] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0.0.0" });
  await Promise.all([server.connect(s), client.connect(c)]);
  return client;
}

/** 呼ぶ側の Module（受け口を名乗るか選べる） */
async function fakeCallerClient(withReceiver: boolean): Promise<Client> {
  const server = new McpServer({ name: "fake-factory", version: "0.0.0" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: withReceiver
      ? [{ name: "receiveReply", inputSchema: { type: "object", properties: {} }, _meta: { [RECEIVES_REPLIES_META_KEY]: true } }]
      : [],
  }));
  server.setRequestHandler(CallToolRequestSchema, async () => ({ content: [] }));
  const [s, c] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0.0.0" });
  await Promise.all([server.connect(s), client.connect(c)]);
  return client;
}

async function relayPair(opts: { withReceiver: boolean; extra?: Partial<HostRelayServerOptions> }) {
  const seen: { meta?: Record<string, unknown> }[] = [];
  const registry = new RelayRegistry();
  registry.registerModule({
    name: "subagent",
    client: await fakeWorkerClient(seen),
    meta: bundledMeta({ satisfies: ["subagent"], dependsOn: [], isolation: "subprocess" }, "subagent"),
  });
  const factoryMeta = bundledMeta(
    { satisfies: ["factory"], dependsOn: [{ role: "subagent", required: true }], isolation: "subprocess" },
    "factory",
  );
  registry.registerModule({ name: "factory", client: await fakeCallerClient(opts.withReceiver), meta: factoryMeta });
  const token = registry.issueToken({ moduleName: "factory", meta: factoryMeta });
  const server = await startTestServer(registry, opts.extra);
  const client = new Client({ name: "factory-module", version: "0.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(server.url), { requestInit: { headers: { authorization: `Bearer ${token}` } } }),
  );
  return { seen, client, close: async () => { await client.close(); server.close(); } };
}

test("中継は宛先の途中経過で上限を数え直し、途中経過を呼び元へ渡す——黙ったままの宛先は上限で切る", async () => {
  const { client, close } = await relayPair({ withReceiver: false, extra: { relayIdleTimeoutMs: 300 } });
  try {
    let progressed = 0;
    // 上限 300ms の3倍かかるが、100ms ごとに途中経過を送る → 通る
    const ok = await client.callTool(
      { name: "relayCallTool", arguments: { targetModule: "subagent", name: "work", arguments: { ms: 900, progressEveryMs: 100 } } },
      undefined,
      { resetTimeoutOnProgress: true, timeout: 300, onprogress: () => void (progressed += 1) },
    );
    assert.equal((ok.content as { text: string }[])[0]?.text, "done");
    assert.ok(progressed >= 3, `途中経過が呼び元に届いていない（${progressed} 回）`);
    // 途中経過を送らない宛先は、host の上限で切れる
    await assert.rejects(
      () =>
        client.callTool(
          { name: "relayCallTool", arguments: { targetModule: "subagent", name: "work", arguments: { ms: 900 } } },
          undefined,
          { timeout: 5000 },
        ),
      /timed out/i,
    );
  } finally {
    await close();
  }
});

test("受け口を名乗る Module が「終わったら届ける」tool を中継で呼ぶと、呼んだ Module 宛ての札が出て、結果に返事の印が載る", async () => {
  const handles = new ReplyHandles();
  const awaiting: string[] = [];
  const { client, seen, close } = await relayPair({
    withReceiver: true,
    extra: {
      replies: {
        issueToModule: (i) => handles.issueToModule(i),
        markAwaiting: async (replyTo) => void awaiting.push(replyTo),
      },
    },
  });
  try {
    const r = (await client.callTool({
      name: "relayCallTool",
      arguments: { targetModule: "subagent", name: "later", arguments: {} },
    })) as { _meta?: Record<string, unknown> };
    const replyTo = seen.at(-1)?.meta?.[REPLY_TO_META_KEY] as string | undefined;
    assert.ok(replyTo, "宛先に札が渡っていない");
    const h = handles.get(replyTo!);
    assert.equal(h?.toModule?.connName, "factory", "札の宛先が呼んだ Module になっていない");
    assert.equal(h?.connName, "subagent", "札を使えるのが宛先の Module になっていない");
    assert.deepEqual(awaiting, [replyTo], "あとで届けると約束したのに返事待ちにしていない");
    assert.equal(r._meta?.[REPLY_ID_META_KEY], h?.toModule?.replyId, "呼んだ Module に返事の印が見えない");
    assert.notEqual(r._meta?.[REPLY_ID_META_KEY], replyTo, "札そのものを呼んだ Module に見せている");
    // 待つ形（deliversLater を名乗らない tool）には札を出さない
    await client.callTool({ name: "relayCallTool", arguments: { targetModule: "subagent", name: "work", arguments: {} } });
    assert.equal(seen.at(-1)?.meta?.[REPLY_TO_META_KEY], undefined);
  } finally {
    await close();
  }
});

test("受け口を名乗らない Module には札を出さない——宛先が「届ける先がない」と断れるように", async () => {
  const handles = new ReplyHandles();
  const { client, seen, close } = await relayPair({
    withReceiver: false,
    extra: { replies: { issueToModule: (i) => handles.issueToModule(i), markAwaiting: async () => undefined } },
  });
  try {
    const r = (await client.callTool({
      name: "relayCallTool",
      arguments: { targetModule: "subagent", name: "later", arguments: {} },
    })) as { _meta?: Record<string, unknown> };
    assert.equal(seen.at(-1)?.meta?.[REPLY_TO_META_KEY], undefined);
    assert.equal(r._meta?.[REPLY_ID_META_KEY], undefined);
  } finally {
    await close();
  }
});

test("返事の受け口は中継からは呼べない——頼んだ仕事の返事を他の Module が偽れない", async () => {
  const { client, seen, close } = await relayPair({ withReceiver: false });
  try {
    await assert.rejects(
      () => client.callTool({ name: "relayCallTool", arguments: { targetModule: "subagent", name: "receive", arguments: {} } }),
      /返事の受け口/,
    );
    assert.equal(seen.length, 0, "受け口が呼ばれた");
  } finally {
    await close();
  }
});

// **起こし直しのために止めている間の中継**（追加・2026-10-05、Fable のレビュー）。実行中の呼び出しの中の中継は通す
// （止める前に待つのはその呼び出しの終わりで、中継を断ると待っている呼び出しが失敗する）。走っている呼び出しに属さない
// 中継は、承認を聞く前に断る。宛先には外側の AI の tool 呼び出しの id を継ぐ
test("止めている間：実行中の呼び出しの中の中継は通り（tool_use の id を継ぐ）、走っている呼び出しに属さない中継は断る", async () => {
  const tracker = new ModuleCallTracker();
  const reached: Array<string | undefined> = [];
  const inner = new McpServer({ name: "fake-directory", version: "0.0.0" }, { capabilities: { tools: {} } });
  inner.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [{ name: "lookupAlias", inputSchema: { type: "object" }, _meta: { "dev.banto/visibility": "module" } }],
  }));
  inner.setRequestHandler(CallToolRequestSchema, async () => {
    reached.push(tracker.toolUseIdFor("vault-directory"));
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
    meta: bundledMeta({ satisfies: ["shell"], dependsOn: [{ role: "vault-directory", required: true }], isolation: "subprocess" }, "shell"),
  });
  const { url, audits, close } = await startTestServer(registry, { moduleCalls: tracker });
  const client = new Client({ name: "shell-module", version: "0.0.0" });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
    const relay = () =>
      client.callTool({ name: "relayCallTool", arguments: { targetModule: "vault-directory", name: "lookupAlias", arguments: {} } });

    const outer = tracker.beginCall("shell", "thread-1", "turn", undefined, false, "toolu_outer");
    tracker.stopAccepting();
    const ok = (await relay()) as { isError?: boolean };
    assert.notEqual(ok.isError, true, "実行中の呼び出しの中の中継を断った");
    assert.deepEqual(reached, ["toolu_outer"], "宛先に外側の tool_use の id が継がれていない");
    outer.end();

    // 断りは中継のエラーとして呼び元の Module に返る（Module はそれを自分の呼び出しの結果に包む）
    await assert.rejects(relay(), (err: Error) => err.message.includes(RESTARTING_REFUSAL));
    assert.equal(reached.length, 1, "止めている間の中継が宛先に届いた");
    assert.equal((audits as Array<{ allowed: boolean; reason?: string }>).at(-1)?.reason, "banto を起こし直しているため断った");
  } finally {
    await client.close();
    close();
  }
});

// **中継で呼んだ先の呼び出しは、呼んだ側を親として台帳に持つ**（追加・2026-10-06、本番で「Backlog の書き込みが承認の間もなく
// 時間切れ」）。宛先の中で人を待つ（さらに奥の中継の承認）と、呼んだ側の呼び出しも人待ちになり、host は外側の上限を数えない
test("中継の宛先で人を待つと、呼んだ側の呼び出しも人待ちになる（入れ子の承認で外側が切れない）", async () => {
  const registry = new RelayRegistry();
  const moduleCalls = new ModuleCallTracker();
  let seen: { outer: boolean; inner: boolean } | undefined;
  const server = new McpServer({ name: "fake-repositories", version: "0.0.0" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [{ name: "push_branch", inputSchema: { type: "object", properties: {} } }],
  }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    // 宛先の中で、さらに奥の中継の承認を待ち始めた（approval-gate が宛先の呼び出しに立てるのと同じ）
    const innerId = (req.params._meta as Record<string, unknown> | undefined)?.["dev.banto/callId"] as string;
    const release = moduleCalls.holdForHuman("repositories", innerId);
    seen = { outer: moduleCalls.isWaitingOnHuman("backlog", outerCall.id), inner: moduleCalls.isWaitingOnHuman("repositories", innerId) };
    release();
    return { content: [{ type: "text", text: "pushed" }] };
  });
  const [s, c] = InMemoryTransport.createLinkedPair();
  const target = new Client({ name: "test", version: "0.0.0" });
  await Promise.all([server.connect(s), target.connect(c)]);
  registry.registerModule({
    name: "repositories",
    client: target,
    meta: bundledMeta({ satisfies: ["repositories"], dependsOn: [], isolation: "subprocess" }, "repositories"),
  });
  const token = registry.issueToken({
    moduleName: "backlog",
    meta: bundledMeta({ satisfies: ["backlog"], dependsOn: [{ role: "repositories", required: false }], isolation: "subprocess" }, "backlog"),
  });
  const outerCall = moduleCalls.beginCall("backlog", "t1", "turn", "pA", false, "toolu_1");
  const { url, close } = await startTestServer(registry, { moduleCalls });
  const client = await relayClient(url, token);
  try {
    const r = await client.callTool({
      name: "relayCallTool",
      arguments: { targetModule: "repositories", name: "push_branch", arguments: {} },
      _meta: { "dev.banto/callId": outerCall.id },
    });
    assert.equal(textOf(r), "pushed");
    assert.deepEqual(seen, { outer: true, inner: true }, "宛先で人を待っても、呼んだ側の呼び出しが人待ちにならない");
    assert.equal(moduleCalls.isWaitingOnHuman("backlog", outerCall.id), false, "待ち終わっても外側が人待ちのまま");
  } finally {
    outerCall.end();
    await client.close();
    close();
  }
});

test("中継は宛先に、頼んだ Module（宣言の名前と接続名）を刻む——呼び元が書いた刻印は使わない", async () => {
  const { client, seen, close } = await relayPair({ withReceiver: false });
  try {
    await client.callTool({
      name: "relayCallTool",
      arguments: { targetModule: "subagent", name: "work", arguments: {} },
      _meta: { "dev.banto/callerModule": { name: "vault", conn: "vault" } },
    });
    assert.deepEqual(seen.at(-1)?.meta?.["dev.banto/callerModule"], { name: "factory", conn: "factory" });
  } finally {
    await close();
  }
});

// **呼び元の Module が持ち主のものだけを書き換える口**（追加・2026-10-06、`dev.banto/callerOwned`）。
//
// Repositories が回った GitHub のログインを Vault に書き戻す呼び出しが、AI のターンの中で人を待ち、答えが無いまま
// 切れて、相手が既に無効にした古い鍵だけが Vault に残っていた（本番）。host は宛先に**呼び元の Module**を刻み
// （`dev.banto/callerModule`——呼び元が書いたものは渡さない）、印を名乗る同梱の口への、banto 本体で動く同梱の
// Module からの中継だけを聞かずに通す。持ち主の確かめは宛先がする。見るのは：
//   1. 同梱→同梱の印つきの口は聞かない（記録に理由）。印の無い口は今までどおり聞く
//   2. 宛先が受け取る呼び元の刻印は宣言の名前で、呼び元が自分で書いた刻印では偽れない
//   3. 呼び元が外から入れた Module・コンテナの中の Module なら聞く
//   4. 宛先が外から入れた Module なら、印を名乗っても聞く
async function callerOwnedWorld(opts: { targetExternal?: boolean } = {}) {
  const seen: Array<{ name: string; meta: Record<string, unknown> }> = [];
  const server = new McpServer({ name: "fake-vault", version: "0.0.0" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      { name: "putSecret", inputSchema: { type: "object" }, _meta: { "dev.banto/visibility": "module", "dev.banto/callerOwned": true } },
      { name: "createAlias", inputSchema: { type: "object" }, _meta: { "dev.banto/visibility": "admin" } },
    ],
  }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    seen.push({ name: req.params.name, meta: (req.params._meta ?? {}) as Record<string, unknown> });
    return { content: [{ type: "text", text: "stored" }] };
  });
  const [s, c] = InMemoryTransport.createLinkedPair();
  const vaultClient = new Client({ name: "test", version: "0.0.0" });
  await Promise.all([server.connect(s), vaultClient.connect(c)]);

  const registry = new RelayRegistry();
  const vaultMeta = { satisfies: ["vault"], dependsOn: [], isolation: "subprocess" };
  registry.registerModule({
    name: "vault",
    client: vaultClient,
    meta: opts.targetExternal ? parseModuleMeta(vaultMeta, "vault") : bundledMeta(vaultMeta, "vault"),
    ...(opts.targetExternal ? { codeId: "code-v1" } : {}),
  });
  const rawCaller = { satisfies: ["repositories"], dependsOn: [{ role: "vault", required: true }], isolation: "subprocess" };
  const tokens = {
    bundled: registry.issueToken({ moduleName: "repositories", meta: bundledMeta(rawCaller, "repositories") }),
    external: registry.issueToken({ moduleName: "third-party", meta: parseModuleMeta(rawCaller, "third-party") }),
    // Project のコンテナの中の同梱の Module（AI が root で、合言葉も読める）。接続名は Project ごと
    inContainer: registry.issueToken({
      moduleName: "backlog",
      connName: "backlog-p1",
      projectId: "p1",
      inContainer: true,
      meta: bundledMeta(rawCaller, "backlog"),
    }),
  };
  const asked: string[] = [];
  const { url, audits, close } = await startTestServer(registry, {
    // 出所は AI のターン——人の画面・banto 自身の仕事という別の緩めは使わない
    moduleCalls: {
      originFor: () => "turn",
      threadFor: () => ({ kind: "none" }),
      projectFor: () => undefined,
      begin: () => () => undefined,
    },
    gate: {
      async requestApproval(req) {
        asked.push(`${req.callerModule}:${req.name}`);
        return { allowed: false, reason: "この試験では人が答えない" };
      },
    },
  });
  // 落ちたときも繋ぎっぱなしにしない——開いたままだと http の close が待ち続け、試験が落ちずに止まる
  const clients: Client[] = [];
  const connect = async (token: string) => {
    const client = await relayClient(url, token);
    clients.push(client);
    return client;
  };
  return {
    seen,
    asked,
    audits,
    tokens,
    connect,
    close: async () => {
      await Promise.all(clients.map((x) => x.close().catch(() => undefined)));
      close();
      await vaultClient.close();
    },
  };
}

const putSecretCall = (meta?: Record<string, unknown>) => ({
  name: "relayCallTool",
  arguments: { targetModule: "vault", name: "putSecret", arguments: { name: "oauth-github-x", value: "v" } },
  ...(meta ? { _meta: meta } : {}),
});

test("同梱→同梱の「呼び元の Module が持ち主のもの」の口は聞かずに通り、宛先には host が刻んだ呼び元の Module が届く——呼び元が書いた刻印では偽れない", async () => {
  const w = await callerOwnedWorld();
  try {
    const client = await w.connect(w.tokens.bundled);
    // 呼び元が自分で別の Module を名乗っても、宛先に渡るのは host の刻印だけ
    const result = await client.callTool(putSecretCall({ "dev.banto/callerModule": { name: "vault-directory", conn: "vault-directory" } }));
    assert.equal(textOf(result), "stored");
    assert.deepEqual(w.asked, [], "持ち主のものだけを書き換える口で人を止めている");
    assert.deepEqual(w.seen[0]?.meta["dev.banto/callerModule"], { name: "repositories", conn: "repositories" }, "呼び元の Module の刻印が host のものではない");
    const audit = (w.audits as Array<{ name: string; allowed: boolean; reason?: string; ok?: boolean }>).find((a) => a.name === "putSecret");
    assert.deepEqual(
      { allowed: audit?.allowed, reason: audit?.reason, ok: audit?.ok },
      { allowed: true, reason: "呼び元の Module が持ち主のものだけを書き換える口", ok: true },
      "聞かずに通した理由が記録に残っていない",
    );
    // 印の無い口は今までどおり聞く
    await assert.rejects(
      () => client.callTool({ name: "relayCallTool", arguments: { targetModule: "vault", name: "createAlias", arguments: {} } }),
      /許可されていません/,
    );
    assert.deepEqual(w.asked, ["repositories:createAlias"], "緩めが印の無い口まで広がっている");
    // 聞かれて断られた口でも、刻印は付いていない呼び出しは宛先に届いていない
    assert.deepEqual(w.seen.map((x) => x.name), ["putSecret"]);
    await client.close();
  } finally {
    await w.close();
  }
});

test("呼び元が外から入れた Module・コンテナの中の Module なら、持ち主のものだけを書き換える口でも聞く", async () => {
  const w = await callerOwnedWorld();
  try {
    for (const token of [w.tokens.external, w.tokens.inContainer]) {
      const client = await w.connect(token);
      await assert.rejects(() => client.callTool(putSecretCall()), /許可されていません/);
    }
    assert.deepEqual(w.asked, ["third-party:putSecret", "backlog:putSecret"], "名乗りを信じてよくない呼び元で、聞かずに通した");
    assert.deepEqual(w.seen, [], "聞いて断られた呼び出しが宛先に届いた");
  } finally {
    await w.close();
  }
});

test("宛先が外から入れた Module なら、持ち主のものだけを書き換える口を名乗っても聞く", async () => {
  const w = await callerOwnedWorld({ targetExternal: true });
  try {
    const client = await w.connect(w.tokens.bundled);
    await assert.rejects(() => client.callTool(putSecretCall()), /許可されていません/);
    assert.deepEqual(w.asked, ["repositories:putSecret"], "確かめるかどうか分からない宛先の名乗りで、承認を飛ばした");
    await client.close();
  } finally {
    await w.close();
  }
});

test("宛先に刻む呼び元の Module は宣言の名前と接続名の両方——Project ごとの Module でも（接続名を名前に化かさない）", async () => {
  // ゲート無し（宣言された依存だけで通す）で、Project ごとの Module から呼び、宛先に届く刻印を見る
  const seen: Record<string, unknown>[] = [];
  const server = new McpServer({ name: "fake-vault", version: "0.0.0" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: "putSecret", inputSchema: { type: "object" } }] }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    seen.push((req.params._meta ?? {}) as Record<string, unknown>);
    return { content: [{ type: "text", text: "stored" }] };
  });
  const [s, c] = InMemoryTransport.createLinkedPair();
  const vault = new Client({ name: "test", version: "0.0.0" });
  await Promise.all([server.connect(s), vault.connect(c)]);
  const registry = new RelayRegistry();
  registry.registerModule({ name: "vault", client: vault, meta: bundledMeta({ satisfies: ["vault"], dependsOn: [], isolation: "subprocess" }, "vault") });
  const token = registry.issueToken({
    moduleName: "backlog",
    connName: "backlog-p1",
    projectId: "p1",
    meta: bundledMeta({ satisfies: ["backlog"], dependsOn: [{ role: "vault", required: true }], isolation: "subprocess" }, "backlog"),
  });
  const { url, close } = await startTestServer(registry);
  const client = await relayClient(url, token);
  try {
    await client.callTool(putSecretCall());
    // 1つの刻印に両方——持ち主（Vault）は宣言の名前、接続ごとの確かめ（Subagent）は接続名を使う
    assert.deepEqual(seen[0]?.["dev.banto/callerModule"], { name: "backlog", conn: "backlog-p1" });
  } finally {
    await client.close();
    close();
    await vault.close();
  }
});

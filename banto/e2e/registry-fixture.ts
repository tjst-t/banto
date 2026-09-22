// **試験のための MCP Registry**（追加・2026-09-21）。
//
// **本物の registry を叩かない**（規則6）——外の都合（繋がらない・中身が変わる・
// 誰かが新しいサーバを公開する）で落ちる試験は、機構が壊れた合図と見分けが
// 付かなくなる。並び順の検査はとくにそうで、**本物の一覧は毎日変わる**。
//
// 返す中身は **2026-09-21 に本物から写したもの**（`com.stripe/mcp` が公式、
// `io.github.*` が第三者、`pypi` はまだ対応していない形式）。写しであることが
// 大事なので、形を勝手に整えない。

import { createServer, type Server } from "node:http";
import { NPM_REGISTRY_BASE_URL } from "./config.ts";
import { NPM_FIXTURE_NAME, NPM_FIXTURE_VERSION } from "./npm-registry-fixture.ts";

export interface RegistryFixture {
  url: string;
  /** 受け取った検索語（host が本当に渡しているかを、受け取った側から見る）。 */
  lastQuery(): string | undefined;
  close(): Promise<void>;
}

const SERVERS = [
  {
    // **実際に取ってきて繋ぐ1本**（追加・2026-09-21）。偽の npm registry が
    // 配る依存無しの MCP サーバを指す——`registryBaseUrl` まで `server.json` の
    // 欄をそのまま使う（本物と同じ経路を通す）
    server: {
      name: "com.banto-e2e/greeter",
      title: "E2E Greeter",
      description: "E2E が実際に取ってきて繋ぐ、依存を持たない MCP サーバ",
      version: NPM_FIXTURE_VERSION,
      packages: [
        {
          registryType: "npm",
          registryBaseUrl: NPM_REGISTRY_BASE_URL,
          identifier: NPM_FIXTURE_NAME,
          version: NPM_FIXTURE_VERSION,
          runtimeHint: "npx",
          transport: { type: "stdio" },
          environmentVariables: [
            {
              name: "BANTO_E2E_GREETING",
              description: "tool の答えに混ぜる言葉（届いたかを受け取った側から見る）",
              isRequired: true,
            },
          ],
        },
      ],
    },
    _meta: { "io.modelcontextprotocol.registry/official": { status: "active", isLatest: true } },
  },
  {
    server: {
      name: "io.github.codespar/mcp-stripe",
      description: "個人が公開している Stripe 用のサーバ",
      version: "1.0.0",
      packages: [
        { registryType: "npm", identifier: "mcp-stripe", version: "1.0.0", transport: { type: "stdio" } },
      ],
    },
    _meta: { "io.modelcontextprotocol.registry/official": { status: "active", isLatest: true } },
  },
  {
    server: {
      name: "com.stripe/mcp",
      description: "MCP server integrating with Stripe - tools for customers, products, payments, and more.",
      // **題は書かない**——本物の `com.stripe/mcp` にも無い（2026-09-21 に確認）。
      // 見出しが「mcp」にならないことを、この1件で見る
      version: "0.2.4",
      repository: { url: "https://github.com/stripe/agent-toolkit", source: "github" },
      remotes: [{ type: "streamable-http", url: "https://mcp.stripe.com" }],
    },
    _meta: { "io.modelcontextprotocol.registry/official": { status: "active", isLatest: true } },
  },
  {
    // **秘密を聞く npm の1本**（追加・2026-09-21）。入れられる形式で、
    // かつ `isSecret` の欄が在るもの——Vault が既定になることをここで見る
    server: {
      name: "io.github.someone/secretful",
      description: "秘密を1つ聞く npm の MCP サーバ（試験用）",
      version: "1.0.0",
      packages: [
        {
          registryType: "npm",
          identifier: "secretful-mcp",
          version: "1.0.0",
          transport: { type: "stdio" },
          environmentVariables: [
            { name: "STRIPE_API_KEY", description: "Stripe の秘密鍵", isRequired: true, isSecret: true },
          ],
        },
      ],
    },
    _meta: { "io.modelcontextprotocol.registry/official": { status: "active", isLatest: true } },
  },
  {
    server: {
      name: "io.github.CSOAI-ORG/stripe-billing-mcp",
      description: "Python で書かれた Stripe の請求用サーバ",
      version: "1.0.0",
      packages: [
        {
          registryType: "pypi",
          identifier: "stripe-billing-mcp",
          transport: { type: "stdio" },
          environmentVariables: [
            { name: "STRIPE_API_KEY", description: "Stripe の秘密鍵", isRequired: true, isSecret: true },
          ],
        },
      ],
    },
    _meta: { "io.modelcontextprotocol.registry/official": { status: "active", isLatest: true } },
  },
];

export async function startRegistryFixture(port: number): Promise<RegistryFixture> {
  let lastQuery: string | undefined;
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
    if (!url.pathname.startsWith("/v0/servers")) {
      res.writeHead(404).end();
      return;
    }
    lastQuery = url.searchParams.get("search") ?? undefined;
    const q = (lastQuery ?? "").toLowerCase();
    // 本物と同じく、名前と説明への部分一致で絞る
    const servers = q
      ? SERVERS.filter((e) => `${e.server.name} ${e.server.description}`.toLowerCase().includes(q))
      : SERVERS;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ servers, metadata: { count: servers.length } }));
  });
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${port}`,
    lastQuery: () => lastQuery,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

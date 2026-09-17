// **試験のための、URL に繋ぐ MCP サーバ**（追加・2026-09-17）。
//
// 本物の公開サーバ（Cloudflare Docs・DeepWiki）で繋がることは別に実測してある
// （`docs/notes/2026-09-17-remote-mcp.md`）。**試験でそこを叩かない**
// ——外の都合で落ちる試験は、機構が壊れた合図と見分けが付かなくなる（規則6）。
//
// このサーバは2つのことを見せる：
//   1. **呼べば答える**（tool が通る）
//   2. **どのヘッダで来たか**を返す——`${secret:…}` が実際に届いたかを、
//      受け取った側から確かめるため（規則1——送った側の自己申告を信じない）

import { createServer, type Server } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

export interface RemoteFixture {
  url: string;
  /** 最後に受け取った Authorization ヘッダ（届いていなければ undefined）。 */
  lastAuthorization(): string | undefined;
  close(): Promise<void>;
}

export async function startRemoteMcpFixture(port: number): Promise<RemoteFixture> {
  let lastAuthorization: string | undefined;

  /** **1リクエストにつき1組**——`sessionIdGenerator: undefined` の作法どおり。
   *  使い回すと2通目の POST が 500 になる（実測・2026-09-17）。 */
  function buildServer(): { mcp: McpServer; transport: StreamableHTTPServerTransport } {
    const mcp = new McpServer({ name: "e2e-remote", version: "0.0.0" });
    mcp.registerTool(
      "echo",
      { description: "受け取った言葉をそのまま返す（試験用）", inputSchema: { word: z.string() } },
      async ({ word }) => ({ content: [{ type: "text" as const, text: `remote-said:${word}` }] }),
    );
    // **届いたヘッダを、受け取った側から見せる**——`${secret:…}` の確認に使う
    mcp.registerTool(
      "whoCalled",
      { description: "受け取った Authorization ヘッダを返す（試験用）" },
      async () => ({ content: [{ type: "text" as const, text: lastAuthorization ?? "(なし)" }] }),
    );
    return { mcp, transport: new StreamableHTTPServerTransport({ sessionIdGenerator: undefined }) };
  }

  const server: Server = createServer((req, res) => {
    const auth = req.headers.authorization;
    if (typeof auth === "string") lastAuthorization = auth;
    void (async () => {
      const { mcp, transport } = buildServer();
      res.on("close", () => {
        void transport.close();
        void mcp.close();
      });
      await mcp.connect(transport);
      await transport.handleRequest(req, res);
    })();
  });
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));

  return {
    url: `http://127.0.0.1:${port}/mcp`,
    lastAuthorization: () => lastAuthorization,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

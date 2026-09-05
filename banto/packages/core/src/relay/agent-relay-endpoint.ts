// docs/specs/v4-architecture.md §2.5「Runner は実 Module に直接繋がない」の
// HTTP transport実装（決定・2026-09-03、
// docs/notes/2026-09-03-agent-relay-http-transport.md）。
//
// host が `/agent-relay/<module名>` を持ち、Runner
// （Claude Agent SDK の `mcpServers: {type:'http', url, headers}`）がそこに繋ぐ。
// 中身は agent-proxy.ts の代理サーバをそのまま HTTP セッションに乗せるだけ。
// Module→hostの中継（host-relay-endpoint.ts、bearer token認証）とは向きが
// 逆で別物。**当初は「localhost限定であることが境界」として認証無しだったが、
// hostを外部公開する運用（決定・2026-09-03、mock/と同じ0.0.0.0待受）が
// 出たため、フロントエンドと同じbearer token（bootstrap.authToken）で
// 認証する形に訂正した**——さもないと、bantoの外にいる第三者がRunnerを
// 経由せず直接tool（Shellのrun Command等）を呼べてしまう。

import { randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { buildAgentProxy, type AgentProxyOptions, type ModuleConnection } from "./agent-proxy.js";

export class AgentRelayEndpoint {
  private readonly connections = new Map<string, ModuleConnection>();
  private readonly sessions = new Map<string, { transport: StreamableHTTPServerTransport }>();

  constructor(private readonly authToken: string, private readonly opts: AgentProxyOptions = {}) {}

  registerModule(conn: ModuleConnection): void {
    this.connections.set(conn.name, conn);
  }

  async handleRequest(
    moduleName: string,
    req: IncomingMessage,
    res: ServerResponse,
    parsedBody?: unknown,
  ): Promise<void> {
    const authHeader = req.headers["authorization"];
    if (authHeader !== `Bearer ${this.authToken}`) {
      res.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ error: "unauthorized" }));
      return;
    }

    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    let entry = sessionId ? this.sessions.get(sessionId) : undefined;

    if (!entry) {
      const conn = this.connections.get(moduleName);
      if (!conn) {
        res.writeHead(404, { "content-type": "application/json" }).end(
          JSON.stringify({ error: `module "${moduleName}" is not registered` }),
        );
        return;
      }
      const proxy = buildAgentProxy(conn, this.opts);
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomBytes(16).toString("hex"),
        onsessioninitialized: (newSessionId) => {
          this.sessions.set(newSessionId, { transport });
        },
      });
      await proxy.server.connect(transport);
      entry = { transport };
    }

    await entry.transport.handleRequest(req, res, parsedBody);
  }
}

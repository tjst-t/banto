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
  private readonly sessions = new Map<
    string,
    { transport: StreamableHTTPServerTransport; moduleName: string; threadId?: string }
  >();

  constructor(
    private readonly authToken: string,
    private readonly opts: AgentProxyOptions & {
      /**
       * **その会話で、その Module の代理サーバに載せる `instructions`**
       * （決定・2026-09-23、§5.6）。効かせる集合は会話に刻まれている
       * （`thread.skills_fixed`）ので、ここは読むだけ——**セッションを張るたびに
       * 同じ記録から同じ文字列を作る**。
       */
      instructionsFor?(module: string, threadId: string | undefined): string | undefined;
    } = {},
  ) {}

  registerModule(conn: ModuleConnection): void {
    this.connections.set(conn.name, conn);
  }

  /** その Module を畳んだ（Project を閉じた等）——**セッションも一緒に片づける**
   *  （決定・2026-09-10）。放っておくと、死んだ Module 向けのセッションが
   *  増える一方になる（`relay-lifecycle-and-elicitation`）。 */
  async unregisterModule(name: string): Promise<void> {
    this.connections.delete(name);
    for (const [sessionId, entry] of [...this.sessions]) {
      if (entry.moduleName !== name) continue;
      this.sessions.delete(sessionId);
      this.opts.elicitations?.unregister(name, entry.threadId);
      await entry.transport.close().catch(() => undefined);
    }
    this.opts.elicitations?.forget(name);
  }

  /** いま抱えているセッションの数（回収できているかを測るため）。 */
  sessionCount(): number {
    return this.sessions.size;
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
      // **どのターンの接続か**は host 自身が Runner に渡している（cli.ts の
      // resolveModulesForThread）。Module 間中継の承認を正しい会話に出すために
      // 要る——推測はしない（relay/module-calls.ts）
      const threadHeader = req.headers["x-banto-thread-id"];
      const threadId = typeof threadHeader === "string" ? threadHeader : undefined;
      // **どの Project のターンか**（追加・2026-09-13）——Vault の制限の根拠
      const projectHeader = req.headers["x-banto-project-id"];
      const projectId = typeof projectHeader === "string" ? projectHeader : undefined;
      const instructions = this.opts.instructionsFor?.(conn.declaredName ?? conn.name, threadId);
      const proxy = buildAgentProxy(conn, { ...this.opts, threadId, projectId, instructions });
      const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomBytes(16).toString("hex"),
        onsessioninitialized: (newSessionId) => {
          this.sessions.set(newSessionId, { transport, moduleName, threadId });
        },
        // **閉じたセッションは覚えておかない**（決定・2026-09-10）。ターンが
        // 終わって Runner が切れたら、その分の宛先も台帳から外す
        onsessionclosed: (closedSessionId) => {
          this.sessions.delete(closedSessionId);
          this.opts.elicitations?.unregister(moduleName, threadId);
        },
      });
      await proxy.server.connect(transport);
      entry = { transport, moduleName, threadId };
    }

    await entry.transport.handleRequest(req, res, parsedBody);
  }
}

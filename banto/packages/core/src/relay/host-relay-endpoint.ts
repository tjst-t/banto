// docs/specs/v4-architecture.md §2.5「Module 側がこの中継 tool にどう到達するか」
// の実装（決定・2026-09-03）。host が localhost限定のStreamable HTTP MCP
// エンドポイントを持ち、Moduleプロセスごとのbearer tokenで呼び出し元を識別する。
//
// Module（クライアント）が host（サーバ）のtool `relayCallTool`/
// `relayReadResource`/`relayGetPrompt` を呼ぶ——アーキ仕様§2.5の
// 「tools/call・resources/read・prompts/getそれぞれに対応する薄い転送
// インターフェース」の実体。

import { randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { BantoModuleMeta } from "@banto/module-contract";

export interface CallerIdentity {
  moduleName: string;
  projectId?: string;
  meta: BantoModuleMeta;
}

export interface RelayAuditRecord {
  callerModule: string;
  targetModule: string;
  kind: "tool" | "resource" | "prompt";
  name: string;
  allowed: boolean;
  reason?: string;
  ts: string;
}

export interface RegisteredModule {
  name: string;
  client: Client;
  meta: BantoModuleMeta;
}

/**
 * 発行済みトークン→呼び出し元識別、Module名→実接続、の2つの台帳を持つ。
 * host が実 Module へ持つ「1本だけの接続」はここに集約する。
 */
export class RelayRegistry {
  private readonly tokens = new Map<string, CallerIdentity>();
  private readonly modules = new Map<string, RegisteredModule>();

  registerModule(mod: RegisteredModule): void {
    this.modules.set(mod.name, mod);
  }

  getModule(name: string): RegisteredModule | undefined {
    return this.modules.get(name);
  }

  /** Moduleプロセスの起動のたびに発行し直す——使い回さない（決定・2026-09-03）。 */
  issueToken(identity: CallerIdentity): string {
    const token = randomBytes(24).toString("base64url");
    this.tokens.set(token, identity);
    return token;
  }

  revokeToken(token: string): void {
    this.tokens.delete(token);
  }

  resolveToken(token: string): CallerIdentity | undefined {
    return this.tokens.get(token);
  }

  /** 呼び出し元が宣言した依存に照らして許可されているか（アーキ仕様§2.5）。 */
  isAllowed(caller: CallerIdentity, targetModule: string): boolean {
    return caller.meta.dependsOn.some((d) => {
      const target = this.modules.get(targetModule);
      return target !== undefined && target.meta.satisfies.includes(d.role);
    });
  }
}

export interface HostRelayServerOptions {
  registry: RelayRegistry;
  onAudit?(record: RelayAuditRecord): void;
}

/** 呼び出し元1件ごとに、閉じ込めた identity を持つ Server+Transport を作る。 */
function buildRelayServer(identity: CallerIdentity, opts: HostRelayServerOptions): Server {
  const server = new Server(
    { name: "banto-host-relay", version: "0.0.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "relayCallTool",
        description: "他Moduleのtoolを呼ぶ（host中継）",
        inputSchema: {
          type: "object",
          properties: {
            targetModule: { type: "string" },
            name: { type: "string" },
            arguments: { type: "object" },
          },
          required: ["targetModule", "name"],
        },
      },
      {
        name: "relayReadResource",
        description: "他Moduleのresourceを読む（host中継）",
        inputSchema: {
          type: "object",
          properties: { targetModule: { type: "string" }, uri: { type: "string" } },
          required: ["targetModule", "uri"],
        },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;
    const targetModule = String(args.targetModule ?? "");

    const audit = (kind: RelayAuditRecord["kind"], name: string, allowed: boolean, reason?: string) => {
      opts.onAudit?.({
        callerModule: identity.moduleName,
        targetModule,
        kind,
        name,
        allowed,
        reason,
        ts: new Date().toISOString(),
      });
    };

    if (!opts.registry.isAllowed(identity, targetModule)) {
      audit(
        request.params.name === "relayReadResource" ? "resource" : "tool",
        String(args.name ?? args.uri ?? ""),
        false,
        "宣言された依存に含まれない",
      );
      throw new Error(`${identity.moduleName} は ${targetModule} を呼ぶ権限がありません`);
    }

    const target = opts.registry.getModule(targetModule);
    if (!target) throw new Error(`target module "${targetModule}" is not connected`);

    if (request.params.name === "relayCallTool") {
      const name = String(args.name ?? "");
      // 実データは host のプロセスメモリを一過性に通過するだけ——
      // ディスクにもEvent Storeにも記録しない。記録するのは識別子だけ。
      const result = await target.client.callTool({
        name,
        arguments: (args.arguments as Record<string, unknown>) ?? {},
      });
      audit("tool", name, true);
      return result as { content: unknown[] };
    }

    if (request.params.name === "relayReadResource") {
      const uri = String(args.uri ?? "");
      const result = await target.client.readResource({ uri });
      audit("resource", uri, true);
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    }

    throw new Error(`unknown relay tool: ${request.params.name}`);
  });

  return server;
}

/**
 * Node.js の http.createServer ハンドラの一部として使う。
 * `/relay` パスへのリクエストを、Authorizationヘッダのbearer tokenで
 * 識別してから中継サーバに渡す。
 */
export class HostRelayEndpoint {
  private readonly sessions = new Map<string, { server: Server; transport: StreamableHTTPServerTransport }>();

  constructor(private readonly opts: HostRelayServerOptions) {}

  async handleRequest(req: IncomingMessage, res: ServerResponse, parsedBody?: unknown): Promise<void> {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;

    let entry = sessionId ? this.sessions.get(sessionId) : undefined;
    if (!entry) {
      const authHeader = req.headers["authorization"];
      const token = typeof authHeader === "string" ? authHeader.replace(/^Bearer /, "") : undefined;
      const identity = token ? this.opts.registry.resolveToken(token) : undefined;
      if (!identity) {
        res.writeHead(401, { "content-type": "application/json" }).end(
          JSON.stringify({ error: "unauthorized" }),
        );
        return;
      }
      const server = buildRelayServer(identity, this.opts);
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomBytes(16).toString("hex"),
        onsessioninitialized: (newSessionId) => {
          this.sessions.set(newSessionId, { server, transport });
        },
      });
      await server.connect(transport);
      entry = { server, transport };
    }

    await entry.transport.handleRequest(req, res, parsedBody);
  }
}

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
import type { RelayApprovalGate } from "./approval-gate.js";

export interface CallerIdentity {
  /** 宣言の名前（`shell`）。**承認の粒度はこちら**——Project は別に持つ。 */
  moduleName: string;
  /** プロセスの名前（`shell-<projectId>`）。省略時は moduleName と同じ。 */
  connName?: string;
  projectId?: string;
  meta: BantoModuleMeta;
}

export interface RelayAuditRecord {
  projectId?: string;
  callerModule: string;
  targetModule: string;
  kind: "tool" | "resource" | "prompt";
  name: string;
  allowed: boolean;
  reason?: string;
  /** 実際に中継した結果。拒否されたときは付かない。 */
  ok?: boolean;
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

  /** その Module を台帳から外し、**発行済みのトークンも失効させる**
   *  （決定・2026-09-10）。プロセスが居なくなったのに合言葉だけ生き残ると、
   *  台帳が増える一方になるうえ、身元が宙に浮く。 */
  unregisterModule(name: string): void {
    this.modules.delete(name);
    for (const [token, identity] of this.tokens) {
      if ((identity.connName ?? identity.moduleName) === name) this.tokens.delete(token);
    }
  }

  /** いま有効なトークンの数（回収できているかを測るため）。 */
  tokenCount(): number {
    return this.tokens.size;
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

/**
 * 承認を待っている間、呼び出し元へ進捗を送る間隔。MCP の既定タイムアウト
 * （60秒）より十分短くする——Shell の長時間コマンドと同じ手当て
 * （docs/specs/v4-modules.md §2.3）。
 */
const APPROVAL_PROGRESS_INTERVAL_MS = 10_000;

export interface HostRelayServerOptions {
  registry: RelayRegistry;
  /**
   * 初回だけ人に聞くゲート（アーキ仕様 §2.5・docs/specs/v4-frontend.md
   * 「Module 間中継の承認」）。**渡さなければ宣言された依存だけで通す**
   * ——ゲートの有無で中継そのものの形が変わらないようにしてある（テストと
   * 実運用で同じ経路を通す）。host は必ず渡す（cli.ts）。
   */
  gate?: RelayApprovalGate;
  /** 記録（メタデータだけ）。成否も含め、拒否された呼び出しも渡ってくる。 */
  onAudit?(record: RelayAuditRecord): void | Promise<void>;
  /** 承認待ちの進捗を送る間隔（既定 10 秒）。**試験で短くするための穴**。 */
  approvalProgressIntervalMs?: number;
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

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;
    const targetModule = String(args.targetModule ?? "");
    const kind: RelayAuditRecord["kind"] = request.params.name === "relayReadResource" ? "resource" : "tool";
    const name = String(args.name ?? args.uri ?? "");
    const call = {
      projectId: identity.projectId,
      callerModule: identity.moduleName,
      targetModule,
      kind,
      name,
    };

    const audit = async (allowed: boolean, reason?: string, ok?: boolean) => {
      await opts.onAudit?.({ ...call, allowed, reason, ok, ts: new Date().toISOString() });
    };

    if (!opts.registry.isAllowed(identity, targetModule)) {
      await audit(false, "宣言された依存に含まれない");
      throw new Error(`${identity.moduleName} は ${targetModule} を呼ぶ権限がありません`);
    }

    const target = opts.registry.getModule(targetModule);
    if (!target) {
      await audit(false, "宛先の Module が繋がっていない");
      throw new Error(`target module "${targetModule}" is not connected`);
    }

    // **初回だけ人に聞く**（アーキ仕様 §2.5）。宣言された依存は「配線として
    // あり得るか」で、こちらは「その配線を実際に使ってよいか」——別の問い。
    //
    // 人はすぐには答えない。**待っている間、呼び出し元に進捗を送り続ける**
    // （docs/specs/v4-frontend.md「Module 間中継の承認」の 2.）——さもないと
    // MCP の既定60秒で呼び出し元が先に諦め、「承認したのに、その回の操作は
    // 失敗している」になる。呼び出し元が progressToken を付けてこないときは
    // 送りようがない（その場合は60秒で切れる、という今までの挙動のまま）
    const progressToken = extra._meta?.progressToken;
    const heartbeat =
      opts.gate && progressToken !== undefined
        ? setInterval(() => {
            void extra.sendNotification({
              method: "notifications/progress",
              params: { progressToken, progress: 0, message: "人の承認を待っています" },
            });
          }, opts.approvalProgressIntervalMs ?? APPROVAL_PROGRESS_INTERVAL_MS)
        : undefined;
    heartbeat?.unref();
    const decision = await (opts.gate
      ? opts.gate
          .requestApproval({ ...call, callerConnName: identity.connName ?? identity.moduleName })
          .finally(() => clearInterval(heartbeat))
      : Promise.resolve({ allowed: true, reason: "ゲート無し" }));
    if (!decision.allowed) {
      await audit(false, decision.reason);
      throw new Error(
        `${identity.moduleName} から ${targetModule} の ${name} への中継は許可されていません：${decision.reason}`,
      );
    }

    try {
      if (request.params.name === "relayCallTool") {
        // 実データは host のプロセスメモリを一過性に通過するだけ——
        // ディスクにもEvent Storeにも記録しない。記録するのは識別子だけ。
        const result = await target.client.callTool({
          name,
          arguments: (args.arguments as Record<string, unknown>) ?? {},
        });
        await audit(true, decision.reason, true);
        return result as { content: unknown[] };
      }

      if (request.params.name === "relayReadResource") {
        const result = await target.client.readResource({ uri: name });
        await audit(true, decision.reason, true);
        return { content: [{ type: "text", text: JSON.stringify(result) }] };
      }
    } catch (err) {
      // **失敗も記録する**——監査で見たいのはむしろこちら（規則2）
      await audit(true, err instanceof Error ? err.message : String(err), false);
      throw err;
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

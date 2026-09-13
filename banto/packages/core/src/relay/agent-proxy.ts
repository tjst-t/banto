// docs/specs/v4-architecture.md §2.5「Runner は実 Module に直接繋がない」の実装。
// poc/05-module-relay-topology・poc/06-resource-prompt-relay で実証済みの設計:
// host が実Moduleへの接続を1本だけ持ち、Runnerには低レベルServerで組んだ
// 代理サーバを見せる。`createSdkMcpServer`は使わない（toolしか受け付けない）。
//
// Runnerとこの代理サーバの間は実HTTPで繋ぐ（決定・2026-09-03、
// docs/notes/2026-09-03-agent-relay-http-transport.md）——in-processの
// `{type:'sdk', instance}`ではElicitationが機能しないため。この関数は
// Serverオブジェクトを組み立てるだけで、HTTP transportへの接続は
// agent-relay-endpoint.ts が行う。

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ReadResourceRequestSchema,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { CALLER_META_KEY, stripBantoMeta, visibilityOf, type BantoModuleMeta } from "@banto/module-contract";
import { makeResourceVisibilityResolver } from "./visibility.js";
import type { ModuleCallTracker } from "./module-calls.js";
import type { ElicitationRouter } from "./elicitation-router.js";

export interface RelayRecord {
  direction: "list" | "call" | "read";
  name: string;
  allowed: boolean;
}

export interface AgentProxyOptions {
  onRelay?(record: RelayRecord): void;
  /**
   * この接続がどのターンのものか（agent-relay-endpoint.ts が
   * `x-banto-thread-id` から取る）と、走行中の呼び出しの台帳。
   * **Module 間中継の承認を、正しい会話に出すために要る**
   * ——Module→host の中継接続は Thread を知らない（relay/module-calls.ts）。
   */
  threadId?: string;
  /** そのターンがどの Project のものか。**host が渡す**（Module に聞かない）。 */
  projectId?: string;
  moduleCalls?: ModuleCallTracker;
  /** Module からの問いを、正しいターンへ届けるための宛先表。 */
  elicitations?: ElicitationRouter;
}

export interface AgentProxy {
  server: Server;
  close(): Promise<void>;
}

export interface ModuleConnection {
  name: string;
  client: Client;
  meta: BantoModuleMeta;
}

/**
 * Runner向けの代理サーバを組む。`agent`可視性のtool/resourceだけを
 * 転送する——「フィルタで隠す」のではなく「最初から存在しない」。
 */
export function buildAgentProxy(conn: ModuleConnection, opts: AgentProxyOptions = {}): AgentProxy {
  const server = new Server(
    { name: conn.name, version: "0.0.0" },
    { capabilities: { tools: {}, resources: {} } }, // prompts は宣言しない（poc/06実測、CLIが呼ばない）
  );
  const visibilityResolver = makeResourceVisibilityResolver(conn.client);

  // 実Module（conn.client の先）が elicitInput() を呼んだとき、それを受けるのは
  // hostの持つ実Client接続——そのままではRunnerに届かない。転送は要るが、
  // **ハンドラを代理サーバごとに付けると最後の1つが上書きしてしまう**
  // （並行ターンで問いが別の会話に出る）。**宛先の決定は router に集約する**
  // （relay/elicitation-router.ts、決定・2026-09-10）。
  opts.elicitations?.register(conn, opts.threadId, server);

  /**
   * **この接続が誰のためのものか**（決定・2026-09-13）。AI の代理接続は必ず
   * ターンの中なので、Project が分かる。**分からなければ刻まない**
   * ——受け手はそれを「決められない」として fail closed で止める（規則2）。
   */
  function callerStamp(): Record<string, unknown> {
    return opts.projectId ? { [CALLER_META_KEY]: { project: opts.projectId } } : {};
  }

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const real = await conn.client.listTools();
    const visible = real.tools.filter((t) => visibilityOf(t as { _meta?: Record<string, unknown> }) === "agent");
    opts.onRelay?.({ direction: "list", name: "tools/list", allowed: true });
    return { tools: visible.map((t) => stripBantoMeta(t as Tool & { _meta?: Record<string, unknown> })) };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    // 名前がRunnerに見えていたことを信じない——毎回ライブに再確認する。
    const real = await conn.client.listTools();
    const target = real.tools.find((t) => t.name === request.params.name);
    const allowed = target !== undefined && visibilityOf(target as { _meta?: Record<string, unknown> }) === "agent";
    opts.onRelay?.({ direction: "call", name: request.params.name, allowed });
    if (!allowed) {
      throw new Error(`tool "${request.params.name}" は agent 可視性ではありません`);
    }

    const progressToken = extra._meta?.progressToken;
    // **このハンドラが動いている間だけ**、この Module はこのターンの仕事をしている
    // ——中継の承認をどの会話に出すかは、これで決まる（relay/module-calls.ts）
    const endCall =
      opts.threadId && opts.moduleCalls
        ? opts.moduleCalls.begin(conn.name, opts.threadId, "turn", opts.projectId)
        : undefined;
    try {
      const result = await conn.client.callTool(
        {
          name: request.params.name,
          arguments: request.params.arguments,
          // **誰のための呼び出しかを host が刻む**（追加・2026-09-13）
          _meta: { ...callerStamp() },
        },
        undefined,
        {
          signal: extra.signal,
          resetTimeoutOnProgress: true,
          onprogress:
            progressToken !== undefined
              ? (progress) => {
                  void extra.sendNotification({
                    method: "notifications/progress",
                    params: { ...progress, progressToken },
                  });
                }
              : undefined,
        },
      );
      return stripBantoMeta(result as { _meta?: Record<string, unknown> }) as typeof result;
    } finally {
      endCall?.();
    }
  });

  server.setRequestHandler(ListResourcesRequestSchema, async () => {
    const real = await conn.client.listResources().catch(() => ({ resources: [] }));
    const visible = real.resources.filter(
      (r) => visibilityOf(r as { _meta?: Record<string, unknown> }) === "agent",
    );
    return { resources: visible.map((r) => stripBantoMeta(r as { _meta?: Record<string, unknown> })) };
  });

  server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => {
    const real = await conn.client.listResourceTemplates().catch(() => ({ resourceTemplates: [] }));
    const visible = real.resourceTemplates.filter(
      (t) => visibilityOf(t as { _meta?: Record<string, unknown> }) === "agent",
    );
    return {
      resourceTemplates: visible.map((t) => stripBantoMeta(t as { _meta?: Record<string, unknown> })),
    };
  });

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    // resourceはtoolと違い一覧に無くても直接読めてしまう非対称がある
    // （poc/06実測）——visibility解決はfail closed。
    const visibility = await visibilityResolver(request.params.uri);
    const allowed = visibility === "agent";
    opts.onRelay?.({ direction: "read", name: request.params.uri, allowed });
    if (!allowed) {
      throw new Error(`resource "${request.params.uri}" は読めません（visibility=${visibility}）`);
    }
    // **読み取りの最中も、この Module はこのターンの仕事をしている**
    // （追加・2026-09-12）。tool 呼び出しには前からこれが有ったが、resource の
    // 読み取りには無かった——**中で他 Module を呼ぶ resource**（横断した一覧を
    // 作る窓口など）は、承認ゲートが「どのターンからの呼び出しか特定できません」
    // で**構造的に必ず拒否される**状態だった。
    const endCall =
      opts.threadId && opts.moduleCalls
        ? opts.moduleCalls.begin(conn.name, opts.threadId, "turn", opts.projectId)
        : undefined;
    try {
      const result = await conn.client.readResource({
        uri: request.params.uri,
        _meta: { ...callerStamp() },
      });
      return stripBantoMeta(result as { _meta?: Record<string, unknown> }) as typeof result;
    } finally {
      endCall?.();
    }
  });

  return {
    server,
    close: () => server.close(),
  };
}

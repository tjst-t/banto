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
  ElicitRequestSchema,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { stripBantoMeta, visibilityOf, type BantoModuleMeta } from "@banto/module-contract";
import { makeResourceVisibilityResolver } from "./visibility.js";

export interface RelayRecord {
  direction: "list" | "call" | "read";
  name: string;
  allowed: boolean;
}

export interface AgentProxyOptions {
  onRelay?(record: RelayRecord): void;
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

  // 実Module（conn.client の先）が elicitInput() を呼んだとき、
  // それを受けるのはhostの持つ実Client接続——そのままではRunnerに届かない。
  // ここでRunner向けproxy Serverのelicitiput()に転送する（決定・実装時発見、
  // アーキ仕様§2.4「人に聞くはElicitationに乗せる」がModule起点の場合の欠落）。
  // conn.client は他のbuildAgentProxy呼び出しと共有され得るため、最後に
  // 登録したproxyが呼び出し元になる——同時に複数ターンが同じModuleへの
  // elicitationを競合させる場合は未対応（TODO）。
  conn.client.setRequestHandler(ElicitRequestSchema, async (request) => {
    return server.elicitInput(request.params);
  });

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
    const result = await conn.client.callTool(
      { name: request.params.name, arguments: request.params.arguments },
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
    const result = await conn.client.readResource({ uri: request.params.uri });
    return stripBantoMeta(result as { _meta?: Record<string, unknown> }) as typeof result;
  });

  return {
    server,
    close: () => server.close(),
  };
}

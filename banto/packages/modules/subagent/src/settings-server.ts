#!/usr/bin/env node
// **サブエージェントの設定**（banto 全体に1本。決定・2026-09-24、ユーザー「鍵の設定は Project ではなく
// Global に」）。
//
// サブエージェントを走らせる Module（`server.ts`）は Project ごとに立つ——作業場所（Project の根）と
// 閉じ込めがあるから。一方、鍵は banto 全体の Vault に1つで、どの Project でも使う。**設定画面が
// どちらに出るかは Module の単位が決める**（Project ごとの Module の画面は Project 設定に出る）ので、
// 設定だけを受け持つ banto 全体の Module をここに分けた。
//
// banto 全体の設定画面から押した操作は、host が人の管理操作（`{admin}`）と刻む——Vault は書き換え・
// 削除をそのときだけ受け付けるので、置き換えも削除もこの画面でできる。

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { CANVAS_META_KEY, MODULE_META_KEY, VALUE_FREE_META_KEY, VISIBILITY_META_KEY } from "@banto/module-contract";
import { defaultAliasName, listAgents, usesStoredKeys, type AgentDefinition } from "./agents.js";
import { ClaudeLoginError, hostClaudeCredentialsPath, readHostClaudeAccount, startClaudeLoginProxy, type ClaudeLoginProxy } from "./claude-login-proxy.js";
import { randomUUID } from "node:crypto";
import { CONFIG_APP_HTML, CONFIG_APP_URI } from "./config-app.js";
import { CredentialError, deleteKey, importableValue, storedKeys, storeKey, type CredentialsRelay } from "./credentials.js";
import { HostRelayClient } from "./host-relay-client.js";

export interface SubagentSettingsDeps {
  relayClient: CredentialsRelay;
  agents?: AgentDefinition[];
  /** banto 本体の Claude ログインの置き場（試験で差し替える）。既定は本体と同じ解決 */
  claudeCredentialsPath?: string;
  /** Claude の上流（試験で差し替える） */
  claudeUpstream?: string;
}

/**
 * 開いた中継の寿命の上限。閉じ忘れ（サブエージェントの Module が落ちた等）で残り続けないように。
 * 長い仕事より長く取る——仕事の途中で切ると、その仕事が推論を呼べなくなる
 */
const PROXY_MAX_LIFETIME_MS = 12 * 60 * 60 * 1000;

const UI_APP_MIME = "text/html;profile=mcp-app";

export function createSubagentSettingsServer(deps: SubagentSettingsDeps) {
  const agents = deps.agents ?? listAgents();
  const claudeCredentialsPath = deps.claudeCredentialsPath ?? hostClaudeCredentialsPath();
  /**
   * **banto 本体の Claude ログインの中継**（決定・2026-09-25、`docs/specs/v4-security.md` §1）。サブエージェントの
   * Module は Project のコンテナの中にいて、本体のログインは中に無い（入れてはいけない）。中継はここ（host で動く
   * 同梱のコード）が持ち、開いた中継の住所と1回ごとの合言葉だけを渡す
   */
  const proxies = new Map<string, { proxy: ClaudeLoginProxy; timer: NodeJS.Timeout }>();
  const server = new Server({ name: "banto-module-subagent-settings", version: "0.1.0" }, { capabilities: { tools: {}, resources: {} } });

  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: [
      {
        // **設定 Canvas**——banto 全体の設定の「Module ごとの設定」に「サブエージェント」として出る
        uri: CONFIG_APP_URI,
        name: "サブエージェント",
        mimeType: UI_APP_MIME,
        _meta: { [VISIBILITY_META_KEY]: "admin", [CANVAS_META_KEY]: "config", ui: { prefersBorder: false } },
      },
      {
        uri: "subagent-settings://module",
        name: "この Module の申告",
        mimeType: "application/json",
        _meta: {
          [VISIBILITY_META_KEY]: "admin",
          [MODULE_META_KEY]: {
            satisfies: ["subagent-settings"],
            // 鍵の在りかを窓口に聞き、窓口を通して金庫へしまう
            dependsOn: [
              { role: "vault-directory", required: true },
              { role: "vault", required: true },
            ],
            isolation: "subprocess",
            scope: "instance",
            // 人が設定画面で打った鍵がこの Module を通って Vault へ行く（要件 C8c）
            handlesSecrets: true,
          },
        },
      },
    ],
  }));

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    if (request.params.uri !== CONFIG_APP_URI) throw new Error(`unknown resource: ${request.params.uri}`);
    return { contents: [{ uri: CONFIG_APP_URI, mimeType: UI_APP_MIME, text: CONFIG_APP_HTML }] };
  });

  // **どれも人の設定画面から呼ぶ（admin——AI には見せない）**
  const agentAndEnv = {
    type: "object",
    properties: { agent: { type: "string" }, env: { type: "string" } },
    required: ["agent", "env"],
  } as const;
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "getCredentials",
        description: "エージェントごとの資格情報の状態（値は返さない）",
        inputSchema: { type: "object", properties: {} },
        _meta: { [VISIBILITY_META_KEY]: "admin" },
      },
      {
        name: "importCredential",
        description: "この機械のエージェント自身の設定から鍵を取り込み、Vault に置く（在れば置き換える）",
        inputSchema: agentAndEnv,
        _meta: { [VISIBILITY_META_KEY]: "admin" },
      },
      {
        name: "setCredential",
        description: "人が貼った鍵を Vault に置く（在れば置き換える）",
        inputSchema: {
          type: "object",
          properties: { agent: { type: "string" }, env: { type: "string" }, value: { type: "string" } },
          required: ["agent", "env", "value"],
        },
        _meta: { [VISIBILITY_META_KEY]: "admin" },
      },
      {
        name: "deleteCredential",
        description: "Vault に置いた鍵を消す",
        inputSchema: agentAndEnv,
        _meta: { [VISIBILITY_META_KEY]: "admin" },
      },
      // **サブエージェントの Module だけが呼ぶ口**（module——AI にも人の画面にも出さない）
      {
        name: "claudeLoginStatus",
        description: "banto 本体の Claude ログインの状態（契約の種類）。値は返さない",
        inputSchema: { type: "object", properties: {} },
        _meta: { [VISIBILITY_META_KEY]: "module", [VALUE_FREE_META_KEY]: true },
      },
      {
        name: "openClaudeLoginProxy",
        description: "サブエージェントの1つの仕事のために、本体の Claude ログインの中継を開く（本物のトークンは渡さない）",
        inputSchema: { type: "object", properties: { listenHost: { type: "string" } }, required: ["listenHost"] },
        _meta: { [VISIBILITY_META_KEY]: "module" },
      },
      {
        name: "closeClaudeLoginProxy",
        description: "開いた中継を閉じる。上流が 401 を返した回数を返す（期限切れを理由つきで伝えるため）",
        inputSchema: { type: "object", properties: { proxyId: { type: "string" } }, required: ["proxyId"] },
        _meta: { [VISIBILITY_META_KEY]: "module", [VALUE_FREE_META_KEY]: true },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;
    const agentOf = (id: unknown): AgentDefinition => {
      const found = agents.find((a) => a.id === id);
      if (!found) throw new CredentialError(`エージェント "${String(id)}" はありません`);
      return found;
    };
    try {
      switch (request.params.name) {
        case "getCredentials":
          return text({ agents: await credentialsStatus() });
        case "importCredential": {
          const agent = agentOf(args.agent);
          const envName = String(args.env);
          const value = await importableValue(agent, envName);
          if (value === undefined) {
            throw new CredentialError(`${agent.importFrom?.label ?? "取り込み元"}に ${envName} の鍵が見つかりません`);
          }
          await storeKey(agent, envName, value, deps.relayClient);
          return text({ ok: true });
        }
        case "setCredential":
          await storeKey(agentOf(args.agent), String(args.env), typeof args.value === "string" ? args.value : "", deps.relayClient);
          return text({ ok: true });
        case "deleteCredential":
          await deleteKey(agentOf(args.agent), String(args.env), deps.relayClient);
          return text({ ok: true });
        case "claudeLoginStatus":
          return text(await readHostClaudeAccount(claudeCredentialsPath));
        case "openClaudeLoginProxy": {
          const proxy = await startClaudeLoginProxy({
            credentialsPath: claudeCredentialsPath,
            host: String(args.listenHost ?? ""),
            ...(deps.claudeUpstream ? { upstream: deps.claudeUpstream } : {}),
          });
          const proxyId = randomUUID();
          const timer = setTimeout(() => void closeProxy(proxyId), PROXY_MAX_LIFETIME_MS);
          timer.unref();
          proxies.set(proxyId, { proxy, timer });
          return text({
            proxyId,
            url: proxy.url,
            secret: proxy.secret,
            ...(proxy.account.subscriptionType ? { subscriptionType: proxy.account.subscriptionType } : {}),
            ...(proxy.account.rateLimitTier ? { rateLimitTier: proxy.account.rateLimitTier } : {}),
          });
        }
        case "closeClaudeLoginProxy":
          return text(await closeProxy(String(args.proxyId)));
        default:
          throw new Error(`unknown tool: ${request.params.name}`);
      }
    } catch (err) {
      // 失敗は理由ごと画面に返す（保存できたふりをしない）
      if (err instanceof CredentialError || err instanceof ClaudeLoginError) return { content: [{ type: "text", text: err.message }], isError: true };
      throw err;
    }
  });

  /** 開いた中継を閉じる（無ければ 0 回として返す——閉じ忘れの上限で先に閉じていることがある） */
  async function closeProxy(proxyId: string): Promise<{ upstreamAuthFailures: number }> {
    const opened = proxies.get(proxyId);
    if (!opened) return { upstreamAuthFailures: 0 };
    proxies.delete(proxyId);
    clearTimeout(opened.timer);
    const upstreamAuthFailures = opened.proxy.upstreamAuthFailures();
    await opened.proxy.close();
    return { upstreamAuthFailures };
  }

  /** 設定画面に出す状態。**値は返さない**（在るか・取り込めるかだけ） */
  async function credentialsStatus() {
    const present = agents.some(usesStoredKeys) ? await storedKeys(deps.relayClient) : new Map();
    return Promise.all(
      agents.map(async (a) => {
        if (a.sharesHostClaudeLogin) {
          return { id: a.id, title: a.title, hostLogin: await readHostClaudeAccount(claudeCredentialsPath) };
        }
        return {
          id: a.id,
          title: a.title,
          ...(a.importFrom ? { importLabel: a.importFrom.label } : {}),
          keys: await Promise.all(
            a.credentialEnv.map(async (envName) => ({
              env: envName,
              alias: defaultAliasName(a.id, envName),
              set: present.has(defaultAliasName(a.id, envName)),
              importable: (await importableValue(a, envName).catch(() => undefined)) !== undefined,
            })),
          ),
        };
      }),
    );
  }

  return server;
}

function text(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value) }] };
}

// **入口の判定は名前まで見る**——`server.js` も同じ語尾なので、語尾だけだと取り違える
if (process.argv[1] && process.argv[1].endsWith("/settings-server.js")) {
  const hostUrl = process.env.BANTO_HOST_MCP_URL;
  const hostToken = process.env.BANTO_HOST_MCP_TOKEN;
  if (!hostUrl || !hostToken) {
    console.error("BANTO_HOST_MCP_URL, BANTO_HOST_MCP_TOKEN が必要です");
    process.exit(1);
  }
  const server = createSubagentSettingsServer({
    relayClient: new HostRelayClient({ url: hostUrl, token: hostToken }),
    // 試験は本物のログインを読まない（E2E が用意した偽物を指す）。ふだんは本体と同じ解決
    ...(process.env.BANTO_SUBAGENT_CLAUDE_CREDENTIALS ? { claudeCredentialsPath: process.env.BANTO_SUBAGENT_CLAUDE_CREDENTIALS } : {}),
  });
  await server.connect(new StdioServerTransport());
}

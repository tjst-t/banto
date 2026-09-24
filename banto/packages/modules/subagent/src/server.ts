#!/usr/bin/env node
// Subagent Module（docs/specs/v4-architecture.md §4.1「Subagent Module の形」）。
// MCP サーバであり、ACP クライアント——Claude Code・OpenCode を ACP の同じ口で起こす。
// tool は2つ：`listSubagents`（一覧と、そのエージェントの設定の候補）と `runSubagent`（仕事を頼む）。
// 鍵の設定画面は banto 全体に1本の別 Module（`settings-server.ts`）が持つ——ここは Project ごとに立つので。

import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListResourcesRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { MODULE_META_KEY, VISIBILITY_META_KEY } from "@banto/module-contract";
import type { GuardOptions } from "@banto/landlock";
import { resolveBootstrapConfigPath } from "@banto/core/dist/config/bootstrap.js";
import { describeAgent, runSubagent, SubagentError, type AgentLaunch, type PermissionQuestion } from "./acp-run.js";
import { listAgents, type AgentDefinition } from "./agents.js";
import {
  ClaudeLoginError,
  hostClaudeCredentialsPath,
  readHostClaudeAccount,
  startClaudeLoginProxy,
  type ClaudeLoginProxy,
} from "./claude-login-proxy.js";
import { confineAgent } from "./confine.js";
import { resolveStoredKeys, type StoredKeysRelay } from "./credentials.js";
import { HostRelayClient, type AliasPlace } from "./host-relay-client.js";

export interface SubagentServerDeps {
  projectRoot: string;
  /** この Module のデータ置き場（エージェントごとの専用ホームをこの下に持つ） */
  moduleDataDir: string;
  relayClient: StoredKeysRelay;
  guard: GuardOptions;
  /** Module が起動したときの PATH（閉じ込めの導出に使う。実行時に読み直さない） */
  pathEntries: string[];
  agents?: AgentDefinition[];
  /** banto 本体の Claude ログインの置き場と上流（試験で差し替える）。既定は本体と同じ解決 */
  claudeLogin?: { credentialsPath?: string; upstream?: string };
}


// host が Module に渡した変数（`BANTO_*`）と、人の環境の秘密はエージェントに渡さない。
// **渡すのはこの一覧と、専用ホーム・資格情報だけ**
const PASS_THROUGH_ENV = ["PATH", "LANG", "LANGUAGE", "LC_ALL", "LC_CTYPE", "LC_MESSAGES", "TERM", "TZ", "USER", "LOGNAME", "SHELL"];
const HOST_ENV_PREFIX = "BANTO_";

const ENV_SECRETS_SCHEMA = {
  type: "object",
  description:
    '環境変数名 → Vault の alias 名。例：{"CLAUDE_CODE_OAUTH_TOKEN": "claude-setup-token"}。' +
    "**値ではなく alias 名を書く。** 値は Vault からエージェントの環境へ直接渡り、あなたの文脈には出ない。" +
    "**渡したものは、そのサブエージェントのシェルから読める**——読まれてよいものだけを渡す",
  additionalProperties: { type: "string" },
} as const;

function agentIdsText(agents: AgentDefinition[]): string {
  return agents.map((a) => `${a.id}（${a.title}。資格情報の変数：${a.credentialEnv.join(" / ")}）`).join("、");
}

export function createSubagentServer(deps: SubagentServerDeps) {
  const agents = deps.agents ?? listAgents();
  const claudeCredentialsPath = deps.claudeLogin?.credentialsPath ?? hostClaudeCredentialsPath();
  const server = new Server({ name: "banto-module-subagent", version: "0.1.0" }, { capabilities: { tools: {}, resources: {} } });

  // **自分が何者かを名乗る**（host は宣言と突き合わせる）。AI には見せない（admin）。
  // **閉じ込めは Module ではなくエージェントに掛ける**（v4-security.md「サブエージェントは
  // 自分のドメインで起こす」）——Module 自身は AI の書いたコマンドを走らせない
  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: [
      {
        uri: "subagent://module",
        name: "この Module の申告",
        mimeType: "application/json",
        _meta: {
          [VISIBILITY_META_KEY]: "admin",
          [MODULE_META_KEY]: {
            satisfies: ["subagent"],
            // 資格情報は Vault の alias から受け取る（Shell の envSecrets と同じ経路）
            dependsOn: [
              { role: "vault-directory", required: true },
              { role: "vault", required: true },
            ],
            isolation: "subprocess",
            scope: "project",
          },
        },
      },
    ],
  }));


  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "listSubagents",
        description:
          "仕事を頼めるサブエージェントの一覧。agent を指定すると、そのエージェントを起こして" +
          "選べるモデル・effort・モードの候補を聞く（候補は渡した資格情報で変わる）。" +
          `エージェント：${agentIdsText(agents)}`,
        inputSchema: {
          type: "object",
          properties: {
            agent: { type: "string", enum: agents.map((a) => a.id), description: "候補を聞きたいエージェント" },
            envSecrets: ENV_SECRETS_SCHEMA,
          },
        },
        _meta: { [VISIBILITY_META_KEY]: "agent" },
      },
      {
        name: "runSubagent",
        description:
          "サブエージェントに仕事を頼み、終わるまで待って最後の返答を返す。サブエージェントは Project root で、" +
          "自分の道具（シェル・ファイル操作）を使って働く——Project root の外には出られない（Landlock で強制）。" +
          "**資格情報は、ふつうは書かなくてよい**：Claude Code は banto 本体の Claude ログインをそのまま使い、" +
          "OpenCode は人が banto 全体の設定の「サブエージェント」で入れた鍵を使う（どれが使えるかは listSubagents）。" +
          "それ以外の鍵で走らせたいときだけ envSecrets に alias を渡す（使える alias の一覧は resource `vault://aliases`）。" +
          "続きを頼むときは、前の返り値の sessionId を渡す。" +
          "**サブエージェントが人に確認を求めても、いまは聞く口が無いので断る**（断ったものは返り値の permissions に出る）",
        inputSchema: {
          type: "object",
          properties: {
            agent: { type: "string", enum: agents.map((a) => a.id) },
            prompt: { type: "string", description: "頼む内容。サブエージェントはあなたの会話を知らないので、要ることは全部書く" },
            model: {
              type: "string",
              description:
                "モデル。候補は listSubagents で agent を指定して聞く。省略時はエージェントの既定" +
                "（Claude Code は banto 本体と同じ既定）",
            },
            effort: { type: "string", description: "考える深さ（エージェントの thought_level）。省略時は既定" },
            sessionId: { type: "string", description: "続きから頼むときの session id（前の runSubagent の返り値）" },
            envSecrets: ENV_SECRETS_SCHEMA,
          },
          required: ["agent", "prompt"],
        },
        _meta: { [VISIBILITY_META_KEY]: "agent" },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;
    const progressToken = extra._meta?.progressToken;
    const onProgress =
      progressToken !== undefined
        ? (message: string) => {
            void extra.sendNotification({ method: "notifications/progress", params: { progressToken, progress: 0, message } });
          }
        : undefined;

    const agentOf = (id: unknown): AgentDefinition => {
      const found = agents.find((a) => a.id === id);
      if (!found) throw new SubagentError(`エージェント "${String(id)}" はありません。使えるもの：${agents.map((a) => a.id).join(", ")}`);
      return found;
    };

    try {
      if (request.params.name === "listSubagents") {
        if (args.agent === undefined) {
          // **何を書かずに使えるか**も返す——AI が envSecrets を書くかどうかを、推測させない。
          // 鍵が Vault に在るかは**ここでは引かない**（会話の中から目録を引くと、人への承認が増える）
          return text(
            await Promise.all(
              agents.map(async (a) => ({
                id: a.id,
                title: a.title,
                credentials: a.sharesHostClaudeLogin
                  ? await hostLoginSummary()
                  : "人が banto 全体の設定の「サブエージェント」で入れた鍵を使う（入っていなければ envSecrets で渡す）",
                credentialEnv: a.credentialEnv,
              })),
            ),
          );
        }
        const agent = agentOf(args.agent);
        const launched = await launchFor(agent, args.envSecrets, onProgress);
        try {
          return text(await describeAgent(launched.launch, deps.projectRoot));
        } catch (err) {
          throw launched.explain(err);
        } finally {
          await launched.cleanup();
        }
      }


      if (request.params.name === "runSubagent") {
        const agent = agentOf(args.agent);
        if (typeof args.prompt !== "string" || args.prompt.trim() === "") throw new SubagentError("prompt が空です");
        const launched = await launchFor(agent, args.envSecrets, onProgress);
        try {
          onProgress?.(`${agent.title} を起こしています`);
          const result = await runSubagent(
            {
              prompt: args.prompt,
              ...(typeof args.model === "string" ? { model: args.model } : {}),
              ...(typeof args.effort === "string" ? { effort: args.effort } : {}),
              ...(typeof args.sessionId === "string" ? { sessionId: args.sessionId } : {}),
            },
            {
              launch: launched.launch,
              cwd: deps.projectRoot,
              ...(agent.mode ? { mode: agent.mode } : {}),
              signal: extra.signal,
              ...(onProgress ? { onProgress } : {}),
              askPermission: refusePermission,
            },
          );
          return text({ ...result, notes: [...launched.notes, ...result.notes] });
        } catch (err) {
          throw launched.explain(err);
        } finally {
          await launched.cleanup();
        }
      }
    } catch (err) {
      // 頼み方の誤り・エージェントの失敗は、AI に理由ごと返す（黙って空を返さない）
      if (err instanceof SubagentError || err instanceof ClaudeLoginError) {
        return { content: [{ type: "text", text: err.message }], isError: true };
      }
      throw err;
    }
    throw new Error(`unknown tool: ${request.params.name}`);
  });

  /** 資格情報を Vault から受け取り（Claude は本体のログインを中継で渡し）、Landlock で包んだ起こし方を作る */
  async function launchFor(
    agent: AgentDefinition,
    envSecrets: unknown,
    onProgress?: (message: string) => void,
  ): Promise<{ launch: AgentLaunch; notes: string[]; cleanup: () => Promise<void>; explain: (err: unknown) => unknown }> {
    const env: NodeJS.ProcessEnv = {};
    for (const name of PASS_THROUGH_ENV) if (process.env[name] !== undefined) env[name] = process.env[name];

    const secrets = (envSecrets ?? {}) as Record<string, unknown>;
    for (const [name, alias] of Object.entries(secrets)) {
      // host が渡した変数を上書きさせない（Shell の envSecrets と同じ。規則2——黙って無視しない）
      if (name.startsWith(HOST_ENV_PREFIX)) throw new SubagentError(`envSecrets に ${HOST_ENV_PREFIX} で始まる名前は使えません: ${name}`);
      if (typeof alias !== "string") throw new SubagentError(`envSecrets の ${name} には alias 名（文字列）を書く`);
      const note = (n: string) => onProgress?.(`envSecrets: ${name}——${n}`);
      const place: AliasPlace = await deps.relayClient.lookupAlias("vault-directory", alias, note);
      env[name] = await deps.relayClient.resolveAlias(place, note);
    }
    // 書かれなかった分は、人が設定で入れた既定の鍵（Vault）から
    const stored = await resolveStoredKeys(agent, new Set(Object.keys(secrets)), deps.relayClient, onProgress);
    Object.assign(env, stored.env);

    // **Claude は banto 本体のログインを共有する**（決定・2026-09-24、ユーザー）。本物のトークンは
    // 渡さず、中継の合言葉だけを渡す。自分の資格情報を envSecrets で渡されたときは、そちらを使う
    let proxy: ClaudeLoginProxy | undefined;
    if (agent.sharesHostClaudeLogin && !agent.credentialEnv.some((name) => name in secrets)) {
      proxy = await startClaudeLoginProxy({
        credentialsPath: claudeCredentialsPath,
        ...(deps.claudeLogin?.upstream ? { upstream: deps.claudeLogin.upstream } : {}),
      });
      env.CLAUDE_CODE_OAUTH_TOKEN = proxy.secret;
      env.ANTHROPIC_BASE_URL = proxy.url;
      // **既定を本体と揃える**（決定・2026-09-24、ユーザー）。env のトークンのとき、CLI は契約の種類を
      // ここから読む（トークンではない）。無いと既定が Sonnet・文脈20万になった（実測）
      if (proxy.account.subscriptionType) env.CLAUDE_CODE_SUBSCRIPTION_TYPE = proxy.account.subscriptionType;
      if (proxy.account.rateLimitTier) env.CLAUDE_CODE_RATE_LIMIT_TIER = proxy.account.rateLimitTier;
    }

    let rulesetFile: string | undefined;
    try {
      const confined = confineAgent({
        agent,
        projectRoot: deps.projectRoot,
        home: join(deps.moduleDataDir, "agents", agent.id, "home"),
        runDir: join(deps.moduleDataDir, "run"),
        pathEntries: deps.pathEntries,
        guard: deps.guard,
      });
      rulesetFile = confined.args[confined.args.indexOf("--ruleset-file") + 1];
      return {
        launch: { command: confined.command, args: confined.args, env: { ...env, ...confined.env } },
        notes: stored.notes,
        cleanup: async () => {
          if (rulesetFile) rmSync(rulesetFile, { force: true });
          await proxy?.close();
        },
        explain: (err) => {
          // **期限切れを、理由つきで返す**——本体のトークンは本体の CLI が更新する。サブエージェントが
          // 長く走ると途中で切れることがあり、そのときは続きから頼み直せば、本体が更新したものを中継が拾う
          if (proxy && proxy.upstreamAuthFailures() > 0 && err instanceof Error) {
            return new SubagentError(
              `${err.message}\n（banto 本体の Claude ログインのトークンが、途中で期限切れになった可能性があります。` +
                "sessionId を渡して続きから頼み直してください——本体が次の呼び出しで更新します）",
            );
          }
          return err;
        },
      };
    } catch (err) {
      await proxy?.close();
      throw err;
    }
  }

  async function hostLoginSummary(): Promise<string> {
    const h = await readHostClaudeAccount(claudeCredentialsPath);
    return h.loggedIn
      ? `banto 本体の Claude ログインを使う（契約：${h.subscriptionType ?? "不明"}。何も渡さなくてよい）`
      : `使えない：${h.reason}`;
  }

  return server;
}

/**
 * **人に聞く口が、いまは無い**——Module からの Elicitation は答えが banto に繋がっていない
 * （アーキ仕様 §2.4.1。受信箱に出ても答えられない）。答えを待って止まるより、**断って、断ったことを
 * 返り値に書く**（規則2）。ACP の `cancelled` は「ターンを取り消した」の意味なので使わず、
 * 断る選択肢を選ぶ
 */
async function refusePermission(question: PermissionQuestion): Promise<{ optionId: string } | "cancelled"> {
  const reject = question.options.find((o) => o.kind === "reject_once") ?? question.options.find((o) => o.kind.startsWith("reject"));
  return reject ? { optionId: reject.optionId } : "cancelled";
}

function text(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value) }] };
}

// **入口の判定は名前まで見る**——`settings-server.js` も同じ語尾なので、語尾だけだと取り違える
if (process.argv[1] && process.argv[1].endsWith("/server.js")) {
  const projectRoot = process.env.BANTO_PROJECT_ROOT;
  const hostUrl = process.env.BANTO_HOST_MCP_URL;
  const hostToken = process.env.BANTO_HOST_MCP_TOKEN;
  const moduleDataDir = process.env.BANTO_MODULE_DATA_DIR;
  const dataDir = process.env.BANTO_DATA_ROOT;
  if (!projectRoot || !hostUrl || !hostToken || !moduleDataDir || !dataDir) {
    console.error("BANTO_PROJECT_ROOT, BANTO_HOST_MCP_URL, BANTO_HOST_MCP_TOKEN, BANTO_MODULE_DATA_DIR, BANTO_DATA_ROOT が必要です");
    process.exit(1);
  }
  const server = createSubagentServer({
    projectRoot,
    moduleDataDir,
    relayClient: new HostRelayClient({ url: hostUrl, token: hostToken }),
    // 閉じ込めの最後の防波堤に、banto 自身の置き場を教える（host と同じ解決——規則3）
    guard: { dataDir, configDir: dirname(resolveBootstrapConfigPath()) },
    pathEntries: (process.env.PATH ?? "").split(":").filter(Boolean),
    // 試験は本物のログインを読まない（E2E が用意した偽物を指す）。ふだんは本体と同じ解決
    ...(process.env.BANTO_SUBAGENT_CLAUDE_CREDENTIALS
      ? { claudeLogin: { credentialsPath: process.env.BANTO_SUBAGENT_CLAUDE_CREDENTIALS } }
      : {}),
  });
  await server.connect(new StdioServerTransport());
}

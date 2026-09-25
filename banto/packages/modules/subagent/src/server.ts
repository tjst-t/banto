#!/usr/bin/env node
// Subagent Module（docs/specs/v4-architecture.md §4.1「Subagent Module の形」）。
// MCP サーバであり、ACP クライアント——Claude Code・OpenCode を ACP の同じ口で起こす。
// tool は2つ：`listSubagents`（一覧と、そのエージェントの設定の候補）と `runSubagent`（仕事を頼む）。
// 鍵の設定画面は banto 全体に1本の別 Module（`settings-server.ts`）が持つ——ここは Project ごとに立つので。

import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import {
  CANVAS_META_KEY,
  DELIVERS_LATER_META_KEY,
  MODULE_META_KEY,
  PENDING_REPLY_META_KEY,
  VISIBILITY_META_KEY,
  replyToOf,
} from "@banto/module-contract";
import { describeAgent, runSubagent, SubagentError, type AgentLaunch, type PermissionQuestion } from "./acp-run.js";
import { defaultAliasName, listAgents, usesStoredKeys, type AgentDefinition } from "./agents.js";
import { ClaudeLoginError } from "./claude-login-proxy.js";
import { prepareAgentLaunch } from "./agent-home.js";
import { relayClaudeLogin, type ClaudeLoginAccess, type OpenedClaudeProxy } from "./claude-login-access.js";
import { resolveStoredKeys, type StoredKeysRelay } from "./credentials.js";
import { HostRelayClient, type AliasPlace } from "./host-relay-client.js";
import { RUNS_APP_HTML, RUNS_APP_URI } from "./runs-app.js";
import { RunLog } from "./runs.js";

export interface SubagentServerDeps {
  projectRoot: string;
  /** この Module のデータ置き場（エージェントごとの専用ホームをこの下に持つ） */
  moduleDataDir: string;
  relayClient: StoredKeysRelay;
  agents?: AgentDefinition[];
  /**
   * **banto 本体の Claude ログインを使わせる口**（決定・2026-09-25）。中継は host の `subagent-settings` が持つ
   * （`claude-login-access.ts`）。試験は同じ中継をその場で立てる
   */
  claudeLogin: ClaudeLoginAccess;
  /**
   * **待たない形の仕事が終わったら、呼び出し元の Thread に届ける**（決定・2026-09-25、アーキ仕様 §4.1・§4.2）。
   * host の中継の `relayDeliverToThread`。無ければ待たない形は断る
   */
  deliver?: (input: { replyTo: string; title: string; text: string; final?: boolean }) => Promise<unknown>;
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

const UI_APP_MIME = "text/html;profile=mcp-app";

function agentIdsText(agents: AgentDefinition[]): string {
  return agents.map((a) => `${a.id}（${a.title}。資格情報の変数：${a.credentialEnv.join(" / ")}）`).join("、");
}

export function createSubagentServer(deps: SubagentServerDeps) {
  const agents = deps.agents ?? listAgents();
  // **頼んだ仕事の記録**——人が launcher の画面から一覧・状態・中身を見る（`runs.ts`）
  const runs = new RunLog(join(deps.moduleDataDir, "runs.jsonl"));
  const server = new Server({ name: "banto-module-subagent", version: "0.1.0" }, { capabilities: { tools: {}, resources: {} } });

  // **自分が何者かを名乗る**（host は宣言と突き合わせる）。AI には見せない（admin）。
  // **閉じ込めは Module ではなくエージェントに掛ける**（v4-security.md「サブエージェントは
  // 自分のドメインで起こす」）——Module 自身は AI の書いたコマンドを走らせない
  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: [
      {
        // **入口**（launcher）——Command Palette の「Module の入口」から、AI を介さずに開く
        uri: RUNS_APP_URI,
        name: "サブエージェント",
        description: "この Project でサブエージェントに頼んだ仕事と、その様子を見る",
        mimeType: UI_APP_MIME,
        _meta: { [VISIBILITY_META_KEY]: "admin", [CANVAS_META_KEY]: "launcher", ui: { prefersBorder: false } },
      },
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
              { role: "subagent-settings", required: true },
            ],
            isolation: "subprocess",
            scope: "project",
          },
        },
      },
    ],
  }));

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    if (request.params.uri !== RUNS_APP_URI) throw new Error(`unknown resource: ${request.params.uri}`);
    return { contents: [{ uri: RUNS_APP_URI, mimeType: UI_APP_MIME, text: RUNS_APP_HTML }] };
  });

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
          "自分の道具（シェル・ファイル操作）を使って働く——Project のコンテナの中で走り、Project root の外（人のホームなど）は見えない。" +
          "**資格情報は、ふつうは書かなくてよい**：Claude Code は banto 本体の Claude ログインをそのまま使い、" +
          "OpenCode は人が banto 全体の設定の「サブエージェント」で入れた鍵を使う（どれが使えるかは listSubagents）。" +
          "それ以外の鍵で走らせたいときだけ envSecrets に alias を渡す（使える alias の一覧は resource `vault://aliases`）。" +
          "続きを頼むときは、前の返り値の sessionId を渡す。" +
          "**長い仕事は runInBackground: true で待たずに頼める**——すぐ仕事の id が返り、終わったら結果がこの会話に届いて、" +
          "あなたが起こされる（届くまで他の仕事を続けてよい。結果を待つために同じ仕事を頼み直さない）。" +
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
            runInBackground: {
              type: "boolean",
              description: "true なら待たない。すぐ仕事の id を返し、終わったら結果がこの会話に届く（既定 false：終わるまで待つ）",
            },
          },
          required: ["agent", "prompt"],
        },
        // **待たない形の返事は、host が渡す返信用の札で届ける**（決定・2026-09-25、アーキ仕様 §4.2）
        _meta: { [VISIBILITY_META_KEY]: "agent", [DELIVERS_LATER_META_KEY]: true },
      },
      // ---- 人の入口の画面から呼ぶ（admin——AI には見せない） ----------------------------
      {
        name: "listAgents",
        description: "使えるエージェントと、資格情報の状態（本体のログイン・Vault に置いた鍵の有無。値は返さない）",
        inputSchema: { type: "object", properties: {} },
        _meta: { [VISIBILITY_META_KEY]: "admin" },
      },
      {
        name: "listRuns",
        description: "この Project で頼んだ仕事の一覧（走っているものが先）",
        inputSchema: { type: "object", properties: {} },
        _meta: { [VISIBILITY_META_KEY]: "admin" },
      },
      {
        name: "getRun",
        description: "頼んだ仕事1つの中身",
        inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
        _meta: { [VISIBILITY_META_KEY]: "admin" },
      },
      {
        name: "cancelRun",
        description: "走っている仕事を止める（エージェントに session/cancel を送る）",
        inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
        _meta: { [VISIBILITY_META_KEY]: "admin" },
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
          throw await launched.explain(err);
        } finally {
          await launched.cleanup();
        }
      }


      if (request.params.name === "listAgents") {
        // **人が入口の画面を開いたときに1回だけ**呼ぶ（取り直しの輪には入れない）。画面から呼ぶので、
        // 目録を引いても人を止めない（会話の中から引くと承認が出る——`credentials.ts`）
        let present: Set<string> | undefined;
        let keysError: string | undefined;
        if (agents.some(usesStoredKeys)) {
          try {
            present = new Set((await deps.relayClient.listAliases("vault-directory")).map((a) => a.name));
          } catch (err) {
            keysError = err instanceof Error ? err.message : String(err);
          }
        }
        return text({
          agents: await Promise.all(
            agents.map(async (a) =>
              a.sharesHostClaudeLogin
                ? { id: a.id, title: a.title, hostLogin: await deps.claudeLogin.status() }
                : {
                    id: a.id,
                    title: a.title,
                    keys: a.credentialEnv.filter((e) => present?.has(defaultAliasName(a.id, e))),
                    ...(keysError ? { keysError } : {}),
                  },
            ),
          ),
        });
      }
      if (request.params.name === "listRuns") return text({ runs: runs.list() });
      if (request.params.name === "getRun") {
        const record = runs.get(String(args.id));
        if (!record) throw new SubagentError(`仕事 "${String(args.id)}" はありません`);
        return text(record);
      }
      if (request.params.name === "cancelRun") {
        if (!runs.cancel(String(args.id))) throw new SubagentError("その仕事はもう走っていません");
        return text({ ok: true });
      }

      if (request.params.name === "runSubagent") {
        const agent = agentOf(args.agent);
        if (typeof args.prompt !== "string" || args.prompt.trim() === "") throw new SubagentError("prompt が空です");
        const prompt = args.prompt;
        // **待たない形**（決定・2026-09-25）：届ける先（host が渡した返信用の札）が無ければ断る——黙って待つ形に
        // 落とさない（規則2。AI は「届く」と思って待ち続けることになる）
        const background = args.runInBackground === true;
        const replyTo = replyToOf(request.params._meta as Record<string, unknown> | undefined);
        const deliver = deps.deliver;
        if (background && (!replyTo || !deliver)) {
          throw new SubagentError(
            "待たない形（runInBackground）では頼めません——終わったことを届ける先がありません" +
              "（banto がこの呼び出しに返信用の札を渡していない）。runInBackground を外して、待つ形で頼んでください",
          );
        }
        // **起こす前から記録する**——資格情報で止まったものも、一覧に「失敗」として残す
        const run = runs.start({
          agent: agent.id,
          agentTitle: agent.title,
          prompt,
          ...(typeof args.model === "string" ? { model: args.model } : {}),
          ...(typeof args.effort === "string" ? { effort: args.effort } : {}),
          ...(typeof args.sessionId === "string" ? { resumedFrom: args.sessionId } : {}),
        });
        const report = (message: string) => {
          runs.progress(run.id, message);
          // 待たない形では、返したあとの呼び出しに進捗は送れない（一覧には残る）
          if (!background) onProgress?.(message);
        };
        // **資格情報は呼び出しの中で用意する**——Vault の中継（と初回の承認）は「どの会話のための呼び出しか」が
        // 決まっている間しか通らない。待たない形でも、ここまでは待つ（背景に回すのはエージェントを走らせる部分だけ）
        let launched: Awaited<ReturnType<typeof launchFor>>;
        try {
          launched = await launchFor(agent, args.envSecrets, report);
        } catch (err) {
          runs.finish(run.id, { error: err instanceof Error ? err.message : String(err) });
          throw err;
        }
        const work = async () => {
          try {
            report(`${agent.title} を起こしています`);
            const result = await runSubagent(
              {
                prompt,
                ...(typeof args.model === "string" ? { model: args.model } : {}),
                ...(typeof args.effort === "string" ? { effort: args.effort } : {}),
                ...(typeof args.sessionId === "string" ? { sessionId: args.sessionId } : {}),
              },
              {
                launch: launched.launch,
                cwd: deps.projectRoot,
                ...(agent.mode ? { mode: agent.mode } : {}),
                // 人が入口の画面で「止める」を押したときも止まる。待つ形なら、依頼元が取り消したときも
                // ——待たない形は依頼元の呼び出しがもう終わっているので、それには縛らない
                signal: background ? run.signal : AbortSignal.any([extra.signal, run.signal]),
                onProgress: report,
                onToolCall: (title, kind) => runs.toolCall(run.id, title, kind),
                onText: (textSoFar) => runs.text(run.id, textSoFar),
                askPermission: refusePermission,
              },
            );
            const final = { ...result, notes: [...launched.notes, ...result.notes] };
            runs.finish(run.id, { result: final });
            return final;
          } catch (err) {
            throw await launched.explain(err);
          } finally {
            await launched.cleanup();
          }
        };

        if (!background) {
          try {
            return text(await work());
          } catch (err) {
            runs.finish(run.id, { error: err instanceof Error ? err.message : String(err) });
            throw err;
          }
        }

        // 待たない形：走らせたまま返す。終わったら（止められても・失敗しても）札で届ける
        void work()
          .then(
            (final) =>
              deliver!({
                replyTo: replyTo!,
                title:
                  final.stopReason === "cancelled"
                    ? `${agent.title} の仕事は止められました`
                    : `${agent.title} の仕事が終わりました`,
                text: JSON.stringify({ runId: run.id, ...final }),
              }),
            (err: unknown) => {
              const message = err instanceof Error ? err.message : String(err);
              runs.finish(run.id, { error: message });
              return deliver!({
                replyTo: replyTo!,
                title: `${agent.title} の仕事が失敗しました`,
                text: JSON.stringify({ runId: run.id, error: message }),
              });
            },
          )
          .catch((err: unknown) => {
            // 届けられなかった——host が落ちている等。札は返事待ちなので、host が起きたら「途中で終わりました」になる
            console.error(`[subagent] 仕事 ${run.id} の結果を届けられませんでした:`, err);
          });
        return {
          ...text({
            runId: run.id,
            status: "running",
            note: "待たずに頼みました。終わったら結果がこの会話に届き、あなたが起こされます。それまで他の仕事を続けてよい",
          }),
          // **あとで届けると約束した**——host は札を返事待ちにし、この Module が止まったら代わりに知らせる
          _meta: { [PENDING_REPLY_META_KEY]: true },
        };
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

  /** 資格情報を Vault から受け取り（Claude は本体のログインを中継で渡し）、専用ホームに向けた起こし方を作る */
  async function launchFor(
    agent: AgentDefinition,
    envSecrets: unknown,
    onProgress?: (message: string) => void,
  ): Promise<{ launch: AgentLaunch; notes: string[]; cleanup: () => Promise<void>; explain: (err: unknown) => Promise<unknown> }> {
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
    // 渡さず、中継の合言葉だけを渡す。中継は host の `subagent-settings` が開く（決定・2026-09-25——本体の
    // ログインはコンテナの中に無い）。自分の資格情報を envSecrets で渡されたときは、そちらを使う
    let proxy: OpenedClaudeProxy | undefined;
    if (agent.sharesHostClaudeLogin && !agent.credentialEnv.some((name) => name in secrets)) {
      onProgress?.("banto 本体の Claude ログインの中継を開いています");
      proxy = await deps.claudeLogin.open();
      env.CLAUDE_CODE_OAUTH_TOKEN = proxy.secret;
      env.ANTHROPIC_BASE_URL = proxy.url;
      // **既定を本体と揃える**（決定・2026-09-24、ユーザー）。env のトークンのとき、CLI は契約の種類を
      // ここから読む（トークンではない）。無いと既定が Sonnet・文脈20万になった（実測）
      if (proxy.subscriptionType) env.CLAUDE_CODE_SUBSCRIPTION_TYPE = proxy.subscriptionType;
      if (proxy.rateLimitTier) env.CLAUDE_CODE_RATE_LIMIT_TIER = proxy.rateLimitTier;
    }

    try {
      const shape = prepareAgentLaunch(agent, deps.projectRoot, join(deps.moduleDataDir, "agents", agent.id, "home"));
      return {
        launch: { command: shape.command, args: shape.args, env: { ...env, ...shape.env } },
        notes: stored.notes,
        cleanup: async () => {
          await proxy?.close();
        },
        explain: async (err) => {
          // **期限切れを、理由つきで返す**——本体のトークンは本体の CLI が更新する。サブエージェントが
          // 長く走ると途中で切れることがあり、そのときは続きから頼み直せば、本体が更新したものを中継が拾う
          const failures = proxy ? (await proxy.close()).upstreamAuthFailures : 0;
          if (failures > 0 && err instanceof Error) {
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
    const h = await deps.claudeLogin.status();
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
  if (!projectRoot || !hostUrl || !hostToken || !moduleDataDir) {
    console.error("BANTO_PROJECT_ROOT, BANTO_HOST_MCP_URL, BANTO_HOST_MCP_TOKEN, BANTO_MODULE_DATA_DIR が必要です");
    process.exit(1);
  }
  const relayClient = new HostRelayClient({ url: hostUrl, token: hostToken });
  const server = createSubagentServer({
    projectRoot,
    moduleDataDir,
    relayClient,
    // 中継はコンテナから届く host 側のアドレスで開いてもらう（host が渡す。コンテナの外なら 127.0.0.1）
    claudeLogin: relayClaudeLogin(relayClient, process.env.BANTO_HOST_ADDRESS ?? "127.0.0.1"),
    deliver: (input) => relayClient.deliverToThread(input),
  });
  await server.connect(new StdioServerTransport());
}

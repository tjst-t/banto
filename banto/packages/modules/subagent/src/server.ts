#!/usr/bin/env node
// Subagent Module（docs/specs/v4-architecture.md §4.1「Subagent Module の形」）。
// MCP サーバであり、ACP クライアント——Claude Code・OpenCode を ACP の同じ口で起こす。
// AI の tool は3つ：`listSubagents`（一覧と、そのエージェントの設定の候補）と `runSubagent`（仕事を頼む）と
// `cancelSubagent`（頼んだ仕事を止める。頼んだ Thread からだけ）。
// 鍵の設定画面は banto 全体に1本の別 Module（`settings-server.ts`）が持つ——ここは Project ごとに立つので。

import { realpathSync, rmSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
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
  CARD_META_KEY,
  DELIVERS_LATER_META_KEY,
  MODULE_META_KEY,
  PENDING_REPLY_META_KEY,
  VISIBILITY_META_KEY,
  replyToOf,
  replyToFingerprint,
  parseResumeQuestion,
  isHostResumeCall,
  RESUME_AFTER_RESTART_TOOL,
  threadOf,
  callerModuleOf,
  type ResumeAnswer,
} from "@banto/module-contract";
import {
  describeAgent,
  runSubagent,
  SessionLoadError,
  SubagentError,
  type AgentLaunch,
  type PermissionQuestion,
  type RunDeps,
  type RunResult,
} from "./acp-run.js";
import { defaultAliasName, listAgents, usesStoredKeys, type AgentDefinition } from "./agents.js";
import { prepareAgentLaunch } from "./agent-home.js";
import { resolveStoredKeys, type StoredKeysRelay } from "./credentials.js";
import { HostRelayClient, type AliasPlace } from "./host-relay-client.js";
import { RUNS_APP_HTML, RUNS_APP_URI } from "./runs-app.js";
import { RunLog } from "./runs.js";
import { promptHeadOf, RunningStore, type RunningRecord } from "./running.js";
import { stopOwnedGroup } from "./process-group.js";
import { compileSchema, extractJson, fixPrompt, schemaInstruction, STRUCTURED_RETRIES, type CompiledSchema } from "./structured.js";

export interface SubagentServerDeps {
  projectRoot: string;
  /** この Module のデータ置き場（エージェントごとの専用ホームをこの下に持つ） */
  moduleDataDir: string;
  relayClient: StoredKeysRelay;
  agents?: AgentDefinition[];
  /**
   * **banto 本体の Claude ログイン**（core に常設の中継、決定・2026-09-27、`docs/specs/v4-security.md` §2）。core が
   * Project のコンテナの環境に住所とその Project の合言葉を入れておくので、ここから写すだけ。既定はこのプロセスの環境
   */
  claudeLoginEnv?: NodeJS.ProcessEnv;
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
/**
 * **Claude のログインの中継の変数**（core がコンテナの環境に入れる）。本体のログインを使うエージェントにだけ渡す
 * ——自分の資格情報を envSecrets で渡されたときは渡さない（住所が中継のままだと、その資格情報が中継で断られる）
 */
const CLAUDE_LOGIN_ENV = ["ANTHROPIC_BASE_URL", "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CODE_SUBSCRIPTION_TYPE", "CLAUDE_CODE_RATE_LIMIT_TIER"];

/** 本体のログインを使えるか（値は返さない）。core が環境に入れていなければ、理由を返す */
export type HostLoginStatus = { loggedIn: true; subscriptionType?: string } | { loggedIn: false; reason: string };
export function hostLoginStatusOf(env: NodeJS.ProcessEnv): HostLoginStatus {
  if (!env.ANTHROPIC_BASE_URL || !env.CLAUDE_CODE_OAUTH_TOKEN) {
    return {
      loggedIn: false,
      reason:
        "この Project では banto 本体の Claude ログインを使えません（Project 設定の「Claude のログイン」がオフか、" +
        "この Module がコンテナの外で起きています。オンにしたら、この Module が次に起きたときから使えます）",
    };
  }
  return { loggedIn: true, ...(env.CLAUDE_CODE_SUBSCRIPTION_TYPE ? { subscriptionType: env.CLAUDE_CODE_SUBSCRIPTION_TYPE } : {}) };
}

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
  const claudeLoginEnv = deps.claudeLoginEnv ?? process.env;
  // **頼んだ仕事の記録**——人が launcher の画面から一覧・状態・中身を見る（`runs.ts`）
  const runs = new RunLog(join(deps.moduleDataDir, "runs.jsonl"));
  // **走っている仕事の記録**（追加・2026-10-05、アーキ仕様 §2.5「2.」）——待たない形の仕事を、走っている間ファイルに残す。
  // 起動したときに残っているものは前の走行で切れた仕事で、起き直した host に問われたら続ける（`resumeAfterRestart`）
  const running = new RunningStore(deps.moduleDataDir);
  const interrupted = new Map(running.list().map((r) => [r.replyToFingerprint, r] as const));
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
            ],
            isolation: "subprocess",
            scope: "project",
            // 待たない形で頼まれた仕事は、banto を起こし直しても続けられる（§2.5「2.」）——終わりは必ず札で届ける
            resumesAfterRestart: true,
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
            cwd: {
              type: "string",
              description:
                "作業する場所（Project root の中のフォルダ。相対なら Project root から。省略時は Project root）。worktree で働かせるときに使う",
            },
            schema: {
              type: "object",
              description:
                "決まった形で返させるときの JSON Schema。最後の返答をこの形の JSON にさせ、合わなければ同じ会話で直させる" +
                `（${STRUCTURED_RETRIES} 回まで）。合った値は返り値の structured に入る`,
            },
            envSecrets: ENV_SECRETS_SCHEMA,
            runInBackground: {
              type: "boolean",
              description: "true なら待たない。すぐ仕事の id を返し、終わったら結果がこの会話に届く（既定 false：終わるまで待つ）",
            },
          },
          required: ["agent", "prompt"],
        },
        // **待たない形の返事は、host が渡す返信用の札で届ける**（決定・2026-09-25、アーキ仕様 §4.2）
        //
        // **会話にはカードを残し、押せば入口の画面でその仕事を開く**（決定・2026-10-01、ユーザー）——Fork と同じ形。
        // 画面は会話に埋めない（カードだけ）。待つ形も待たない形も、呼んだその時点から出る
        _meta: {
          [VISIBILITY_META_KEY]: "agent",
          [DELIVERS_LATER_META_KEY]: true,
          ui: { resourceUri: RUNS_APP_URI },
          [CARD_META_KEY]: { title: "{agent} に頼んだ仕事", description: "{prompt}" },
        },
      },
      {
        // **AI が自分で頼んだ仕事を止める口**（追加・2026-10-03、ユーザー）。**頼んだ Thread からだけ**止められる——
        // 同じ Project の別の Thread（Fork）が頼んだ仕事を、id を知っただけで止められないように。どの Thread からの
        // 呼び出しかは host が刻む印（`dev.banto/thread`）で見る（AI の申告ではない）
        name: "cancelSubagent",
        description:
          "runSubagent で頼んだ仕事を止める（runInBackground で頼んだものが主な対象）。runId は runSubagent の返り値のもの。" +
          "**止められるのは、この会話（Thread）で頼んだ仕事だけ**——別の Thread が頼んだものは断る。" +
          "止めると、待たない形の仕事は「止められました」がこの会話に届く。走っていない（もう終わった）仕事は止められない",
        inputSchema: {
          type: "object",
          properties: { runId: { type: "string", description: "止める仕事の id（runSubagent の返り値の runId）" } },
          required: ["runId"],
        },
        _meta: { [VISIBILITY_META_KEY]: "agent" },
      },
      // ---- host が起き直したときに呼ぶ（admin——AI には見せない） ----------------------------
      {
        // **起こし直しても続けられる**（追加・2026-10-05、アーキ仕様 §2.5「2. Module の仕事を続ける」、`@banto/module-contract`
        // の `resume.ts`）。host が、この Module に「あとで届ける」と約束したまま終わっていない仕事を渡す。走っている仕事の
        // 記録があるものは「続ける」と答えて続け、終わりは必ず札で届ける（成功も失敗も）
        name: RESUME_AFTER_RESTART_TOOL,
        description: "banto を起こし直したあと、途中で切れた待たない形の仕事を続けるかを答える（host だけが呼ぶ）",
        inputSchema: {
          type: "object",
          properties: {
            items: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  replyTo: { type: "string" },
                  toolName: { type: "string" },
                  toolCallId: { type: "string" },
                  thread: { type: "object", properties: { projectId: { type: "string" }, threadId: { type: "string" } } },
                },
                required: ["replyTo", "thread"],
              },
            },
          },
          required: ["items"],
        },
        _meta: { [VISIBILITY_META_KEY]: "admin" },
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
        description: "この Project で頼んだ仕事の一覧（走っているものは全部、終わったものは新しい順に limit 件まで。既定 10）",
        inputSchema: { type: "object", properties: { limit: { type: "number" } } },
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
                  ? hostLoginSummary()
                  : "人が banto 全体の設定の「サブエージェント」で入れた鍵を使う（入っていなければ envSecrets で渡す）",
                credentialEnv: a.credentialEnv,
              })),
            ),
          );
        }
        const agent = agentOf(args.agent);
        const launched = await launchFor(agent, args.envSecrets, onProgress);
        return text(await describeAgent(launched.launch, deps.projectRoot));
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
                ? { id: a.id, title: a.title, hostLogin: hostLoginStatusOf(claudeLoginEnv) }
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
      if (request.params.name === RESUME_AFTER_RESTART_TOOL) {
        // **host だけが問う**（追加・2026-10-05、Fable のレビュー）。人の画面・中継・AI のターンからの呼び出しには呼び元の印が
        // 付く——付いていたら断る（記録には触らない）
        if (!isHostResumeCall(request.params._meta as Record<string, unknown> | undefined)) {
          throw new SubagentError(`${RESUME_AFTER_RESTART_TOOL} は banto 本体だけが呼べます`);
        }
        const question = parseResumeQuestion(args);
        const answers: ResumeAnswer[] = question.items.map((item) => {
          const record = interrupted.get(replyToFingerprint(item.replyTo));
          const no = (reason: string): ResumeAnswer => ({ replyTo: item.replyTo, resume: false, reason });
          if (!record) return no("走っている仕事の記録がありません（待つ形で頼んだ仕事か、記録の前に切れた）");
          interrupted.delete(record.replyToFingerprint);
          if (!deps.deliver) {
            abandon(record);
            return no("この Subagent には届ける口がありません");
          }
          // 頼んだ相手が記録と合うか：AI のターン（Thread）から頼んだ仕事は同じ Thread、Module が中継で頼んだ仕事は
          // 呼び元の Module として問われる（Thread の印が無い）
          const mismatch = item.thread
            ? !record.requestedBy
              ? "記録は Module が中継で頼んだ仕事ですが、Thread の仕事として問われました"
              : record.requestedBy.threadId !== item.thread.threadId
                ? "記録の頼んだ Thread と、問われた Thread が違います"
                : undefined
            : record.requestedBy
              ? "記録は Thread から頼まれた仕事ですが、Module の仕事として問われました"
              : undefined;
          if (mismatch) {
            abandon(record);
            return no(mismatch);
          }
          if (!agents.some((a) => a.id === record.agent)) {
            abandon(record);
            return no(`エージェント "${record.agent}" はもうありません`);
          }
          // 答えを返してから続ける（host は答えを待っている。終わりは札で届く）。**host が問いを取り消したら続けない**
          // ——期限を過ぎた問いで、host はもう「途中で終わりました」を届けている（続けても結果は誰にも届かない）
          setImmediate(() => {
            if (extra.signal.aborted) {
              console.error(`[subagent] 仕事 ${record.id}：host が問いを取り消したので続けません`);
              abandon(record);
              return;
            }
            void resumeRun(record, item.replyTo);
          });
          return { replyTo: item.replyTo, resume: true };
        });
        // **問われなかった記録は片づける**——host はもうその札を待っていない（「途中で終わりました」を届けた）。host は
        // Thread 宛ての札も Module 宛ての札（Module が中継で頼んだ仕事）も同じ問いで渡す
        for (const record of interrupted.values()) {
          abandon(record);
          const run = runs.start({ ...runInputOf(record), continues: { id: record.id, startedAt: record.startedAt, notes: [] } });
          runs.finish(run.id, { error: "banto を起こし直したため途中で終わりました（host が続けるかを問いませんでした）" });
        }
        interrupted.clear();
        return text({ answers });
      }
      if (request.params.name === "listRuns") {
        const limit = typeof args.limit === "number" && args.limit > 0 ? Math.floor(args.limit) : undefined;
        return text(runs.page(limit));
      }
      if (request.params.name === "getRun") {
        const record = runs.get(String(args.id));
        if (!record) throw new SubagentError(`仕事 "${String(args.id)}" はありません`);
        return text(record);
      }
      if (request.params.name === "cancelRun") {
        if (!runs.cancel(String(args.id))) throw new SubagentError("その仕事はもう走っていません");
        return text({ ok: true });
      }

      if (request.params.name === "cancelSubagent") {
        const id = String(args.runId ?? "");
        const record = runs.get(id);
        if (!record) throw new SubagentError(`仕事 "${id}" はありません`);
        // **Module が中継で頼んだ仕事は、頼んだ Module（接続名）からだけ止められる**（追加・2026-10-06、Factory）。印は host が刻む
        const callerModule = callerModuleOf(request.params._meta as Record<string, unknown> | undefined);
        if (callerModule) {
          if (!record.requestedByModule || record.requestedByModule.conn !== callerModule.conn) {
            throw new SubagentError(
              record.requestedByModule
                ? "この仕事は別の Module が頼んだものなので、ここからは止められません。止められるのは、この Module が頼んだ仕事だけです"
                : "この仕事は Module が頼んだものではないので、Module からは止められません",
            );
          }
          if (!runs.cancel(id)) throw new SubagentError(`その仕事はもう走っていません（状態：${record.status}）`);
          return text({ ok: true, runId: id, note: "止めました。待たない形で頼んだものは、止まったことが頼んだ Module に届きます" });
        }
        // **頼んだ Thread と呼び出し元の Thread が同じときだけ**。どちらかの印が無ければ確かめられないので断る（fail closed）
        const caller = threadOf(request.params._meta as Record<string, unknown> | undefined);
        if (!caller) {
          throw new SubagentError("どの会話からの呼び出しか分からないため止められません（banto がこの呼び出しに Thread の印を付けていない）");
        }
        const owner = record.requestedBy;
        if (!owner) {
          throw new SubagentError("この仕事は、どの会話が頼んだかの記録が無いため、AI からは止められません。人がサブエージェントの画面から止めてください");
        }
        if (owner.projectId !== caller.projectId || owner.threadId !== caller.threadId) {
          throw new SubagentError("この仕事は別の会話（Thread）が頼んだものなので、ここからは止められません。止められるのは、この会話で頼んだ仕事だけです");
        }
        if (!runs.cancel(id)) throw new SubagentError(`その仕事はもう走っていません（状態：${record.status}）`);
        return text({ ok: true, runId: id, note: "止めました。待たない形で頼んだものは、止まったことがこの会話に届きます" });
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
        // **起こす前から記録する**——資格情報で止まったものも、一覧に「失敗」として残す。
        // 頼んだ Thread も残す（host の刻印。AI が止める口 `cancelSubagent` はこれで持ち主を確かめる）
        const requestedBy = threadOf(request.params._meta as Record<string, unknown> | undefined);
        // 中継で頼んだ Module（host の刻印）。止める口が持ち主を確かめる
        const requestedByModule = callerModuleOf(request.params._meta as Record<string, unknown> | undefined);
        // **作業場所と形は、起こす前に確かめる**（間違いはエージェントを起こさずに断る）
        const cwd = resolveCwd(args.cwd);
        const compiled = args.schema === undefined ? undefined : compileOrRefuse(args.schema);
        const run = runs.start({
          ...(requestedBy ? { requestedBy } : {}),
          ...(requestedByModule ? { requestedByModule } : {}),
          ...(cwd !== deps.projectRoot ? { cwd } : {}),
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
        // **待たない形は、走っている間ファイルに残す**（§2.5「2.」）——起こし直したあと続けるため。資格情報は書かない
        // （envSecrets は alias の名前）、札は指紋だけ
        if (background) {
          running.write({
            id: run.id,
            agent: agent.id,
            agentTitle: agent.title,
            cwd,
            ...(compiled ? { schema: compiled.schema } : {}),
            ...(requestedByModule ? { requestedByModule } : {}),
            ...(typeof args.model === "string" ? { model: args.model } : {}),
            ...(typeof args.effort === "string" ? { effort: args.effort } : {}),
            ...(aliasNamesOf(args.envSecrets) ? { envSecrets: aliasNamesOf(args.envSecrets)! } : {}),
            replyToFingerprint: replyToFingerprint(replyTo!),
            ...(requestedBy ? { requestedBy } : {}),
            prompt,
            promptHead: promptHeadOf(prompt),
            ...(typeof args.sessionId === "string" ? { resumedFrom: args.sessionId, sessionId: args.sessionId } : {}),
            startedAt: Date.now(),
            progressed: false,
            toolsInFlight: [],
            resumes: 0,
          });
        }
        // 期限切れ（上流の 401）は core の中継が受信箱に知らせる——ここでは推測しない
        const work = async () => {
          report(`${agent.title} を起こしています`);
          const result = await runStructured(
            {
              prompt,
              ...(typeof args.model === "string" ? { model: args.model } : {}),
              ...(typeof args.effort === "string" ? { effort: args.effort } : {}),
              ...(typeof args.sessionId === "string" ? { sessionId: args.sessionId } : {}),
            },
            agentRunDeps(run.id, launched.launch, agent, {
              // 人が入口の画面で「止める」を押したときも止まる。待つ形なら、依頼元が取り消したときも
              // ——待たない形は依頼元の呼び出しがもう終わっているので、それには縛らない
              signal: background ? run.signal : AbortSignal.any([extra.signal, run.signal]),
              onProgress: report,
              recordRunning: background,
              cwd,
            }),
            compiled,
            report,
          );
          const final = { ...result, notes: [...launched.notes, ...result.notes] };
          runs.finish(run.id, { result: final });
          return final;
        };

        if (!background) {
          try {
            // 仕事の id も添える——会話のカードから開いた画面が、どの仕事かを引き当てる
            return text({ runId: run.id, ...(await work()) });
          } catch (err) {
            runs.finish(run.id, { error: err instanceof Error ? err.message : String(err) });
            throw err;
          }
        }

        // 待たない形：走らせたまま返す。終わったら（止められても・失敗しても）札で届ける
        void work().then(
          (final) => deliverEnd(run.id, replyTo!, endTitle(agent.title, final), JSON.stringify({ runId: run.id, ...final })),
          (err: unknown) => {
            const message = err instanceof Error ? err.message : String(err);
            runs.finish(run.id, { error: message });
            return deliverEnd(run.id, replyTo!, `${agent.title} の仕事が失敗しました`, JSON.stringify({ runId: run.id, error: message }));
          },
        );
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
      if (err instanceof SubagentError) {
        return { content: [{ type: "text", text: err.message }], isError: true };
      }
      throw err;
    }
    throw new Error(`unknown tool: ${request.params.name}`);
  });

  /**
   * エージェントを1回走らせるときの口（頼まれた仕事と、起こし直しのあと続ける仕事で同じ）。待たない形なら、会話の id・
   * 呼んだ tool・進んだかを走っている仕事の記録にも書く
   */
  function agentRunDeps(
    runId: string,
    launch: AgentLaunch,
    agent: AgentDefinition,
    opts: { signal: AbortSignal; onProgress: (message: string) => void; recordRunning: boolean; cwd: string },
  ): RunDeps {
    const record = (change: (r: RunningRecord) => void) => {
      if (opts.recordRunning) running.update(runId, change);
    };
    let progressed = false;
    const markProgressed = () => {
      if (progressed) return;
      progressed = true;
      record((r) => void (r.progressed = true));
    };
    return {
      launch,
      cwd: opts.cwd,
      ...(agent.mode ? { mode: agent.mode } : {}),
      signal: opts.signal,
      onProgress: opts.onProgress,
      onSession: (sessionId) => record((r) => void (r.sessionId = sessionId)),
      onSpawn: (agentProcess) => record((r) => void (r.agentProcess = agentProcess)),
      onToolCall: (title, kind, toolCallId) => {
        runs.toolCall(runId, title, kind);
        progressed = true;
        record((r) => {
          r.progressed = true;
          r.toolsInFlight.push({ ...(toolCallId ? { id: toolCallId } : {}), title });
        });
      },
      onToolDone: (toolCallId) => record((r) => void (r.toolsInFlight = r.toolsInFlight.filter((t) => t.id !== toolCallId))),
      onText: (textSoFar) => {
        runs.text(runId, textSoFar);
        markProgressed();
      },
      askPermission: refusePermission,
    };
  }

  /** **続けない仕事の後片づけ**：記録を消し、前の走行のエージェントが残っていれば止める（答えは待たせない） */
  function abandon(record: RunningRecord): void {
    running.remove(record.id);
    if (record.agentProcess) {
      void stopOwnedGroup(record.agentProcess).then((stopped) => {
        if (!stopped) console.error(`[subagent] 続けない仕事 ${record.id} のエージェント（pid ${record.agentProcess!.pid}）が止まりません`);
      });
    }
  }

  /**
   * **終わりを札で届ける**（待たない形）。届いたら走っている仕事の記録を消す。**届けられなければ記録に結果を残す**
   * ——host が落ちていた等。起き直した host に問われたら、走らせ直さずにそれを届ける（§2.5「2.」）
   */
  async function deliverEnd(runId: string, replyTo: string, title: string, body: string): Promise<void> {
    try {
      await deps.deliver!({ replyTo, title, text: body });
      running.remove(runId);
    } catch (err) {
      console.error(`[subagent] 仕事 ${runId} の結果を届けられませんでした（記録に残し、起こし直したあと届け直します）:`, err);
      running.update(runId, (r) => void (r.finished = { title, text: body }));
    }
  }

  /**
   * **起こし直しのあと続ける**（§2.5「2.」）。続けると答えた仕事なので、**終わりは必ず札で届ける**（成功も失敗も）。
   *   - 結果はもう出ていて届ける前に止まった → それを届ける
   *   - 会話の id があれば `session/load` して「途中で切れました。実行中だった tool：…」を送る（claude-agent-acp は
   *     切れた tool を黙って落とすので、ここで書く）
   *   - 会話の id が無い・load できず、まだ何も進んでいなかった（最初の頼みが記録される前に切れた）→ 同じ頼みで最初から
   */
  async function resumeRun(record: RunningRecord, replyTo: string): Promise<void> {
    const agent = agents.find((a) => a.id === record.agent)!;
    // **前の走行のエージェントが残っていれば、先に止める**（実測：Module が止まってもエージェントと子はコンテナの中で
    // 走り続ける）。止まったのを確かめてから続ける——同じ会話を2本が書かない。止まらなければ続けずに失敗を届ける
    if (record.agentProcess && !(await stopOwnedGroup(record.agentProcess))) {
      const message = `前の走行のエージェント（pid ${record.agentProcess.pid}）が止まらないので、続けられませんでした`;
      await deliverEnd(record.id, replyTo, `${agent.title} の仕事が失敗しました`, JSON.stringify({ runId: record.id, resumedAfterRestart: true, error: message }));
      return;
    }
    if (record.finished) {
      await deliverEnd(record.id, replyTo, record.finished.title, record.finished.text);
      return;
    }
    const note = `banto を起こし直したため途中で切れ、続きから再開しました（${record.resumes + 1} 回目）`;
    running.update(record.id, (r) => void (r.resumes += 1));
    const run = runs.start({ ...runInputOf(record), continues: { id: record.id, startedAt: record.startedAt, notes: [note] } });
    const report = (message: string) => runs.progress(run.id, message);
    const fail = (message: string) => {
      runs.finish(run.id, { error: message });
      return deliverEnd(record.id, replyTo, `${agent.title} の仕事が失敗しました`, JSON.stringify({ runId: record.id, resumedAfterRestart: true, error: message }));
    };
    let launched: Awaited<ReturnType<typeof launchFor>>;
    try {
      launched = await launchFor(agent, record.envSecrets, report);
    } catch (err) {
      await fail(`起こし直したあと、資格情報を受け取れませんでした: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    const notes = [...launched.notes, note];
    const runDeps = agentRunDeps(record.id, launched.launch, agent, {
      signal: run.signal,
      onProgress: report,
      recordRunning: true,
      cwd: record.cwd,
    });
    const compiled = record.schema ? compileOrRefuse(record.schema) : undefined;
    const options = { ...(record.model ? { model: record.model } : {}), ...(record.effort ? { effort: record.effort } : {}) };
    try {
      let result: RunResult | undefined;
      if (record.sessionId !== undefined) {
        report(`${agent.title} の会話を続きから開いています`);
        try {
          result = await runStructured({ prompt: resumePromptOf(record), sessionId: record.sessionId, ...options }, runDeps, compiled, report, {
            alreadyInstructed: true,
          });
        } catch (err) {
          // 最初の頼みが記録される前に切れた（まだ何もしていない）なら、同じ頼みで最初から。進んでいたなら失敗として届ける
          if (!(err instanceof SessionLoadError) || record.progressed || record.resumedFrom !== undefined) throw err;
          notes.push(`会話を続きから開けなかったので（${err.message}）、同じ頼みで最初からやり直しました`);
        }
      } else {
        notes.push("会話が始まる前に切れていたので、同じ頼みで最初からやり直しました");
      }
      if (!result) {
        running.update(record.id, (r) => {
          delete r.sessionId;
          r.toolsInFlight = [];
        });
        report(`${agent.title} を起こしています`);
        result = await runStructured({ prompt: record.prompt, ...options }, runDeps, compiled, report);
      }
      const final = { ...result, notes: [...notes, ...result.notes] };
      runs.finish(run.id, { result: final });
      await deliverEnd(record.id, replyTo, endTitle(agent.title, final), JSON.stringify({ runId: record.id, resumedAfterRestart: true, ...final }));
    } catch (err) {
      await fail(err instanceof Error ? err.message : String(err));
    }
  }

  /**
   * **作業場所を決める**（追加・2026-10-06、Factory が worktree で働かせる）。Project の根の中のフォルダだけ（実体で比べる
   * ——シンボリックリンクで外へ出させない）。省けば根
   */
  function resolveCwd(raw: unknown): string {
    if (raw === undefined) return deps.projectRoot;
    if (typeof raw !== "string" || raw.trim() === "") throw new SubagentError("cwd は文字列で渡してください");
    const root = realpathSync(deps.projectRoot);
    const wanted = isAbsolute(raw) ? raw : resolve(deps.projectRoot, raw);
    let real: string;
    try {
      real = realpathSync(wanted);
    } catch {
      throw new SubagentError(`作業場所 ${raw} がありません`);
    }
    const rel = relative(root, real);
    if (rel.startsWith("..") || isAbsolute(rel)) {
      throw new SubagentError(`作業場所 ${raw} は Project root（${deps.projectRoot}）の外です。Project root の中のフォルダだけ選べます`);
    }
    if (!statSync(real).isDirectory()) throw new SubagentError(`作業場所 ${raw} はフォルダではありません`);
    return real;
  }

  function compileOrRefuse(raw: unknown): CompiledSchema {
    try {
      return compileSchema(raw);
    } catch (err) {
      throw new SubagentError(err instanceof Error ? err.message : String(err));
    }
  }

  /**
   * **1回走らせ、形が決まっていれば合うまで同じ会話で直させる**（追加・2026-10-06、`structured.ts`）。合った値は
   * `structured` に入れる。止められた・上限を越えた・合わないまま終わったら、そのとおり返す（合わないまま越えたら失敗）
   */
  async function runStructured(
    input: { prompt: string; model?: string; effort?: string; sessionId?: string },
    runDeps: RunDeps,
    compiled: CompiledSchema | undefined,
    report: (message: string) => void,
    opts: { alreadyInstructed?: boolean } = {},
  ): Promise<RunResult & { structured?: unknown }> {
    if (!compiled) return runSubagent(input, runDeps);
    const options = { ...(input.model ? { model: input.model } : {}), ...(input.effort ? { effort: input.effort } : {}) };
    let result = await runSubagent(
      { ...input, prompt: opts.alreadyInstructed ? input.prompt : input.prompt + schemaInstruction(compiled.schema) },
      runDeps,
    );
    const toolCalls = [...result.toolCalls];
    const notes: string[] = [];
    for (let attempt = 0; ; attempt++) {
      if (result.stopReason !== "end_turn") return { ...result, toolCalls, notes: [...notes, ...result.notes] };
      const found = extractJson(result.text);
      const problem = found === undefined ? "JSON が見つかりません" : compiled.check(found.value);
      if (problem === undefined) return { ...result, toolCalls, notes: [...notes, ...result.notes], structured: found!.value };
      if (attempt >= STRUCTURED_RETRIES) {
        throw new SubagentError(
          `決まった形の返答になりませんでした（${STRUCTURED_RETRIES} 回直させても合わない）：${problem}。最後の返答の頭：${result.text.slice(0, 200)}`,
        );
      }
      notes.push(`返答が決まった形に合わなかったので直させました（${attempt + 1} 回目）：${problem}`);
      report(`返答を決まった形に直させています（${attempt + 1} 回目）`);
      result = await runSubagent({ prompt: fixPrompt(problem, compiled.schema), sessionId: result.sessionId, ...options }, runDeps);
      toolCalls.push(...result.toolCalls);
    }
  }

  /** 資格情報を Vault から受け取り（Claude は本体のログインの中継の変数を写し）、専用ホームに向けた起こし方を作る */
  async function launchFor(
    agent: AgentDefinition,
    envSecrets: unknown,
    onProgress?: (message: string) => void,
  ): Promise<{ launch: AgentLaunch; notes: string[] }> {
    const env: NodeJS.ProcessEnv = {};
    for (const name of PASS_THROUGH_ENV) if (process.env[name] !== undefined) env[name] = process.env[name];

    const secrets = (envSecrets ?? {}) as Record<string, unknown>;
    // **Claude は banto 本体のログインを共有する**（決定・2026-09-24、ユーザー）。本物のトークンは渡さず、core が
    // コンテナの環境に入れた中継の住所と合言葉を写す（決定・2026-09-27——中継は core に常設）。自分の資格情報を
    // envSecrets で渡されたときは、そちらを使う
    if (agent.sharesHostClaudeLogin && !agent.credentialEnv.some((name) => name in secrets)) {
      const status = hostLoginStatusOf(claudeLoginEnv);
      if (!status.loggedIn) throw new SubagentError(status.reason);
      // **既定を本体と揃える**（決定・2026-09-24、ユーザー）。契約の種類（トークンではない）も一緒に渡る——
      // 無いと既定が Sonnet・文脈20万になった（実測）
      for (const name of CLAUDE_LOGIN_ENV) if (claudeLoginEnv[name] !== undefined) env[name] = claudeLoginEnv[name];
    }
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

    const shape = prepareAgentLaunch(agent, deps.projectRoot, join(deps.moduleDataDir, "agents", agent.id, "home"));
    return { launch: { command: shape.command, args: shape.args, env: { ...env, ...shape.env } }, notes: stored.notes };
  }

  function hostLoginSummary(): string {
    const h = hostLoginStatusOf(claudeLoginEnv);
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

/** 終わりの題（止められた・終わった） */
function endTitle(agentTitle: string, final: Pick<RunResult, "stopReason">): string {
  return final.stopReason === "cancelled" ? `${agentTitle} の仕事は止められました` : `${agentTitle} の仕事が終わりました`;
}

/**
 * **起こし直しのあと送る文**（§2.5「2.」）。実行中だった tool は走っている仕事の記録の、終わりの来ていない最後の tool
 * ——claude-agent-acp は切れた tool を黙って落とすので、エージェントに任せず書く
 */
export function resumePromptOf(record: Pick<RunningRecord, "toolsInFlight">): string {
  const last = record.toolsInFlight.at(-1);
  return last
    ? `banto を起こし直したため、作業が途中で切れました。切れたとき実行中だった tool：${last.title}——結果は分かりません` +
        "（コマンドならまだ動いているかもしれません）。確かめてから続けてください"
    : "banto を起こし直したため、作業が途中で切れました。切れたとき実行中だった tool はありません。続けてください";
}

/** envSecrets の名前の対応（環境変数名 → alias 名）。文字列だけ——値ではない。無ければ undefined */
function aliasNamesOf(envSecrets: unknown): Record<string, string> | undefined {
  if (typeof envSecrets !== "object" || envSecrets === null) return undefined;
  const names = Object.fromEntries(Object.entries(envSecrets).filter((e): e is [string, string] => typeof e[1] === "string"));
  return Object.keys(names).length > 0 ? names : undefined;
}

/** 走っている仕事の記録から、仕事の記録（`runs.ts`）を始める形 */
function runInputOf(record: RunningRecord) {
  return {
    agent: record.agent,
    agentTitle: record.agentTitle,
    prompt: record.prompt,
    ...(record.model ? { model: record.model } : {}),
    ...(record.effort ? { effort: record.effort } : {}),
    ...(record.resumedFrom ? { resumedFrom: record.resumedFrom } : {}),
    ...(record.requestedBy ? { requestedBy: record.requestedBy } : {}),
    ...(record.requestedByModule ? { requestedByModule: record.requestedByModule } : {}),
    cwd: record.cwd,
  };
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
    deliver: (input) => relayClient.deliverToThread(input),
  });
  await server.connect(new StdioServerTransport());
}

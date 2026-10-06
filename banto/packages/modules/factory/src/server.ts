#!/usr/bin/env node
// Factory Module（docs/specs/v4-modules.md §4.5）——Backlog のタスクを手順どおりに main まで運ぶ。
// Project ごとにつき、Project のコンテナの中で動く。サブエージェントは Subagent に、タスクの読み書きは Backlog に、host の
// 中継で頼む。AI の tool は4本（runFactory・listFactoryRuns・answerFactory・cancelFactory）。

import { spawn } from "node:child_process";
import { join } from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import {
  CALL_ID_META_KEY,
  DELIVERS_LATER_META_KEY,
  MODULE_META_KEY,
  PENDING_REPLY_META_KEY,
  RECEIVES_REPLIES_META_KEY,
  RESUME_AFTER_RESTART_TOOL,
  VISIBILITY_META_KEY,
  callIdOf,
  isHostResumeCall,
  parseResumeQuestion,
  replyToFingerprint,
  replyToOf,
  threadOf,
  type ResumeAnswer,
} from "@banto/module-contract";
import { Factory, ReplyBox, type Answer, type FactoryPorts, type RelayResult, type RunItem, type RunRecord, type TaskSnapshot } from "./engine.js";
import { deliverTask } from "./procedure.js";
import { readSettings, SettingsError, writeSettings } from "./settings.js";

class FactoryError extends Error {}

const text = (value: unknown) => ({ content: [{ type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }] });

/** host の中継を呼ぶ口。結果の `_meta`（返事の印）も返す。人の承認を待つ間の進捗で上限を延ばす */
export function hostRelay(url: string, token: string) {
  let client: Promise<Client> | undefined;
  const connect = () => {
    if (!client) {
      const c = new Client({ name: "banto-module-factory", version: "0.1.0" });
      client = c
        .connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { authorization: `Bearer ${token}` } } }))
        .then(() => c);
    }
    return client;
  };
  return async (name: string, args: Record<string, unknown>, callId?: string): Promise<RelayResult> => {
    try {
      const c = await connect();
      const r = await c.callTool(
        { name, arguments: args, ...(callId ? { _meta: { [CALL_ID_META_KEY]: callId } } : {}) },
        undefined,
        { resetTimeoutOnProgress: true, onprogress: () => undefined },
      );
      return {
        text: (r.content as { type: string; text?: string }[])[0]?.text ?? "",
        isError: r.isError === true,
        ...(r._meta ? { meta: r._meta as Record<string, unknown> } : {}),
        ...(r.structuredContent ? { structured: r.structuredContent as Record<string, unknown> } : {}),
      };
    } catch (err) {
      if (!(err instanceof McpError) || err.code === ErrorCode.ConnectionClosed) {
        const old = client;
        client = undefined;
        void old?.then((c) => c.close()).catch(() => undefined);
      }
      throw err;
    }
  };
}

type Relay = ReturnType<typeof hostRelay>;

/** コマンドを走らせる（標準出力と標準エラーを混ぜ、末尾だけ持つ）。host が渡した変数（BANTO_*）は渡さない */
export async function execCommand(
  argv: string[],
  opts: { cwd: string; timeoutMs?: number; signal?: AbortSignal },
): Promise<{ code: number; out: string }> {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith("BANTO_")) env[k] = v;
  // コミットを作る段（rebase）に名前が要る。人の設定があればそれを使う
  env.GIT_COMMITTER_NAME ??= "banto factory";
  env.GIT_COMMITTER_EMAIL ??= "factory@banto.localhost";
  return new Promise((resolve) => {
    const child = spawn(argv[0]!, argv.slice(1), { cwd: opts.cwd, env, stdio: ["ignore", "pipe", "pipe"], detached: true });
    let out = "";
    const add = (b: Buffer) => {
      out += b.toString("utf8");
      if (out.length > 200_000) out = out.slice(-100_000);
    };
    child.stdout.on("data", add);
    child.stderr.on("data", add);
    const kill = (why: string) => {
      out += `\n[factory] ${why}`;
      try {
        process.kill(-child.pid!, "SIGTERM");
      } catch {
        child.kill("SIGTERM");
      }
    };
    const timer = opts.timeoutMs ? setTimeout(() => kill(`${Math.round(opts.timeoutMs! / 60000)} 分を越えたので止めました`), opts.timeoutMs) : undefined;
    const onAbort = () => kill("止めました");
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    child.on("error", (err) => {
      out += `\n${err.message}`;
    });
    child.on("close", (code, sig) => {
      if (timer) clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      resolve({ code: code ?? (sig ? 128 : 1), out });
    });
  });
}

export interface FactoryServerDeps {
  projectRoot: string;
  dataDir: string;
  relay: Relay;
  exec?: FactoryPorts["exec"];
}

export function createFactoryServer(deps: FactoryServerDeps) {
  const server = new Server({ name: "banto-module-factory", version: "0.1.0" }, { capabilities: { tools: {}, resources: {} } });

  /** 依存先の Module の名前（役割で引く。Project ごとの Module は `<名前>-<projectId>`） */
  const targets = new Map<string, string>();
  async function targetOf(role: "subagent" | "backlog", callId?: string): Promise<string> {
    const known = targets.get(role);
    if (known) return known;
    const listed = await deps.relay("relayListTargets", {}, callId);
    if (listed.isError) throw new FactoryError(listed.text || "中継が相手の一覧を返しませんでした");
    const found = (JSON.parse(listed.text) as Array<{ name: string; roles: string[] }>).find((t) => t.roles.includes(role));
    if (!found) throw new FactoryError(`この Project に ${role} の Module がありません（Factory は ${role} を使います）`);
    targets.set(role, found.name);
    return found.name;
  }

  const ports: FactoryPorts = {
    call: async (role, tool, args, callId) =>
      deps.relay("relayCallTool", { targetModule: await targetOf(role, callId), name: tool, arguments: args }, callId),
    exec: deps.exec ?? execCommand,
  };

  /**
   * **頼んだ Thread への知らせの札**（実行ごと、メモリにだけ持つ——札は平文で書かない）。`finalOnly` は host を起こし直した
   * あとに問われて続けたもの——最後の1回しか使えない
   */
  const handles = new Map<string, { replyTo: string; finalOnly: boolean }>();

  async function notify(run: RunRecord, title: string, body: string, final: boolean): Promise<void> {
    const h = handles.get(run.id);
    if (!h) {
      factory.noteNotifyError(run, `知らせる先がありません（${title}）——listFactoryRuns で見てください`);
      return;
    }
    const last = final || h.finalOnly;
    const r = await deps.relay("relayDeliverToThread", { replyTo: h.replyTo, title, text: body, final: last });
    if (last) handles.delete(run.id);
    if (r.isError) factory.noteNotifyError(run, `知らせられませんでした（${title}）：${r.text.slice(0, 300)}`);
  }

  const factory = new Factory({
    dataDir: deps.dataDir,
    projectRoot: deps.projectRoot,
    ports,
    procedure: deliverTask,
    replies: new ReplyBox(join(deps.dataDir, "replies")),
    events: {
      itemStopped: (run, item) =>
        notify(
          run,
          `Factory：${item.task.title} が止まりました（${item.stopped?.stage ?? item.stage}）`,
          JSON.stringify({ runId: run.id, task: item.task.id, ...describeItem(item), howToAnswer: HOW_TO_ANSWER }),
          false,
        ),
      runFinished: (run) =>
        notify(
          run,
          `Factory の実行が終わりました（取り込み ${run.items.filter((i) => i.status === "done").length}／${run.items.length} 件）`,
          JSON.stringify({ runId: run.id, items: run.items.map((i) => ({ task: i.task.id, ...describeItem(i) })) }),
          true,
        ),
    },
  });

  const HOW_TO_ANSWER =
    "answerFactory で答える：action=continue（instruction で指示を足して続ける）／accept（レビューの指摘を承知でこのまま取り込む）／" +
    "retry（stage で段を指定してやり直す。無ければいまの段から）／drop（やめる。Backlog は ready に戻る）";

  /** 起きたら、終わっていない実行を続ける（札は host に問われたら覚え直す） */
  const resumed = factory.resumeAll();
  if (resumed.length > 0) console.error(`[factory] 終わっていない実行を ${resumed.length} 件続けます`);

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "runFactory",
        description:
          "Backlog のタスク（id か番号を1件以上）を Factory に流す。1件ずつ worktree で、実装（サブエージェント）→ テスト → " +
          "レビュー（別のサブエージェント）→ main へ取り込み、まで進め、Backlog を done にする。**すぐ実行の id を返し、" +
          "終わったら（止まって人の答えが要るときも）結果がこの会話に届く**。流せるのは ready で依存が全部 done のタスク・" +
          "バグだけ（ストーリーは先に splitStory で分ける）。流せないものは理由つきで返し、流せるものだけ流す",
        inputSchema: {
          type: "object",
          properties: {
            items: { type: "array", items: { type: ["string", "integer"] }, description: "Backlog の項目（id か番号）" },
          },
          required: ["items"],
        },
        _meta: { [VISIBILITY_META_KEY]: "agent", [DELIVERS_LATER_META_KEY]: true },
      },
      {
        name: "listFactoryRuns",
        description: "Factory の実行の一覧と、1件ずつのいまの段・止まっている理由・かかっている時間。runId を渡すとその実行だけ",
        inputSchema: { type: "object", properties: { runId: { type: "string" } } },
        _meta: { [VISIBILITY_META_KEY]: "agent" },
      },
      {
        name: "answerFactory",
        description:
          "止まっている1件に答える。action：continue（instruction で指示を足して続ける）／accept（レビューの指摘を承知でこのまま" +
          "取り込む）／retry（stage——実装・テスト・レビュー・マージ——からやり直す。無ければいまの段から）／drop（やめる。Backlog は ready に戻る）",
        inputSchema: {
          type: "object",
          properties: {
            runId: { type: "string" },
            item: { type: ["string", "integer"], description: "Backlog の項目（id か番号）" },
            action: { type: "string", enum: ["continue", "accept", "retry", "drop"] },
            instruction: { type: "string" },
            stage: { type: "string" },
            reason: { type: "string" },
          },
          required: ["runId", "item", "action"],
        },
        _meta: { [VISIBILITY_META_KEY]: "agent", [DELIVERS_LATER_META_KEY]: true },
      },
      {
        name: "cancelFactory",
        description: "実行（か、その中の1件）を止める。走っているサブエージェントとテストも止め、Backlog は ready に戻す。worktree は残す",
        inputSchema: {
          type: "object",
          properties: { runId: { type: "string" }, item: { type: ["string", "integer"] }, reason: { type: "string" } },
          required: ["runId"],
        },
        _meta: { [VISIBILITY_META_KEY]: "agent" },
      },
      {
        name: "receiveReply",
        description: "頼んだサブエージェントの仕事の返事を受ける（host だけが呼ぶ）",
        inputSchema: { type: "object", properties: {} },
        _meta: { [VISIBILITY_META_KEY]: "admin", [RECEIVES_REPLIES_META_KEY]: true },
      },
      {
        name: RESUME_AFTER_RESTART_TOOL,
        description: "banto を起こし直したとき、続けるかを問われる（host だけが呼ぶ）",
        inputSchema: { type: "object", properties: {} },
        _meta: { [VISIBILITY_META_KEY]: "admin" },
      },
      {
        name: "getSettings",
        description: "Factory の設定（テストのコマンド・準備のコマンド・取り込む先・実装役とレビュー役・同時件数・上限）",
        inputSchema: { type: "object", properties: {} },
        _meta: { [VISIBILITY_META_KEY]: "admin" },
      },
      {
        name: "setSettings",
        description: "Factory の設定を書く（全体を渡す。省いた欄は既定）",
        inputSchema: { type: "object", properties: { settings: { type: "object" } }, required: ["settings"] },
        _meta: { [VISIBILITY_META_KEY]: "admin" },
      },
      {
        name: "getRuns",
        description: "実行の一覧（人の画面用。中身は listFactoryRuns と同じ）",
        inputSchema: { type: "object", properties: {} },
        _meta: { [VISIBILITY_META_KEY]: "admin" },
      },
    ],
  }));

  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: [
      {
        uri: "factory://module",
        name: "この Module の申告",
        mimeType: "application/json",
        _meta: {
          [VISIBILITY_META_KEY]: "admin",
          [MODULE_META_KEY]: MODULE_META,
        },
      },
    ],
  }));
  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    if (request.params.uri !== "factory://module") throw new Error(`unknown resource: ${request.params.uri}`);
    return { contents: [{ uri: request.params.uri, mimeType: "application/json", text: JSON.stringify(MODULE_META) }] };
  });

  /** Backlog の項目を読んで、流せるかを確かめる。流せないなら理由 */
  async function taskOf(ref: string | number, callId?: string): Promise<TaskSnapshot | { refused: string }> {
    const r = await ports.call("backlog", "getItem", { id: ref }, callId);
    if (r.isError) return { refused: r.text.slice(0, 300) };
    if (!r.structured) return { refused: `Backlog の返事が読めません：${r.text.slice(0, 200)}` };
    const got = r.structured as {
      item: { id: string; number: number | null; kind: string; title: string; status: string; body: string; doneWhen: string; parent: string | null };
      waitingOn: string[];
    };
    const item = got.item;
    if (item.kind === "story") return { refused: `${item.id} はストーリーです——先に splitStory でタスクに分けてください` };
    if (item.status !== "ready") return { refused: `${item.id} は ready ではありません（いま ${item.status}）` };
    if (got.waitingOn.length > 0) return { refused: `${item.id} は ${got.waitingOn.join("・")} が終わるのを待っています` };
    const running = factory.activeRunOf(item.id);
    if (running) return { refused: `${item.id} はもう流れています（実行 ${running.id}）` };
    let parent: TaskSnapshot["parent"];
    if (item.parent) {
      const p = await ports.call("backlog", "getItem", { id: item.parent }, callId);
      if (!p.isError && p.structured) {
        const pi = (p.structured as { item: { id: string; title: string; body: string } }).item;
        parent = { id: pi.id, title: pi.title, body: pi.body };
      }
    }
    return {
      id: item.id,
      number: item.number,
      kind: item.kind,
      title: item.title,
      body: item.body,
      doneWhen: item.doneWhen,
      ...(parent ? { parent } : {}),
    };
  }

  /** id か番号（42・"#42"）で、実行の中の1件を引く */
  function itemOf(run: RunRecord, ref: unknown): RunItem {
    const s = String(ref ?? "").replace(/^#/, "");
    const found = run.items.find((i) => i.task.id === s || (i.task.number !== null && String(i.task.number) === s));
    if (!found) throw new FactoryError(`実行 ${run.id} に ${String(ref)} はありません`);
    return found;
  }

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;
    const meta = request.params._meta as Record<string, unknown> | undefined;
    const callId = callIdOf(meta);
    try {
      switch (request.params.name) {
        case "runFactory": {
          const settings = readSettings(deps.dataDir);
          if (!settings.testCommand) {
            throw new FactoryError(
              "テストのコマンドが設定されていません——テストを通ったものだけを取り込むのが Factory の決まりなので、流せません。" +
                "人に Factory の設定（Project の設定）でテストのコマンドを入れてもらってください",
            );
          }
          const refs = Array.isArray(args.items) ? (args.items as Array<string | number>) : [];
          if (refs.length === 0) throw new FactoryError("items に Backlog の項目（id か番号）を1件以上渡してください");
          const tasks: TaskSnapshot[] = [];
          const refused: Array<{ item: string; reason: string }> = [];
          for (const ref of refs) {
            const t = await taskOf(ref, callId);
            if ("refused" in t) refused.push({ item: String(ref), reason: t.refused });
            else if (tasks.some((x) => x.id === t.id)) refused.push({ item: String(ref), reason: "同じ項目が2回あります" });
            else tasks.push(t);
          }
          if (tasks.length === 0) return { ...text({ started: false, refused }), isError: true };
          const thread = threadOf(meta);
          const run = factory.start({ tasks, settings, ...(thread ? { requestedBy: thread } : {}) });
          const replyTo = replyToOf(meta);
          if (replyTo) {
            handles.set(run.id, { replyTo, finalOnly: false });
            factory.recordHandle(run, replyToFingerprint(replyTo));
          }
          // 走り出した各件が最初のサブエージェントに頼めるまで待つ——承認（Factory→Subagent・Backlog、Subagent→Vault）を
          // この会話で出すため。そのあとは裏で進む（承認はこの Project で覚えられている）
          await factory.withCall(run.id, callId, () => factory.settled(run.id));
          return {
            ...text({
              runId: run.id,
              started: run.items.map((i) => ({ item: i.task.id, title: i.task.title, ...describeItem(i) })),
              ...(refused.length ? { refused } : {}),
              note: replyTo
                ? "流しました。終わったら（止まって答えが要るときも）この会話に届きます。それまで他の仕事を続けてよい"
                : "流しました（知らせる先が無いので、様子は listFactoryRuns で見てください）",
            }),
            ...(replyTo ? { _meta: { [PENDING_REPLY_META_KEY]: true } } : {}),
          };
        }
        case "listFactoryRuns":
        case "getRuns": {
          const runs = typeof args.runId === "string" ? [factory.get(args.runId)].filter((r): r is RunRecord => !!r) : factory.list();
          return text({ runs: runs.map(describeRun) });
        }
        case "answerFactory": {
          const run = factory.get(String(args.runId ?? ""));
          if (!run) throw new FactoryError(`実行 ${String(args.runId)} はありません`);
          const item = itemOf(run, args.item);
          const action = String(args.action ?? "");
          let answer: Answer;
          if (action === "continue") answer = { action, ...(typeof args.instruction === "string" && args.instruction.trim() ? { instruction: args.instruction } : {}) };
          else if (action === "accept") answer = { action };
          else if (action === "retry") answer = { action, ...(typeof args.stage === "string" && args.stage.trim() ? { stage: args.stage.trim() } : {}) };
          else if (action === "drop") answer = { action, ...(typeof args.reason === "string" ? { reason: args.reason } : {}) };
          else throw new FactoryError("action は continue・accept・retry・drop のどれか");
          factory.answer(run.id, item.task.id, answer);
          // 知らせる札が無くなっていれば（使い切った・起こし直したあと最後の1回を使った）、この呼び出しの札を引き継ぐ
          const replyTo = replyToOf(meta);
          const adopt = !!replyTo && !handles.has(run.id) && !run.finishedAt;
          if (adopt) {
            handles.set(run.id, { replyTo: replyTo!, finalOnly: false });
            factory.recordHandle(run, replyToFingerprint(replyTo!));
          }
          await factory.withCall(run.id, callId, () => factory.settled(run.id));
          return {
            ...text({ runId: run.id, item: item.task.id, answered: action, now: describeItem(item) }),
            ...(adopt ? { _meta: { [PENDING_REPLY_META_KEY]: true } } : {}),
          };
        }
        case "cancelFactory": {
          const run = factory.get(String(args.runId ?? ""));
          if (!run) throw new FactoryError(`実行 ${String(args.runId)} はありません`);
          const taskId = args.item === undefined ? undefined : itemOf(run, args.item).task.id;
          const stopped = await factory.withCall(run.id, callId, () =>
            factory.cancel(run.id, taskId, typeof args.reason === "string" && args.reason.trim() ? args.reason : "止めました"),
          );
          return text({ runId: run.id, stopping: stopped, note: "止めています。Backlog は ready に戻し、worktree は残します" });
        }
        case "receiveReply": {
          if (callIdOf(meta) || threadOf(meta)) throw new FactoryError("receiveReply は banto 本体だけが呼べます");
          factory.receiveReply(args as never);
          return text("ok");
        }
        case RESUME_AFTER_RESTART_TOOL: {
          if (!isHostResumeCall(meta)) throw new FactoryError(`${RESUME_AFTER_RESTART_TOOL} は banto 本体だけが呼べます`);
          const question = parseResumeQuestion(args);
          const answers: ResumeAnswer[] = question.items.map((q) => {
            const fp = replyToFingerprint(q.replyTo);
            const run = factory.list().find((r) => !r.finishedAt && r.handleFingerprints.includes(fp));
            if (!run) return { replyTo: q.replyTo, resume: false, reason: "終わっていない Factory の実行がありません" };
            handles.set(run.id, { replyTo: q.replyTo, finalOnly: true });
            return { replyTo: q.replyTo, resume: true };
          });
          return text({ answers });
        }
        case "getSettings":
          return text({ settings: readSettings(deps.dataDir) });
        case "setSettings":
          return text({ settings: writeSettings(deps.dataDir, args.settings) });
      }
    } catch (err) {
      if (err instanceof FactoryError || err instanceof SettingsError) return { ...text(err.message), isError: true };
      throw err;
    }
    throw new Error(`unknown tool: ${request.params.name}`);
  });

  return { server, factory };
}

function describeItem(item: RunItem) {
  return {
    status: item.status,
    stage: item.stage,
    stageSince: item.stageSince,
    worktree: item.worktree,
    branch: item.branch,
    ...(item.stopped ? { stopped: item.stopped } : {}),
    ...(item.subagentRunId ? { subagentRunId: item.subagentRunId } : {}),
    ...(item.lastTest ? { lastTest: { ok: item.lastTest.ok, code: item.lastTest.code, at: item.lastTest.at } } : {}),
    ...(item.lastReview ? { lastReview: item.lastReview } : {}),
    ...(item.result ? { result: item.result } : {}),
  };
}

function describeRun(run: RunRecord) {
  return {
    runId: run.id,
    createdAt: run.createdAt,
    ...(run.finishedAt ? { finishedAt: run.finishedAt } : {}),
    items: run.items.map((i) => ({ item: i.task.id, number: i.task.number, title: i.task.title, ...describeItem(i) })),
    ...(run.notifyErrors.length ? { notifyErrors: run.notifyErrors } : {}),
  };
}

export const MODULE_META = {
  satisfies: ["factory"],
  dependsOn: [
    { role: "subagent", required: true },
    { role: "backlog", required: true },
  ],
  isolation: "subprocess",
  scope: "project",
  // git とテストのコマンドを走らせる
  confinement: { kind: "landlock", root: "project", profile: "exec" },
  // 起こし直しても、終わっていない実行を続けられる（記録から流し直す）
  resumesAfterRestart: true,
};

if (process.argv[1] && process.argv[1].endsWith("server.js")) {
  const projectRoot = process.env.BANTO_PROJECT_ROOT;
  const dataDir = process.env.BANTO_MODULE_DATA_DIR;
  const url = process.env.BANTO_HOST_MCP_URL;
  const token = process.env.BANTO_HOST_MCP_TOKEN;
  if (!projectRoot || !dataDir || !url || !token) {
    console.error("BANTO_PROJECT_ROOT・BANTO_MODULE_DATA_DIR・BANTO_HOST_MCP_URL・BANTO_HOST_MCP_TOKEN が必要です");
    process.exit(1);
  }
  const { server } = createFactoryServer({ projectRoot, dataDir, relay: hostRelay(url, token) });
  await server.connect(new StdioServerTransport());
}

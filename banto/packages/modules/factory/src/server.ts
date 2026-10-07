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
  CANVAS_META_KEY,
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
import { CONFIG_APP_HTML, CONFIG_APP_URI, RUNS_APP_HTML, RUNS_APP_URI, UI_APP_MIME } from "./apps.js";
import { describeJournal, type ItemCounts } from "./describe.js";
import type { StepRecord } from "./journal.js";

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
  /** 起き直したあと、知らせを host の問いまで待たせる上限（既定 `RESUME_ASK_WAIT_MS`） */
  resumeAskWaitMs?: number;
}

/**
 * 起き直したあと、流し直した実行の知らせを host の問い（`resumeAfterRestart`）まで待たせる上限。host は Module を起こす時間も
 * 入れて 120 秒まで問う（core の `RESUME_ASK_TIMEOUT_MS`）——それより少し長く待つ
 */
export const RESUME_ASK_WAIT_MS = 150_000;

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
  /**
   * **起き直して流し直した実行のうち、host にまだ問われていないもの**（追加・2026-10-07、resume-factory）。札はメモリにしか
   * 無いので、問われて覚え直すまで知らせる先が無い。流し直しが問いより先に進んで知らせる（記録の最後の段だけ残っていた等）
   * と、以前は知らせを捨て、問われると「終わっていない実行がありません」と答えて、頼んだ Thread には仕事が済んだのに
   * 「途中で終わりました」が届いていた。**知らせは問いまで待たせ**（上限 `RESUME_ASK_WAIT_MS`）、問われたら終わった実行でも
   * 「続ける」と答えて待たせた知らせを届ける
   */
  const awaitingAsk = new Map<string, () => void>();
  const askArrived = new Map<string, Promise<void>>();
  /** 最後の知らせを届けた実行（あとから来た問いの札は、引き継いだことを知らせて閉じる） */
  const finalSent = new Set<string>();

  /** 札が付いた（問われた・answerFactory が引き継いだ）——問いまで待たせていた知らせを放す */
  function handleArrived(runId: string): void {
    const release = awaitingAsk.get(runId);
    if (!release) return;
    awaitingAsk.delete(runId);
    askArrived.delete(runId);
    setImmediate(release);
  }

  /**
   * 頼んだ Thread に知らせる。返すのは届いたか。`stillWanted` は、札を待つ間に要らなくなったか（止まった1件に答えが来た）——
   * 要らなくなった知らせは届けない
   */
  async function notify(run: RunRecord, title: string, body: string, final: boolean, stillWanted?: () => boolean): Promise<boolean> {
    if (!handles.has(run.id)) await askArrived.get(run.id);
    if (stillWanted && !stillWanted()) return false;
    const h = handles.get(run.id);
    if (!h) {
      factory.noteNotifyError(run, `知らせる先がありません（${title}）——listFactoryRuns で見てください`);
      return false;
    }
    const last = final || h.finalOnly;
    const r = await deps.relay("relayDeliverToThread", { replyTo: h.replyTo, title, text: body, final: last });
    if (last) {
      handles.delete(run.id);
      if (!r.isError) finalSent.add(run.id);
    }
    if (r.isError) factory.noteNotifyError(run, `知らせられませんでした（${title}）：${r.text.slice(0, 300)}`);
    return !r.isError;
  }

  const factory = new Factory({
    dataDir: deps.dataDir,
    projectRoot: deps.projectRoot,
    ports,
    procedure: deliverTask,
    replies: new ReplyBox(join(deps.dataDir, "replies")),
    events: {
      itemStopped: (run, item) => {
        const stop = item.stopped;
        return notify(
          run,
          `Factory：${item.task.title} が止まりました（${stop?.stage ?? item.stage}）`,
          JSON.stringify({ runId: run.id, task: item.task.id, ...describeItem(item), howToAnswer: HOW_TO_ANSWER }),
          false,
          () => item.stopped === stop,
        );
      },
      runFinished: async (run) =>
        void (await notify(
          run,
          `Factory の実行が終わりました（取り込み ${run.items.filter((i) => i.status === "done").length}／${run.items.length} 件）`,
          JSON.stringify({ runId: run.id, items: run.items.map((i) => ({ task: i.task.id, ...describeItem(i) })) }),
          true,
        )),
    },
  });

  /** 覚え直した札を、answerFactory の呼び出しに引き継いだことを知らせて閉じる */
  async function handOver(run: RunRecord, replyTo: string): Promise<void> {
    const r = await deps.relay("relayDeliverToThread", {
      replyTo,
      title: "Factory：知らせの宛先を answerFactory の呼び出しに引き継ぎました",
      text: JSON.stringify({
        runId: run.id,
        note:
          "banto を起こし直したあと、この実行には answerFactory で答えがあり、知らせはその呼び出しに引き継ぎました。" +
          (finalSent.has(run.id) ? "最後の知らせはそちらに届けてあります" : "これからの知らせはそちらに届きます"),
      }),
      final: true,
    });
    if (r.isError) factory.noteNotifyError(run, `覚え直した札を閉じられませんでした：${r.text.slice(0, 300)}`);
  }

  const HOW_TO_ANSWER =
    "answerFactory で答える：action=continue（instruction で指示を足して続ける）／accept（レビューの指摘を承知でこのまま取り込む）／" +
    "retry（stage で段を指定してやり直す。無ければいまの段から）／drop（やめる。Backlog は ready に戻る）";

  /** 起きたら、終わっていない実行を続ける（札は host に問われたら覚え直す。それまで知らせは待たせる） */
  const resumed = factory.resumeAll();
  for (const run of resumed) {
    if (run.handleFingerprints.length > 0) askArrived.set(run.id, new Promise<void>((resolve) => awaitingAsk.set(run.id, resolve)));
  }
  if (resumed.length > 0) console.error(`[factory] 終わっていない実行を ${resumed.length} 件続けます`);
  if (awaitingAsk.size > 0) {
    // 問われないまま上限を越えたら待つのをやめる（Factory だけが起き直した——host は問わない。知らせは記録に残る）
    setTimeout(() => {
      for (const [runId, resolve] of awaitingAsk) {
        awaitingAsk.delete(runId);
        askArrived.delete(runId);
        resolve();
      }
    }, deps.resumeAskWaitMs ?? RESUME_ASK_WAIT_MS).unref();
  }

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
        name: "getRunItem",
        description: "1件の詳細（人の画面用）：段・最後のテスト・回数・何が起きたか・変更",
        inputSchema: { type: "object", properties: { runId: { type: "string" }, item: { type: ["string", "integer"] } }, required: ["runId", "item"] },
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
        // **人が直接開く入口**（launcher）。長引いたとき・止まったときに覗く場所
        uri: RUNS_APP_URI,
        name: "Factory",
        description: "Factory に流したタスクの様子（段・止まっている理由・テスト・レビュー・変更）。止まったものに答える・止める",
        mimeType: UI_APP_MIME,
        _meta: { [VISIBILITY_META_KEY]: "admin", [CANVAS_META_KEY]: "launcher", ui: { prefersBorder: false } },
      },
      {
        // 設定 Canvas——テストのコマンド・実装役とレビュー役・上限
        uri: CONFIG_APP_URI,
        name: "Factory",
        mimeType: UI_APP_MIME,
        _meta: { [VISIBILITY_META_KEY]: "admin", [CANVAS_META_KEY]: "config", ui: { prefersBorder: false } },
      },
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
    if (request.params.uri === RUNS_APP_URI) return { contents: [{ uri: RUNS_APP_URI, mimeType: UI_APP_MIME, text: RUNS_APP_HTML }] };
    if (request.params.uri === CONFIG_APP_URI) return { contents: [{ uri: CONFIG_APP_URI, mimeType: UI_APP_MIME, text: CONFIG_APP_HTML }] };
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
            handleArrived(run.id);
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
          // host は印を何も付けずに呼ぶ。人の画面・中継・AI のターンの呼び出しには印が付く——付いていたら断る
          if (!isHostResumeCall(meta)) throw new FactoryError("receiveReply は banto 本体だけが呼べます");
          factory.receiveReply(args as never);
          return text("ok");
        }
        case RESUME_AFTER_RESTART_TOOL: {
          if (!isHostResumeCall(meta)) throw new FactoryError(`${RESUME_AFTER_RESTART_TOOL} は banto 本体だけが呼べます`);
          const question = parseResumeQuestion(args);
          const answers: ResumeAnswer[] = question.items.map((q) => {
            const fp = replyToFingerprint(q.replyTo);
            const run = factory.list().find((r) => r.handleFingerprints.includes(fp));
            // **問いの前に answerFactory が札を引き継いだ**（追加・2026-10-07、Fable のレビュー）：引き継いだ札を上書きしない
            // ——上書きすると引き継いだ札が返事待ちのまま残る。覚え直した札は、引き継いだことを最後の知らせとして届けて閉じる
            // （「続ける」と答えたまま使わないと「続けています」が残り、「続けない」と答えると「途中で終わりました」が届く）
            if (run && (handles.has(run.id) || finalSent.has(run.id))) {
              handleArrived(run.id);
              setImmediate(() => void handOver(run, q.replyTo));
              return { replyTo: q.replyTo, resume: true };
            }
            // 終わった実行でも、最後の知らせを問いまで待たせていれば続ける（届けるのは答えを返したあと）
            if (!run || (run.finishedAt && !awaitingAsk.has(run.id))) {
              return { replyTo: q.replyTo, resume: false, reason: "終わっていない Factory の実行がありません" };
            }
            handles.set(run.id, { replyTo: q.replyTo, finalOnly: true });
            handleArrived(run.id);
            return { replyTo: q.replyTo, resume: true };
          });
          return text({ answers });
        }
        case "getRunItem": {
          const run = factory.get(String(args.runId ?? ""));
          if (!run) throw new FactoryError(`実行 ${String(args.runId)} はありません`);
          const item = itemOf(run, args.item);
          const steps = factory.journalOf(run.id, item.task.id);
          return text({
            runId: run.id,
            createdAt: run.createdAt,
            ...(run.finishedAt ? { finishedAt: run.finishedAt } : {}),
            ...(run.requestedBy ? { requestedBy: run.requestedBy } : {}),
            settings: { testCommand: run.settings.testCommand, targetBranch: run.settings.targetBranch, limits: run.settings.limits },
            item: { item: item.task.id, number: item.task.number, title: item.task.title, ...(item.task.parent ? { story: item.task.parent.title } : {}), ...describeItem(item) },
            lastTest: item.lastTest,
            counts: countsOf(steps),
            journal: describeJournal(steps, run.createdAt, item.branch, run.settings.targetBranch),
            diff: await diffOf(deps.projectRoot, run.settings.targetBranch, item.branch, ports.exec),
          });
        }
        case "getSettings": {
          // 選べるエージェント（Subagent に聞く。聞けなくても設定は出す——理由を添える）
          let agents: Array<{ id: string; title: string }> | undefined;
          let agentsError: string | undefined;
          try {
            const r = await ports.call("subagent", "listSubagents", {}, callId);
            if (r.isError) agentsError = r.text.slice(0, 300);
            else agents = (JSON.parse(r.text) as Array<{ id: string; title: string }>).map((a) => ({ id: a.id, title: a.title }));
          } catch (err) {
            agentsError = err instanceof Error ? err.message : String(err);
          }
          return text({ settings: readSettings(deps.dataDir), ...(agents ? { agents } : {}), ...(agentsError ? { agentsError } : {}) });
        }
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

/** 回数（落ちたテスト・直すことがあったレビュー）。上限と並べて画面に出す */
function countsOf(steps: StepRecord[]): ItemCounts {
  let testFails = 0;
  let reviewChanges = 0;
  for (const s of steps) {
    const v = s.end?.ok ? (s.end.value as Record<string, unknown> | null) : null;
    if (s.key === "test" && v && v.ok === false) testFails++;
    if (s.key === "agent:reviewer" && v && (v.structured as { verdict?: string } | undefined)?.verdict === "changes") reviewChanges++;
  }
  return { testFails, reviewChanges };
}

/** 取り込む先からの変更（コミットの数・ファイルごとの増減）。ブランチがもう無ければ出さない */
async function diffOf(root: string, target: string, branch: string, exec: FactoryPorts["exec"]) {
  const ref = await exec(["git", "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], { cwd: root });
  if (ref.code !== 0) return undefined;
  const count = await exec(["git", "rev-list", "--count", `${target}..${branch}`], { cwd: root });
  const numstat = await exec(["git", "diff", "--numstat", `${target}...${branch}`], { cwd: root });
  if (count.code !== 0 || numstat.code !== 0) return undefined;
  const files = numstat.out
    .split("\n")
    .filter((l) => l.trim())
    .slice(0, 200)
    .map((l) => {
      const [add, del, ...path] = l.split("\t");
      return { path: path.join("\t"), add: add === "-" ? null : Number(add), del: del === "-" ? null : Number(del) };
    });
  return { commits: Number(count.out.trim()), files };
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

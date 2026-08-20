#!/usr/bin/env node
/**
 * 職人を **Claude Code（Agent SDK）** で動かす小さなホスト（1プロセス＝1人の職人）。
 *
 * `ClaudeAgentDriver` がこのファイルを子プロセスとして起こし、標準入出力の JSONL で話す。
 * 話す言葉は pi の RPC モードのうち **Worker Pool が実際に使う分だけ**に揃えてある
 * （`get_state` / `prompt` / `abort`）——Worker Pool から見て、ランタイムの違いが
 * `RuntimeDriver` の内側で閉じるようにするため（決定11・決定3）。
 *
 * なぜ番頭ホストの中で `query()` を回さないか：Worker Pool は職人の生死を **pid の生存**で
 * 見て、畳むときはその pid を落とす（pool.ts）。同居させると畳むたびに自分を殺しかねないし、
 * 職人1人の異常がホストごと巻き込む。プロセスを分けるのは pi と同じ形に揃えることでもある。
 *
 * 起動:
 *   node --import tsx host.ts --session-file <path> --model <id> [--tools a,b] [--network]
 *                            [--append-system-prompt <text>] [--resume <sessionId>]
 *
 * 環境変数（pi の `worker-report` 拡張と同じ）:
 *   BANTO_WORKER_POOL_URL  報告・質問の宛先（無ければ報告経路ごと載せない）
 *   BANTO_PROJECT / BANTO_TASK_ID  自分の名乗り
 *
 * D5: 判断は無い。指示を渡し、出てきたものを写し、報告を転送するだけ。
 * D6: 依存は Agent SDK と zod（SDK が MCP Tool の入力スキーマに要求する形）と node 標準。
 * I2: 認証切れ・起動失敗は握りつぶさず、標準エラーへ書いて非0で終わる（親が spawn_failed にする）。
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import { z } from "zod";
import {
  createSdkMcpServer,
  query,
  tool,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { BANTO_MCP_SERVER, CLAUDE_DEFAULT_MODEL } from "./naming.js";
import { createReportChannel, endedWithoutReporting } from "./report.js";
import { createKoboChannel } from "./kobo.js";
import { createClaudeToolOffload } from "./tool-offload.js";
import { createClaudeWorkKeep } from "./work-keep.js";
import { buildHostOptions } from "./options.js";
import { SessionTranscript } from "./session-log.js";
import { ContextWatch } from "./context-watch.js";

// ── 起動時の指定 ────────────────────────────────────────────────────────────

export interface HostConfig {
  sessionFile: string;
  model: string;
  systemPrompt: string;
  tools: string[];
  resume?: string;
  network: boolean;
  settingSources: ("user" | "project" | "local")[];
}

function readFlag(args: readonly string[], name: string): string | undefined {
  const idx = args.indexOf(`--${name}`);
  if (idx === -1) return undefined;
  const value = args[idx + 1];
  if (value === undefined) throw new Error(`--${name} には値が要ります。`);
  return value;
}

/** 起動引数を読む（純関数。試験から直に確かめられるように分けてある）。 */
export function readHostConfig(args: readonly string[]): HostConfig {
  const sessionFile = readFlag(args, "session-file");
  if (!sessionFile) throw new Error("--session-file は必須です。");
  const settingSources = (readFlag(args, "setting-sources") ?? "project")
    .split(",")
    .map((s) => s.trim())
    .filter((s): s is "user" | "project" | "local" => s === "user" || s === "project" || s === "local");
  const tools = (readFlag(args, "tools") ?? "")
    .split(",")
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
  const resume = readFlag(args, "resume");
  return {
    sessionFile,
    model: readFlag(args, "model") ?? CLAUDE_DEFAULT_MODEL,
    systemPrompt: readFlag(args, "append-system-prompt") ?? "",
    tools,
    ...(resume ? { resume } : {}),
    network: args.includes("--network"),
    settingSources,
  };
}

// ── 指示の待ち行列（streaming input） ────────────────────────────────────────

/**
 * 番頭からの指示を Agent SDK へ流す口。
 *
 * **空になっても終わらせない**のが要点。ここで返り切ると `query()` が畳まれ、職人は
 * 追加の指示（`worker.steer`・質問への答え）を受け取れなくなる——起動時の1通で
 * 終わってしまう職人は、決定29b（質問して待つ）を満たせない。
 */
export class PromptQueue {
  private readonly queued: SDKUserMessage[] = [];
  private waiting: ((value: IteratorResult<SDKUserMessage>) => void) | undefined;
  private closed = false;

  push(text: string): void {
    const message = {
      type: "user" as const,
      message: { role: "user" as const, content: text },
      parent_tool_use_id: null,
    } as SDKUserMessage;
    const waiter = this.waiting;
    if (waiter) {
      this.waiting = undefined;
      waiter({ value: message, done: false });
      return;
    }
    this.queued.push(message);
  }

  close(): void {
    this.closed = true;
    const waiter = this.waiting;
    if (waiter) {
      this.waiting = undefined;
      waiter({ value: undefined as unknown as SDKUserMessage, done: true });
    }
  }

  async *stream(): AsyncGenerator<SDKUserMessage> {
    while (true) {
      const next = this.queued.shift();
      if (next) {
        yield next;
        continue;
      }
      if (this.closed) return;
      const result = await new Promise<IteratorResult<SDKUserMessage>>((resolve) => {
        this.waiting = resolve;
      });
      if (result.done) return;
      yield result.value;
    }
  }
}

// ── JSONL の読み書き ────────────────────────────────────────────────────────

function attachJsonlReader(stream: NodeJS.ReadableStream, onLine: (line: string) => void): void {
  const decoder = new StringDecoder("utf8");
  let buffer = "";
  stream.on("data", (chunk: Buffer | string) => {
    buffer += typeof chunk === "string" ? chunk : decoder.write(chunk);
    while (true) {
      const idx = buffer.indexOf("\n");
      if (idx === -1) break;
      const line = buffer.slice(0, idx).replace(/\r$/, "");
      buffer = buffer.slice(idx + 1);
      if (line.length > 0) onLine(line);
    }
  });
}

function send(message: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify(message) + "\n");
}

// ── 本体 ────────────────────────────────────────────────────────────────────

/**
 * **自分の袋（cgroup）へ入る**（inc-0066 第2段）。何より先に、SDK を触る前にやる。
 *
 * `cgroup.procs` へ自分の pid を書くと、以後この プロセスが起こす子孫——`claude` CLI も、
 * その下の bash も grep も——**自動的に同じ袋の中で生まれる**（cgroup v2 の継承）。
 * 親が spawn の後に書く形だと、書く前に起きた孫を取りこぼす。
 *
 * I2・fail closed: 入れなかったら**働かずに落ちる**。工房は「隔離を作ったのに入れなかった」
 * 職人を隔離なしで走らせない（PO 裁定）——1本の暴走が機械全体を巻き込むため。
 */
function joinOwnCgroup(): void {
  const procsFile = process.env["BANTO_WORKER_CGROUP_PROCS"];
  if (!procsFile) return; // 隔離しない運転（開発機・コンテナ）。工房が別に警告を出している
  try {
    fs.writeFileSync(procsFile, String(process.pid));
  } catch (err) {
    process.stderr.write(
      `[claude-agent] 自分を隔離（cgroup）へ入れられませんでした: ${procsFile}: ${String(err)}\n` +
        `[claude-agent] 隔離なしでは働きません（inc-0066）\n`
    );
    process.exit(1);
  }
}

async function main(): Promise<void> {
  joinOwnCgroup();
  const config = readHostConfig(process.argv.slice(2));
  fs.mkdirSync(path.dirname(config.sessionFile), { recursive: true });

  // 決定30d: 起こし直しは元のセッションの再開。同じ id を返すのは pi と同じ振る舞い
  const sessionId = config.resume ?? randomUUID();
  const transcript = new SessionTranscript();
  const appendLines = (lines: Record<string, unknown>[]): void => {
    if (lines.length === 0) return;
    fs.appendFileSync(
      config.sessionFile,
      lines.map((line) => JSON.stringify(line)).join("\n") + "\n",
      "utf-8"
    );
  };
  appendLines(transcript.start(sessionId, config.model, new Date().toISOString()));

  const report = createReportChannel();
  /**
   * 工場（Kobo）の口。**Kobo が起こした職人にだけ載る**（PO報告 2026-08-11）。
   *
   * これが無かったので、Claude Code の職人は実装を終えても工場へ伝えられず、タスクは
   * `implementing` のまま止まっていた。監査人に至っては「`audit_report` ツールはこの環境に
   * 存在せず」と書き残して落ちていた。
   */
  const kobo = createKoboChannel();
  const queue = new PromptQueue();

  /** このターンで呼ばれた Tool（安全弁の判定）と、最後の発話（安全弁の中身）。 */
  let calledTools = new Set<string>();
  let lastAssistantText = "";

  /**
   * 文脈が伸びたことを知らせる係。**セッションのファイル名で呼ぶ**——
   * `banto-task-0307-….jsonl` のようにタスクが読めるので、どの仕事が伸びたかを
   * journal から数え直せる（可視化の目的そのもの）。
   */
  const contextWatch = new ContextWatch(path.basename(config.sessionFile));

  const mcpServers = report
    ? {
        [BANTO_MCP_SERVER]: createSdkMcpServer({
          name: BANTO_MCP_SERVER,
          tools: [
            tool(
              "report",
              "起動元へ報告する。作業が終わったとき・進み具合を伝えたいときに使う。" +
                "これは完了の宣言ではなく、検証へ回す合図。",
              {
                summary: z.string().describe("何をしたか・確認した結果・残っている懸念"),
                done: z.boolean().optional().describe("自分としては作業を終えたつもりなら true"),
              },
              async (args) => ({
                content: [
                  {
                    type: "text" as const,
                    text: await report.post("worker.report", {
                      summary: args.summary,
                      ...(args.done !== undefined ? { done: args.done } : {}),
                    }),
                  },
                ],
              })
            ),
            tool(
              "ask",
              "起動元に質問する。指示に無い前提を推測して進めるより、ここで聞く。" +
                "呼んだあとは答えが来るまで待つ（答えは追加の指示として届く）。",
              {
                question: z.string().describe("聞きたいこと。判断に必要な背景も添える"),
                blocking: z.boolean().optional().describe("答えが無いと先へ進めないなら true"),
              },
              async (args) => ({
                content: [
                  {
                    type: "text" as const,
                    text: await report.post("worker.ask", {
                      question: args.question,
                      ...(args.blocking !== undefined ? { blocking: args.blocking } : {}),
                    }),
                  },
                ],
              })
            ),
            /**
             * 工場（Kobo）の口。**Kobo が起こした職人にだけ生える**（PO報告 2026-08-11）。
             *
             * pi 拡張（`pi-extension/banto-executor.ts` / `banto-auditor.ts`）が載せるものと
             * 同じ HTTP 面を叩く。ランタイムが違っても工場から見た形が同じになる。
             */
            ...(kobo
              ? [
                  tool(
                    "report_phase",
                    "工場に工程を伝える（planning: 読み解いている / implementing: 書いている）。" +
                      "実装が終わったら report_phase ではなく report_done を呼ぶ。",
                    {
                      phase: z.enum(["planning", "implementing"]).describe("いまの工程"),
                      note: z.string().optional().describe("一言添えるなら"),
                    },
                    async (args) => ({
                      content: [
                        {
                          type: "text" as const,
                          text: await kobo.reportPhase(args.phase, args.note),
                        },
                      ],
                    })
                  ),
                  tool(
                    "report_done",
                    "実装が終わったことを工場に伝える。**完了の宣言ではなく、監査へ回す合図**。" +
                      "review-ready へ自分で進めることはできない（そこは監査の判断）。",
                    {
                      summary: z.string().describe("何を変えたか・何で確かめたか"),
                    },
                    async (args) => ({
                      content: [
                        { type: "text" as const, text: await kobo.reportDone(args.summary) },
                      ],
                    })
                  ),
                  tool(
                    "audit_report",
                    "監査の判定を工場に出す。**pass は受け入れ基準を全部満たしたときだけ**。" +
                      "fail のときは findings に具体的な指摘を並べる（直す職人がそれを読む）。",
                    {
                      verdict: z.enum(["pass", "fail"]).describe("pass か fail"),
                      findings: z
                        .array(z.string())
                        .describe("見つけた問題（pass なら空、fail なら必須）"),
                      // task-0287 a11（PO裁定 2026-08-20）: diff の外を読んだファイルと理由の
                      // 自己申告。I1: pass/fail の判断材料ではない——工場は audit_verdict へ
                      // そのまま刻むだけ
                      consultedBeyondDiff: z
                        .array(z.string())
                        .optional()
                        .describe(
                          "diff の外で読んだファイルとその理由（自己申告）。diff だけで判断" +
                            "できたなら省略してよい。pass/fail の判断には使われない"
                        ),
                    },
                    async (args) => ({
                      content: [
                        {
                          type: "text" as const,
                          text: await kobo.auditReport(
                            args.verdict,
                            args.findings,
                            args.consultedBeyondDiff
                          ),
                        },
                      ],
                    })
                  ),
                ]
              : []),
          ],
        }),
      }
    : undefined;

  /**
   * 長いツール結果の退避（task-0090 / task-0102）。
   *
   * pi 職人には拡張として載っているものと**同じ判断**を、この経路では `PostToolUse` フックで
   * 載せる。載せ忘れた経路だけが「長い結果の直後に応答が返らない」穴に落ちる——
   * 実運用の職人はほぼ全部こちらなので、ここが空いていた間は対策が効いていなかった。
   */
  const offload = createClaudeToolOffload();

  /**
   * 作業の取り置き（機構が定期的にコミットする）。
   *
   * 職人が落ちても・無報告で終わっても、そこまでの成果が名前つきの枝に残る。
   * pi 経路には拡張（`pi-extension/work-keep.ts`）として載っている**同じ判断**を、
   * この経路では `PostToolUse` フック＋タイマーで載せる——実運用の職人はほぼ全部こちらなので、
   * ここが空いていれば機構はどこにも効いていないことになる（task-0102 と同じ穴）。
   */
  const workKeep = createClaudeWorkKeep(process.env, process.cwd(), sessionId);

  // 組み立ては `options.ts`（純関数）。**繋ぎ目を試験から叩けるようにするため**に分けてある
  const options = buildHostOptions({
    config,
    cwd: process.cwd(),
    sessionId,
    reported: Boolean(report),
    offload,
    workKeep,
    mcpServers,
  });

  const session = query({ prompt: queue.stream(), options });

  // 親（ドライバ）からの命令
  attachJsonlReader(process.stdin, (line) => {
    let command: Record<string, unknown>;
    try {
      command = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return; // JSON でない行は無視（pi と同じ）
    }
    const id = typeof command["id"] === "string" ? command["id"] : undefined;
    const type = command["type"];

    if (type === "get_state") {
      send({
        type: "response",
        ...(id ? { id } : {}),
        command: "get_state",
        success: true,
        data: { sessionId, sessionFile: config.sessionFile },
      });
      return;
    }
    if (type === "prompt") {
      const message = typeof command["message"] === "string" ? command["message"] : "";
      if (message.length === 0) {
        // I2: 空の指示を成功に見せない。届いたつもりで消えるのが一番たちが悪い
        send({
          type: "response",
          ...(id ? { id } : {}),
          command: "prompt",
          success: false,
          error: "empty message",
        });
        return;
      }
      appendLines(transcript.user(message));
      queue.push(message);
      send({ type: "response", ...(id ? { id } : {}), command: "prompt", success: true });
      return;
    }
    if (type === "abort") {
      queue.close();
      void session.interrupt().catch(() => undefined);
      return;
    }
    send({
      type: "response",
      ...(id ? { id } : {}),
      success: false,
      error: `unknown command: ${String(type)}`,
    });
  });
  process.stdin.on("end", () => queue.close());

  for await (const message of session) {
    appendLines(transcript.fromSdkMessage(message as Record<string, unknown>));

    if (message.type === "assistant") {
      contextWatch.observe((message.message as { usage?: unknown }).usage);
      const blocks = Array.isArray(message.message.content) ? message.message.content : [];
      for (const block of blocks) {
        if (block.type === "tool_use") calledTools.add(block.name);
        if (block.type === "text" && block.text.trim().length > 0) {
          lastAssistantText = block.text.trim();
        }
      }
      continue;
    }

    if (message.type === "result") {
      const unreported = endedWithoutReporting(calledTools);
      // 安全弁：報告も質問もせずにターンが終わったら、代わりに報告する（決定29e・P4）。
      // `auto: true` を付ける——**職人が自分で書いた報告ではない**ことを隠さない（I1）
      if (report && unreported) {
        await report
          .post("worker.report", {
            summary: lastAssistantText.length > 0 ? lastAssistantText : "(発話なしで手を止めました)",
            done: true,
            auto: true,
          })
          .catch((err: unknown) => {
            // 安全弁の失敗で職人のターンを壊さない。ただし黙らせない
            process.stderr.write(`[claude-agent] auto report failed: ${String(err)}\n`);
          });
      }
      /**
       * **喋り終わったことを、いつでも伝える**（PO要望 2026-08-11）。
       *
       * 上の安全弁は「報告しなかったとき」にしか動かない。報告したあとに手が空いたことは
       * どこにも出ず、起動元は明示の報告か**時間切れ**（既定15分）を待つしかなかった。
       * ターンの終わりはここで分かっているのだから、事実として渡す——意味は起動元が
       * 与える（決定29d）。
       */
      if (report) {
        await report
          .post("worker.turn_ended", {
            ...(lastAssistantText.length > 0 ? { text: lastAssistantText } : {}),
            reported: !unreported,
          })
          .catch((err: unknown) => {
            process.stderr.write(`[claude-agent] turn_ended failed: ${String(err)}\n`);
          });
      }
      calledTools = new Set<string>();
      lastAssistantText = "";
    }
  }
}

main().catch((err: unknown) => {
  process.stderr.write(`[claude-agent] ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  process.exit(1);
});

/**
 * **Agent SDK バックエンド**（ADR-0020 決定89・91・92・93）。`BantoHarness` の第二実装。
 *
 * 番頭を Claude Code（Agent SDK）で回す。職人側の `claude-agent/host.ts` が前例だが、
 * **あちらは別プロセス**（Worker Pool が pid で生死を見るため）。番頭は自分のプロセスで
 * 回す——記憶の注入とターン制御が番頭の本業で、そこはプロセスを跨げない（決定11）。
 *
 * ## 実測にもとづく要点（2026-08-12・実機で確認）
 *
 * - **組み込みツールは `tools: []` で切る。** `disallowedTools` に名前を並べても消えない
 *   ——Read/Bash 等10本を並べても `Cron*` / `Task*` / `Workflow` / `ToolSearch` など
 *   26本が残り、モデルは実際に `ToolSearch` を呼んだ。番頭の道具はいま56本に絞ってある
 *   （ADR-0019）ので、26本が黙って足されると絞った意味が消える。加えて組み込みの出力は
 *   banto の退避を通らない（決定92）
 * - **道具は wire 名で載せる。** MCP の名前は `mcp__<server>__<name>` になり、
 *   **ドットは単一アンダースコアに化ける**。論理名を渡すと第3の名前体系が生まれて
 *   逆引きが外れる（決定91）
 * - **章の種は系プロンプトに入れる。** ユーザーメッセージとして渡した回は使われなかった。
 *   `query()` を `resume` 無しで起こし直すと文脈は引き継がれない（決定93）
 *
 * D5: 判断は無い。語彙の翻訳と、SDK の手順を呼ぶだけ。
 * I2: 認証切れ・起動失敗は握りつぶさず、知らせとして番頭の会話へ出す。
 */

import { randomUUID } from "node:crypto";
import {
  createSdkMcpServer,
  query,
  tool,
  type Options,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type {
  BantoHarness,
  ChapterOpening,
  HarnessEvent,
  HarnessPromptOptions,
  NamespacedToolDefinition,
} from "@banto/core";
import { toWireToolName } from "@banto/core";
import { jsonSchemaToZodShape } from "./schema-to-zod.js";

/** banto の道具を載せる MCP サーバの名前。Tool の wire 名は `mcp__banto__<name>`。 */
export const BANTO_MCP_SERVER = "banto";

export interface ClaudeAgentHarnessOptions {
  /** 系プロンプト。記憶・SKILL・道具の一覧は番頭が組んで渡す（seam の外）。 */
  systemPrompt: string;
  /** 番頭の道具（**提示する集合だけ**。ADR-0019 決定82 で絞った後のもの）。 */
  tools: NamespacedToolDefinition[];
  /** `opus` / `sonnet` / `haiku` 等の別名か、完全なモデル ID。 */
  model?: string;
  /** 復元するときの SDK セッション ID。 */
  resume?: string;
}

/**
 * 指示の待ち行列（streaming input）。
 *
 * **空になっても終わらせない**のが要点。返り切ると `query()` が畳まれ、番頭は
 * 次の発話を受け取れなくなる。
 */
class PromptQueue {
  private readonly queued: SDKUserMessage[] = [];
  private waiting: ((v: IteratorResult<SDKUserMessage>) => void) | undefined;
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
    for (;;) {
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

/** 会話の記録（章の要約器へ渡す文章と、短すぎる判定に使う）。 */
interface Turn {
  role: "user" | "assistant";
  text: string;
}

export class ClaudeAgentHarness implements BantoHarness {
  readonly backendId = "claude-agent-sdk";
  private readonly options: ClaudeAgentHarnessOptions;
  private readonly listeners = new Set<(event: HarnessEvent) => void>();
  /** 論理名 ↔ この背後での名前（決定91）。両方向をハーネスが持つ。 */
  private readonly logicalByWire = new Map<string, string>();
  /** 呼び出しID → 論理名。SDK のツール結果は名前を持たないので、呼び出し側で覚える。 */
  private readonly nameByCallId = new Map<string, string>();

  private queue = new PromptQueue();
  private run: Promise<void> | undefined;
  private abortController: AbortController | undefined;
  private streaming = false;
  private sdkSessionId: string;
  /** いまの章の系プロンプト（`startChapter` で差し替わる）。 */
  private systemPrompt: string;
  private turns: Turn[] = [];
  private tokens: number | undefined;
  private thinkingStartedAt: number | undefined;

  constructor(options: ClaudeAgentHarnessOptions) {
    this.options = options;
    this.systemPrompt = options.systemPrompt;
    this.sdkSessionId = options.resume ?? randomUUID();
    for (const t of options.tools) {
      this.logicalByWire.set(`mcp__${BANTO_MCP_SERVER}__${toWireToolName(t.name)}`, t.name);
    }
  }

  get sessionId(): string {
    return this.sdkSessionId;
  }

  get isStreaming(): boolean {
    return this.streaming;
  }

  subscribe(handler: (event: HarnessEvent) => void): () => void {
    this.listeners.add(handler);
    return () => this.listeners.delete(handler);
  }

  private emit(event: HarnessEvent): void {
    for (const l of [...this.listeners]) l(event);
  }

  /** 番頭の道具を MCP の口として載せる。**wire 名で**（決定91）。 */
  private mcpServer() {
    return createSdkMcpServer({
      name: BANTO_MCP_SERVER,
      tools: this.options.tools.map((definition) =>
        tool(
          toWireToolName(definition.name),
          definition.description,
          jsonSchemaToZodShape(definition.parameters as never),
          async (args: unknown) => {
            /**
             * **ハンドラは番頭側のまま。** 退避・ターン予算・place の砦は
             * `toPiTool` の手前で皮として掛かっているので、ここを通れば
             * どちらのバックエンドでも同じように効く（決定91・task-0090）。
             */
            const result = await definition.execute(args, { toolCallId: randomUUID() });
            return { content: result.content as never };
          }
        )
      ),
    });
  }

  private buildOptions(): Options {
    return {
      // **自分で組んだ系プロンプトだけを使う**（preset を継がない）。番頭の人格は
      // banto が組み立てる——Claude Code の既定は「コードを書く道具」の人格なので合わない
      systemPrompt: this.systemPrompt,
      // 決定92: 組み込みは0本。`disallowedTools` では消えない（実測）
      tools: [],
      mcpServers: { [BANTO_MCP_SERVER]: this.mcpServer() },
      /**
       * 番頭の前には人が居るが、**可否を尋ねる相手はここではない**——判断を求める口は
       * 取次1本（決定73）。危険の境目は「渡した道具」と「書ける範囲」であって、
       * 呼び出しごとの確認ではない（pi と同じ）。
       *
       * なお名前を `allowedTools` に並べると `canUseTool` は**呼ばれない**（実測）。
       * 掛け金はハンドラの中にあるので成立するが、口はここに残しておく。
       */
      canUseTool: async (_name: string, input: Record<string, unknown>) => ({
        behavior: "allow" as const,
        updatedInput: input,
      }),
      // 置き場の設定ファイルを読まない（番頭は banto の開発者ではない・host-session.ts 参照）
      settingSources: [],
      ...(this.options.model ? { model: this.options.model } : {}),
      resume: this.sdkSessionId,
    };
  }

  /** `query()` を起こして、出てくるものを番頭の語彙へ翻訳し続ける。 */
  private start(): void {
    if (this.run) return;
    const controller = new AbortController();
    this.abortController = controller;
    const session = query({ prompt: this.queue.stream(), options: this.buildOptions() });
    this.run = (async () => {
      try {
        for await (const message of session) {
          this.translate(message as Record<string, unknown>);
        }
      } catch (error) {
        // I2: 落ちたことを握りつぶさない。会話に出して、番頭とPOの両方に見えるようにする
        this.emit({
          type: "notice",
          source: "system",
          text: `Claude Code のセッションが落ちました：${String(
            (error as Error)?.message ?? error
          )}`,
        });
      } finally {
        // **`run_end` はここで出さない**（`result` で出している）。両方で出すと
        // 章の判定が1ターンに2回走る（pi 側で同じ罠を踏んだ・決定89）
        this.streaming = false;
        this.run = undefined;
      }
    })();
  }

  async prompt(text: string, _options?: HarnessPromptOptions): Promise<void> {
    this.turns.push({ role: "user", text });
    this.streaming = true;
    this.queue.push(text);
    this.start();
  }

  async abort(): Promise<void> {
    this.abortController?.abort();
    this.streaming = false;
  }

  // ── 章 ──────────────────────────────────────────────────────────────────

  contextTokens(): number | undefined {
    return this.tokens;
  }

  messageCount(): number {
    return this.turns.length;
  }

  transcript(): string {
    return this.turns
      .map((t) => `${t.role === "user" ? "PO" : "番頭"}: ${t.text}`)
      .join("\n\n");
  }

  /**
   * **文脈を捨てて、種から始め直す**（決定93）。
   *
   * `resume` を渡さない新しい `query()` は文脈を引き継がない（実測）。種は
   * **系プロンプト**へ入れる——ユーザーメッセージとして渡した回は使われなかった。
   */
  async startChapter(opening: ChapterOpening): Promise<void> {
    this.queue.close();
    this.abortController?.abort();
    this.run = undefined;
    this.streaming = false;
    this.queue = new PromptQueue();
    // 新しいセッションにする（前の文脈へ戻れないようにする）
    this.sdkSessionId = randomUUID();
    this.systemPrompt = `${this.options.systemPrompt}\n\n${opening.text}`;
    this.turns = [];
    this.tokens = undefined;
  }

  // ── 語彙の翻訳（SDK のメッセージ → HarnessEvent） ──────────────────────

  private translate(message: Record<string, unknown>): void {
    const type = message["type"];

    if (type === "system" && message["subtype"] === "init") {
      const id = message["session_id"];
      if (typeof id === "string") this.sdkSessionId = id;
      return;
    }

    if (type === "assistant") {
      const content = ((message["message"] as { content?: unknown[] })?.content ?? []) as Array<
        Record<string, unknown>
      >;
      for (const block of content) {
        if (block["type"] === "text") {
          const text = String(block["text"] ?? "");
          if (text) {
            this.turns.push({ role: "assistant", text });
            this.emit({ type: "text_delta", delta: text });
          }
        } else if (block["type"] === "thinking") {
          // 思考は本文と別のチャネル（決定90）
          if (this.thinkingStartedAt === undefined) this.thinkingStartedAt = Date.now();
          const thought = String(block["thinking"] ?? "");
          if (thought) this.emit({ type: "reasoning_delta", delta: thought });
        } else if (block["type"] === "tool_use") {
          const wire = String(block["name"] ?? "");
          const callId = String(block["id"] ?? "");
          const logical = this.logicalByWire.get(wire) ?? wire;
          this.nameByCallId.set(callId, logical);
          this.emit({
            type: "tool_start",
            toolCallId: callId,
            name: logical,
            ...(block["input"] !== undefined ? { input: block["input"] } : {}),
          });
        }
      }
      if (this.thinkingStartedAt !== undefined) {
        this.emit({ type: "reasoning_end", durationMs: Date.now() - this.thinkingStartedAt });
        this.thinkingStartedAt = undefined;
      }
      return;
    }

    if (type === "user") {
      // ツール結果はユーザーメッセージとして返ってくる
      const content = ((message["message"] as { content?: unknown[] })?.content ?? []) as Array<
        Record<string, unknown>
      >;
      for (const block of content) {
        if (block["type"] !== "tool_result") continue;
        const callId = String(block["tool_use_id"] ?? "");
        // SDK のツール結果は名前を持たない。呼び出しIDで引いて**から**捨てる
        const logical = this.nameByCallId.get(callId) ?? "";
        this.nameByCallId.delete(callId);
        this.emit({
          type: "tool_end",
          toolCallId: callId,
          name: logical,
          isError: Boolean(block["is_error"]),
          ...(block["content"] !== undefined ? { output: block["content"] } : {}),
        });
      }
      return;
    }

    if (type === "result") {
      const usage = message["usage"] as Record<string, unknown> | undefined;
      if (usage) {
        const total =
          num(usage["input_tokens"]) +
          num(usage["cache_read_input_tokens"]) +
          num(usage["cache_creation_input_tokens"]) +
          num(usage["output_tokens"]);
        if (total > 0) {
          this.tokens = total;
          this.emit({ type: "turn_end", contextTokens: total });
        } else {
          this.emit({ type: "turn_end" });
        }
      } else {
        this.emit({ type: "turn_end" });
      }
      this.streaming = false;
      // **手を止めた**。章を閉じるかの判定はここ（決定89）
      this.emit({ type: "run_end" });
    }
  }
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

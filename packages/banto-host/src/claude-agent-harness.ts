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
  /**
   * **前の会話の札**（`resumeToken()` が返したもの・決定97）。
   *
   * 渡すと `resume` で続きから起こす。**渡さないときは `sessionId` で新しく立てる**
   * ——ここを取り違えて「新規なのに `resume` へ乱数の UUID を渡す」形になっていた。
   * 実在しない札の `resume` は `error_during_execution` で返り、翻訳の上では
   * 「本文の無いターン」に見える＝**番頭が黙る**（実測 2026-08-13・task-0104）。
   */
  resume?: string;
  /**
   * `query()` の差し替え。**試験のためだけ**にある口（本番は渡さない）。
   *
   * 世代の掛け金・待ち行列の作り直し・復元の失敗からの立て直しは、どれも
   * **`query()` が実際に立って終わる**ところでしか現れない——翻訳だけを流し込む
   * 試験では1件も落ちない。`PiHarness` が pi のセッションを受け取るのと同じ形で、
   * 起こす手続きを外から渡せるようにしてある。
   */
  spawnQuery?: (args: {
    prompt: AsyncIterable<SDKUserMessage>;
    options: Options;
  }) => AsyncIterable<unknown>;
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
  /**
   * **その札で `resume` できるか**（決定97）。
   *
   * 新しい会話では false ＝ `sessionId` で立てる。SDK が `init` を返した時点で
   * 記録が始まっている（実測：`~/.claude/projects/<場所>/<id>.jsonl` ができる）ので
   * true にする。`startChapter` で捨てたら false に戻す。
   */
  private sessionExists: boolean;
  /**
   * **走っている `query()` の世代**（task-0104）。
   *
   * `startChapter` と `dispose` は走行中のループを畳むが、非同期のループが実際に
   * 抜けるのはその後になる。世代を持たないと、**古いループの `finally` が新しい `run`
   * を消し**、次の発話で2本目の `query()` が立って発話が1つ握り潰される。
   */
  private generation = 0;
  /** この run で `resume` に渡した札（失敗したときに何を読み戻せなかったかを言うため）。 */
  private resumedFrom: string | undefined;
  /** この run で `init` を受け取ったか。復元の失敗はここが false のまま終わる形で出る。 */
  private sawInit = false;
  /** 差分（`stream_event`）で本文を受け取ったか。**二重に流さない**ための掛け金。 */
  private sawPartial = false;
  private disposed = false;
  /** いまの章の系プロンプト（`startChapter` で差し替わる）。 */
  private systemPrompt: string;
  private turns: Turn[] = [];
  private tokens: number | undefined;
  /** モデルの文脈長。**SDK が返したものを使う**（自前の表を持たない・D3）。 */
  private window: number | undefined;
  private thinkingStartedAt: number | undefined;

  constructor(options: ClaudeAgentHarnessOptions) {
    this.options = options;
    this.systemPrompt = options.systemPrompt;
    // **札があれば続きから、無ければ新しく立てる**（決定97）。ここを一本化していたのが
    // task-0104 の1番——新規にも `resume` を渡していた
    this.sdkSessionId = options.resume ?? randomUUID();
    this.sessionExists = options.resume !== undefined;
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
      /**
       * **止める口を実際に繋ぐ**。以前は `AbortController` を作るだけで渡しておらず、
       * `abort()` は `streaming = false` を立てるだけ——**画面は止まったと出るのに
       * モデルは走り続けた**（レビュー 2026-08-13）。
       */
      abortController: this.abortController ?? new AbortController(),
      ...(this.options.model ? { model: this.options.model } : {}),
      /**
       * **続きから起こすのか、新しく立てるのか**（決定97）。
       *
       * `resume` は既にある会話の札。`sessionId` は「この UUID で立てる」——SDK の型注釈も
       * 両立しないと明記している（`Cannot be used with continue or resume`）。
       * 新規に `resume` を渡すと SDK は `error_during_execution` を返し、翻訳の上では
       * 本文の無いターンになる＝番頭が黙る（実測 2026-08-13）。
       */
      ...(this.sessionExists
        ? { resume: this.sdkSessionId }
        : { sessionId: this.sdkSessionId }),
      /**
       * **本文を差分で流す**（task-0104 の6番）。無いとターンが終わるまで画面が無音で、
       * 長考するモデルほど「止まっている」と見分けがつかない。
       */
      includePartialMessages: true,
    };
  }

  /** `query()` を起こして、出てくるものを番頭の語彙へ翻訳し続ける。 */
  private start(): void {
    if (this.run) return;
    // **世代を1つ進める**（task-0104 の4番）。畳んだ後に抜けてくる古いループが、
    // ここで立てた新しい run を消さないようにする
    const generation = ++this.generation;
    this.abortController = new AbortController();
    this.sawInit = false;
    this.resumedFrom = this.sessionExists ? this.sdkSessionId : undefined;
    const spawn = this.options.spawnQuery ?? query;
    const session = spawn({ prompt: this.queue.stream(), options: this.buildOptions() });
    this.run = (async () => {
      try {
        for await (const message of session) {
          // 畳んだ後に届く古い query の残響は流さない（章を跨いで前の章の発話が出る）
          if (generation !== this.generation) break;
          this.translate(message as Record<string, unknown>);
        }
      } catch (error) {
        // I2: 落ちたことを握りつぶさない。会話に出して、番頭とPOの両方に見えるようにする
        if (generation === this.generation) {
          this.emit({
            type: "notice",
            source: "system",
            text: `Claude Code のセッションが落ちました：${String(
              (error as Error)?.message ?? error
            )}`,
          });
        }
      } finally {
        // **`run_end` はここで出さない**（`result` で出している）。両方で出すと
        // 章の判定が1ターンに2回走る（pi 側で同じ罠を踏んだ・決定89）
        if (generation === this.generation) {
          this.streaming = false;
          this.run = undefined;
          /**
           * **待ち行列を作り直す。** `query()` が終わると入力の生成器も終わるが、
           * その生成器は `PromptQueue.waiting` に自分の resolver を残したまま止まる
           * ——次の発話はその死んだ生成器へ渡り、**どこにも届かない**。
           * 起こし直すときは新しい行列から始める。
           */
          this.queue.close();
          this.queue = new PromptQueue();
        }
      }
    })();
  }

  async prompt(text: string, options?: HarnessPromptOptions): Promise<void> {
    // I2: 畳んだハーネスへ話しかけられたら黙って捨てない（発話が消えたことに気づけない）
    if (this.disposed) {
      throw new Error("このハーネスは畳まれています（dispose 済み）。新しく組み立ててください");
    }
    /**
     * I2: **黙って落とさない。** 画像はまだ載せられないので、その旨を本文に足して
     * 番頭に伝える——添付したのに何も言われないのが一番困る。
     */
    const images = options?.images ?? [];
    const body =
      images.length > 0
        ? `${text}\n\n（このバックエンドでは画像 ${images.length} 件を渡せませんでした。` +
          "内容が要るなら、文章で伝えるか pi のバックエンドへ切り替えてください）"
        : text;
    this.turns.push({ role: "user", text: body });
    this.streaming = true;
    this.queue.push(body);
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
    // **世代を進めてから畳む**（task-0104 の4番）。古いループの `finally` が
    // 新しい run を消さないようにするのが要点で、順序を逆にすると効かない
    this.generation++;
    this.queue.close();
    this.abortController?.abort();
    this.run = undefined;
    this.streaming = false;
    this.queue = new PromptQueue();
    // 新しいセッションにする（前の文脈へ戻れないようにする）。**まだ実在しない**ので
    // 次は `resume` ではなく `sessionId` で立てる（決定97）
    this.sdkSessionId = randomUUID();
    this.sessionExists = false;
    this.systemPrompt = `${this.options.systemPrompt}\n\n${opening.text}`;
    this.turns = [];
    this.tokens = undefined;
  }

  // ── 復元と後始末（決定97・task-0104） ──────────────────────────────────

  /**
   * 次の起動でこの会話を続けるための札。**一度も往復していなければ無い**
   * ——実在しない札を保存すると、次の起動でその `resume` が必ず失敗する。
   */
  resumeToken(): string | undefined {
    return this.sessionExists ? this.sdkSessionId : undefined;
  }

  /** モデルの文脈長。SDK が `result` で返した値（自前の表を持たない）。 */
  contextWindow(): number | undefined {
    return this.window;
  }

  /**
   * **畳む**（task-0104 の3番）。
   *
   * `PromptQueue` は「空になっても終わらせない」設計なので、参照を落とすだけでは
   * `query()` が生き続け、**バックエンドを往復するたびに Claude Code の子プロセスが
   * 積み上がる**。待ち行列を閉じて（＝入力の生成器を返し切らせて）から止める。
   */
  async dispose(): Promise<void> {
    if (this.disposed) return; // 冪等
    this.disposed = true;
    // 走っているループの後始末を無効化してから畳む（世代の掛け金）
    this.generation++;
    this.queue.close();
    this.abortController?.abort();
    this.streaming = false;
    this.run = undefined;
    this.listeners.clear();
  }

  // ── 語彙の翻訳（SDK のメッセージ → HarnessEvent） ──────────────────────

  private translate(message: Record<string, unknown>): void {
    const type = message["type"];

    if (type === "system" && message["subtype"] === "init") {
      const id = message["session_id"];
      if (typeof id === "string") this.sdkSessionId = id;
      // ここまで来れば SDK 側に記録が始まっている＝次からは `resume` で戻れる（決定97）
      this.sessionExists = true;
      this.sawInit = true;
      return;
    }

    /**
     * **本文と思考の差分**（`includePartialMessages`・task-0104 の6番）。
     *
     * 中身は Anthropic の生のストリームイベント。ここで流したものは、後から届く
     * `assistant` の全文で**もう一度流さない**（`sawPartial`）。
     */
    if (type === "stream_event") {
      const event = message["event"] as Record<string, unknown> | undefined;
      if (event?.["type"] !== "content_block_delta") return;
      const delta = event["delta"] as Record<string, unknown> | undefined;
      const kind = delta?.["type"];
      if (kind === "text_delta") {
        const text = String(delta?.["text"] ?? "");
        if (text) {
          this.sawPartial = true;
          this.emit({ type: "text_delta", delta: text });
        }
      } else if (kind === "thinking_delta") {
        const thought = String(delta?.["thinking"] ?? "");
        if (thought) {
          this.sawPartial = true;
          if (this.thinkingStartedAt === undefined) this.thinkingStartedAt = Date.now();
          this.emit({ type: "reasoning_delta", delta: thought });
        }
      }
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
            // 記録は全文から作る（差分で流したかに依らず、章の要約器へ渡すものは要る）
            this.turns.push({ role: "assistant", text });
            // 差分で流し済みなら**もう一度流さない**（同じ本文が2回出る）
            if (!this.sawPartial) this.emit({ type: "text_delta", delta: text });
          }
        } else if (block["type"] === "thinking") {
          // 思考は本文と別のチャネル（決定90）
          if (this.thinkingStartedAt === undefined) this.thinkingStartedAt = Date.now();
          const thought = String(block["thinking"] ?? "");
          if (thought && !this.sawPartial) this.emit({ type: "reasoning_delta", delta: thought });
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
      // 次の塊の差分はこれから届く。ここで戻しておかないと、道具を挟んだ2つ目以降の
      // 発話が「差分で流し済み」と誤判定されて消える
      this.sawPartial = false;
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
      /**
       * **モデルの文脈長**は SDK が返したものを使う（task-0104 の5番）。自前の表を
       * 持つと世代が上がるたびに書き換えて回ることになり、忘れれば黙ってずれる（D3）。
       */
      const modelUsage = message["modelUsage"] as Record<string, unknown> | undefined;
      for (const entry of Object.values(modelUsage ?? {})) {
        const w = (entry as Record<string, unknown> | undefined)?.["contextWindow"];
        if (typeof w === "number" && w > 0) this.window = w;
      }
      /**
       * **エラーで終わったターンを黙って通さない**（I2・task-0104）。
       *
       * 翻訳は `result` を一様に「ターンの終わり」として扱っていたので、
       * `error_during_execution` は**本文の無いターン**にしか見えなかった
       * ——番頭が黙る、という一番診断しにくい形で出る。
       */
      const subtype = message["subtype"];
      if (typeof subtype === "string" && subtype !== "success") {
        const failedResume = this.resumedFrom !== undefined && !this.sawInit;
        this.emit({
          type: "notice",
          source: "system",
          text: failedResume
            ? `前の会話（${this.resumedFrom}）を読み戻せませんでした（${subtype}）。` +
              "この会話は続きからではなく、新しく始め直します——" +
              "画面の記録は残っていますが、番頭はこれ以前を覚えていません。"
            : `Claude Code がターンを終えられませんでした（${subtype}）。`,
        });
        if (failedResume) {
          /**
           * **読み戻せない札を握り続けない。** 掴んだままだと以後どの発話も同じ理由で
           * 落ち、会話が永久に死ぬ。新しく立て直す（何が起きたかは上で知らせている）。
           */
          this.sessionExists = false;
          this.sdkSessionId = randomUUID();
          this.resumedFrom = undefined;
        }
      }
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

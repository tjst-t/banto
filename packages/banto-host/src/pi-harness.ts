/**
 * **pi バックエンド**（ADR-0020 決定89）。`BantoHarness` の第一実装。
 *
 * pi の `AgentSession` を包み、**pi の語彙をここで完全に閉じる**:
 *
 * - 生のイベント → `HarnessEvent`（`server.ts` の `toServerEvent` から下ろした）
 * - 章の切れ目 → `startChapter`（`chapters.ts` から下ろした
 *   `appendCompaction(keepNothing)` ＋ `buildSessionContext`）
 * - 文脈トークンの実測と見積もり
 *
 * **挙動は変えない。** この段は seam を切るだけで、振る舞いが変わらないことを
 * `npm test` で押さえるのが価値（ADR-0020「段取り」1）。
 *
 * D5: 判断は無い。語彙の翻訳と、pi の手順をそのまま呼ぶだけ。
 */

import {
  calculateContextTokens,
  estimateTokens,
  type AgentSession,
} from "@earendil-works/pi-coding-agent";
import type {
  BantoHarness,
  ChapterOpening,
  HarnessEvent,
  HarnessPromptOptions,
} from "@banto/core";

/** 会話の口だけを持つ皮（`withEmptyResponseGuard` の戻り値など）。 */
export interface PiConversationFacade {
  readonly sessionId: string;
  readonly isStreaming: boolean;
  subscribe(listener: (event: unknown) => void): () => void;
  prompt(text: string, options?: unknown): Promise<void>;
  abort(): Promise<void>;
  setModel?(model: unknown): Promise<void>;
}

export interface PiHarnessOptions {
  /**
   * **会話の口**。空応答ガード（imp-0016）とターン予算の皮を通したものを渡す。
   *
   * 皮は `HostSession` の口だけを持つ委譲オブジェクトで、pi の内部（`agent` /
   * `sessionManager`）は通さない。だから下の `agentSession` を別に受け取る。
   */
  session: PiConversationFacade;
  /**
   * **pi の内部**。文脈の量と章の操作に要る（`agent.state.messages` /
   * `sessionManager.appendCompaction` / `setAutoCompactionEnabled`）。
   *
   * **皮を渡してはいけない。** 皮は会話の口しか持たないので、ここへ渡すと
   * 章立てが実行時に落ちる（実際に落ちた——全会話が開き直せなくなった）。
   */
  agentSession: AgentSession;
  /**
   * wire 名 → 論理名（決定22）。**ハーネスが持つ**——名前の対応はバックエンドごとに
   * 違うため（決定91：Agent SDK では `mcp__banto__worker__delegate` になる）。
   */
  toLogicalName: (wireName: string) => string;
  /** 会話の記録を組み立てる（章の要約器へ渡す文章）。pi のメッセージ列を読む。 */
  renderTranscript: (messages: readonly unknown[]) => string;
}

function numberOf(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export class PiHarness implements BantoHarness {
  readonly backendId = "pi";
  private readonly session: PiConversationFacade;
  /** pi の内部。皮では届かない（文脈の量と章の操作に要る）。 */
  private readonly pi: AgentSession;
  private readonly toLogicalName: (wireName: string) => string;
  private readonly renderTranscript: (messages: readonly unknown[]) => string;
  /** 思考が始まった時刻。**このセッションのもの**（以前は server が threadId で持っていた）。 */
  private thinkingStartedAt: number | undefined;

  constructor(options: PiHarnessOptions) {
    this.session = options.session;
    this.pi = options.agentSession;
    /**
     * I2: **皮を渡されたら黙って進まない。** 皮は会話の口しか持たないので、そのまま
     * 進むと章を閉じる段（会話を開き直す段）で初めて落ちる——実際に落ちて、
     * 全会話が開き直せなくなった。組み立てたその場で止める。
     */
    // 見るのは**皮と本体を見分けるのに足りる2つ**。`sessionManager` は章を閉じるときに
    // だけ要るので、ここでは必須にしない（翻訳だけを使う呼び出し元を巻き込まないため）
    const missing = ["agent", "setAutoCompactionEnabled"].filter(
      (k) => (this.pi as unknown as Record<string, unknown>)[k] === undefined
    );
    if (missing.length > 0) {
      throw new Error(
        `PiHarness の agentSession に pi の内部がありません（${missing.join(" / ")}）。` +
          "会話の口の皮ではなく、createAgentSession が返した本体を渡してください。"
      );
    }
    this.toLogicalName = options.toLogicalName;
    this.renderTranscript = options.renderTranscript;
    /**
     * **自動コンパクションを切る。** これを切らないと、章を閉じる前に pi が要約で潰す。
     * 章の境界は番頭が持つ（ADR-0003 / 提案§3.2）——ここが契約の前提なので、
     * `ChapterKeeper.start()` ではなくハーネスの生成時に済ませる。
     */
    this.pi.setAutoCompactionEnabled(false);
  }

  get sessionId(): string {
    return this.session.sessionId;
  }

  get isStreaming(): boolean {
    return this.session.isStreaming;
  }

  async prompt(text: string, options?: HarnessPromptOptions): Promise<void> {
    await this.session.prompt(text, options);
  }

  async abort(): Promise<void> {
    await this.session.abort();
  }

  async setModel(model: unknown): Promise<void> {
    const withSetModel = this.session as unknown as {
      setModel?: (m: unknown) => Promise<void> | void;
    };
    if (withSetModel.setModel) await withSetModel.setModel(model);
  }

  subscribe(handler: (event: HarnessEvent) => void): () => void {
    return this.session.subscribe((raw: unknown) => {
      const translated = this.translate(raw);
      if (translated) handler(translated);
    });
  }

  // ── 章 ──────────────────────────────────────────────────────────────────

  private messages(): readonly unknown[] {
    return this.pi.agent.state.messages as readonly unknown[];
  }

  contextTokens(): number | undefined {
    const messages = this.messages() as ReadonlyArray<
      { role?: string; usage?: unknown } | undefined
    >;
    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i];
      if (message && message.role === "assistant" && "usage" in message && message.usage) {
        return calculateContextTokens(message.usage as never);
      }
    }
    if (messages.length === 0) return undefined;
    return messages.reduce((sum, message) => sum + estimateTokens(message as never), 0);
  }

  messageCount(): number {
    return this.messages().length;
  }

  transcript(): string {
    return this.renderTranscript(this.messages());
  }

  async startChapter(opening: ChapterOpening): Promise<void> {
    // 境界より前は1件も残さない。`firstKeptEntryId` にどのエントリとも一致しない値を
    // 渡すと `buildSessionContext` が「残さない」を選ぶ（chapters.ts 冒頭の説明）
    const keepNothing = `chapter-boundary:${opening.handoffId}`;
    this.pi.sessionManager.appendCompaction(
      opening.text,
      keepNothing,
      opening.tokensBefore,
      { bantoChapter: opening.chapter, handoffId: opening.handoffId },
      // fromHook: pi が作った要約ではないと分かるようにする
      true
    );
    // pi の compact() と同じ手順。ここを忘れると、書いたのに文脈が畳まれない
    this.pi.agent.state.messages = this.pi.sessionManager.buildSessionContext().messages;
  }

  // ── 語彙の翻訳（pi のイベント → HarnessEvent） ─────────────────────────

  private translate(event: unknown): HarnessEvent | undefined {
    const e = event as {
      type?: string;
      toolCallId?: string;
      toolName?: string;
      isError?: boolean;
      args?: unknown;
      result?: unknown;
      assistantMessageEvent?: { type?: string; delta?: string };
    } | null;

    if (e?.type === "message_update" && e.assistantMessageEvent?.type === "text_delta") {
      return { type: "text_delta", delta: String(e.assistantMessageEvent.delta) };
    }
    // 思考（thinking）。**本文とは別のチャネル**（決定90）
    if (e?.type === "message_update" && e.assistantMessageEvent?.type === "thinking_start") {
      this.thinkingStartedAt = Date.now();
      return undefined;
    }
    if (e?.type === "message_update" && e.assistantMessageEvent?.type === "thinking_delta") {
      return { type: "reasoning_delta", delta: String(e.assistantMessageEvent.delta) };
    }
    if (e?.type === "message_update" && e.assistantMessageEvent?.type === "thinking_end") {
      const startedAt = this.thinkingStartedAt;
      this.thinkingStartedAt = undefined;
      // 開始を見ていない（途中で繋がった等）ときは 0。時間を推測して名乗らない（I1）
      return { type: "reasoning_end", durationMs: startedAt === undefined ? 0 : Date.now() - startedAt };
    }

    /**
     * 文脈のまとめ直し（compaction）。**黙って進めない**——自動は切ってあるが、
     * 手動・あふれによる発火は起こりうる。話した内容が実際に削られるので会話に残す
     * （PO要望 2026-08-04：それまで画面には何も出ていなかった）。
     */
    if (e?.type === "compaction_end") {
      const done = e as {
        reason?: string;
        aborted?: boolean;
        errorMessage?: string;
        result?: { tokensBefore?: number };
      };
      if (done.aborted) return undefined;
      // I2: 失敗したことも隠さない（要約できないまま長い文脈で走り続ける）
      if (done.errorMessage) {
        return {
          type: "notice",
          source: "system",
          text: `文脈のまとめ直しに失敗しました：${done.errorMessage}`,
        };
      }
      const before = done.result?.tokensBefore;
      const why =
        done.reason === "overflow"
          ? "文脈があふれたため"
          : done.reason === "manual"
            ? "指示により"
            : "文脈が長くなったため";
      return {
        type: "notice",
        source: "system",
        text:
          `${why}、ここまでの会話をまとめ直しました` +
          (before ? `（まとめる前 ${before.toLocaleString()} トークン）` : "") +
          "。**古いやり取りは要約に置き換わっています**——番頭が細部を覚えていないときは、" +
          "必要な前提をもう一度伝えてください。",
      };
    }

    // ターンの終わりに、そのターンで運んだトークン数が分かる。
    // **入力＋キャッシュ＋出力**＝次のターンで運ぶ量の目安（文脈の使用量として出す）
    //
    // **pi の usage はターンの累計ではない**——imp-0051 で claude 側が踏んだ穴（`result.usage`
    // が全 API 呼び出しの累計で、道具の回数だけ膨れる）は、ここには無い。pi の `turn_end` は
    // provider へ1回投げるごとに出て（`AgentLoopHooks.prepareNextTurn` の注：「after `turn_end`
    // and before the loop decides whether another provider request should start」）、
    // `message.usage` はその1回ぶんを `=` で入れている（pi-ai `api/anthropic-messages.js`:
    // `output.usage.input = event.message.usage.input_tokens`）。だからこの足し算は
    // 「いま窓に載っている量」で、claude 側と見比べて直しに来る必要は無い。
    if (e?.type === "turn_end") {
      const usage = (e as { message?: { usage?: Record<string, unknown> } }).message?.usage;
      if (usage) {
        const tokens =
          numberOf(usage["input"]) +
          numberOf(usage["cacheRead"]) +
          numberOf(usage["cacheWrite"]) +
          numberOf(usage["output"]);
        if (tokens > 0) return { type: "turn_end", contextTokens: tokens };
      }
      return { type: "turn_end" };
    }

    /**
     * pi の `agent_end`＝道具の呼び出しも含めてひと仕事終わり、入力待ちになった。
     * **`turn_end` と畳まない**——畳むと章の判定が1ターンに2回走る（挙動が変わる）。
     */
    if (e?.type === "agent_end") return { type: "run_end" };

    if (e?.type === "tool_execution_start") {
      return {
        type: "tool_start",
        toolCallId: String(e.toolCallId),
        name: this.toLogicalName(String(e.toolName)),
        ...(e.args !== undefined ? { input: e.args } : {}),
      };
    }
    if (e?.type === "tool_execution_end") {
      return {
        type: "tool_end",
        toolCallId: String(e.toolCallId),
        name: this.toLogicalName(String(e.toolName)),
        isError: Boolean(e.isError),
        ...(e.result !== undefined ? { output: e.result } : {}),
      };
    }
    return undefined;
  }
}

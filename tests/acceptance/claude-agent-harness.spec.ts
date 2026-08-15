/**
 * **Agent SDK バックエンド**（ADR-0020 決定91・92・93）。
 *
 * 実機で確かめた4点を、機構として固定する試験:
 *   1. 道具は wire 名で載る（ドットは MCP 側で化けるため）
 *   2. 組み込みツールは0本（`tools: []`。`disallowedTools` では消えない）
 *   3. 章の種は系プロンプトへ入り、文脈は引き継がない
 *   4. `run_end` は1ターンにちょうど1回（畳むと章の判定が二重に走る）
 *
 * 実際に Claude を叩かない——**組み立てと翻訳だけ**を見る（試験でサブスクリプションを
 * 消費しないため）。生きた往復は実機の確認で見る。
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { Type } from "typebox";

import type { HarnessEvent } from "@banto/core";
import { defineNamespacedTool } from "@banto/core";
import { ClaudeAgentHarness, jsonSchemaToZodShape } from "@banto/host";

function stub(name: `${string}.${string}`, parameters = Type.Object({})) {
  return defineNamespacedTool({
    name,
    label: name,
    description: `Stub ${name}.`,
    parameters,
    async execute() {
      return { content: [{ type: "text" as const, text: "ok" }] };
    },
  });
}

/** 翻訳だけを見るために、SDK のメッセージを直接流し込む。 */
function feed(harness: ClaudeAgentHarness, messages: unknown[]): HarnessEvent[] {
  const out: HarnessEvent[] = [];
  harness.subscribe((e) => out.push(e));
  const translate = (harness as unknown as { translate(m: Record<string, unknown>): void })
    .translate;
  for (const m of messages) translate.call(harness, m as Record<string, unknown>);
  return out;
}

describe("[ADR-0020 決定91] 道具は wire 名で載り、論理名へ戻る", () => {
  it("MCP の名前は mcp__banto__<wire名>。ドットは使わない", () => {
    const harness = new ClaudeAgentHarness({
      systemPrompt: "sp",
      tools: [stub("worker.delegate"), stub("place.request_write")],
    });
    const out = feed(harness, [
      {
        type: "assistant",
        message: {
          content: [
            { type: "tool_use", id: "c1", name: "mcp__banto__worker__delegate", input: { a: 1 } },
          ],
        },
      },
    ]);
    const start = out.find((e) => e.type === "tool_start");
    assert.ok(start?.type === "tool_start");
    assert.equal(start.name, "worker.delegate", "論理名へ戻す（決定22）");
  });

  it("ツール結果は呼び出しIDで名前を引く（SDK は名前を持たない）", () => {
    const harness = new ClaudeAgentHarness({ systemPrompt: "sp", tools: [stub("file.read")] });
    const out = feed(harness, [
      {
        type: "assistant",
        message: {
          content: [{ type: "tool_use", id: "c9", name: "mcp__banto__file__read", input: {} }],
        },
      },
      {
        type: "user",
        message: {
          content: [
            { type: "tool_result", tool_use_id: "c9", content: "本文", is_error: false },
          ],
        },
      },
    ]);
    const end = out.find((e) => e.type === "tool_end");
    assert.ok(end?.type === "tool_end");
    assert.equal(end.name, "file.read", "呼び出しIDで対応づく");
    assert.equal(end.isError, false);
  });

  it("知らない名前はそのまま通す（黙って落とさない）", () => {
    const harness = new ClaudeAgentHarness({ systemPrompt: "sp", tools: [] });
    const out = feed(harness, [
      { type: "assistant", message: { content: [{ type: "tool_use", id: "x", name: "Bash" }] } },
    ]);
    assert.ok(out[0]?.type === "tool_start" && out[0].name === "Bash");
  });
});

describe("[ADR-0020 決定92] 番頭に組み込みツールを持たせない", () => {
  it("SDK へ渡す tools は空（disallowedTools では消えないため）", () => {
    const harness = new ClaudeAgentHarness({ systemPrompt: "sp", tools: [stub("worker.close")] });
    const options = (
      harness as unknown as { buildOptions(): { tools: unknown; mcpServers: object } }
    ).buildOptions();
    assert.deepEqual(options.tools, [], "空でないと Cron*/Task*/ToolSearch 等が残る（実測）");
    assert.ok("banto" in options.mcpServers, "番頭の道具は MCP の口として載る");
  });

  it("置き場の設定ファイルを読まない（番頭は banto の開発者ではない）", () => {
    const harness = new ClaudeAgentHarness({ systemPrompt: "sp", tools: [] });
    const options = (
      harness as unknown as { buildOptions(): { settingSources: unknown[] } }
    ).buildOptions();
    assert.deepEqual(options.settingSources, []);
  });
});

describe("[ADR-0020 決定93] 章の切れ目は種から始め直す", () => {
  it("種は系プロンプトへ入り、記録は空になり、セッションが変わる", async () => {
    // **本物の `query()` を起こさない**。ここで起こすと試験が Claude Code の
    // 子プロセスを立て、`prompt()` がターンの終わりを待つぶん実際に往復してしまう
    const { harness } = withFakeQuery({ systemPrompt: "元の人格" });
    void harness.prompt("最初の話");
    await settle();
    assert.equal(harness.messageCount(), 1);
    const before = harness.sessionId;

    await harness.startChapter({
      text: "## 前章の要約\n退避を先に入れると決めた。",
      tokensBefore: 1234,
      chapter: 2,
      handoffId: "h-2",
    });

    assert.equal(harness.messageCount(), 0, "文脈は捨てる");
    assert.notEqual(harness.sessionId, before, "前の文脈へ戻れないよう別セッションにする");
    const options = (
      harness as unknown as { buildOptions(): { systemPrompt: string } }
    ).buildOptions();
    assert.match(options.systemPrompt, /元の人格/);
    assert.match(options.systemPrompt, /前章の要約/, "**種はユーザー発話ではなく系プロンプト**");
  });

  /**
   * [番頭指示 2026-08-14・疑い(A)への答え] `buildOptions()` を覗くだけでは
   * 「そのターンで何を渡すか」は分からない——実際に `prompt()` を起こして、
   * `spawnQuery` が受け取った options を見て初めて確かめられる。
   *
   * 畳む前は `resume` で前章から続けて起こしていた会話が、畳んだ直後の最初の
   * 起動では `resume` を渡さず、新しい `sessionId` で立つことを確認する。
   * `resume` が残っていたら、それこそが「畳んだのに前章の文脈へ戻ってしまう」
   * 本体側の不具合になるはずだったが、**実測では残っていない**。
   */
  it("[事実確定/A] 畳んだ後の最初の起動は resume を渡さず、新しい sessionId で立つ", async () => {
    const { harness, spawned } = withFakeQuery({ resume: "old-chapter-session" });
    void harness.prompt("前章の話");
    await settle();
    assert.equal(spawned.length, 1);
    assert.equal(
      spawned[0]!.options.resume,
      "old-chapter-session",
      "前提：畳む前は resume で前章から続けて起こしている"
    );
    assert.ok(!("sessionId" in spawned[0]!.options), "resume と sessionId は両立しない（SDK の型どおり）");

    await harness.startChapter({ text: "種", tokensBefore: 1, chapter: 2, handoffId: "h-2" });
    void harness.prompt("新しい章の話");
    await settle();

    assert.equal(spawned.length, 2, "新しい章は新しい query で始まる");
    const nextOptions = spawned[1]!.options;
    assert.ok(
      !("resume" in nextOptions),
      "前章の resume 札を渡していない（渡っていたら前章の文脈へ戻ってしまう＝本体の不具合）"
    );
    assert.equal(typeof nextOptions.sessionId, "string", "代わりに新しい sessionId で立てる");
    assert.notEqual(nextOptions.sessionId, "old-chapter-session", "前章の札とは別物");
    assert.equal(nextOptions.sessionId, harness.sessionId, "ハーネスが名乗るセッションIDと一致する");
  });

  /**
   * [PO報告 2026-08-14・事実確定] 畳んだ直後、`contextTokens()` は前章の実測を
   * 引きずらない——`startChapter` が `this.tokens = undefined` に戻すので、
   * 次のターンの `result` が来るまで「まだ分からない」を正しく返す。
   *
   * ただし、この遷移自体は**出来事として配られない**——`toServerEvent` は
   * `contextTokens === undefined` の `turn_end` を握りつぶすので、ハーネス側は
   * 直っていても、ホスト側の帳簿（`server.ts` の `contextTokens` Map）は
   * 前章の値を持ったまま残る（`banto-host-server.spec.ts` の事実確定テストを参照）。
   */
  it("[事実確定] 畳んだ直後の contextTokens() は前章の実測を引きずらない", async () => {
    const { harness } = withFakeQuery({ systemPrompt: "元の人格" });
    const out = feed(harness, [
      {
        type: "result",
        usage: {
          input_tokens: 100,
          cache_read_input_tokens: 400,
          cache_creation_input_tokens: 0,
          output_tokens: 50,
        },
      },
    ]);
    assert.ok(out[0]?.type === "turn_end" && out[0].contextTokens === 550);
    assert.equal(harness.contextTokens(), 550, "前提：畳む前は前章の実測が出る");

    await harness.startChapter({ text: "種", tokensBefore: 550, chapter: 2, handoffId: "h-2" });

    assert.equal(harness.contextTokens(), undefined, "前章の実測を引きずらず「まだ分からない」に戻る");
  });
});

describe("[ADR-0020 決定89] ターンの終わりは1回だけ", () => {
  it("result で turn_end と run_end が1回ずつ出る", () => {
    const harness = new ClaudeAgentHarness({ systemPrompt: "sp", tools: [] });
    const out = feed(harness, [
      {
        type: "result",
        usage: {
          input_tokens: 100,
          cache_read_input_tokens: 400,
          cache_creation_input_tokens: 0,
          output_tokens: 50,
        },
      },
    ]);
    assert.deepEqual(
      out.map((e) => e.type),
      ["turn_end", "run_end"]
    );
    assert.ok(out[0]?.type === "turn_end" && out[0].contextTokens === 550);
    assert.equal(harness.contextTokens(), 550);
  });

  it("使用量が無いターンは量を名乗らない（0 と偽らない・I1）", () => {
    const harness = new ClaudeAgentHarness({ systemPrompt: "sp", tools: [] });
    const out = feed(harness, [{ type: "result" }]);
    assert.deepEqual(out, [{ type: "turn_end" }, { type: "run_end" }]);
  });

  it("思考は本文と別のチャネルで出る（決定90）", () => {
    const harness = new ClaudeAgentHarness({ systemPrompt: "sp", tools: [] });
    const out = feed(harness, [
      {
        type: "assistant",
        message: {
          content: [
            { type: "thinking", thinking: "考え中" },
            { type: "text", text: "はい" },
          ],
        },
      },
    ]);
    assert.deepEqual(
      out.map((e) => e.type),
      ["reasoning_delta", "text_delta", "reasoning_end"]
    );
  });
});

/**
 * **復元と後始末**（決定97・task-0104）。
 *
 * 実測（2026-08-13・実機の Agent SDK 0.3.229）でこの試験の前提を確かめてある:
 *   - `sessionId: <UUID>` で立てた会話は、別プロセスの `resume: <同じUUID>` で戻る
 *   - **実在しない札の `resume` は `error_during_execution`** で返る。`init` は来ず、
 *     本文も無い——翻訳の上では「空のターン」にしか見えない＝番頭が黙る
 */
describe("[決定97] 復元の札（resume）と、新しく立てる（sessionId）を取り違えない", () => {
  it("新しい会話は sessionId で立てる（resume を渡さない）", () => {
    const harness = new ClaudeAgentHarness({ systemPrompt: "sp", tools: [] });
    const options = (
      harness as unknown as { buildOptions(): { resume?: string; sessionId?: string } }
    ).buildOptions();
    assert.equal(options.resume, undefined, "実在しない札で resume すると SDK がエラーで返す");
    assert.match(options.sessionId ?? "", /^[0-9a-f-]{36}$/, "自分で決めた UUID で立てる");
  });

  it("札を渡された会話は resume で続きから起こす", () => {
    const harness = new ClaudeAgentHarness({
      systemPrompt: "sp",
      tools: [],
      resume: "11111111-2222-3333-4444-555555555555",
    });
    const options = (
      harness as unknown as { buildOptions(): { resume?: string; sessionId?: string } }
    ).buildOptions();
    assert.equal(options.resume, "11111111-2222-3333-4444-555555555555");
    assert.equal(options.sessionId, undefined, "resume と sessionId は両立しない（SDK の型注釈）");
  });

  it("一度も往復していない会話は札を名乗らない（保存すると次の起動で必ず失敗する）", () => {
    const harness = new ClaudeAgentHarness({ systemPrompt: "sp", tools: [] });
    assert.equal(harness.resumeToken(), undefined);
    feed(harness, [{ type: "system", subtype: "init", session_id: "sdk-1" }]);
    assert.equal(harness.resumeToken(), "sdk-1", "init が来た＝SDK 側に記録がある");
  });

  it("章を畳んだら札を捨てる（前の文脈へ戻れないようにする・決定93）", async () => {
    const harness = new ClaudeAgentHarness({ systemPrompt: "sp", tools: [], resume: "old" });
    assert.equal(harness.resumeToken(), "old");
    await harness.startChapter({ text: "種", tokensBefore: 1, chapter: 2, handoffId: "h" });
    assert.equal(harness.resumeToken(), undefined, "新しい章は新しく立てる");
  });
});

describe("[決定97] 黙って終わるターンを作らない（I2）", () => {
  it("読み戻せなかったときは知らせを出し、札を捨てて立て直す", () => {
    const harness = new ClaudeAgentHarness({ systemPrompt: "sp", tools: [], resume: "gone" });
    // `start()` を通らない試験なので、この run で resume に渡した状態を作る
    Object.assign(harness as unknown as Record<string, unknown>, {
      resumedFrom: "gone",
      sawInit: false,
    });
    const out = feed(harness, [{ type: "result", subtype: "error_during_execution" }]);
    const notice = out.find((e) => e.type === "notice");
    assert.ok(notice?.type === "notice", "黙って turn_end だけ出さない");
    assert.match(notice.text, /gone/, "何を読み戻せなかったかを名指しする");
    assert.equal(harness.resumeToken(), undefined, "死んだ札を握り続けない（会話が永久に死ぬ）");
  });

  it("成功したターンでは知らせを出さない", () => {
    const harness = new ClaudeAgentHarness({ systemPrompt: "sp", tools: [] });
    const out = feed(harness, [{ type: "result", subtype: "success" }]);
    assert.deepEqual(
      out.map((e) => e.type),
      ["turn_end", "run_end"]
    );
  });

  it("文脈長は SDK が返したものを使う（自前の表を持たない）", () => {
    const harness = new ClaudeAgentHarness({ systemPrompt: "sp", tools: [] });
    assert.equal(harness.contextWindow(), undefined);
    feed(harness, [
      { type: "result", subtype: "success", modelUsage: { opus: { contextWindow: 200_000 } } },
    ]);
    assert.equal(harness.contextWindow(), 200_000);
  });
});

describe("[決定97] 本文の差分（includePartialMessages）", () => {
  it("差分で流したものを、後から届く全文でもう一度流さない", () => {
    const harness = new ClaudeAgentHarness({ systemPrompt: "sp", tools: [] });
    const out = feed(harness, [
      {
        type: "stream_event",
        event: { type: "content_block_delta", delta: { type: "text_delta", text: "こん" } },
      },
      {
        type: "stream_event",
        event: { type: "content_block_delta", delta: { type: "text_delta", text: "にちは" } },
      },
      { type: "assistant", message: { content: [{ type: "text", text: "こんにちは" }] } },
    ]);
    assert.deepEqual(
      out.map((e) => (e.type === "text_delta" ? e.delta : e.type)),
      ["こん", "にちは"],
      "全文で二重に出さない"
    );
    assert.equal(harness.messageCount(), 1, "記録は全文から作る（章の要約器へ渡すため）");
  });

  it("思考も差分で流れ、終わりに時間が出る（決定90）", () => {
    const harness = new ClaudeAgentHarness({ systemPrompt: "sp", tools: [] });
    const out = feed(harness, [
      {
        type: "stream_event",
        event: { type: "content_block_delta", delta: { type: "thinking_delta", thinking: "うむ" } },
      },
      { type: "assistant", message: { content: [{ type: "thinking", thinking: "うむ" }] } },
    ]);
    assert.deepEqual(
      out.map((e) => e.type),
      ["reasoning_delta", "reasoning_end"]
    );
  });

  it("道具を挟んだ2つ目の発話も流れる（掛け金を戻し忘れると消える）", () => {
    const harness = new ClaudeAgentHarness({ systemPrompt: "sp", tools: [] });
    const out = feed(harness, [
      {
        type: "stream_event",
        event: { type: "content_block_delta", delta: { type: "text_delta", text: "調べます" } },
      },
      { type: "assistant", message: { content: [{ type: "text", text: "調べます" }] } },
      // 2つ目は差分が届かない構成（例：翻訳だけを流し込む経路）でも落とさない
      { type: "assistant", message: { content: [{ type: "text", text: "分かりました" }] } },
    ]);
    assert.deepEqual(
      out.filter((e) => e.type === "text_delta").map((e) => (e as { delta: string }).delta),
      ["調べます", "分かりました"]
    );
  });
});

/**
 * **走らせてみないと出ない3つ**（task-0104）。翻訳だけを流し込む試験では1件も落ちない
 * ——`query()` が実際に立って終わるところにしか現れないため、起こす手続きを差し替える。
 */
/** `message.content` の要素（本文か画像）。 */
interface ContentBlock {
  type: string;
  text?: string;
  source?: { type: string; media_type: string; data: string };
}

class FakeQuery {
  /** **本文だけ**を取り出した写し（大半の試験はここを見れば足りる）。 */
  readonly received: string[] = [];
  /**
   * `message.content` を**そのまま**。画像ブロックが実際に入っているかは、
   * 平らにした本文からは見えないのでこちらで見る。
   */
  readonly receivedContent: Array<string | ContentBlock[]> = [];
  /** 入力の生成器が返り切ったか（＝本物なら子プロセスが終わる）。 */
  inputClosed = false;
  private readonly pending: unknown[] = [];
  private waiting: ((v: IteratorResult<unknown>) => void) | undefined;
  private ended = false;

  constructor(
    readonly options: Record<string, unknown>,
    prompt: AsyncIterable<{ message: { content: string | ContentBlock[] } }>
  ) {
    void (async () => {
      for await (const message of prompt) {
        const content = message.message.content;
        this.receivedContent.push(content);
        this.received.push(
          typeof content === "string"
            ? content
            : content
                .filter((b) => b.type === "text")
                .map((b) => b.text ?? "")
                .join("")
        );
      }
      // 入力が尽きたら query も終わる（本物と同じ）
      this.inputClosed = true;
      this.end();
    })();
  }

  emit(message: unknown): void {
    const waiter = this.waiting;
    if (waiter) {
      this.waiting = undefined;
      waiter({ value: message, done: false });
      return;
    }
    this.pending.push(message);
  }

  end(): void {
    this.ended = true;
    const waiter = this.waiting;
    if (waiter) {
      this.waiting = undefined;
      waiter({ value: undefined, done: true });
    }
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<unknown> {
    for (;;) {
      const next = this.pending.shift();
      if (next !== undefined) {
        yield next;
        continue;
      }
      if (this.ended) return;
      const result = await new Promise<IteratorResult<unknown>>((r) => (this.waiting = r));
      if (result.done) return;
      yield result.value;
    }
  }
}

/** マイクロタスクを何回か回す（非同期のループが実際に進むところまで待つ）。 */
async function settle(times = 4): Promise<void> {
  for (let i = 0; i < times; i++) await new Promise((r) => setImmediate(r));
}

function withFakeQuery(options: { resume?: string; systemPrompt?: string } = {}) {
  const spawned: FakeQuery[] = [];
  const harness = new ClaudeAgentHarness({
    systemPrompt: options.systemPrompt ?? "sp",
    tools: [],
    ...(options.resume ? { resume: options.resume } : {}),
    spawnQuery: ({ prompt, options: opts }) => {
      const fake = new FakeQuery(
        opts as unknown as Record<string, unknown>,
        prompt as unknown as AsyncIterable<{ message: { content: string } }>
      );
      spawned.push(fake);
      return fake as unknown as AsyncIterable<unknown>;
    },
  });
  return { harness, spawned };
}

describe("[決定97] 走っている query の後始末", () => {
  it("発話は待ち行列を通って query へ届く", async () => {
    const { harness, spawned } = withFakeQuery();
    void harness.prompt("ひとつめ");
    await settle();
    assert.equal(spawned.length, 1);
    assert.deepEqual(spawned[0]!.received, ["ひとつめ"]);
  });

  it("dispose で待ち行列が閉じ、query が終わる（放すだけでは終わらない）", async () => {
    const { harness, spawned } = withFakeQuery();
    void harness.prompt("はなし");
    await settle();
    assert.equal(spawned[0]!.inputClosed, false, "空になっても終わらせないのが待ち行列の設計");

    await harness.dispose();
    await settle();
    assert.equal(spawned[0]!.inputClosed, true, "畳めば入力の生成器が返り切る＝子プロセスが終わる");
    await assert.rejects(() => harness.prompt("あとから"), /畳まれています/, "I2: 黙って捨てない");
  });

  it("prompt はターンが終わるまで返らない（サーバがこれで turn_end を配る）", async () => {
    const { harness, spawned } = withFakeQuery();
    let done = false;
    const turn = harness.prompt("問い").then(() => (done = true));
    await settle();
    assert.equal(done, false, "積んだだけで返すと、返事の前に画面が「終わった」になる");

    spawned[0]!.emit({ type: "assistant", message: { content: [{ type: "text", text: "答え" }] } });
    await settle();
    assert.equal(done, false, "本文が来ただけではまだ終わりではない");

    spawned[0]!.emit({ type: "result", subtype: "success" });
    await turn;
    assert.equal(done, true, "run_end で返る");
  });

  it("中断・畳みでも返る（画面が「回答中」のまま戻らなくなる）", async () => {
    const { harness } = withFakeQuery();
    const aborted = harness.prompt("問い");
    await settle();
    await harness.abort();
    await aborted;

    const { harness: h2 } = withFakeQuery();
    const disposed = h2.prompt("問い");
    await settle();
    await h2.dispose();
    await disposed;
  });

  it("dispose は冪等（往復のたびに畳んでも壊れない）", async () => {
    const { harness } = withFakeQuery();
    await harness.dispose();
    await harness.dispose();
  });

  it("章を畳んだ後、古いループが新しい query を消さない（世代の掛け金）", async () => {
    const { harness, spawned } = withFakeQuery();
    void harness.prompt("前の章の話");
    await settle();
    assert.equal(spawned.length, 1);

    // 走っている最中に章を畳む（待ち行列を閉じ、abort する）
    await harness.startChapter({ text: "種", tokensBefore: 9, chapter: 2, handoffId: "h-2" });
    void harness.prompt("新しい章の話");
    await settle();
    assert.equal(spawned.length, 2, "新しい章は新しい query で始まる");
    assert.deepEqual(spawned[1]!.received, ["新しい章の話"]);

    // ここで**古いほうの後始末が届く**。掛け金が無いと run が消え、次の発話で3本目が立つ
    spawned[0]!.end();
    await settle();
    void harness.prompt("続き");
    await settle();
    assert.equal(spawned.length, 2, "古いループの finally が新しい run を消していない");
    assert.deepEqual(spawned[1]!.received, ["新しい章の話", "続き"], "発話が握り潰されない");
  });

  it("畳んだ query の残響は流さない（前の章の発話が新しい章に出ない）", async () => {
    const { harness, spawned } = withFakeQuery();
    const seen: HarnessEvent[] = [];
    harness.subscribe((e) => seen.push(e));
    void harness.prompt("前の章の話");
    await settle();

    await harness.startChapter({ text: "種", tokensBefore: 9, chapter: 2, handoffId: "h-2" });
    // 畳んだ後に古い query から届く（本物でも abort が効くまでの間に起こりうる）
    spawned[0]!.emit({
      type: "assistant",
      message: { content: [{ type: "text", text: "前の章の言いかけ" }] },
    });
    await settle();
    assert.deepEqual(seen, [], "前の章の発話が新しい章の会話に混ざらない");
  });

  it("query が終わった後の発話も届く（待ち行列を作り直す）", async () => {
    const { harness, spawned } = withFakeQuery();
    void harness.prompt("いちど目");
    await settle();
    // 本物でいえば error_during_execution 等で query が終わった状態
    spawned[0]!.end();
    await settle();

    void harness.prompt("にど目");
    await settle();
    assert.equal(spawned.length, 2, "起こし直す");
    assert.deepEqual(spawned[1]!.received, ["にど目"], "死んだ生成器へ渡って消えない");
  });
});

describe("[ADR-0020 決定91] 本物の道具100本のスキーマが zod へ写せる", () => {
  const REAL = "/home/ubuntu/banto-desk/reports/tap/req-0007.json";

  it("100本すべてが変換できる（落ちる形が無い）", (t) => {
    if (!fs.existsSync(REAL)) {
      t.skip("実物の要求記録が無い環境ではスキップ");
      return;
    }
    const body = JSON.parse(fs.readFileSync(REAL, "utf-8")) as Record<string, unknown>;
    const tools = (body["tools"] ?? []) as Array<{ function?: { parameters?: unknown } }>;
    assert.ok(tools.length > 0, "実物の道具が取れている");
    let converted = 0;
    for (const entry of tools) {
      const shape = jsonSchemaToZodShape(entry.function?.parameters as never);
      assert.equal(typeof shape, "object");
      converted++;
    }
    assert.equal(converted, tools.length, `${tools.length}本すべて変換できること`);
  });

  it("省略できる引数を必須にしない（空文字で埋められるのを防ぐ）", () => {
    const shape = jsonSchemaToZodShape({
      type: "object",
      properties: { a: { type: "string" }, b: { type: "string" } },
      required: ["a"],
    } as never);
    assert.equal(shape["a"]!.safeParse(undefined).success, false, "必須は欠けたら通さない");
    assert.equal(shape["b"]!.safeParse(undefined).success, true, "省略可は通す");
  });

  it("知らない形は落とさず通す（引数の口を消さない・I2）", () => {
    const shape = jsonSchemaToZodShape({
      type: "object",
      properties: { weird: { type: "banana" } },
      required: ["weird"],
    } as never);
    assert.equal(shape["weird"]!.safeParse({ anything: 1 }).success, true);
  });
});

/**
 * **画像を実際に渡す**（PO報告 2026-08-15「画像が貼れなくて困る」）。
 *
 * 以前は `options.images` を受け取っておきながら SDK へ渡さず、本文の末尾に
 * 「渡せませんでした」と書き足していた。**運ぶ経路が最後の一歩で切れていた**。
 *
 * `SDKUserMessage.message` は Anthropic の `MessageParam` なので `content` に
 * コンテンツブロック配列を置ける（`sdk.d.ts` → `@anthropic-ai/sdk` の `MessageParam`）。
 * 実測（2026-08-15）：`pathToClaudeCodeExecutable` を stdin を写すだけの偽物へ
 * 差し替えたところ、画像ブロックは一字も変えられずに子プロセスへ届いた。
 *
 * だから見るのは「例外が出ないこと」ではなく**中身が入っていること**。
 */
describe("画像の入力（claude-agent-sdk）", () => {
  /** 1x1 の png。`data:` 接頭辞を除いた実データ（`protocol.ts` の約束どおり）。 */
  const PNG_1X1 =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

  /** 実際に SDK へ流れた `content` を取り出す。 */
  function contentOf(spawned: FakeQuery[]): string | ContentBlock[] {
    assert.equal(spawned.length, 1, "query が1本立っている");
    assert.equal(spawned[0]!.receivedContent.length, 1, "発話が1つ届いている");
    return spawned[0]!.receivedContent[0]!;
  }

  it("画像ブロックが実際に SDK へ流し込まれる（本文と一緒に）", async () => {
    const { harness, spawned } = withFakeQuery();
    void harness.prompt("この画面は何がおかしい？", {
      images: [{ type: "image", data: PNG_1X1, mimeType: "image/png" }],
    });
    await settle();

    const content = contentOf(spawned);
    assert.ok(Array.isArray(content), "画像があるときはブロック配列で渡す");
    assert.deepEqual(content, [
      { type: "text", text: "この画面は何がおかしい？" },
      {
        type: "image",
        source: { type: "base64", media_type: "image/png", data: PNG_1X1 },
      },
    ]);
    // base64 を二重に剥がしたり `data:` を足したりしていない
    assert.equal(
      (content[1] as ContentBlock).source!.data,
      PNG_1X1,
      "受け取った実データをそのまま渡す"
    );
  });

  it("複数枚でも全部入る（順番も保つ）", async () => {
    const { harness, spawned } = withFakeQuery();
    void harness.prompt("2枚見て", {
      images: [
        { type: "image", data: "AAAA", mimeType: "image/png" },
        { type: "image", data: "BBBB", mimeType: "image/jpeg" },
      ],
    });
    await settle();

    const content = contentOf(spawned) as ContentBlock[];
    assert.deepEqual(
      content.filter((b) => b.type === "image").map((b) => b.source!.data),
      ["AAAA", "BBBB"]
    );
  });

  // Anthropic が受ける4種すべて。1つでも落ちると「貼れたのに見えない」が復活する
  for (const mimeType of ["image/png", "image/jpeg", "image/gif", "image/webp"]) {
    it(`${mimeType} は通る`, async () => {
      const { harness, spawned } = withFakeQuery();
      void harness.prompt("見て", { images: [{ type: "image", data: PNG_1X1, mimeType }] });
      await settle();

      const content = contentOf(spawned) as ContentBlock[];
      const image = content.find((b) => b.type === "image");
      assert.ok(image, `${mimeType} が画像ブロックとして渡っている`);
      assert.equal(image.source!.media_type, mimeType);
    });
  }

  it("綴りが揃っていなくても（大文字・前後の空白）落とさない", async () => {
    const { harness, spawned } = withFakeQuery();
    void harness.prompt("見て", {
      images: [{ type: "image", data: PNG_1X1, mimeType: " Image/PNG " }],
    });
    await settle();

    const content = contentOf(spawned) as ContentBlock[];
    const image = content.find((b) => b.type === "image");
    assert.ok(image, "綴りの揺れで画像を捨てない");
    assert.equal(image.source!.media_type, "image/png", "SDK の綴りへ正規化して渡す");
  });

  /**
   * I2: 渡せないものは**黙って消さない**。Anthropic が受けるのは4種だけなので、
   * svg はここで弾かれる——弾いたことを本文で言わないと、貼った側からは
   * 「見えているはずなのに何も言わない」に見える（一番困る形）。
   */
  it("対応外の形式（svg）は黙って消えず、本文で断る", async () => {
    const { harness, spawned } = withFakeQuery();
    void harness.prompt("この図を見て", {
      images: [{ type: "image", data: "PHN2Zz48L3N2Zz4=", mimeType: "image/svg+xml" }],
    });
    await settle();

    const content = contentOf(spawned);
    // 画像ブロックが1つも無い＝渡せていない。ならば本文が理由を言っていること
    const text = typeof content === "string" ? content : JSON.stringify(content);
    assert.ok(!text.includes("PHN2Zz48L3N2Zz4="), "渡せない画像を無理に載せない");
    assert.match(text, /image\/svg\+xml/, "何が弾かれたのかを名指しする");
    assert.match(text, /渡せませんでした/, "黙って消さない");
    assert.match(text, /png/, "次にどうすればよいかまで書く（I2）");
    assert.match(text, /この図を見て/, "本文そのものは失わない");
  });

  it("通る画像と通らない画像が混じったら、通るぶんは渡して残りを断る", async () => {
    const { harness, spawned } = withFakeQuery();
    void harness.prompt("2枚", {
      images: [
        { type: "image", data: PNG_1X1, mimeType: "image/png" },
        { type: "image", data: "PHN2Zz4=", mimeType: "image/svg+xml" },
      ],
    });
    await settle();

    const content = contentOf(spawned) as ContentBlock[];
    assert.equal(content.filter((b) => b.type === "image").length, 1, "通るぶんは渡す");
    assert.match(content[0]!.text!, /image\/svg\+xml/, "通らなかったぶんは本文で断る");
  });

  it("画像が0件のときは今までどおり——文字列のまま渡し、余計な注記も付けない", async () => {
    const { harness, spawned } = withFakeQuery();
    void harness.prompt("ただの発話");
    await settle();

    assert.equal(contentOf(spawned), "ただの発話", "ブロック配列へ変えるのは画像があるときだけ");
  });

  it("images に空配列を渡しても 0 件と同じ（注記が湧かない）", async () => {
    const { harness, spawned } = withFakeQuery();
    void harness.prompt("ただの発話", { images: [] });
    await settle();

    assert.equal(contentOf(spawned), "ただの発話");
  });
});

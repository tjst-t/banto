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
    const harness = new ClaudeAgentHarness({ systemPrompt: "元の人格", tools: [] });
    await harness.prompt("最初の話");
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
class FakeQuery {
  readonly received: string[] = [];
  /** 入力の生成器が返り切ったか（＝本物なら子プロセスが終わる）。 */
  inputClosed = false;
  private readonly pending: unknown[] = [];
  private waiting: ((v: IteratorResult<unknown>) => void) | undefined;
  private ended = false;

  constructor(
    readonly options: Record<string, unknown>,
    prompt: AsyncIterable<{ message: { content: string } }>
  ) {
    void (async () => {
      for await (const message of prompt) this.received.push(message.message.content);
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

function withFakeQuery(options: { resume?: string } = {}) {
  const spawned: FakeQuery[] = [];
  const harness = new ClaudeAgentHarness({
    systemPrompt: "sp",
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
    await harness.prompt("ひとつめ");
    await settle();
    assert.equal(spawned.length, 1);
    assert.deepEqual(spawned[0]!.received, ["ひとつめ"]);
  });

  it("dispose で待ち行列が閉じ、query が終わる（放すだけでは終わらない）", async () => {
    const { harness, spawned } = withFakeQuery();
    await harness.prompt("はなし");
    await settle();
    assert.equal(spawned[0]!.inputClosed, false, "空になっても終わらせないのが待ち行列の設計");

    await harness.dispose();
    await settle();
    assert.equal(spawned[0]!.inputClosed, true, "畳めば入力の生成器が返り切る＝子プロセスが終わる");
    await assert.rejects(() => harness.prompt("あとから"), /畳まれています/, "I2: 黙って捨てない");
  });

  it("dispose は冪等（往復のたびに畳んでも壊れない）", async () => {
    const { harness } = withFakeQuery();
    await harness.dispose();
    await harness.dispose();
  });

  it("章を畳んだ後、古いループが新しい query を消さない（世代の掛け金）", async () => {
    const { harness, spawned } = withFakeQuery();
    await harness.prompt("前の章の話");
    await settle();
    assert.equal(spawned.length, 1);

    // 走っている最中に章を畳む（待ち行列を閉じ、abort する）
    await harness.startChapter({ text: "種", tokensBefore: 9, chapter: 2, handoffId: "h-2" });
    await harness.prompt("新しい章の話");
    await settle();
    assert.equal(spawned.length, 2, "新しい章は新しい query で始まる");
    assert.deepEqual(spawned[1]!.received, ["新しい章の話"]);

    // ここで**古いほうの後始末が届く**。掛け金が無いと run が消え、次の発話で3本目が立つ
    spawned[0]!.end();
    await settle();
    await harness.prompt("続き");
    await settle();
    assert.equal(spawned.length, 2, "古いループの finally が新しい run を消していない");
    assert.deepEqual(spawned[1]!.received, ["新しい章の話", "続き"], "発話が握り潰されない");
  });

  it("畳んだ query の残響は流さない（前の章の発話が新しい章に出ない）", async () => {
    const { harness, spawned } = withFakeQuery();
    const seen: HarnessEvent[] = [];
    harness.subscribe((e) => seen.push(e));
    await harness.prompt("前の章の話");
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
    await harness.prompt("いちど目");
    await settle();
    // 本物でいえば error_during_execution 等で query が終わった状態
    spawned[0]!.end();
    await settle();

    await harness.prompt("にど目");
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

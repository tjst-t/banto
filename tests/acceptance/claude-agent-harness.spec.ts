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

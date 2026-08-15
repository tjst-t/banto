/**
 * **文脈長の測り方を実機で突き合わせる**（imp-0051）。
 *
 * `result.usage` は「そのターン中に走った全 API 呼び出しの累計」であって、
 * 文脈長ではない。道具を n 回呼ぶターンでは同じキャッシュ済みプレフィクスが
 * n 回足し込まれる——実際の事故では 9.7 倍に膨れ、要らない章畳みを起こした。
 *
 * このスクリプトは**道具を3回以上呼ぶターン**を1回走らせ、
 *
 *   (0) assistant メッセージごとの usage の列和   ＝ result.usage と一致するか
 *   (1) 直す前の式（result.usage の4項を足す）
 *   (2) 新しい実装（`query.getContextUsage()` の totalTokens）
 *   (3) 落とし先（`result.usage.iterations` の最後の1件）
 *
 * を並べて出す。(1) が (2) の数倍に膨れ、(2)(3) が一致することを目で確かめられる。
 *
 * 走らせ方（リポジトリ直下から。Claude のサブスクリプションが要る）:
 *
 *     node --import tsx tools/measure-context-tokens.ts
 *
 * 注意: SDK は banto-host のワークスペースに入っているので、そこから読む。
 */
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { Type } from "typebox";
import { defineNamespacedTool } from "../packages/banto-core/src/index.js";
import { ClaudeAgentHarness } from "../packages/banto-host/src/claude-agent-harness.js";
import type { RunningQuery } from "../packages/banto-host/src/claude-agent-harness.js";

const require = createRequire(
  fileURLToPath(new URL("../packages/banto-host/package.json", import.meta.url))
);
// I4: SDK を実行時解決で引くので型は付かない。ここは計測用の使い捨てで本体は触らない
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const { query } = require("@anthropic-ai/claude-agent-sdk") as { query: any };

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** 直す前の式。1回の API 呼び出しぶんなら文脈長だが、累計に当てると膨れる。 */
function sumUsage(usage: Record<string, unknown> | undefined): number {
  if (!usage) return 0;
  return (
    num(usage["input_tokens"]) +
    num(usage["cache_read_input_tokens"]) +
    num(usage["cache_creation_input_tokens"]) +
    num(usage["output_tokens"])
  );
}

const PROMPT =
  "次を1つずつ、別々の Bash 呼び出しで実行してください（まとめないこと）：" +
  "`echo one`、`echo two`、`echo three`、`echo four`。" +
  "4回とも終わったら「done」とだけ答えてください。";

/**
 * 番頭と同じ **streaming input**（`PromptQueue` の縮小版）。
 *
 * 文字列を渡す形だと `result` と同時に `query()` が畳まれ、control request が
 * 「Query closed before response received」で落ちる（実測）。本体は空でも
 * 終わらせない待ち行列を渡しているので、ここも同じ形にしないと測ったことにならない。
 */
function streamOnce(text: string): { input: AsyncIterable<unknown>; close: () => void } {
  let release: (() => void) | undefined;
  let closed = false;
  const done = new Promise<void>((r) => (release = r));
  async function* input(): AsyncIterable<unknown> {
    yield {
      type: "user",
      message: { role: "user", content: text },
      parent_tool_use_id: null,
      session_id: "",
    };
    await done; // 空になっても返り切らない＝ query() が生き続ける
  }
  return {
    input: input(),
    close: () => {
      if (closed) return;
      closed = true;
      release?.();
    },
  };
}

async function main(): Promise<void> {
  const stream = streamOnce(PROMPT);
  const session = query({
    prompt: stream.input,
    options: {
      allowedTools: ["Bash"],
      permissionMode: "bypassPermissions",
      maxTurns: 12,
    },
  });

  let apiCalls = 0;
  let perCallSum = 0;
  let toolCalls = 0;
  let model = "";
  let printed = false;

  for await (const message of session as AsyncIterable<Record<string, unknown>>) {
    const type = message["type"];

    if (type === "system" && message["subtype"] === "init") {
      model = String(message["model"] ?? "");
      continue;
    }

    if (type === "assistant") {
      // assistant メッセージ＝API 呼び出し1回ぶん
      const inner = message["message"] as Record<string, unknown> | undefined;
      apiCalls += 1;
      perCallSum += sumUsage(inner?.["usage"] as Record<string, unknown> | undefined);
      const content = (inner?.["content"] ?? []) as Array<Record<string, unknown>>;
      toolCalls += content.filter((b) => b["type"] === "tool_use").length;
      continue;
    }

    if (type !== "result") continue;

    /**
     * **ここで訊く**のが肝。`getContextUsage()` は control request なので、
     * `query()` が生きている間——つまり `result` を処理し切ってイテレータを
     * 畳む前——にしか通らない。
     */
    let measured: Record<string, unknown> | undefined;
    let measureError: string | undefined;
    try {
      measured = (await (session as { getContextUsage: () => Promise<Record<string, unknown>> })
        .getContextUsage()) as Record<string, unknown>;
    } catch (error) {
      measureError = String((error as Error)?.message ?? error);
    }

    const usage = message["usage"] as Record<string, unknown> | undefined;
    const iterations = usage?.["iterations"] as Array<Record<string, unknown>> | undefined;
    const last = iterations?.[iterations.length - 1];

    const before = sumUsage(usage);
    const viaContextUsage = num(measured?.["totalTokens"]);
    const viaIterations = sumUsage(last);

    const modelUsage = (message["modelUsage"] ?? {}) as Record<string, Record<string, unknown>>;

    console.log("");
    console.log("── 実測 ──────────────────────────────────────────────");
    console.log(`model                       : ${model}`);
    console.log(`API 呼び出し回数            : ${apiCalls}（うち道具の呼び出し ${toolCalls} 回）`);
    console.log("");
    console.log(`(0) assistant usage の列和  : ${perCallSum}`);
    console.log(`(1) 直す前の式（result.usage 4項の和）: ${before}`);
    console.log(`(2) getContextUsage().totalTokens     : ${viaContextUsage}`);
    console.log(`(3) result.usage.iterations の最後    : ${viaIterations}`);
    if (measureError) console.log(`    getContextUsage の失敗: ${measureError}`);
    console.log("");
    if (viaContextUsage > 0) {
      console.log(`(1)/(2) の倍率              : ${(before / viaContextUsage).toFixed(2)} 倍`);
      console.log(`(3)−(2) の差                : ${viaIterations - viaContextUsage} トークン`);
    }
    console.log(`(0)−(1) の差（＝累計か）    : ${perCallSum - before} トークン`);
    console.log("");
    console.log(`窓: getContextUsage().maxTokens = ${num(measured?.["maxTokens"])}`);
    for (const [key, entry] of Object.entries(modelUsage)) {
      console.log(`    modelUsage["${key}"].contextWindow = ${num(entry?.["contextWindow"])}`);
    }
    console.log(`    iterations の件数 = ${iterations?.length ?? "(無し)"}`);
    console.log("──────────────────────────────────────────────────────");
    printed = true;
    // 測り終えたので待ち行列を閉じる（＝ query() を畳んでループを抜けさせる）
    stream.close();
  }

  if (!printed) {
    console.error("result メッセージが来なかった（走り切っていない）");
    process.exitCode = 1;
  }
}

/**
 * **本体（`ClaudeAgentHarness`）が実際に配る値**を同じターンで突き合わせる。
 *
 * `spawnQuery` を挟んで本物の `query()` を包み、流れていく `result` から
 * **直す前の式**を横で計算する。ハーネスが `contextTokens()` に置く値が
 * 新しい取り方の結果なので、両者を並べれば直ったことがそのターンの数で読める。
 */
async function measureThroughHarness(): Promise<void> {
  let before = 0;
  let crossCheck: number | undefined;
  const probe = defineNamespacedTool({
    name: "probe.echo",
    label: "echo",
    description: "渡された言葉をそのまま返す。数えるためだけの道具。",
    parameters: Type.Object({ word: Type.String() }),
    execute: async (args: { word: string }) => ({ ok: true as const, summary: args.word }),
  });

  const harness = new ClaudeAgentHarness({
    systemPrompt: "あなたは道具の呼び出し回数を測るための相手です。指示どおりに道具を呼びます。",
    tools: [probe],
    spawnQuery: ({ prompt, options }) => {
      // 実行時解決の SDK をそのまま使う（本番と同じ経路）
      const real = query({ prompt, options });
      const wrapped: RunningQuery = {
        [Symbol.asyncIterator]: async function* () {
          for await (const message of real as AsyncIterable<Record<string, unknown>>) {
            if (message["type"] === "result") {
              const usage = message["usage"] as Record<string, unknown> | undefined;
              before = sumUsage(usage);
              // 裏取り: `iterations` の最後の1件（本体とは別経路で同じターンを測る）
              const iterations = usage?.["iterations"] as
                | Array<Record<string, unknown>>
                | undefined;
              crossCheck = iterations?.length ? sumUsage(iterations[iterations.length - 1]) : undefined;
            }
            yield message;
          }
        },
        getContextUsage: () => real.getContextUsage(),
      };
      return wrapped;
    },
  });

  await harness.prompt(
    "probe.echo を1回ずつ、別々に4回呼んでください（word は one / two / three / four）。" +
      "4回とも終わったら「done」とだけ答えてください。"
  );

  const after = harness.contextTokens();
  const window = harness.contextWindow();
  console.log("");
  console.log("── 本体（ClaudeAgentHarness）が配る値 ────────────────");
  console.log(`直す前の式（result.usage 4項の和） : ${before}`);
  console.log(`いまの実装 contextTokens()         : ${after ?? "(無し)"}`);
  console.log(`いまの実装 contextWindow()         : ${window ?? "(無し)"}`);
  console.log(`裏取り iterations の最後           : ${crossCheck ?? "(無し)"}`);
  if (after && after > 0) {
    console.log(`ずれの倍率（直す前 / いま）       : ${(before / after).toFixed(2)} 倍`);
    if (crossCheck !== undefined) console.log(`裏取りとの差                      : ${crossCheck - after} トークン`);
  }
  console.log("──────────────────────────────────────────────────────");
  await harness.dispose();
}

async function run(): Promise<void> {
  await main();
  await measureThroughHarness();
}

void run();

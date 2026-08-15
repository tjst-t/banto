/**
 * **ターンには予算がある**（PO報告 2026-08-11・P4）。
 *
 * ## 何が起きたか（実機・thread-69「banto類似品の調査」）
 *
 * 職人に調査を任せたあと、完了を待つために道具を呼び続けて止まらなくなった。
 * 番頭自身の発話がその構造を書いている：
 *
 * > 職人は私に自動的に報告が届く仕組みなので、完了したら知らせが来ます。
 * > **少し待って、もう一度進捗を確認してみます。**
 *
 * ## 最初の対策が駄目だった理由
 *
 * 「様子を見る道具」を並べ、**連続した**同じ呼び出しを数えるものを書いた。だが実機の
 * 並びは道具が入れ替わっており、一覧に無い `file.find` まで混ざっていたので、
 * **その対策では1回も止まらなかった**（この検体の1本目がそれを示す）。
 *
 * 症状（どの道具か）ではなく、**ターンそのもの**を測る。
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";

import {
  createTurnBudget,
  guardTurn,
  withTurnBudgetReset,
  DEFAULT_REPEAT_LIMIT,
  DEFAULT_CALL_WARN_LIMIT,
  DEFAULT_CALL_WARN_AGAIN_LIMIT,
  DEFAULT_CALL_LIMIT,
} from "@banto/host";
import type { NamespacedToolDefinition, TurnBudget } from "@banto/host";
import type { BantoHarness, ChapterOpening, HarnessEvent, HarnessPromptOptions } from "@banto/core";

/** 実機（thread-69）で番頭が呼んだ道具の並び。**これが止められなければ意味がない**。 */
const RUNAWAY: ReadonlyArray<[string, Record<string, unknown>]> = [
  ["worker.delegate", { taskId: "banto-similar-survey" }],
  ["worker.attach", { sessionId: "s-1" }],
  ["worker.attach", { sessionId: "s-1" }],
  ["worker.events", { afterEventId: 0 }],
  ["worker.attach", { sessionId: "s-1" }],
  ["worker.attach", { sessionId: "s-1" }],
  ["worker.attach", { sessionId: "s-1" }],
  ["worker.attach", { sessionId: "s-1" }],
  ["file.find", { query: "desk" }],
  ["file.find", { query: "desk" }],
  ["worker.attach", { sessionId: "s-1" }],
  ["worker.events", { afterEventId: 0 }],
  ["worker.attach", { sessionId: "s-1" }],
];

function counted(name: string, calls: string[]): NamespacedToolDefinition {
  return {
    name,
    label: name,
    description: "",
    parameters: { type: "object", properties: {} },
    async execute() {
      calls.push(name);
      return { content: [{ type: "text" as const, text: "まだ作業中です" }] };
    },
  } as unknown as NamespacedToolDefinition;
}

describe("[PO報告 2026-08-11] ターンの予算——実機の暴走が止まる", () => {
  it("**実機の並びで止まる**（道具が入れ替わっても、間に別の道具が挟まっても）", async () => {
    const budget = createTurnBudget();
    const calls: string[] = [];
    const tools = new Map(
      [...new Set(RUNAWAY.map(([n]) => n))].map((n) => [n, guardTurn(counted(n, calls), budget)])
    );

    let refusal: string | undefined;
    for (const [name, args] of RUNAWAY) {
      try {
        await tools.get(name)!.execute(args as never, { toolCallId: "t" });
      } catch (err) {
        refusal = (err as Error).message;
        break;
      }
    }

    assert.ok(refusal, "実機の並びを最後まで通してしまった（止められていない）");
    // 4回目の `worker.attach` で止まる＝待ちの代わりだと分かった時点
    assert.equal(calls.filter((c) => c === "worker.attach").length, DEFAULT_REPEAT_LIMIT);
    assert.match(refusal!, /ターンを終えて/u, "次にやることが書かれていない（D8）");
    assert.match(refusal!, /自動で届き/u, "終えれば知らせで起きることを教える");
  });

  it("間に何を挟んでも数える（連続でなくても待ちの代わりは待ちの代わり）", async () => {
    const budget = createTurnBudget();
    const calls: string[] = [];
    const attach = guardTurn(counted("worker.attach", calls), budget);
    const find = guardTurn(counted("file.find", calls), budget);

    for (let i = 0; i < DEFAULT_REPEAT_LIMIT; i++) {
      await attach.execute({ sessionId: "s-1" } as never, { toolCallId: "t" });
      // 別の道具を挟んで数えを外そうとする
      await find.execute({ query: `q-${i}` } as never, { toolCallId: "t" });
    }
    await assert.rejects(
      () => attach.execute({ sessionId: "s-1" } as never, { toolCallId: "t" }),
      /同じ確認/u
    );
  });

  it("引数の書き方を変えただけでは数え直さない", async () => {
    const budget = createTurnBudget();
    const calls: string[] = [];
    const tool = guardTurn(counted("worker.events", calls), budget);
    for (let i = 0; i < DEFAULT_REPEAT_LIMIT; i++) {
      const args = i % 2 === 0 ? { a: 1, b: 2 } : { b: 2, a: 1 };
      await tool.execute(args as never, { toolCallId: "t" });
    }
    await assert.rejects(
      () => tool.execute({ a: 1, b: 2 } as never, { toolCallId: "t" }),
      /同じ確認/u
    );
  });

  it("**毎回違う問いを出し続ける形も止まる**（同じ問いの数えに当たらない暴走）", async () => {
    const budget = createTurnBudget({ callLimit: 10 });
    const calls: string[] = [];
    const tool = guardTurn(counted("file.read", calls), budget);

    for (let i = 0; i < 10; i++) {
      await tool.execute({ path: `f-${i}` } as never, { toolCallId: "t" });
    }
    await assert.rejects(
      () => tool.execute({ path: "f-11" } as never, { toolCallId: "t" }),
      (err: Error) => {
        assert.match(err.message, /このターンで道具を/u);
        assert.match(err.message, /続きは次のターンでできます/u, "失われないことを言う");
        return true;
      }
    );
  });

  it("正常な仕事は通る（数回の確認・違う仕事の積み重ね）", async () => {
    const budget = createTurnBudget();
    const calls: string[] = [];
    const attach = guardTurn(counted("worker.attach", calls), budget);
    const read = guardTurn(counted("file.read", calls), budget);

    // 起こした直後に様子を見る → 少し進んでから見る（2回は正常）
    await attach.execute({ sessionId: "s-1" } as never, { toolCallId: "t" });
    await attach.execute({ sessionId: "s-1" } as never, { toolCallId: "t" });
    // 別々のファイルを読むのは別々の問い
    for (let i = 0; i < 20; i++) {
      await read.execute({ path: `f-${i}` } as never, { toolCallId: "t" });
    }
    assert.equal(calls.length, 22, "正常な仕事まで断ってはいけない");
  });

  it("新しい入力が来たら数え直す（前のターンの数えを持ち越さない）", async () => {
    const budget = createTurnBudget();
    const calls: string[] = [];
    const tool = guardTurn(counted("worker.attach", calls), budget);
    for (let i = 0; i < DEFAULT_REPEAT_LIMIT; i++) {
      await tool.execute({ sessionId: "s-1" } as never, { toolCallId: "t" });
    }

    // 職人の知らせ・PO の言葉で次のターンが始まった
    budget.reset();
    await tool.execute({ sessionId: "s-1" } as never, { toolCallId: "t" });
    assert.equal(calls.length, DEFAULT_REPEAT_LIMIT + 1, "状況が変わったのに断っている");
  });
});

/**
 * **抜け道を作らない**（PO報告 2026-08-11）。
 *
 * 最初の対策はモジュールの口だけを見ていて、`file.find` を混ぜられた実機の暴走を
 * 止められなかった。**番頭が呼べる道具の最後の1点**で掛かっていることを確かめる
 * ——ここが外れていると、道具が1つ増えるたびに穴が開く。
 */
describe("[PO報告 2026-08-11] 番頭が呼べる道具すべてに掛かる", () => {
  it("createBantoHostSession に渡した道具は、全部が予算を通る", async () => {
    const budget = createTurnBudget({ repeatLimit: 1 });
    const seen: string[] = [];
    // 実際に pi を起こさずに、掛かっているかだけを見る（`guardTurn` の適用点の検査）
    const wrapped = [counted("canvas.open", seen), counted("memory.add", seen)].map((t) =>
      guardTurn(t, budget)
    );
    for (const tool of wrapped) {
      await tool.execute({ x: 1 } as never, { toolCallId: "t" });
      await assert.rejects(
        () => tool.execute({ x: 1 } as never, { toolCallId: "t" }),
        /同じ確認/u,
        `${tool.name} に予算が掛かっていない`
      );
    }
  });

  it("**適用点はソースで1箇所**（呼び出し側で選ばせない）", () => {
    const src = fs.readFileSync(
      new URL("../../packages/banto-host/src/host-session.ts", import.meta.url).pathname,
      "utf-8"
    );
    /**
     * **理由**（T4・2026-08-15）: 掛ける対象の名前が `offloaded` から `nudged` に変わった。
     * 幹の促し（`nudgeTrunkWork`）を退避と予算の**間**に挟んだためで、**予算を掛ける点は
     * 依然としてここ1箇所**、対象も**道具箱の全部**のまま（`.map` で漏れなく掛かる）。
     * 促しを予算の内側に置いたのは、**断られた呼び出しを促しの数えに入れない**ため。
     */
    assert.match(
      src,
      /nudged\.map\(\(tool\) => guardTurn\(tool, options\.turnBudget!\)\)/u,
      "番頭へ渡す最後の1点で掛けること（ここが動いたら、この検査を直す前に理由を書くこと）"
    );
    // 促しも同じ1箇所で、同じく道具箱の全部に掛かること（T4）
    assert.match(
      src,
      /offloaded\.map\(\(tool\) => nudgeTrunkWork\(tool, options\.trunkNudge!\)\)/u,
      "幹の促しも最後の1点で掛けること（選んで掛けると足し忘れが抜け道になる）"
    );
    // 呼び出し側（bin.ts）で個別に掛け直していないこと＝足し忘れの余地を作らない
    const bin = fs.readFileSync(
      new URL("../../packages/banto-host/src/bin.ts", import.meta.url).pathname,
      "utf-8"
    );
    assert.doesNotMatch(bin, /guardTurn\(/u, "呼び出し側で選んで掛けると抜け道ができる");
  });
});

// ── ここから：PO報告 2026-08-13（安全装置が人の介入を殺した）─────────────────

/** Tool 結果の本文（LLM に渡る側）をつなげる。 */
async function runTool(
  tool: NamespacedToolDefinition,
  args: Record<string, unknown>
): Promise<string> {
  const result = (await tool.execute(args as never, { toolCallId: "t" })) as {
    content: Array<{ type: string; text?: string }>;
  };
  return result.content.map((c) => c.text ?? "").join("\n");
}

/**
 * **三段の止め方**（PO裁定 2026-08-13）。
 *
 * 60 回で全部を例外にしていたので、正当な長い段取りまで途中で殺していた。警告2回を
 * 挟んで、断るのは 120 回まで待つ。**警告のときは結果を返す**——ここが要点で、
 * 返さないと番頭は「道具が壊れた」と読んで別の道具で同じことを始める。
 */
describe("[PO裁定 2026-08-13] ターンの予算は三段で止める", () => {
  it("既定値の並びが崩れていない（警告 → 再警告 → 打ち切り）", () => {
    assert.ok(
      DEFAULT_CALL_WARN_LIMIT < DEFAULT_CALL_WARN_AGAIN_LIMIT,
      "第一警告は第二警告より前に来ること"
    );
    assert.ok(
      DEFAULT_CALL_WARN_AGAIN_LIMIT < DEFAULT_CALL_LIMIT,
      "断るのは第二警告より後。ここが逆転すると『次は断る』と言った後で何も起きない"
    );
    // `DEFAULT_CALL_LIMIT` は**断る値**。名前と意味の対応が壊れると外から誤読される
    assert.equal(DEFAULT_CALL_LIMIT, 120);
    assert.equal(DEFAULT_CALL_WARN_LIMIT, 60);
    assert.equal(DEFAULT_CALL_WARN_AGAIN_LIMIT, 100);
  });

  it("**第一警告は結果を返す**（例外にしない）——添えるのは一言だけ", async () => {
    const budget = createTurnBudget({ callWarnLimit: 3, callWarnAgainLimit: 5, callLimit: 6 });
    const calls: string[] = [];
    const tool = guardTurn(counted("file.read", calls), budget);

    assert.doesNotMatch(await runTool(tool, { path: "f-1" }), /ターン予算/u);
    assert.doesNotMatch(await runTool(tool, { path: "f-2" }), /ターン予算/u);
    const warned = await runTool(tool, { path: "f-3" });
    assert.match(warned, /まだ作業中です/u, "**結果が消えている**（警告で置き換えてはいけない）");
    assert.match(warned, /ターン予算 3\/6/u, "いま何回目でいくつで断るかを言う");
    assert.match(warned, /このターンを\s*終えてください/u, "次にやることを書く（D8）");
    assert.match(warned, /続きは次のターンでできます/u, "失われないことを言う");
    assert.equal(calls.length, 3, "警告のときは道具が実際に走ること");

    // 4回目は静か（毎回添えると、断るまでに同じ文章が何十回も文脈へ積まれる）
    assert.doesNotMatch(await runTool(tool, { path: "f-4" }), /ターン予算/u);
  });

  it("**第二警告は「次は断る」と言う**（結果は返す）", async () => {
    const budget = createTurnBudget({ callWarnLimit: 3, callWarnAgainLimit: 5, callLimit: 6 });
    const calls: string[] = [];
    const tool = guardTurn(counted("file.read", calls), budget);
    for (let i = 1; i <= 4; i++) await runTool(tool, { path: `f-${i}` });

    const again = await runTool(tool, { path: "f-5" });
    assert.match(again, /まだ作業中です/u, "第二警告でも結果は返す");
    assert.match(again, /6 回で断ります/u, "どこで断られるかを明示する");
    assert.equal(calls.length, 5);
  });

  it("**打ち切りだけが例外**（第二警告のあと、上限を越えたところで断る）", async () => {
    const budget = createTurnBudget({ callWarnLimit: 3, callWarnAgainLimit: 5, callLimit: 6 });
    const calls: string[] = [];
    const tool = guardTurn(counted("file.read", calls), budget);
    for (let i = 1; i <= 6; i++) await runTool(tool, { path: `f-${i}` });
    assert.equal(calls.length, 6, "上限までは全部通ること");

    await assert.rejects(
      () => tool.execute({ path: "f-7" } as never, { toolCallId: "t" }),
      /このターンで道具を 6 回呼びました/u
    );
    assert.equal(calls.length, 6, "断ったのに道具が走っている");
  });

  it("**同じ問いの繰り返しは今まで通り即座に断る**（回数を緩めた分の担保）", async () => {
    // 回数の上限は遠くしても、待ちの代わりは3回で止まること
    const budget = createTurnBudget({ callWarnLimit: 60, callWarnAgainLimit: 100, callLimit: 120 });
    const calls: string[] = [];
    const tool = guardTurn(counted("worker.attach", calls), budget);
    for (let i = 0; i < DEFAULT_REPEAT_LIMIT; i++) await runTool(tool, { sessionId: "s-1" });
    await assert.rejects(
      () => tool.execute({ sessionId: "s-1" } as never, { toolCallId: "t" }),
      /同じ確認/u
    );
  });
});

/**
 * **安全装置が人の介入を殺した**（PO報告 2026-08-13・本丸）。
 *
 * `reset()` を呼んでいたのは pi バックエンドにしか渡らない皮（`countingSession`）だけで、
 * Agent SDK バックエンドでは一度も呼ばれなかった。ターン予算が実体としてセッション累積に
 * なり、PO が2回話しかけると数えは 61 → 62 と積み上がって、**新しい指示ごと断られた**
 * ——復旧手段が手動の `kill -9` しか残らない形。
 *
 * だから継ぎ目（`BantoHarness`）で掛ける。ここでは**偽ハーネス**で振る舞いを見る
 * ——ソースの文字列検査はリファクタで簡単に嘘になるので、そちらは補助に留める。
 */
class FakeHarness implements BantoHarness {
  readonly backendId: string;
  readonly sessionId = "fake";
  isStreaming = false;
  readonly prompts: Array<{ text: string; options?: HarnessPromptOptions }> = [];

  constructor(backendId: string) {
    this.backendId = backendId;
  }

  async prompt(text: string, options?: HarnessPromptOptions): Promise<void> {
    this.prompts.push(options ? { text, options } : { text });
  }
  async abort(): Promise<void> {}
  subscribe(_handler: (event: HarnessEvent) => void): () => void {
    return () => {};
  }
  contextTokens(): number | undefined {
    return 42;
  }
  messageCount(): number {
    return this.prompts.length;
  }
  transcript(): string {
    return this.prompts.map((p) => p.text).join("\n");
  }
  async startChapter(_opening: ChapterOpening): Promise<void> {}
}

/** pi 側の形（`setModel` を持ち、札は持たない）。 */
class FakePiHarness extends FakeHarness {
  modelSet: unknown;
  constructor() {
    super("pi");
  }
  async setModel(model: unknown): Promise<void> {
    this.modelSet = model;
  }
}

/** Agent SDK 側の形（札と後始末を持ち、`setModel` は持たない）。 */
class FakeClaudeHarness extends FakeHarness {
  disposed = false;
  constructor() {
    super("claude-agent-sdk");
  }
  resumeToken(): string | undefined {
    return "resume-1";
  }
  async dispose(): Promise<void> {
    this.disposed = true;
  }
}

/** 使い切ってから、新しい入力を入れて、1回目の呼び出しが通るかを見る。 */
async function exhaustThenPrompt(
  harness: BantoHarness,
  budget: TurnBudget,
  promptOptions?: HarnessPromptOptions
): Promise<{ calls: string[]; refused: boolean }> {
  const calls: string[] = [];
  const tool = guardTurn(counted("worker.attach", calls), budget);
  let refused = false;
  for (let i = 0; i < DEFAULT_REPEAT_LIMIT + 1; i++) {
    try {
      await tool.execute({ sessionId: "s-1" } as never, { toolCallId: "t" });
    } catch {
      refused = true;
    }
  }
  assert.ok(refused, "前提が崩れている（そもそも断られていない）");

  // 新しい入力（PO の言葉・職人の知らせ・言伝・steer——出所は問わない）
  await harness.prompt("状況が変わりました", promptOptions);
  calls.length = 0;
  await tool.execute({ sessionId: "s-1" } as never, { toolCallId: "t" });
  return { calls, refused };
}

describe("[PO報告 2026-08-13] 上限に当たった状態は、次の入力で必ず解ける", () => {
  for (const make of [() => new FakePiHarness(), () => new FakeClaudeHarness()]) {
    const backendId = make().backendId;

    it(`**${backendId} でも新しい入力で数え直す**（片方だけに掛ける形を残さない）`, async () => {
      const budget = createTurnBudget();
      const harness = withTurnBudgetReset(make(), budget);
      const { calls } = await exhaustThenPrompt(harness, budget);
      assert.equal(calls.length, 1, "新しい指示を出したのに、まだ断られている");
    });

    it(`${backendId}: steer（走っている最中の差し込み）でも数え直す`, async () => {
      const budget = createTurnBudget();
      const inner = make();
      const harness = withTurnBudgetReset(inner, budget);
      const { calls } = await exhaustThenPrompt(harness, budget, { streamingBehavior: "steer" });
      assert.equal(calls.length, 1, "**止めたいときに限って止められない**形が戻っている");
      assert.deepEqual(
        inner.prompts[0]?.options,
        { streamingBehavior: "steer" },
        "皮が引数を落としている"
      );
    });

    it(`${backendId}: 会話ごとに独立している（隣の会話の数えと混ぜない）`, async () => {
      const mine = createTurnBudget();
      const neighbour = createTurnBudget();
      const harness = withTurnBudgetReset(make(), mine);
      const calls: string[] = [];
      const theirs = guardTurn(counted("worker.attach", calls), neighbour);
      for (let i = 0; i < DEFAULT_REPEAT_LIMIT; i++) {
        await theirs.execute({ sessionId: "s-1" } as never, { toolCallId: "t" });
      }

      // こちらの会話に入力が来ても、隣の数えは戻らない
      await harness.prompt("こちらの話");
      await assert.rejects(
        () => theirs.execute({ sessionId: "s-1" } as never, { toolCallId: "t" }),
        /同じ確認/u
      );
    });
  }

  it("包んでも口が消えない（省略可能な口・getter・素性がそのまま残る）", async () => {
    const budget = createTurnBudget();
    const pi = withTurnBudgetReset(new FakePiHarness(), budget);
    const claude = withTurnBudgetReset(new FakeClaudeHarness(), budget);

    assert.equal(pi.backendId, "pi");
    assert.equal(typeof pi.setModel, "function", "pi の setModel が消えている");
    assert.equal(pi.resumeToken, undefined, "持っていない口を名乗ってはいけない");
    assert.equal(claude.setModel, undefined, "持っていない口を名乗ってはいけない");
    assert.equal(claude.resumeToken?.(), "resume-1");

    // 束ねた this が壊れていないこと（`transcript` は自分の状態を読む）
    await claude.prompt("ひとこと");
    assert.equal(claude.transcript(), "ひとこと");
    assert.equal(claude.messageCount(), 1);
    assert.equal(claude.contextTokens(), 42);
    await claude.dispose?.();
    assert.ok(claude instanceof FakeClaudeHarness, "素性（instanceof）が消えている");
  });
});

describe("[PO報告 2026-08-13] 継ぎ目に掛かっている（組み立ての検査）", () => {
  it("**どちらのバックエンドも `withTurnBudgetReset` を通る**", () => {
    const bin = fs.readFileSync(
      new URL("../../packages/banto-host/src/bin.ts", import.meta.url).pathname,
      "utf-8"
    );
    // 振る舞いの検査は上の偽ハーネス側。ここは「組み立てで包み忘れていないか」だけを見る
    // （ここが動いたら、この検査を直す前に、両方に掛かっていることを確かめること）
    assert.match(bin, /withTurnBudgetReset\(\s*new PiHarness\(/u, "pi 側が包まれていない");
    assert.match(
      bin,
      /withTurnBudgetReset\(claudeHarness, turnBudget\)/u,
      "Agent SDK 側が包まれていない（**本番の既定がこちら**）"
    );
    assert.doesNotMatch(
      bin,
      /countingSession/u,
      "`HostSession` の皮で数え直す形は、pi にしか掛からない（今回の不具合の形）"
    );
  });
});

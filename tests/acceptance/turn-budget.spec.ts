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

import { createTurnBudget, guardTurn, DEFAULT_REPEAT_LIMIT } from "@banto/host";
import type { NamespacedToolDefinition } from "@banto/host";

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
    assert.match(
      src,
      /offloaded\.map\(\(tool\) => guardTurn\(tool, options\.turnBudget!\)\)/u,
      "番頭へ渡す最後の1点で掛けること（ここが動いたら、この検査を直す前に理由を書くこと）"
    );
    // 呼び出し側（bin.ts）で個別に掛け直していないこと＝足し忘れの余地を作らない
    const bin = fs.readFileSync(
      new URL("../../packages/banto-host/src/bin.ts", import.meta.url).pathname,
      "utf-8"
    );
    assert.doesNotMatch(bin, /guardTurn\(/u, "呼び出し側で選んで掛けると抜け道ができる");
  });
});

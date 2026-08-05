/**
 * 提案「コンパクションをやめ、退避と章立てで文脈を管理する」§3.6 の受け入れ検証。
 *
 * `spec-improvement-loop` §1 の「層A資産は壊れると静かに劣化する」への手当て。
 * **記憶が正しいものを差し出せているか**を、LongMemEval の6分類に倣って毎回測る。
 *
 * ここが落ちたら、記憶に手を入れた誰かが何かを壊している——予算・注入・訂正・二層の
 * どれかが、以前は届いていた記憶を届けなくなったということ。
 *
 * LLM は呼ばない（`memory-eval.ts` 冒頭の理由）。測るのは「届いているか」であって
 * モデルの賢さではない。
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { JsonlMemoryStore, ScopedMemory } from "@banto/core";
import { DEFAULT_MEMORY_EVAL, runMemoryEval, type MemoryEvalCategory } from "@banto/host";

let dir: string;
let seq = 0;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "banto-memory-eval-"));
  seq = 0;
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

/** 問いごとに空の記憶を作る（問い同士が混ざると評価にならない）。 */
function makeMemory(): ScopedMemory {
  const root = path.join(dir, `case-${++seq}`);
  return new ScopedMemory(
    new JsonlMemoryStore(path.join(root, "memory.jsonl")),
    (placeId) =>
      new JsonlMemoryStore(path.join(root, "projects", encodeURIComponent(placeId), "memory.jsonl"))
  );
}

describe("[提案§3.6] 記憶の評価セット", () => {
  it("既定の評価セットが全問通る", () => {
    const report = runMemoryEval(makeMemory, DEFAULT_MEMORY_EVAL);

    const failures = report.results
      .filter((r) => !r.passed)
      .map((r) => `${r.id} (${r.category}): ${r.notes.join(" / ")}`);

    assert.deepEqual(failures, [], `落ちた問い:\n${failures.join("\n")}`);
    assert.equal(report.failed, 0);
    assert.ok(report.passed >= 14, `問いが少なすぎる（${report.passed}問）`);
  });

  it("6分類すべてに問いがある（どこかの軸が空のまま通らない）", () => {
    const report = runMemoryEval(makeMemory, DEFAULT_MEMORY_EVAL);
    const expected: MemoryEvalCategory[] = [
      "single-session-recall",
      "preference-recall",
      "knowledge-update",
      "temporal-reasoning",
      "multi-session-recall",
      "budget-overflow",
    ];

    for (const category of expected) {
      const bucket = report.byCategory[category];
      assert.ok(bucket, `分類 ${category} に問いが無い`);
      assert.ok(bucket.total > 0, `分類 ${category} が空`);
      assert.equal(bucket.passed, bucket.total, `分類 ${category} に落ちた問いがある`);
    }
  });

  it("壊れていれば落ちる（評価が評価として働いていることの確認）", () => {
    // 「注入されるべきものが注入されない」を仕込んだ問い
    const report = runMemoryEval(makeMemory, [
      {
        id: "canary",
        category: "single-session-recall",
        question: "わざと落ちる問い",
        arrange: () => {
          /* 何も覚えさせない */
        },
        expectInPrompt: ["絶対に出てこない語"],
      },
    ]);

    assert.equal(report.failed, 1, "落ちるべき問いが通ってしまった");
    assert.match(report.results[0]!.notes.join(""), /注入されていない/);
  });

  it("結果には、通った問いでも何を見たかが残る", () => {
    const report = runMemoryEval(makeMemory, DEFAULT_MEMORY_EVAL.slice(0, 1));
    assert.ok(report.results[0]!.notes.length > 0);
  });
});

/**
 * 職人の文脈が伸びたことに気づける（task-0313・PO 裁定 2026-08-20「まず可視化だけ」）。
 *
 * 打ち切りはしない——ここで確かめるのは「どのタスクが伸びたか、後から数え直せる形で
 * 出るか」だけ。上限を入れるかどうかは、この数字が貯まってから決める（P6「根拠は計測」）。
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  ContextWatch,
  DEFAULT_CONTEXT_WARN_TOKENS,
} from "../../packages/banto-worker-pool/src/claude-agent/context-watch.js";

/** `write` を捕まえる係。`env` は既定で空＝環境変数に左右されない。 */
function watcher(env: NodeJS.ProcessEnv = {}) {
  const lines: string[] = [];
  const watch = new ContextWatch("banto-task-0307-1787219478553.jsonl", {
    env,
    write: (text) => lines.push(text),
  });
  return { watch, lines };
}

/** SDK の `usage` の形（読む部分だけ）。 */
function usage(cacheRead: number, input = 2, cacheWrite = 0) {
  return {
    input_tokens: input,
    cache_creation_input_tokens: cacheWrite,
    cache_read_input_tokens: cacheRead,
  };
}

describe("[task-0313] 伸び続ける職人に気づける（可視化のみ・打ち切らない）", () => {
  it("刻みに届かないうちは何も言わない（短い仕事を騒がない）", () => {
    const { watch, lines } = watcher();
    for (let i = 0; i < 20; i++) watch.observe(usage(50_000));
    assert.deepEqual(lines, [], "8万トークン程度の職人は中央値そのもので、知らせる相手ではない");
  });

  it("刻みを越えたら1回だけ言う（毎ターン出して journal を埋めない）", () => {
    const { watch, lines } = watcher();
    watch.observe(usage(100_000));
    assert.equal(lines.length, 0, "刻み未満では出ない");

    watch.observe(usage(210_000));
    assert.equal(lines.length, 1, "刻みを越えたら出る");

    for (let i = 0; i < 10; i++) watch.observe(usage(215_000));
    assert.equal(lines.length, 1, "同じ刻みの内側では繰り返さない");
  });

  it("刻みを重ねるごとに、また言う（40万・60万…と伸びたことが分かる）", () => {
    const { watch, lines } = watcher();
    watch.observe(usage(210_000));
    watch.observe(usage(410_000));
    watch.observe(usage(610_000));
    assert.equal(lines.length, 3, "刻みを越えるたびに出るべき");
  });

  it("どのタスクが・何ターン目で伸びたかが読める（後から数え直せる形）", () => {
    const { watch, lines } = watcher();
    for (let i = 0; i < 41; i++) watch.observe(usage(5_000));
    watch.observe(usage(400_000));

    const line = lines.at(-1) ?? "";
    assert.match(line, /banto-task-0307/, "どの仕事かが読めない");
    assert.match(line, /42 ターン目/, "何ターン目かが読めない");
    assert.match(line, /400,002/, "いくつに達したかが読めない");
  });

  it("usage が無いターンでも数えは進む（落ちない・ターン数がずれない）", () => {
    const { watch, lines } = watcher();
    watch.observe(undefined);
    watch.observe(usage(0, 0, 0));
    watch.observe(usage(250_000));

    assert.equal(lines.length, 1);
    assert.match(lines[0] ?? "", /3 ターン目/, "usage の無いターンも数に入るべき");
  });

  it("刻みは BANTO_WORKER_CONTEXT_WARN_TOKENS で変えられる", () => {
    const { watch, lines } = watcher({ BANTO_WORKER_CONTEXT_WARN_TOKENS: "50000" });
    watch.observe(usage(60_000));
    assert.equal(lines.length, 1, "5万の刻みなら6万で出るべき");
    assert.match(lines[0] ?? "", /知らせる刻み 50,000/, "効いている刻みが読めない");
  });

  it("[I2] 読めない刻みは黙って既定に落とさず知らせる", () => {
    const { watch, lines } = watcher({ BANTO_WORKER_CONTEXT_WARN_TOKENS: "ぜんぶ" });
    assert.equal(lines.length, 1, "断りが出ていない");
    assert.match(lines[0] ?? "", /正の整数です/);

    // 既定へ落ちること自体は正しい。落ちたことを黙らないのが要点
    watch.observe(usage(DEFAULT_CONTEXT_WARN_TOKENS + 1_000));
    assert.equal(lines.length, 2, "既定の刻みで動いていない");
  });
});

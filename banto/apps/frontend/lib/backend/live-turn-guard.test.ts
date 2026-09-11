// `decideRun` の見分け（`frontend-interaction-hardening`、2026-09-10）。
//
// **同じ文面をもう一度送ると、前は「再開」に見えていた**——走行中の1本を
// 2つの run が食い合い、送ったプロンプトは host に届かないまま消えた
// （`docs/notes/2026-09-06-tool-approval-review.md` §2）。ここはその見分けだけを見る。

import { test } from "node:test";
import assert from "node:assert/strict";
import { decideRun } from "./live-turn-guard.ts";

test("走行中のターンが無ければ、host に新しいターンを起こす", () => {
  assert.equal(decideRun(undefined, 1), "start");
});

test("判断待ちに答えた後の呼び直しは、同じターンの続き", () => {
  // 発言の数は変わっていない（人は何も送っていない）
  assert.equal(decideRun({ userMessageCount: 1, consuming: false }, 1), "resume");
});

test("走行中に人が送ったら、文面が同じでも受け取らない", () => {
  // ここが以前の穴——文面で見分けていたので「再開」に落ちていた
  assert.equal(decideRun({ userMessageCount: 1, consuming: false }, 2), "refuse");
});

test("誰かが読んでいる最中の呼び直しは受け取らない（1本を2つで食い合わない）", () => {
  assert.equal(decideRun({ userMessageCount: 1, consuming: true }, 1), "refuse");
});

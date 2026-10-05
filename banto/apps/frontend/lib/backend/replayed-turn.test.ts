// 流し直すターンの AI の発言を、記録から外す（`replayed-turn.ts`、追加・2026-10-05）。
// 外しすぎると前のターンの返事が消え、外し忘れると同じ発言が2つ出る。

import { test } from "node:test";
import assert from "node:assert/strict";
import { withoutReplayedReply } from "./replayed-turn.ts";

const record = (...messages: Array<[number, "user" | "assistant"]>) => ({
  messages: messages.map(([seq, role]) => ({ seq, role, text: `${role}-${seq}` })),
});
const seqs = (r: { messages: Array<{ seq: number }> }) => r.messages.map((m) => m.seq);

test("走っているターンの AI の発言（始まりより後ろ、人の発言の次の1件）だけを外す", () => {
  const r = record([1, "user"], [2, "assistant"], [11, "user"], [12, "user"], [13, "assistant"]);
  assert.deepEqual(seqs(withoutReplayedReply(r, 10)), [1, 2, 11, 12]);
});

test("まだ AI が何も書いていなければ、何も外さない", () => {
  const r = record([1, "user"], [2, "assistant"], [11, "user"]);
  assert.deepEqual(seqs(withoutReplayedReply(r, 10)), [1, 2, 11]);
});

test("境界が無い（始まりを記録する前に乗った・断られたターン）なら、何も外さない", () => {
  const r = record([1, "user"], [2, "assistant"]);
  assert.equal(withoutReplayedReply(r, undefined), r);
});

test("始まりより前の返事（前のターン）は外さない。乗ったあとに始まった次のターンの返事も外さない", () => {
  // 乗ったターン（10〜）は返事を書かずに終わり（取り消した）、次のターン（20〜）が返事を書いた
  const withdrawnThenNext = { ...record([1, "user"], [2, "assistant"], [21, "user"], [22, "assistant"]), lastTurn: { startedSeq: 20 } };
  assert.deepEqual(seqs(withoutReplayedReply(withdrawnThenNext, 10)), [1, 2, 21, 22]);
  // 乗ったターンが返事を書いて終わり、次のターンも返事を書いた——乗ったターンの返事だけ外す
  const both = {
    ...record([1, "user"], [2, "assistant"], [11, "user"], [12, "assistant"], [21, "user"], [22, "assistant"]),
    lastTurn: { startedSeq: 20 },
  };
  assert.deepEqual(seqs(withoutReplayedReply(both, 10)), [1, 2, 11, 21, 22]);
  // 記録の最後のターンが乗ったターンそのもの——その返事を外す
  const same = { ...record([1, "user"], [11, "user"], [12, "assistant"]), lastTurn: { startedSeq: 10 } };
  assert.deepEqual(seqs(withoutReplayedReply(same, 10)), [1, 11]);
});

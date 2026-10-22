// 取り直しの差分を手元の全部に重ねる（`thread-delta.ts`、追加・2026-10-22）。重ねた結果が、全部を取ったときと同じであること。

import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeThreadDelta, threadDeltaQuery } from "./thread-delta.ts";

type R = {
  messages: Array<{ seq: number; text: string }>;
  usage: Array<{ seq: number }>;
  markers: number[];
  messagesCursor?: { seq: number; hash: string };
  messagesAfter?: number;
  usageUnchanged?: true;
};
const m = (seq: number, text = `m${seq}`) => ({ seq, text });

test("差分は手元の after 以下に続ける。usage が変わっていなければ手元のもの。差分の欄は残さず、指紋は残す", () => {
  const known: R = { messages: [m(1), m(2), m(3)], usage: [{ seq: 7 }], markers: [1], messagesCursor: { seq: 2, hash: "h2" } };
  const received: R = { messages: [m(3, "m3 と続き"), m(4)], usage: [], markers: [1, 2], messagesCursor: { seq: 3, hash: "h3" }, messagesAfter: 2, usageUnchanged: true };
  const merged = mergeThreadDelta(known, received);
  assert.deepEqual(merged, { messages: [m(1), m(2), m(3, "m3 と続き"), m(4)], usage: [{ seq: 7 }], markers: [1, 2], messagesCursor: { seq: 3, hash: "h3" } });
});

test("usage が変わっていれば届いたもの。全部が届いたらそのまま（差分の欄は無い）", () => {
  const known: R = { messages: [m(1), m(2)], usage: [{ seq: 7 }], markers: [] };
  assert.deepEqual(mergeThreadDelta(known, { messages: [m(3)], usage: [{ seq: 8 }], markers: [], messagesAfter: 2 }).usage, [{ seq: 8 }]);
  const full: R = { messages: [m(1)], usage: [{ seq: 9 }], markers: [] };
  assert.deepEqual(mergeThreadDelta(known, full), full);
  assert.deepEqual(mergeThreadDelta(undefined, full), full);
});

test("差分なのに手元に前の記録が無ければ投げる（欠けた記録を出さない）", () => {
  assert.throws(() => mergeThreadDelta<R>(undefined, { messages: [m(3)], usage: [], markers: [], messagesAfter: 2 }));
});

test("クエリ：指紋があれば after・hash と最新の usage の番号。無ければ空（全部を取る）", () => {
  assert.equal(threadDeltaQuery(undefined), "");
  assert.equal(threadDeltaQuery({ messages: [], usage: [] }), "");
  assert.equal(threadDeltaQuery({ messages: [], usage: [{ seq: 5 }], messagesCursor: { seq: 2, hash: "a+b/c" } }), "?after=2&hash=a%2Bb%2Fc&usageSeq=5");
  assert.equal(threadDeltaQuery({ messages: [], usage: [], messagesCursor: { seq: 2, hash: "h" } }), "?after=2&hash=h");
});

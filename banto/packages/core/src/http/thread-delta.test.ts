import { test } from "node:test";
import assert from "node:assert/strict";
import { messagesCursorOf, messagesHash, parseThreadDeltaRequest, withThreadDelta } from "./thread-delta.js";

const msg = (seq: number, text: string, extra: Record<string, unknown> = {}) => ({ seq, role: seq % 2 ? "user" : "assistant", text, ...extra });
const detailOf = (messages: ReturnType<typeof msg>[], usageSeq = 10) => ({
  id: "t1",
  markers: [{ seq: 1 }],
  usage: [{ seq: usageSeq, contextUsage: { big: "x".repeat(100) } }],
  messages,
});

test("指紋は最後から2つ目まで。発言が2件未満なら付けない", () => {
  const messages = [msg(1, "a"), msg(2, "b"), msg(3, "c")];
  assert.deepEqual(messagesCursorOf(messages), { seq: 2, hash: messagesHash(messages, 2) });
  assert.equal(messagesCursorOf([msg(1, "a")]), undefined);
  assert.equal(withThreadDelta(detailOf([msg(1, "a")]), {}).messagesCursor, undefined);
});

test("前の発言が変わっていなければ、後ろの発言だけを返す（最後の1件が伸びていても）。ほかの欄は全部", () => {
  const before = detailOf([msg(1, "a"), msg(2, "b"), msg(3, "c")]);
  const cursor = withThreadDelta(before, {}).messagesCursor!;
  // 最後の1件（seq 3）に書き足され、新しい発言が2つ足された
  const now = detailOf([msg(1, "a"), msg(2, "b"), msg(3, "c と続き"), msg(4, "d"), msg(5, "e")], 11);
  const delta = withThreadDelta(now, { after: cursor.seq, hash: cursor.hash, usageSeq: 10 });
  assert.equal(delta.messagesAfter, 2);
  assert.deepEqual(delta.messages.map((m) => m.seq), [3, 4, 5]);
  assert.equal(delta.messages[0]!.text, "c と続き");
  assert.deepEqual(delta.markers, [{ seq: 1 }]);
  // usage は番号が変わったので送る
  assert.equal(delta.usageUnchanged, undefined);
  assert.equal(delta.usage.length, 1);
  // 次の指紋はいまの記録の最後から2つ目
  assert.deepEqual(delta.messagesCursor, messagesCursorOf(now.messages));
});

test("usage は番号が同じなら送らない（差分のときだけ）", () => {
  const d = detailOf([msg(1, "a"), msg(2, "b"), msg(3, "c")]);
  const c = messagesCursorOf(d.messages)!;
  const delta = withThreadDelta(d, { after: c.seq, hash: c.hash, usageSeq: 10 });
  assert.equal(delta.usageUnchanged, true);
  assert.deepEqual(delta.usage, []);
  // 全部を返すときは usage も全部
  const full = withThreadDelta(d, { usageSeq: 10 });
  assert.equal(full.usageUnchanged, undefined);
  assert.equal(full.usage.length, 1);
});

test("前の発言が変わったら全部を返す：取り下げ・表示の印の後付け・判断待ちの答え", () => {
  const before = [msg(1, "a"), msg(2, "b", { uiToolCalls: [{ toolCallId: "x" }] }), msg(3, "c", { judgments: [{ id: "j", liveness: "live" }] }), msg(4, "d")];
  const c = messagesCursorOf(before)!; // seq 3 まで
  const cases = {
    取り下げ: [msg(1, "a"), msg(3, "c", { judgments: [{ id: "j", liveness: "live" }] }), msg(4, "d")],
    指紋の発言の取り下げ: [msg(1, "a"), msg(2, "b", { uiToolCalls: [{ toolCallId: "x" }] }), msg(4, "d")],
    表示の印: [msg(1, "a"), msg(2, "b", { uiToolCalls: [{ toolCallId: "x", displayMode: "fullscreen" }] }), msg(3, "c", { judgments: [{ id: "j", liveness: "live" }] }), msg(4, "d")],
    判断待ちの答え: [msg(1, "a"), msg(2, "b", { uiToolCalls: [{ toolCallId: "x" }] }), msg(3, "c", { judgments: [{ id: "j", liveness: "answered", answer: "はい" }] }), msg(4, "d")],
  };
  for (const [name, messages] of Object.entries(cases)) {
    const r = withThreadDelta(detailOf(messages), { after: c.seq, hash: c.hash, usageSeq: 10 });
    assert.equal(r.messagesAfter, undefined, name);
    assert.deepEqual(r.messages, messages, name);
    assert.equal(r.usage.length, 1, `${name}：全部のときは usage も送る`);
  }
});

test("クエリ：数でない after・usageSeq は無いものとして扱い、全部を返す", () => {
  assert.deepEqual(parseThreadDeltaRequest(new URLSearchParams("after=12&hash=abc&usageSeq=3")), { after: 12, hash: "abc", usageSeq: 3 });
  assert.deepEqual(parseThreadDeltaRequest(new URLSearchParams("after=x&hash=abc")), { hash: "abc" });
  assert.deepEqual(parseThreadDeltaRequest(new URLSearchParams("")), {});
  const d = detailOf([msg(1, "a"), msg(2, "b"), msg(3, "c")]);
  assert.equal(withThreadDelta(d, { hash: "abc" }).messagesAfter, undefined);
});

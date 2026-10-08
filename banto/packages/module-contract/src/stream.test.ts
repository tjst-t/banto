// 流れの刻印（host → Module）と、画面の資源の名乗り（アーキ仕様 §5.8）
import { test } from "node:test";
import assert from "node:assert/strict";
import { decodeStreamStamp, encodeStreamStamp, streamNamesOf, STREAMS_META_KEY, type StreamStamp } from "./stream.js";

test("刻印は日本語の params ごと往復し、ヘッダに載せられる文字だけになる", () => {
  const stamp: StreamStamp = { name: "terminal", params: { title: "端末" }, projectId: "p1", threadId: "t1", resourceUri: "ui://t/main", human: true };
  const header = encodeStreamStamp(stamp);
  assert.match(header, /^[A-Za-z0-9_-]+$/);
  assert.deepEqual(decodeStreamStamp(header), stamp);
});

test("形の違う刻印は読まない（Module は断る）", () => {
  const enc = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
  assert.equal(decodeStreamStamp(undefined), undefined);
  assert.equal(decodeStreamStamp("not-json"), undefined);
  assert.equal(decodeStreamStamp(enc({ name: "x", params: {}, resourceUri: "ui://a" })), undefined); // human が無い
  assert.equal(decodeStreamStamp(enc({ name: "x", params: [], resourceUri: "ui://a", human: true })), undefined);
  assert.equal(decodeStreamStamp(enc({ name: "x", params: {}, resourceUri: "ui://a", human: true, projectId: 1 })), undefined);
});

test("名乗っている流れの名前を読む（形が違えば空）", () => {
  assert.deepEqual(streamNamesOf({ [STREAMS_META_KEY]: ["terminal", "", 3, "log"] }), ["terminal", "log"]);
  assert.deepEqual(streamNamesOf({ [STREAMS_META_KEY]: "terminal" }), []);
  assert.deepEqual(streamNamesOf(undefined), []);
});

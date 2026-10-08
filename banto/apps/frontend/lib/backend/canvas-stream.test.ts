// Canvas から流れを開く頼み：名前は要る・params はオブジェクトだけ
import { test } from "node:test";
import assert from "node:assert/strict";
import { newFrameId, parseStreamOpenParams } from "./canvas-stream.ts";

test("流れを開く頼み：名前と params（オブジェクト）を読み、形が違えば理由を返す", () => {
  assert.deepEqual(parseStreamOpenParams({ name: "echo" }), { name: "echo", params: {} });
  assert.deepEqual(parseStreamOpenParams({ name: "echo", params: { a: 1 } }), { name: "echo", params: { a: 1 } });
  assert.ok("error" in parseStreamOpenParams({}));
  assert.ok("error" in parseStreamOpenParams({ name: "" }));
  assert.ok("error" in parseStreamOpenParams({ name: "echo", params: [1] }));
  assert.ok("error" in parseStreamOpenParams({ name: "echo", params: "x" }));
});

test("iframe ごとの印は crypto.randomUUID が無い（http の LAN アドレスの携帯）でも作れる——Canvas を描くたびに走る", () => {
  const original = crypto.randomUUID;
  Object.defineProperty(crypto, "randomUUID", { value: undefined, configurable: true, writable: true });
  try {
    const a = newFrameId();
    assert.match(a, /^[0-9a-f-]{36}$/);
    assert.notEqual(a, newFrameId());
  } finally {
    Object.defineProperty(crypto, "randomUUID", { value: original, configurable: true, writable: true });
  }
});

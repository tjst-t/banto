import { test } from "node:test";
import assert from "node:assert/strict";
import { randomId } from "./random-id.ts";

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

test("crypto.randomUUID が無い（安全でない文脈）でも UUID v4 の形を返す", () => {
  const original = crypto.randomUUID;
  Object.defineProperty(crypto, "randomUUID", { value: undefined, configurable: true, writable: true });
  try {
    const a = randomId();
    const b = randomId();
    assert.match(a, UUID_V4);
    assert.notEqual(a, b);
  } finally {
    Object.defineProperty(crypto, "randomUUID", { value: original, configurable: true, writable: true });
  }
});

test("crypto.randomUUID があればそれを使う", () => {
  assert.match(randomId(), UUID_V4);
});

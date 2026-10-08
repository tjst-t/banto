// Canvas から流れを開く頼み：名前は要る・params はオブジェクトだけ
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseStreamOpenParams } from "./canvas-stream.ts";

test("流れを開く頼み：名前と params（オブジェクト）を読み、形が違えば理由を返す", () => {
  assert.deepEqual(parseStreamOpenParams({ name: "echo" }), { name: "echo", params: {} });
  assert.deepEqual(parseStreamOpenParams({ name: "echo", params: { a: 1 } }), { name: "echo", params: { a: 1 } });
  assert.ok("error" in parseStreamOpenParams({}));
  assert.ok("error" in parseStreamOpenParams({ name: "" }));
  assert.ok("error" in parseStreamOpenParams({ name: "echo", params: [1] }));
  assert.ok("error" in parseStreamOpenParams({ name: "echo", params: "x" }));
});

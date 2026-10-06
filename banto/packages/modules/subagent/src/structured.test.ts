import { test } from "node:test";
import assert from "node:assert/strict";
import { compileSchema, extractJson } from "./structured.js";

test("返答から JSON を取り出す——全体・囲み・文の中の最後のもの。無ければ undefined", () => {
  assert.deepEqual(extractJson(' {"a":1} '), { value: { a: 1 } });
  assert.deepEqual(extractJson('前置き\n```json\n{"a":2}\n```\n後ろ'), { value: { a: 2 } });
  assert.deepEqual(extractJson('結果は {"verdict":"pass","items":[]}（model=x）'), { value: { verdict: "pass", items: [] } });
  assert.deepEqual(extractJson('{"a":"} の中"} と {"b":[1,{"c":2}]}'), { value: { b: [1, { c: 2 }] } });
  assert.equal(extractJson("JSON はありません"), undefined);
});

test("schema で確かめる——合えば undefined、合わなければ理由。読めない schema は断る", () => {
  const c = compileSchema({
    type: "object",
    required: ["verdict"],
    properties: { verdict: { enum: ["pass", "changes"] } },
  });
  assert.equal(c.check({ verdict: "pass" }), undefined);
  assert.match(c.check({ verdict: "maybe" }) ?? "", /verdict/);
  assert.match(c.check({}) ?? "", /verdict/);
  assert.throws(() => compileSchema("文字"), /JSON Schema/);
  assert.throws(() => compileSchema({ type: "no-such-type" }), /JSON Schema として読めません/);
});

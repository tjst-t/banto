import { test } from "node:test";
import assert from "node:assert/strict";
import { formFieldsOf, parseFieldValue } from "./form-fields.ts";

test("formFieldsOf：数の欄だけを、題・上限下限・既定つきで読む。形の違うものは出さない", () => {
  const schema = {
    type: "object",
    properties: {
      maxWakes: { type: "integer", title: "起きる回数の上限（回）", minimum: 1, maximum: 100, default: 20 },
      untilDays: { type: "number", title: "期限（今から何日）", minimum: 0.1, maximum: 14, default: 3 },
      note: { type: "string", title: "メモ" },
      odd: "x",
    },
  };
  assert.deepEqual(formFieldsOf(schema), [
    { name: "maxWakes", title: "起きる回数の上限（回）", type: "integer", minimum: 1, maximum: 100, default: 20 },
    { name: "untilDays", title: "期限（今から何日）", type: "number", minimum: 0.1, maximum: 14, default: 3 },
  ]);
  assert.deepEqual(formFieldsOf(undefined), []);
  assert.deepEqual(formFieldsOf({ properties: [] }), []);
});

test("parseFieldValue：数・整数・上限下限を確かめる", () => {
  const field = { name: "maxWakes", title: "回数", type: "integer" as const, minimum: 1, maximum: 100 };
  assert.deepEqual(parseFieldValue(field, " 30 "), { value: 30 });
  assert.deepEqual(parseFieldValue(field, ""), { problem: "回数は数で入れてください" });
  assert.deepEqual(parseFieldValue(field, "1.5"), { problem: "回数は整数で入れてください" });
  assert.deepEqual(parseFieldValue(field, "0"), { problem: "回数は 1 以上にしてください" });
  assert.deepEqual(parseFieldValue(field, "101"), { problem: "回数は 100 以下にしてください" });
  assert.deepEqual(parseFieldValue({ ...field, type: "number" }, "2.5"), { value: 2.5 });
});

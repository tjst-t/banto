import { test } from "node:test";
import assert from "node:assert/strict";
import { distinctDescription, fillCardText } from "./card-text.ts";

// `@banto/module-contract` の meta.test.ts の fillCardText と同じ見方（写しが食い違っていないか）
test("fillCardText：{引数名} を埋め、1行に収めて 80 字で畳む。無い名前は残す", () => {
  assert.equal(fillCardText("{agent} に頼んだ仕事", { agent: "claude-code" }), "claude-code に頼んだ仕事");
  assert.equal(fillCardText("{prompt}", { prompt: "一行目\n二行目" }), "一行目 二行目");
  assert.equal(fillCardText("{prompt}", { prompt: "あ".repeat(90) }), `${"あ".repeat(80)}…`);
  assert.equal(fillCardText("{nope} の仕事", {}), "{nope} の仕事");
  assert.equal(fillCardText("{obj}", { obj: { a: 1 } }), "{obj}");
  assert.equal(fillCardText(undefined, {}), undefined);
  assert.equal(fillCardText("{x}", { x: "  " }), undefined);
});

test("fillCardText：{a|b} は左から順に使える最初の引数。空白だけの文字列は飛ばし、どれも無ければ残す", () => {
  assert.equal(fillCardText("{label|command}", { label: "E2E を 20 回", command: "npm run e2e" }), "E2E を 20 回");
  assert.equal(fillCardText("{label|command}", { command: "npm run e2e" }), "npm run e2e");
  assert.equal(fillCardText("{label|command}", { label: "  \n", command: "npm run e2e" }), "npm run e2e");
  assert.equal(fillCardText("{label|command}", { label: { x: 1 }, command: "npm run e2e" }), "npm run e2e");
  assert.equal(fillCardText("{label|count}", { count: 0 }), "0");
  assert.equal(fillCardText("{a|b|c} の仕事", { c: "三つ目" }), "三つ目 の仕事");
  assert.equal(fillCardText("{label|command}", {}), "{label|command}");
  assert.equal(fillCardText("{label|command}", { label: "一行目\n二行目" }), "一行目 二行目");
  assert.equal(fillCardText("[{x}]", { x: "" }), "[]");
});

test("distinctDescription：題と同じ文の説明は出さない", () => {
  assert.equal(distinctDescription("npm run e2e", "npm run e2e"), undefined);
  assert.equal(distinctDescription("E2E を 20 回", "npm run e2e"), "npm run e2e");
  assert.equal(distinctDescription("題", undefined), undefined);
  assert.equal(distinctDescription(undefined, "説明"), "説明");
});

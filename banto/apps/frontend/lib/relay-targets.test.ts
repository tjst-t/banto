import { test } from "node:test";
import assert from "node:assert/strict";
import { splitTargets } from "./relay-targets.ts";

test("splitTargets：対象が配列なら表にし、残りの中身から抜く——列は現れた順", () => {
  const input = { 名前: "resolveAliases", 対象: [{ name: "a" }, { name: "b", group: "g1" }] };
  assert.deepEqual(splitTargets(input), {
    rest: { 名前: "resolveAliases" },
    targets: { columns: ["name", "group"], rows: [{ name: "a" }, { name: "b", group: "g1" }] },
  });
});

test("splitTargets：対象が配列でない（1件ずつの口）・形が違うものが混ざるなら、中身をそのまま出す", () => {
  const single = { 名前: "resolveAlias", 対象: { name: "a" } };
  assert.deepEqual(splitTargets(single), { rest: single });
  const odd = { 対象: [{ name: "a" }, "b"] };
  assert.deepEqual(splitTargets(odd), { rest: odd });
  const nonString = { 対象: [{ name: 1 }] };
  assert.deepEqual(splitTargets(nonString), { rest: nonString });
  assert.deepEqual(splitTargets(undefined), { rest: undefined });
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { isNewerBuild } from "./frontend-build-compare.ts";

test("印が違えば新しい版", () => {
  assert.equal(isNewerBuild("aaa-1", "bbb-2"), true);
});

test("同じ印なら新しくない", () => {
  assert.equal(isNewerBuild("aaa-1", "aaa-1"), false);
});

test("どちらかが分からなければ勧めない", () => {
  assert.equal(isNewerBuild(null, "bbb-2"), false);
  assert.equal(isNewerBuild("", "bbb-2"), false);
  assert.equal(isNewerBuild("aaa-1", null), false);
  assert.equal(isNewerBuild("aaa-1", ""), false);
  assert.equal(isNewerBuild("aaa-1", 42), false);
});

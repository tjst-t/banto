// 大きく開いた Module の画面の「見ている場所」（banto の拡張、`dev.banto/view-state`）。

import { test } from "node:test";
import assert from "node:assert/strict";
import { MAX_VIEW_STATE_LENGTH, parseViewState, serializeViewState } from "./canvas-view-state.ts";

test("預かった場所は、URL の値を通ってそのまま画面に戻る", () => {
  const state = { file: "docs/README.md", dir: "docs", treeCollapsed: false };
  assert.deepEqual(parseViewState(serializeViewState(state)!), state);
});

test("壊れた URL の値は、無いことにする（開き直すと最初の画面になるだけ）", () => {
  assert.equal(parseViewState(null), undefined);
  assert.equal(parseViewState("{壊れている"), undefined);
});

test("大きすぎるもの・JSON にできないものは預からない", () => {
  assert.equal(serializeViewState({ file: "x".repeat(MAX_VIEW_STATE_LENGTH) }), undefined);
  const loop: Record<string, unknown> = {};
  loop.self = loop;
  assert.equal(serializeViewState(loop), undefined);
  assert.equal(serializeViewState(undefined), undefined);
});

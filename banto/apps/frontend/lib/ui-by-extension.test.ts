// `@banto/module-contract` の `uiResourceUriForCall` の写し（ui-by-extension.ts）が、同じ答えを返すことを見る
import { test } from "node:test";
import assert from "node:assert/strict";
import { uiResourceUriForCall } from "./ui-by-extension.ts";

test("引数のパスの拡張子に当たればその画面、当たらなければ tool の画面", () => {
  const meta = { arg: "path", byExtension: { pdf: "ui://fs/document" } };
  assert.equal(uiResourceUriForCall("ui://fs/file", meta, { path: "docs/Plan.PDF" }), "ui://fs/document");
  assert.equal(uiResourceUriForCall("ui://fs/file", meta, { path: "/abs/dir.pdf/a.txt" }), "ui://fs/file");
  assert.equal(uiResourceUriForCall("ui://fs/file", meta, { path: ".pdf" }), "ui://fs/file");
  assert.equal(uiResourceUriForCall("ui://fs/file", meta, { path: 3 }), "ui://fs/file");
  assert.equal(uiResourceUriForCall("ui://fs/file", undefined, { path: "a.pdf" }), "ui://fs/file");
});

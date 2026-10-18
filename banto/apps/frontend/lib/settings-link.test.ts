import { test } from "node:test";
import assert from "node:assert/strict";
import { settingsCloseHref, settingsToggleHref } from "./settings-link.ts";

// 決定・2026-10-18（v4-frontend.md §6.16）：サイドバーの「設定」は押すたびに開閉を切り替える
test("settingsToggleHref：閉じていれば開き、開いていれば下の画面の URL へ閉じる", () => {
  const p = "/p/abc";
  assert.equal(settingsToggleHref(p, new URLSearchParams("fork=f1"), { project: "abc" }), "/p/abc?fork=f1&settings=1&project=abc");
  assert.equal(settingsToggleHref(p, new URLSearchParams("fork=f1&settings=1&project=abc&section=resources")), "/p/abc?fork=f1");
  // `/settings` を直接開いていたなら、見ていた Project の会話へ
  assert.equal(settingsToggleHref("/settings", new URLSearchParams("project=abc")), "/p/abc");
  assert.equal(settingsToggleHref("/settings", new URLSearchParams("")), "/");
});

// 受信箱を開くとき（usePanelStack の settings: false）はこの URL の上に overlay を足す
test("settingsCloseHref：設定の印・project・section だけを外し、ほかの印は残す", () => {
  assert.equal(settingsCloseHref("/p/abc", new URLSearchParams("canvas=m:v&settings=1&project=abc")), "/p/abc?canvas=m%3Av");
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { backgroundViewHref } from "./background-view.ts";

test("入口を canvasView＝select で開く。Fork ならその Fork を開く", () => {
  const href = backgroundViewHref("p1", null, "shell", { resourceUri: "ui://banto-shell/commands", select: { commandId: "c1" } });
  const url = new URL(href, "http://x");
  assert.equal(url.pathname, "/p/p1");
  assert.equal(url.searchParams.get("canvas"), "shell:ui://banto-shell/commands");
  assert.equal(url.searchParams.get("canvasView"), '{"commandId":"c1"}');
  assert.equal(url.searchParams.get("fork"), null);
  assert.equal(new URL(backgroundViewHref("p1", "f1", "shell", { resourceUri: "ui://x/y" }), "http://x").searchParams.get("fork"), "f1");
  assert.equal(new URL(backgroundViewHref("p1", null, "shell", { resourceUri: "ui://x/y" }), "http://x").searchParams.get("canvasView"), null);
});

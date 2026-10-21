import { test } from "node:test";
import assert from "node:assert/strict";
import { backgroundViewOf, BACKGROUND_VIEW_META_KEY, BACKGROUND_VIEW_SELECT_MAX } from "./background-work.js";

test("backgroundViewOf：ui:// の資源と、JSON にできる select だけを読む", () => {
  assert.deepEqual(backgroundViewOf({ [BACKGROUND_VIEW_META_KEY]: { resourceUri: "ui://banto-shell/commands", select: { commandId: "c1" } } }), {
    resourceUri: "ui://banto-shell/commands",
    select: { commandId: "c1" },
  });
  assert.deepEqual(backgroundViewOf({ [BACKGROUND_VIEW_META_KEY]: { resourceUri: "ui://x/y" } }), { resourceUri: "ui://x/y" });
  assert.equal(backgroundViewOf({ [BACKGROUND_VIEW_META_KEY]: { resourceUri: "https://x/y" } }), undefined);
  assert.equal(backgroundViewOf({ [BACKGROUND_VIEW_META_KEY]: "ui://x/y" }), undefined);
  assert.equal(backgroundViewOf({ [BACKGROUND_VIEW_META_KEY]: { resourceUri: `ui://${"x".repeat(600)}` } }), undefined);
  assert.equal(
    backgroundViewOf({ [BACKGROUND_VIEW_META_KEY]: { resourceUri: "ui://x/y", select: { big: "x".repeat(BACKGROUND_VIEW_SELECT_MAX) } } }),
    undefined,
  );
  assert.equal(backgroundViewOf(undefined), undefined);
});

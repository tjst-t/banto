import { test } from "node:test";
import assert from "node:assert/strict";
import { forkActionsAllowed } from "./chat-fork.ts";

// 決定・2026-10-21（v4-architecture.md §2.2「チャット」・v4-frontend.md §6.53）：チャットでは Fork を作らない
test("forkActionsAllowed：チャットでは出さず、普通の Project（「Project にする」で印が外れたものも）では出す", () => {
  assert.equal(forkActionsAllowed({ kind: "chat" }), false);
  assert.equal(forkActionsAllowed({}), true);
});

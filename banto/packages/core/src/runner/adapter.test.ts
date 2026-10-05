import { test } from "node:test";
import assert from "node:assert/strict";
import { runTurn } from "./adapter.js";

test("続きの会話（forkSession 無しの resume）に session id を渡したら、CLI を起こす前に断る", async () => {
  const gen = runTurn({ resumeSessionId: "s-1", sessionId: "11111111-1111-4111-8111-111111111111", prompt: "x", systemPrompt: [] });
  await assert.rejects(gen.next(), /sessionId は新しい会話か forkSession のときだけ/);
});

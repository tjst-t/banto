import { test } from "node:test";
import assert from "node:assert/strict";
import { judgmentAnswerText } from "./answer-text.js";
import { MESSAGE_ALLOW_REMEMBER } from "../delivery/thread-messages.js";

test("judgmentAnswerText：許可・覚える許可・理由つきの拒否・理由なしの拒否", () => {
  assert.equal(judgmentAnswerText({ behavior: "allow" }), "許可する");
  assert.equal(judgmentAnswerText({ behavior: "allow", remember: true }), MESSAGE_ALLOW_REMEMBER);
  assert.equal(judgmentAnswerText({ behavior: "deny", message: "人がターンを止めました" }), "人がターンを止めました");
  assert.equal(judgmentAnswerText({ behavior: "deny" }), "拒否する");
});

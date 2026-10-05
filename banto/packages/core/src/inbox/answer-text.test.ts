import { test } from "node:test";
import assert from "node:assert/strict";
import { judgmentAnswerText } from "./answer-text.js";
import { MESSAGE_ALLOW_REMEMBER } from "../delivery/thread-messages.js";
import { AUTO_APPROVED_ANSWER, AUTO_APPROVED_ANSWER_TEXT } from "./auto-approve.js";

test("judgmentAnswerText：許可・覚える許可・理由つきの拒否・理由なしの拒否", () => {
  assert.equal(judgmentAnswerText({ behavior: "allow" }), "許可する");
  assert.equal(judgmentAnswerText({ behavior: "allow", remember: true }), MESSAGE_ALLOW_REMEMBER);
  assert.equal(judgmentAnswerText({ behavior: "deny", message: "人がターンを止めました" }), "人がターンを止めました");
  assert.equal(judgmentAnswerText({ behavior: "deny" }), "拒否する");
});

test("judgmentAnswerText：host が自動で許可したものは、そうと分かる言葉にする（追加・2026-10-05）", () => {
  assert.equal(judgmentAnswerText(AUTO_APPROVED_ANSWER), AUTO_APPROVED_ANSWER_TEXT);
  assert.match(judgmentAnswerText(AUTO_APPROVED_ANSWER), /自動で許可/);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseModuleMeta, classifyMetaDifference } from "./meta.js";
import { parseResumeAnswers, parseResumeQuestion, replyToFingerprint } from "./resume.js";

const base = { satisfies: ["x"], isolation: "subprocess" };

test("resumesAfterRestart：名乗らなければ false、true を名乗れば true、書き間違いは断る", () => {
  assert.equal(parseModuleMeta(base, "t").resumesAfterRestart, false);
  assert.equal(parseModuleMeta({ ...base, resumesAfterRestart: true }, "t").resumesAfterRestart, true);
  assert.throws(() => parseModuleMeta({ ...base, resumesAfterRestart: "true" }, "t"), /resumesAfterRestart は true か false/);
});

test("resumesAfterRestart の食い違いは起動の形に関わらない（other）", () => {
  const d = classifyMetaDifference(parseModuleMeta(base, "a"), parseModuleMeta({ ...base, resumesAfterRestart: true }, "b"));
  assert.deepEqual(d, { stricter: [], looser: [], other: ["resumesAfterRestart"] });
});

test("問いを読む：形が違えば投げる", () => {
  assert.deepEqual(
    parseResumeQuestion({ items: [{ replyTo: "r1", toolName: "runSubagent", toolCallId: "toolu_1", thread: { threadId: "t1", projectId: "p1" } }] }),
    { items: [{ replyTo: "r1", toolName: "runSubagent", toolCallId: "toolu_1", thread: { threadId: "t1", projectId: "p1" } }] },
  );
  assert.throws(() => parseResumeQuestion({}), /items/);
  assert.throws(() => parseResumeQuestion({ items: [{ thread: { threadId: "t" } }] }), /replyTo/);
});

test("答えを読む：問いに無い札・形の違う答えは捨て、理由の無い「やめた」には理由を補う", () => {
  const got = parseResumeAnswers(
    {
      answers: [
        { replyTo: "r1", resume: true },
        { replyTo: "r2", resume: false },
        { replyTo: "r3", resume: "yes" },
        { replyTo: "unknown", resume: true },
        { replyTo: "r1", resume: false, reason: "二つめは無視" },
      ],
    },
    ["r1", "r2", "r3"],
  );
  assert.deepEqual([...got.values()], [
    { replyTo: "r1", resume: true },
    { replyTo: "r2", resume: false, reason: "理由は書かれていません" },
  ]);
  assert.equal(parseResumeAnswers("壊れた", ["r1"]).size, 0);
});

test("札の指紋は札そのものを含まず、同じ札なら同じ", () => {
  const f = replyToFingerprint("reply_abc");
  assert.equal(f, replyToFingerprint("reply_abc"));
  assert.notEqual(f, replyToFingerprint("reply_abd"));
  assert.doesNotMatch(f, /reply_abc/);
  assert.equal(f.length, 32);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseModuleMeta, classifyMetaDifference } from "./meta.js";
import { isHostResumeCall, parseResumeAnswers, parseResumeQuestion, replyToFingerprint } from "./resume.js";
import { CALL_ID_META_KEY, CALLER_META_KEY, THREAD_META_KEY } from "./meta.js";

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
  // Module が中継で頼んだ仕事は Thread の代わりに呼び元の Module。どちらか一方だけ
  assert.deepEqual(parseResumeQuestion({ items: [{ replyTo: "r2", caller: { module: "factory", projectId: "p1" } }] }), {
    items: [{ replyTo: "r2", caller: { module: "factory", projectId: "p1" } }],
  });
  assert.throws(() => parseResumeQuestion({ items: [{ replyTo: "r" }] }), /どちらか一方/);
  assert.throws(() => parseResumeQuestion({ items: [{ replyTo: "r", thread: { threadId: "t" }, caller: { module: "m" } }] }), /どちらか一方/);
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

test("問いは host だけ：呼び元の印（人の画面・中継・AI のターン）が付いていたら host の問いではない", () => {
  assert.equal(isHostResumeCall(undefined), true);
  assert.equal(isHostResumeCall({ progressToken: 1 }), true);
  assert.equal(isHostResumeCall({ [CALLER_META_KEY]: { admin: true } }), false);
  assert.equal(isHostResumeCall({ [CALLER_META_KEY]: { project: "p1" } }), false);
  assert.equal(isHostResumeCall({ [THREAD_META_KEY]: { projectId: "p1", threadId: "t1" } }), false);
  assert.equal(isHostResumeCall({ [CALL_ID_META_KEY]: "c1" }), false);
});

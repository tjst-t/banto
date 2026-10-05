import { test } from "node:test";
import assert from "node:assert/strict";
import { ModuleCallTracker } from "./module-calls.js";

// **出所は呼び出し単位で引ける**（追加・2026-09-28、Fable のレビュー）。banto 全体の Module は同じ接続で
// ある Project の AI のターンと人の画面を同時に処理しうる。印を渡せばその1件、渡さなければ今までどおり全部を合わせる
test("呼び出しの印を渡せばその1件について答え、渡さなければ接続で走っている全部を合わせる（混ざれば厳しいほう）", () => {
  const t = new ModuleCallTracker();
  const turn = t.beginCall("window", "t1", "turn", "pA");
  const canvas = t.beginCall("window", "t2", "canvas", "pA");
  const other = t.beginCall("window", "t3", "turn", "pB");
  assert.notEqual(turn.id, canvas.id);

  assert.equal(t.originFor("window", canvas.id), "canvas");
  assert.deepEqual(t.threadFor("window", canvas.id), { kind: "thread", threadId: "t2" });
  assert.deepEqual(t.callerFor("window", canvas.id), { project: "pA" });
  assert.deepEqual(t.callerFor("window", other.id), { project: "pB" });
  // 印が無ければ今までどおり——ターンが混ざればターン、Project が混ざれば決められない
  assert.equal(t.originFor("window"), "turn");
  assert.equal(t.callerFor("window"), undefined);
  assert.deepEqual(t.threadFor("window"), { kind: "ambiguous", threadIds: ["t1", "t2", "t3"] });

  // 終わった呼び出しの印・別の接続の印は、**何も指さない**（改訂・2026-10-05、docs/notes/2026-10-05-relay-stale-card.md）
  // ——以前は接続の全部に戻していたので、終わった呼び出しの仕事が、同じ Module を使っている別のターンの呼び出しを借りた
  canvas.end();
  assert.equal(t.originFor("window", canvas.id), undefined);
  assert.deepEqual(t.threadFor("window", canvas.id), { kind: "none" }, "終わった呼び出しの印で、別のターンの会話を借りた");
  assert.equal(t.isRunning("window", canvas.id), false);
  assert.equal(t.isRunning("window"), true);
  const elsewhere = t.beginCall("other-module", "t9", "canvas", "pA");
  assert.equal(t.originFor("window", elsewhere.id), undefined, "別の接続の印で、この接続の呼び出しを名指せた");
  turn.end();
  other.end();
  elsewhere.end();
  assert.equal(t.originFor("window"), undefined);
});

test("whenEnded：対象の呼び出しが全部終わったら1回だけ呼ぶ／走っていなければすぐ呼ぶ／取り消せる", () => {
  const t = new ModuleCallTracker();
  let calls = 0;
  t.whenEnded("m", undefined, () => calls++);
  assert.equal(calls, 1, "走っていなければすぐ");

  const a = t.beginCall("m", "th");
  const b = t.beginCall("m", "th");
  let both = 0;
  t.whenEnded("m", undefined, () => both++);
  let onlyA = 0;
  t.whenEnded("m", a.id, () => onlyA++);
  let cancelled = 0;
  const cancel = t.whenEnded("m", b.id, () => cancelled++);
  cancel();
  a.end();
  assert.equal(onlyA, 1);
  assert.equal(both, 0, "b がまだ走っている");
  b.end();
  b.end();
  assert.equal(both, 1);
  assert.equal(cancelled, 0);
});

test("holdForHuman：待っている間だけ isWaitingOnHuman が true（重ねてよい・二度外しても負にならない）", () => {
  const t = new ModuleCallTracker();
  const a = t.beginCall("m", "th");
  const r1 = t.holdForHuman("m", a.id);
  const r2 = t.holdForHuman("m", a.id);
  assert.equal(t.isWaitingOnHuman("m", a.id), true);
  r1();
  r1();
  assert.equal(t.isWaitingOnHuman("m", a.id), true);
  r2();
  assert.equal(t.isWaitingOnHuman("m", a.id), false);
  a.end();
  assert.equal(t.isWaitingOnHuman("m", a.id), false);
});

test("isModuleWaitingOnHuman：その Module のどれかの呼び出しが人を待っている間だけ true（別の Module は数えない）", () => {
  const t = new ModuleCallTracker();
  const a = t.beginCall("m", "th1");
  const b = t.beginCall("m", "th2");
  const other = t.beginCall("n", "th3");
  assert.equal(t.isModuleWaitingOnHuman("m"), false);
  const release = t.holdForHuman("m", a.id);
  assert.equal(t.isModuleWaitingOnHuman("m"), true);
  assert.equal(t.isWaitingOnHuman("m", b.id), false, "後ろの呼び出し自身は人を待っていない");
  assert.equal(t.isModuleWaitingOnHuman("n"), false);
  release();
  assert.equal(t.isModuleWaitingOnHuman("m"), false);
  // 終わった呼び出しの印で持とうとしても、誰も人待ちにならない
  a.end();
  t.holdForHuman("m", a.id);
  assert.equal(t.isModuleWaitingOnHuman("m"), false, "終わった呼び出しの印で、別の呼び出しが人待ちになった");
  b.end();
  other.end();
});

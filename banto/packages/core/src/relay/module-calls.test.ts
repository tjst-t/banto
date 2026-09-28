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

  // 終わった呼び出しの印・別の接続の印は、その1件を指さない（全部を合わせる形に戻る）
  canvas.end();
  assert.equal(t.originFor("window", canvas.id), "turn");
  const elsewhere = t.beginCall("other-module", "t9", "canvas", "pA");
  assert.equal(t.originFor("window", elsewhere.id), "turn", "別の接続の印で、この接続の呼び出しを名指せた");
  turn.end();
  other.end();
  elsewhere.end();
  assert.equal(t.originFor("window"), undefined);
});

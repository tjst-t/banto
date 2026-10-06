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

// **起こし直しのために止める**（追加・2026-10-05、Fable のレビュー）。止め始めたら入口が断る印が立ち、`drain` は実行中の
// 呼び出し（人を待っていないもの）が終わるまで待つ。人を待っているものは待たない。上限で抜けて残りの数を返す
test("止め始めたら isStopping が立ち、drain は実行中の呼び出しが終わるまで待つ（人を待っているものは待たない）", async () => {
  const t = new ModuleCallTracker();
  assert.equal(t.isStopping(), false);
  const running = t.beginCall("shell-p", "t1", "turn", "p");
  const asking = t.beginCall("vault", "t2", "turn", "p");
  t.holdForHuman("vault", asking.id);
  t.stopAccepting();
  assert.equal(t.isStopping(), true);
  setTimeout(() => running.end(), 150);
  const started = Date.now();
  const r = await t.drain(5_000, 10);
  assert.equal(r.left, 0, "人を待っている呼び出しまで待った");
  assert.ok(Date.now() - started >= 140, "実行中の呼び出しを待たずに抜けた");
  assert.ok(Date.now() - started < 2_000);
});

test("drain は上限を過ぎたら、残っている呼び出しの数を返して抜ける", async () => {
  const t = new ModuleCallTracker();
  t.beginCall("shell-p", "t1", "turn", "p");
  t.beginCall("shell-p", "t1", "turn", "p");
  const started = Date.now();
  const r = await t.drain(120, 10);
  assert.equal(r.left, 2);
  assert.ok(Date.now() - started >= 110 && Date.now() - started < 1_000, `上限どおりに抜けない（${Date.now() - started}ms）`);
});

// **質問の印は絞る**（追加・2026-10-05、Fable のレビュー）。印（callId）があればその1件、無ければ会話の呼び出しだけ
test("質問の印：callId があればその1件だけ、会話で絞れば同じ接続の別の会話の呼び出しには立てない。tool_use の id に結びつく", () => {
  const t = new ModuleCallTracker();
  const a = t.beginCall("vault", "t1", "turn", "p", false, "toolu_a");
  const b = t.beginCall("vault", "t1", "turn", "p", false, "toolu_b");
  const c = t.beginCall("vault", "t2", "turn", "p", false, "toolu_c");
  const waiting = () => t.list().map((x) => x.waitingOnHuman);

  const release = t.holdForElicitation("vault", { callId: a.id });
  assert.deepEqual(waiting(), [true, false, false], "質問していない呼び出しまで人待ちになった");
  assert.equal(t.elicitingToolUseId("t1"), "toolu_a");
  assert.equal(t.elicitingToolUseId("t2"), undefined);
  release();
  assert.deepEqual(waiting(), [false, false, false]);
  assert.equal(t.elicitingToolUseId("t1"), undefined);

  // 印が無ければ会話の呼び出しだけ——別の会話（t2）には立てない。会話の中で2つ立てば、どちらの質問か決めない
  const byThread = t.holdForElicitation("vault", { threadId: "t1" });
  assert.deepEqual(waiting(), [true, true, false]);
  assert.equal(t.elicitingToolUseId("t1"), undefined, "2つの呼び出しのどちらの質問か決められないのに決めた");
  byThread();
  // もう終わった呼び出しの印なら何にも立てない
  b.end();
  t.holdForElicitation("vault", { callId: b.id });
  assert.deepEqual(waiting(), [false, false]);

  // 承認は質問に数えない
  t.holdForHuman("vault", c.id);
  assert.equal(t.elicitingToolUseId("t2"), undefined);
  assert.equal(t.toolUseIdFor("vault", c.id), "toolu_c");
  assert.equal(t.toolUseIdFor("vault"), undefined, "接続の全部から1つに決めた");
});

// **入れ子の奥で人を待つと、外側の呼び出しも人待ちになる**（追加・2026-10-06、本番で「Backlog の書き込みが承認の間もなく
// 時間切れ」）。AI → Backlog → Repositories → Vault の承認は Repositories の呼び出しで聞くが、host が上限を数えているのは
// AI → Backlog——そちらにも印が立たないと 60 秒で切れ、承認カードも畳まれていた
test("holdForHuman：中継で呼んだ側（parent）をたどって外側にも立て、外せば外側も戻る。関係ない呼び出しには立てない", () => {
  const t = new ModuleCallTracker();
  const outer = t.beginCall("backlog-p1", "t1", "turn", "p1", false, "toolu_1");
  const middle = t.beginCall("repositories", "t1", "turn", "p1", false, "toolu_1", { connName: "backlog-p1", callId: outer.id });
  const other = t.beginCall("backlog-p1", "t2", "turn", "p1");
  const release = t.holdForHuman("repositories", middle.id);
  assert.equal(t.isWaitingOnHuman("repositories", middle.id), true);
  assert.equal(t.isWaitingOnHuman("backlog-p1", outer.id), true, "外側の呼び出しに人待ちが立たない");
  assert.equal(t.isWaitingOnHuman("backlog-p1", other.id), false, "関係ない呼び出しまで人待ちになった");
  release();
  assert.equal(t.isWaitingOnHuman("backlog-p1", outer.id), false);
  assert.equal(t.isWaitingOnHuman("repositories", middle.id), false);
  // 外側が先に終わっていても、外すときに壊れない
  const again = t.holdForHuman("repositories", middle.id);
  outer.end();
  again();
  middle.end();
  other.end();
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MESSAGE_MAX, RunLog, STEP_BYTES_MAX, STEP_DESCRIPTION_MAX, STEP_TITLE_MAX, STEPS_MAX } from "./runs.js";

const result = (text: string) => ({
  agent: { name: "a" }, sessionId: "s", stopReason: "end_turn" as const, text, toolCalls: [], permissions: [], notes: [],
});

test("終わった仕事は置き場に残り、立て直しても一覧に出る。走っていたものは残らない", () => {
  const dir = mkdtempSync(join(tmpdir(), "runlog-"));
  try {
    const file = join(dir, "runs.jsonl");
    const log = new RunLog(file);
    const a = log.start({ agent: "fake", agentTitle: "Fake", prompt: "一つめ" });
    log.finish(a.id, { result: result("はい") });
    log.start({ agent: "fake", agentTitle: "Fake", prompt: "走りかけ" });

    const again = new RunLog(file);
    assert.deepEqual(again.list().map((r) => [r.status, r.promptHead]), [["done", "一つめ"]]);
    assert.equal(again.get(a.id)?.text, "はい");
    // 1行に1件
    assert.equal(readFileSync(file, "utf8").trim().split("\n").length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("残す件数には上限がある（古いものから落とす）", () => {
  const dir = mkdtempSync(join(tmpdir(), "runlog-"));
  try {
    const log = new RunLog(join(dir, "runs.jsonl"), 2);
    for (const p of ["1", "2", "3"]) {
      const r = log.start({ agent: "fake", agentTitle: "Fake", prompt: p });
      log.finish(r.id, { result: result(p) });
    }
    assert.deepEqual(log.list().map((r) => r.promptHead).sort(), ["2", "3"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("壊れた記録は読み飛ばさず止める（黙って欠けない）", () => {
  const dir = mkdtempSync(join(tmpdir(), "runlog-"));
  try {
    writeFileSync(join(dir, "runs.jsonl"), "{not json}\n");
    assert.throws(() => new RunLog(join(dir, "runs.jsonl")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("覚える数を超えた古い記録はファイルからも消える（多くても上限の2倍の行）。一覧は limit 件ずつ（決定・2026-10-01）", () => {
  const dir = mkdtempSync(join(tmpdir(), "runlog-"));
  try {
    const file = join(dir, "runs.jsonl");
    const lines = () => readFileSync(file, "utf8").trim().split("\n").length;
    const log = new RunLog(file, 5);
    for (let i = 0; i < 23; i++) {
      const r = log.start({ agent: "fake", agentTitle: "Fake", prompt: `仕事${i}` });
      log.finish(r.id, { result: result(`返事${i}`) });
      assert.ok(lines() <= 10, `ファイルが ${lines()} 行に増えた`);
    }
    // 前の版が溜めたファイル（上限より多い）も、起こしたときに詰める
    writeFileSync(file, readFileSync(file, "utf8").repeat(4));
    const again = new RunLog(file, 5);
    assert.equal(lines(), 5);
    assert.deepEqual(again.list().map((r) => r.promptHead), ["仕事22", "仕事21", "仕事20", "仕事19", "仕事18"]);

    const running = again.start({ agent: "fake", agentTitle: "Fake", prompt: "走っている" });
    const page = again.page(2);
    assert.deepEqual(page.runs.map((r) => r.promptHead), ["走っている", "仕事22", "仕事21"]);
    assert.equal(page.finishedTotal, 5);
    again.cancel(running.id);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("経過は上限で古い順に畳み、題・説明・1件の大きさ・発言を切る（アーキ仕様 §4.1）", () => {
  const dir = mkdtempSync(join(tmpdir(), "runlog-"));
  try {
    const log = new RunLog(join(dir, "runs.jsonl"));
    const run = log.start({ agent: "fake", agentTitle: "Fake", prompt: "多い" });
    for (let i = 0; i < STEPS_MAX + 5; i++) log.toolCall(run.id, { toolCallId: `t${i}`, title: `step ${i}`, kind: "execute", status: "completed" });
    let r = log.get(run.id)!;
    assert.equal(r.steps.length, STEPS_MAX);
    assert.equal(r.stepsOmitted, 5);
    assert.equal(r.steps[0]!.title, "step 5");
    // 畳んだあとも番号は通しのまま
    assert.equal(log.view(run.id)!.steps[0]!.n, 5);

    log.toolCall(run.id, { toolCallId: "long", title: "x".repeat(1000), kind: "execute" });
    log.toolUpdate(run.id, "long", { description: "d".repeat(1000) });
    r = log.get(run.id)!;
    assert.equal(r.steps.at(-1)!.title.length, STEP_TITLE_MAX + 1);
    assert.equal(r.steps.at(-1)!.description!.length, STEP_DESCRIPTION_MAX + 1);

    const many = Array.from({ length: 2000 }, (_, i) => `/elsewhere/${"f".repeat(20)}/${i}.ts`);
    log.toolCall(run.id, { toolCallId: "big", title: "Read many", kind: "read", files: many });
    const big = log.get(run.id)!.steps.at(-1)!;
    assert.ok(Buffer.byteLength(JSON.stringify(big)) <= STEP_BYTES_MAX);
    assert.equal(big.truncated, true);
    assert.ok(big.files!.length < many.length);

    log.message(run.id, "あ".repeat(MESSAGE_MAX - 1));
    log.message(run.id, "いいい");
    const said = log.get(run.id)!.steps.at(-1)!;
    assert.equal(said.kind, "message");
    assert.equal(said.title.length, MESSAGE_MAX + 1);
    assert.equal(said.truncated, true);
    log.cancel(run.id);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("sinceStep：走っている仕事は、その版より後に変わった経過だけを返す。終わった仕事は丸ごと（版は残さない）", () => {
  const dir = mkdtempSync(join(tmpdir(), "runlog-"));
  try {
    const log = new RunLog(join(dir, "runs.jsonl"));
    const run = log.start({ agent: "fake", agentTitle: "Fake", prompt: "差分" });
    log.toolCall(run.id, { toolCallId: "a", title: "Terminal", kind: "execute", status: "pending" });
    log.message(run.id, "考えています");
    log.toolCall(run.id, { toolCallId: "b", title: "Read File", kind: "read", status: "pending" });
    const first = log.view(run.id)!;
    assert.equal(first.stepsSince, undefined);
    assert.equal(first.steps.length, 3);
    const seen = first.stepVersion!;

    // 前の1件（a）が本当の題で書き換わり、新しい1件（c）が足される
    log.toolUpdate(run.id, "a", { title: "npm test", status: "completed" });
    log.toolCall(run.id, { toolCallId: "c", title: "Edit", kind: "edit" });
    log.plan(run.id, [{ content: "読む", status: "in_progress" }]);
    const diff = log.view(run.id, seen)!;
    assert.equal(diff.stepsSince, seen);
    assert.deepEqual(diff.steps.map((s) => [s.n, s.title]), [[0, "npm test"], [3, "Edit"]]);
    // いまの状況の欄は丸ごと
    assert.deepEqual(diff.plan, [{ content: "読む", status: "in_progress" }]);
    assert.deepEqual(log.view(run.id, diff.stepVersion!)!.steps, []);
    // 一覧の「いまやっていること」は動いている tool の最後
    assert.deepEqual(log.list()[0]!.current, { kind: "edit", title: "Edit" });
    assert.deepEqual(log.list()[0]!.plan, { done: 0, total: 1 });

    log.finish(run.id, { result: result("おわり") });
    const done = log.view(run.id, seen)!;
    assert.equal(done.stepsSince, undefined);
    assert.equal(done.steps.length, 4);
    assert.equal(done.stepVersion, undefined);
    assert.ok(done.steps.every((s) => s.v === undefined));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("起こし直しのあと続けた仕事は、前の経過が無いことの印を持つ", () => {
  const dir = mkdtempSync(join(tmpdir(), "runlog-"));
  try {
    const log = new RunLog(join(dir, "runs.jsonl"));
    const fresh = log.start({ agent: "fake", agentTitle: "Fake", prompt: "新しく" });
    const continued = log.start({ agent: "fake", agentTitle: "Fake", prompt: "続き", continues: { id: "old", startedAt: 1, notes: [] } });
    assert.equal(log.get(fresh.id)!.continuedAfterRestart, undefined);
    assert.equal(log.get(continued.id)!.continuedAfterRestart, true);
    log.cancel(fresh.id);
    log.cancel(continued.id);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

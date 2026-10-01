import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RunLog } from "./runs.js";

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

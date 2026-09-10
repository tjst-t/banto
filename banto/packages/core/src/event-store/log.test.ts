import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventLog } from "./log.js";
import { SnapshotProjection, type Fold } from "./snapshot.js";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "banto-eventlog-test-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("append assigns monotonic seq and readFrom replays in order", async () => {
  await withTempDir(async (dir) => {
    const log = new EventLog(dir);
    await log.init();
    const e1 = await log.append("counter.incremented", { by: 1 });
    const e2 = await log.append("counter.incremented", { by: 2 });
    assert.equal(e1.seq, 1);
    assert.equal(e2.seq, 2);

    const events = [];
    for await (const e of log.readFrom(0)) events.push(e);
    assert.equal(events.length, 2);
    assert.equal(events[0]!.seq, 1);
    assert.equal(events[1]!.seq, 2);
  });
});

test("re-opening a log resumes seq from where it left off", async () => {
  await withTempDir(async (dir) => {
    const log1 = new EventLog(dir);
    await log1.init();
    await log1.append("x", {});
    await log1.append("x", {});

    const log2 = new EventLog(dir);
    await log2.init();
    const e3 = await log2.append("x", {});
    assert.equal(e3.seq, 3);
  });
});

test("concurrent appends do not interleave or lose events", async () => {
  await withTempDir(async (dir) => {
    const log = new EventLog(dir);
    await log.init();
    const results = await Promise.all(
      Array.from({ length: 50 }, (_, i) => log.append("n", { i })),
    );
    const seqs = results.map((r) => r.seq).sort((a, b) => a - b);
    assert.deepEqual(seqs, Array.from({ length: 50 }, (_, i) => i + 1));

    const events = [];
    for await (const e of log.readFrom(0)) events.push(e);
    assert.equal(events.length, 50);
  });
});

// ---- crash-torn の回復（アーキ仕様§2.1）--------------------------------------
//
// **書きかけの最終行が残ると、次回以降の起動が毎回同じ行で落ちる**——host が
// 二度と立ち上がらない、という壊れ方をする。`\n` で終わらない最終レコードは
// 「無い」とみなして切り詰め、**切り詰めたこと自体を記録する**（規則2）。

test("書きかけの最終行は切り詰められ、切り詰めたことが記録に残る", async () => {
  await withTempDir(async (dir) => {
    const log1 = new EventLog(dir);
    await log1.init();
    await log1.append("x", { i: 1 });
    await log1.append("x", { i: 2 });

    // 途中で電源が落ちた形（`\n` で終わらない半端な行）
    const logPath = join(dir, "events.jsonl");
    const halfLine = '{"seq":3,"type":"x","payload":{"i":3},"ts":"2026';
    await appendFile(logPath, halfLine, "utf8");

    const log2 = new EventLog(dir);
    await log2.init();
    const events = [];
    for await (const e of log2.readFrom(0)) events.push(e);

    // 半端な行は消え、そこまでの2件は残り、切り詰めの記録が1件足される
    assert.deepEqual(
      events.map((e) => e.type),
      ["x", "x", "event_store.torn_line_truncated"],
    );
    const truncation = events[2]!.payload as { droppedBytes: number; keptThroughSeq: number };
    assert.equal(truncation.droppedBytes, Buffer.byteLength(halfLine));
    assert.equal(truncation.keptThroughSeq, 2);

    // 続きは壊れた行を数えずに進む
    const next = await log2.append("x", { i: 4 });
    assert.equal(next.seq, 4);
  });
});

test("1行も完結していないログは空として回復する", async () => {
  await withTempDir(async (dir) => {
    await writeFile(join(dir, "events.jsonl"), '{"seq":1,"type":"x"', "utf8");
    const log = new EventLog(dir);
    await log.init();
    const first = await log.append("x", {});
    // 切り詰めの記録が seq 1、その次が 2
    assert.equal(first.seq, 2);
    const events = [];
    for await (const e of log.readFrom(0)) events.push(e);
    assert.equal(events[0]!.type, "event_store.torn_line_truncated");
  });
});

test("本当に kill された書き手が残した半端な行から、次の起動が回復する", async () => {
  await withTempDir(async (dir) => {
    // **実際に SIGKILL される子プロセス**に書かせる——「書いている途中で落ちた」を
    // 机上で作らない（規則1）。半端な行を書いた直後に自分を kill する
    const logModule = new URL("./log.js", import.meta.url).href;
    const child = join(dir, "crasher.mjs");
    await writeFile(
      child,
      `import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { EventLog } from ${JSON.stringify(logModule)};
const dir = process.argv[2];
const log = new EventLog(dir);
await log.init();
await log.append("before.crash", { i: 1 });
await log.append("before.crash", { i: 2 });
appendFileSync(join(dir, "events.jsonl"), '{"seq":3,"type":"half.written","payl');
process.kill(process.pid, "SIGKILL");
`,
      "utf8",
    );

    const exit = await new Promise<{ code: number | null; signal: string | null }>((resolve) => {
      const proc = spawn(process.execPath, [child, dir], { stdio: "inherit" });
      proc.on("exit", (code, signal) => resolve({ code, signal }));
    });
    assert.equal(exit.signal, "SIGKILL", "子プロセスが kill されていない（試験が壊れている）");

    // kill される前に fsync まで済んだ2件は残っている（append は fsync 後に解決する）
    const raw = await readFile(join(dir, "events.jsonl"), "utf8");
    assert.equal(raw.endsWith("\n"), false, "半端な行が残っていない（試験が壊れている）");
    assert.equal(raw.split("\n").filter((l) => l.includes("before.crash")).length, 2);

    // 次の起動——壊れた行を切り詰めて、そのまま使える
    const log = new EventLog(dir);
    await log.init();
    const events = [];
    for await (const e of log.readFrom(0)) events.push(e);
    assert.deepEqual(
      events.map((e) => e.type),
      ["before.crash", "before.crash", "event_store.torn_line_truncated"],
    );
    const after = await log.append("after.crash", {});
    assert.equal(after.seq, 4);
  });
});

interface CounterState {
  total: number;
}
const counterFold: Fold<CounterState> = {
  initial: () => ({ total: 0 }),
  apply: (s, e) => ({ total: s.total + (e.payload as { by: number }).by }),
};

test("snapshot resumes correctly after restart (cold start does not re-fold everything from scratch)", async () => {
  await withTempDir(async (dir) => {
    const log = new EventLog(dir);
    await log.init();
    for (let i = 0; i < 10; i++) {
      const ev = await log.append("counter.incremented", { by: 1 });
    }

    const proj1 = new SnapshotProjection(dir, "counter", log, counterFold);
    await proj1.load();
    assert.equal(proj1.current.total, 10);
    await proj1.save();

    // more events after the snapshot
    await log.append("counter.incremented", { by: 5 });

    // fresh projection instance simulating a restart
    const proj2 = new SnapshotProjection(dir, "counter", log, counterFold);
    await proj2.load();
    assert.equal(proj2.current.total, 15);
    assert.equal(proj2.appliedSeq, 11);
  });
});

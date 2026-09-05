import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
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

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventLog } from "../event-store/log.js";
import { InboxStore } from "./store.js";

async function withStore(fn: (store: InboxStore) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "banto-inbox-test-"));
  try {
    const log = new EventLog(dir);
    await log.init();
    const store = new InboxStore(dir, log);
    await store.load();
    await fn(store);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("judgments come before reviews in listOpen", async () => {
  await withStore(async (store) => {
    await store.raiseReview({ threadId: "t1", summary: "done" });
    await store.raiseJudgment({ threadId: "t1", source: "elicitation", message: "which one?" });
    const open = store.listOpen();
    assert.equal(open.length, 2);
    assert.equal(open[0]!.kind, "judgment");
    assert.equal(open[1]!.kind, "review");
  });
});

test("answered judgments and acknowledged reviews are removed from listOpen", async () => {
  await withStore(async (store) => {
    const j = await store.raiseJudgment({ threadId: "t1", source: "text", message: "ok?" });
    const r = await store.raiseReview({ threadId: "t1", summary: "done" });
    assert.equal(store.listOpen().length, 2);

    await store.answerJudgment(j.id, { accept: true });
    await store.acknowledgeReview(r.id);
    assert.equal(store.listOpen().length, 0);
  });
});

test("late answer after timeout does not resurrect liveness (timed_out wins if already set)", async () => {
  await withStore(async (store) => {
    const j = await store.raiseJudgment({ threadId: "t1", source: "elicitation", message: "?" });
    await store.timeoutJudgment(j.id);
    const after = store.get(j.id);
    assert.equal(after?.kind, "judgment");
    assert.equal((after as { liveness: string }).liveness, "timed_out");
  });
});

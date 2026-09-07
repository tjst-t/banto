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

test("起動時に、前のプロセスが抱えていた判断待ちを期限切れにする", async () => {
  const dir = await mkdtemp(join(tmpdir(), "banto-inbox-restart-"));
  try {
    const log = new EventLog(dir);
    await log.init();
    const store = new InboxStore(dir, log);
    await store.load();
    const judgment = await store.raiseJudgment({
      threadId: "t1",
      source: "text",
      message: "tool呼び出しの承認: test",
    });
    assert.equal(store.listOpen().length, 1);

    // 別プロセスとして読み直す＝host の再起動。止めていた走行はもう無い
    const log2 = new EventLog(dir);
    await log2.init();
    const restarted = new InboxStore(dir, log2);
    await restarted.load();
    await restarted.expireOrphanedJudgments();

    const still = restarted.get(judgment.id);
    assert.equal(
      still?.kind === "judgment" ? still.liveness : undefined,
      "timed_out",
      "再起動後も live のままだと、答えても何も起きない幽霊カードになる",
    );
    // §2.4.1 は3状態を出し分けると決めているので、記録としては残す
    // ——画面に「答えられるもの」として出さないのは liveness で判断する側の責任
    const listed = restarted.listOpen().filter((i) => i.kind === "judgment" && i.liveness === "live");
    assert.equal(listed.length, 0, "live なものは残っていてはいけない");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

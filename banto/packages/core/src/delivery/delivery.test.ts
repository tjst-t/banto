import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventLog } from "../event-store/log.js";
import { ProjectThreadStore } from "../project-thread/store.js";
import { ThreadTurns } from "./thread-turns.js";
import { ThreadDeliveries, DELIVERY_LIMITS, composeTurnPrompt } from "./thread-deliveries.js";
import { ReplyHandles, REPLY_LIMITS } from "./reply-handles.js";

async function setup(fn: (ctx: {
  store: ProjectThreadStore;
  turns: ThreadTurns;
  deliveries: ThreadDeliveries;
  threadId: string;
  runs: Array<{ threadId: string; hop: number }>;
  notices: Array<{ title: string; detail: string }>;
  dir: string;
  log: EventLog;
  clock: { now: number };
}) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "banto-delivery-test-"));
  try {
    const log = new EventLog(dir);
    await log.init();
    const store = new ProjectThreadStore(dir, log);
    await store.load();
    const project = await store.createProject("demo", dir);
    const thread = await store.createBaseThread(project.id);
    const turns = new ThreadTurns();
    const notices: Array<{ title: string; detail: string }> = [];
    const clock = { now: 1_000_000 };
    const deliveries = new ThreadDeliveries({
      projectThread: store,
      turns,
      notify: async (n) => void notices.push(n),
      now: () => clock.now,
    });
    const runs: Array<{ threadId: string; hop: number }> = [];
    deliveries.setTurnRunner(async (threadId, hop) => {
      runs.push({ threadId, hop });
      return true;
    });
    await fn({ store, turns, deliveries, threadId: thread.id, runs, notices, dir, log, clock });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const input = (threadId: string, hop = 1) => ({ threadId, from: "subagent", title: "仕事が終わりました", text: "結果", hop });

test("届いたら残して、空いていればすぐ起こす——人への知らせも1件", async () => {
  await setup(async ({ store, deliveries, threadId, runs, notices }) => {
    const r = await deliveries.deliver(input(threadId, 1));
    assert.equal(r.wake, "now");
    assert.deepEqual(runs, [{ threadId, hop: 1 }]);
    const pending = store.getThread(threadId)!.deliveries!;
    assert.equal(pending.length, 1, "起こす前に残していない");
    assert.equal(pending[0]!.from, "subagent");
    assert.equal(notices.length, 1);
    assert.match(notices[0]!.detail, /AI が続きをやります/);
  });
});

test("走っている間に届いたら、終わってから起こす（人のターンとぶつけない）", async () => {
  await setup(async ({ turns, deliveries, threadId, runs }) => {
    const release = turns.tryAcquire(threadId, 0)!;
    const r = await deliveries.deliver(input(threadId));
    assert.equal(r.wake, "later");
    assert.deepEqual(runs, [], "走っている Thread を起こした");
    release();
    await new Promise((res) => setImmediate(res));
    assert.equal(runs.length, 1, "終わったのに起こさない");
  });
});

test("同じ Thread の鍵は1本だけ", () => {
  const turns = new ThreadTurns();
  const a = turns.tryAcquire("t1", 0);
  assert.ok(a);
  assert.equal(turns.tryAcquire("t1", 0), undefined);
  assert.ok(turns.tryAcquire("t2", 3), "別の Thread まで止めた");
  assert.equal(turns.hopOf("t2"), 3);
  a!();
  a!(); // 2回返しても壊れない
  assert.ok(turns.tryAcquire("t1", 0));
});

test("人は並んで待ち、前が終わると鍵がそのまま渡る——届いたもので起こすほうは横取りしない", async () => {
  const turns = new ThreadTurns();
  const first = turns.tryAcquire("t1", 1)!;
  const got: { release?: () => void } = {};
  const waiting = turns.acquire("t1", 0).then((r) => (got.release = r));
  await new Promise((res) => setImmediate(res));
  assert.equal(got.release === undefined, true, "走っているのに鍵を渡した");
  assert.equal(turns.tryAcquire("t1", 1), undefined, "人が並んでいるのに横取りした");
  first();
  await waiting;
  assert.ok(got.release, "前が終わったのに鍵が渡らない");
  assert.equal(turns.isRunning("t1"), true);
  assert.equal(turns.hopOf("t1"), 0, "人のターンのホップになっていない");
  got.release();
  assert.equal(turns.isRunning("t1"), false);
});

test("ホップ数が上限を超えたら起こさない——溜めたまま、理由を人に言う", async () => {
  await setup(async ({ store, deliveries, threadId, runs, notices }) => {
    const r = await deliveries.deliver(input(threadId, DELIVERY_LIMITS.maxHop + 1));
    assert.equal(r.wake, "held");
    assert.deepEqual(runs, []);
    assert.equal(store.getThread(threadId)!.deliveries!.length, 1, "起こさなかったものを捨てた");
    assert.match(notices[0]!.detail, /起こしませんでした.*連鎖/);
  });
});

test("1時間に起こす回数に上限がある", async () => {
  await setup(async ({ deliveries, threadId, runs, clock }) => {
    for (let i = 0; i < DELIVERY_LIMITS.wakesPerHour; i++) {
      assert.equal((await deliveries.deliver(input(threadId))).wake, "now");
    }
    const over = await deliveries.deliver(input(threadId));
    assert.equal(over.wake, "held");
    assert.equal(runs.length, DELIVERY_LIMITS.wakesPerHour);
    // 1時間たてば、また起こす
    clock.now += 60 * 60 * 1000 + 1;
    assert.equal(deliveries.kick(threadId).wake, "now");
  });
});

test("閉じた Thread は起こさない", async () => {
  await setup(async ({ store, deliveries, threadId, runs }) => {
    await store.closeThread(threadId);
    const r = await deliveries.deliver(input(threadId));
    assert.equal(r.wake, "held");
    assert.deepEqual(runs, []);
  });
});

test("起動の途中（ターンを開く口がまだ無い）は後で起こす——resumeAll で起きる", async () => {
  const dir = await mkdtemp(join(tmpdir(), "banto-delivery-test-"));
  try {
    const log = new EventLog(dir);
    await log.init();
    const store = new ProjectThreadStore(dir, log);
    await store.load();
    const project = await store.createProject("demo", dir);
    const thread = await store.createBaseThread(project.id);
    const deliveries = new ThreadDeliveries({ projectThread: store, turns: new ThreadTurns(), notify: async () => {} });
    assert.equal((await deliveries.deliver(input(thread.id))).wake, "later");
    const runs: string[] = [];
    deliveries.setTurnRunner(async (t) => {
      runs.push(t);
      return true;
    });
    deliveries.resumeAll();
    assert.deepEqual(runs, [thread.id]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("会話に積むと届いたものの待ち行列から消え、印（origin）が残る。起動し直しても溜まったものは残る", async () => {
  await setup(async ({ store, threadId, dir, log }) => {
    await store.recordDelivery({ threadId, deliveryId: "d1", from: "subagent", title: "t1", text: "x1", hop: 1 });
    await store.recordDelivery({ threadId, deliveryId: "d2", from: "subagent", title: "t2", text: "x2", hop: 2 });
    await store.appendMessage(threadId, "user", "x1", undefined, { from: "subagent", title: "t1", hop: 1, deliveryId: "d1" });
    const t = store.getThread(threadId)!;
    assert.deepEqual(t.deliveries!.map((d) => d.deliveryId), ["d2"]);
    assert.deepEqual(t.messages.at(-1)!.origin, { from: "subagent", title: "t1", hop: 1, deliveryId: "d1" });
    await store.save();
    const reloaded = new ProjectThreadStore(dir, log);
    await reloaded.load();
    assert.deepEqual(reloaded.getThread(threadId)!.deliveries!.map((d) => d.deliveryId), ["d2"]);
  });
});

test("返事待ちの札は記録に残り、済んだら消える", async () => {
  await setup(async ({ store, threadId }) => {
    await store.recordAwaitingReply({ threadId, replyTo: "r1", connName: "subagent-p", moduleName: "subagent", hop: 1 });
    assert.equal(store.getThread(threadId)!.awaitingReplies!.length, 1);
    await store.settleReply(threadId, "r1");
    assert.equal(store.getThread(threadId)!.awaitingReplies!.length, 0);
    // 無いものを済ませても何も書かない
    await store.settleReply(threadId, "r1");
  });
});

test("返事待ちの札に、人に見せる手がかり（work）が残る——読み込み直しても", async () => {
  await setup(async ({ store, threadId, dir, log }) => {
    const work = { toolName: "runSubagent", toolCallId: "toolu_1", title: "fake に頼んだ仕事" };
    await store.recordAwaitingReply({ threadId, replyTo: "r1", connName: "subagent-p", moduleName: "subagent", hop: 1, work });
    assert.deepEqual(store.getThread(threadId)!.awaitingReplies![0]!.work, work);
    await store.save();
    const reloaded = new ProjectThreadStore(dir, log);
    await reloaded.load();
    assert.deepEqual(reloaded.getThread(threadId)!.awaitingReplies![0]!.work, work);
  });
});

test("ターンに渡す文：届いたものは人の発言ではないと分かる形で先に、人の発言は後に", () => {
  const d = { deliveryId: "d", from: "subagent", title: "仕事が終わりました", text: "結果です", hop: 1, receivedAt: "" };
  assert.equal(composeTurnPrompt([], "こんにちは"), "こんにちは");
  const only = composeTurnPrompt([d], "");
  assert.match(only, /人の発言ではなく/);
  assert.match(only, /<banto-delivery from="subagent" hop="1">\n仕事が終わりました\n\n結果です\n<\/banto-delivery>/);
  assert.doesNotMatch(only, /ここから人の発言/);
  const both = composeTurnPrompt([d], "続けて");
  assert.ok(both.indexOf("banto-delivery") < both.indexOf("（ここから人の発言）\n続けて"));
  // 画像だけの発言でも、人の発言があることを言う——画像は文より前に置かれるので、誰のものかをここで言う
  const imageOnly = composeTurnPrompt([d], "", 2);
  assert.match(imageOnly, /（ここから人の発言——先頭の画像 2 枚は人が添えたもの）/);
});

test("返信用の札：渡した Module だけが使え、期限と回数がある。返事待ちは期限で切らない", () => {
  const clock = { now: 0 };
  const handles = new ReplyHandles(() => clock.now);
  const id = handles.issue({ threadId: "t1", projectId: "p", connName: "subagent-p", moduleName: "subagent", hop: 0 });
  assert.match(id, /^reply_[A-Za-z0-9_-]{32}$/);
  // 別の Module・別の Project の同じ Module は使えない
  assert.ok("error" in handles.use(id, { moduleName: "shell", connName: "shell-p" }));
  assert.ok("error" in handles.use(id, { moduleName: "subagent", connName: "subagent-q" }));
  // 渡した相手は使える（回数まで）
  for (let i = 0; i < REPLY_LIMITS.uses; i++) assert.ok(!("error" in handles.use(id, { moduleName: "subagent", connName: "subagent-p" })));
  assert.match((handles.use(id, { moduleName: "subagent", connName: "subagent-p" }) as { error: string }).error, /使い切りました/);
  // 期限
  const id2 = handles.issue({ threadId: "t1", connName: "subagent-p", moduleName: "subagent", hop: 0 });
  clock.now += REPLY_LIMITS.ttlMs + 1;
  assert.match((handles.use(id2, { moduleName: "subagent", connName: "subagent-p" }) as { error: string }).error, /期限/);
  // 返事待ちは期限を過ぎても使える
  const id3 = handles.issue({ threadId: "t1", connName: "subagent-p", moduleName: "subagent", hop: 2 });
  handles.markAwaiting(id3);
  clock.now += REPLY_LIMITS.ttlMs * 2;
  assert.ok(!("error" in handles.use(id3, { moduleName: "subagent", connName: "subagent-p" })));
  assert.deepEqual(handles.awaitingFor("subagent-p").map(([k]) => k), [id3]);
  handles.settle(id3);
  assert.deepEqual(handles.awaitingFor("subagent-p"), []);
  // 知らない札
  assert.match((handles.use("reply_nope", { moduleName: "subagent" }) as { error: string }).error, /見つかりません/);
});

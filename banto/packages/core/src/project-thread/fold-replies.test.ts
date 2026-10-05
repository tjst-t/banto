// **同じターンの AI の発言を会話の1件にまとめる fold**（追加・2026-10-05、アーキ仕様 §2.5「書き終えた発言ごとに
// 記録する」）。まとめるのは「最後のターンの始まりより後ろで、直前の1件も AI の発言」のときだけ。
// Fork の写し・snapshot からの読み戻し・この仕組みより前の記録との混在で崩れないことを見る。

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventLog } from "../event-store/log.js";
import { ProjectThreadStore } from "./store.js";
import { TurnEventBus } from "../http/turn-events.js";

async function open(dir: string): Promise<ProjectThreadStore> {
  const log = new EventLog(dir);
  await log.init();
  const store = new ProjectThreadStore(dir, log);
  await store.load();
  return store;
}

async function withStore(fn: (ctx: { store: ProjectThreadStore; threadId: string; dir: string }) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "banto-fold-replies-"));
  try {
    const store = await open(dir);
    const project = await store.createProject("demo", dir);
    const thread = await store.createBaseThread(project.id);
    await fn({ store, threadId: thread.id, dir });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const texts = (store: ProjectThreadStore, threadId: string) =>
  store.getThread(threadId)!.messages.map((m) => `${m.role}:${m.text}`);

test("Fork が親の途中の吹き出しを写したあと、親の吹き出しが伸びても Fork の写しは変わらない", async () => {
  await withStore(async ({ store, threadId }) => {
    await store.startTurn(threadId, { cause: "human", attempt: 0 });
    await store.appendMessage(threadId, "user", "見て");
    await store.appendMessage(threadId, "assistant", "まず見ます");
    const fork = await store.forkThread(threadId);
    await store.appendMessage(threadId, "assistant", "終わりました");

    assert.deepEqual(texts(store, threadId), ["user:見て", "assistant:まず見ます\n\n終わりました"]);
    assert.deepEqual(texts(store, fork.id), ["user:見て", "assistant:まず見ます"], "親の吹き出しを差し替えたら Fork の写しまで変わった");
    // 写しを持ったまま snapshot に書いて読み戻しても、それぞれの中身のまま（同じ seq でも別の中身）
    await store.save();
  });
});

test("snapshot から読み戻した最後のターンでも、そのターンの発言はまとめ続ける", async () => {
  await withStore(async ({ store, threadId, dir }) => {
    await store.startTurn(threadId, { cause: "human", attempt: 0 });
    await store.appendMessage(threadId, "user", "見て");
    await store.appendMessage(threadId, "assistant", "まず見ます");
    await store.save();

    const reopened = await open(dir);
    assert.ok(reopened.getThread(threadId)!.lastTurn, "snapshot から最後のターンが戻らない");
    await reopened.appendMessage(threadId, "assistant", "終わりました");
    assert.deepEqual(texts(reopened, threadId), ["user:見て", "assistant:まず見ます\n\n終わりました"]);
    // Fork を持つ snapshot も同じ（写しが別の中身でも読み戻せる）
    const fork = await reopened.forkThread(threadId);
    await reopened.appendMessage(threadId, "assistant", "もう一言");
    await reopened.save();
    const again = await open(dir);
    assert.deepEqual(texts(again, threadId).at(-1), "assistant:まず見ます\n\n終わりました\n\nもう一言");
    assert.deepEqual(texts(again, fork.id).at(-1), "assistant:まず見ます\n\n終わりました");
  });
});

test("turn.started の無い前からの記録はまとめない。そのあと始まったターンの発言だけまとめる", async () => {
  await withStore(async ({ store, threadId }) => {
    // この仕組みより前の記録（ターンの始まりが無い）——AI の発言が続いていても別々
    await store.appendMessage(threadId, "user", "前の発言");
    await store.appendMessage(threadId, "assistant", "前の返事1");
    await store.appendMessage(threadId, "assistant", "前の返事2");
    // 始まりを書いたターン。前の返事のすぐ後ろでも、前の吹き出しには足さない
    await store.startTurn(threadId, { cause: "delivery", attempt: 0 });
    await store.appendMessage(threadId, "assistant", "新しい返事1");
    await store.appendMessage(threadId, "assistant", "新しい返事2");
    assert.deepEqual(texts(store, threadId), [
      "user:前の発言",
      "assistant:前の返事1",
      "assistant:前の返事2",
      "assistant:新しい返事1\n\n新しい返事2",
    ]);
  });
});

test("whenStarted：聞くのをやめたら呼ばれず、聞き手も残らない。始まっている・走っていないならすぐ呼ぶ", () => {
  const bus = new TurnEventBus();
  const calls: string[] = [];
  bus.begin("t1", "2026-10-05T00:00:00.000Z");
  const stop = bus.whenStarted("t1", () => calls.push("stopped-one"));
  bus.whenStarted("t1", () => calls.push("kept-one"));
  stop();
  bus.markStarted("t1", "2026-10-05T00:00:01.000Z", 3);
  assert.deepEqual(calls, ["kept-one"]);
  // 中の聞き手の表に残っていない（試験のために中を覗く）
  const listeners = (bus as unknown as { startListeners: Map<string, Set<() => void>> }).startListeners;
  assert.equal(listeners.size, 0);

  // 最後の1つをやめたら表から消える
  bus.begin("t2", "2026-10-05T00:00:00.000Z");
  const off = bus.whenStarted("t2", () => calls.push("never"));
  assert.equal(listeners.size, 1);
  off();
  assert.equal(listeners.size, 0);

  // もう始まっている・走っていない——待たずに呼ぶ
  bus.whenStarted("t1", () => calls.push("already"));
  bus.whenStarted("none", () => calls.push("not-running"));
  assert.deepEqual(calls, ["kept-one", "already", "not-running"]);
});

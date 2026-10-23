import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventLog } from "../event-store/log.js";
import { ProjectThreadStore } from "../project-thread/store.js";
import { ThreadTurns } from "./thread-turns.js";
import { ThreadDeliveries, composeTurnPrompt } from "./thread-deliveries.js";
import { MANAGED_TURN_FROM, ManagedTurnNotices, managedProjectOf } from "./managed-turn-notices.js";

async function setup(
  fn: (ctx: {
    store: ProjectThreadStore;
    turns: ThreadTurns;
    runs: Array<{ threadId: string; hop: number }>;
    notices: Array<{ title: string }>;
    managed: { projectId: string; baseId: string };
    other: { projectId: string; baseId: string };
    meta: { projectId: string; forkId: string };
  }) => Promise<void>,
) {
  const dir = await mkdtemp(join(tmpdir(), "banto-managed-turn-test-"));
  try {
    const log = new EventLog(dir);
    await log.init();
    const store = new ProjectThreadStore(dir, log);
    await store.load();
    const a = await store.createProject("banto", dir);
    const aBase = await store.createBaseThread(a.id);
    const b = await store.createProject("home", dir);
    const bBase = await store.createBaseThread(b.id);
    const meta = await store.createProject("orchestrator", dir, { kind: "meta" });
    await store.setManagedProjects(meta.id, [a.id]);
    const fork = store.listThreadsForProject(meta.id).find((t) => t.managedProjectId === a.id)!;
    const turns = new ThreadTurns();
    const notices: Array<{ title: string }> = [];
    const deliveries = new ThreadDeliveries({ projectThread: store, turns, notify: async (n) => void notices.push(n) });
    const runs: Array<{ threadId: string; hop: number }> = [];
    // 起こされたターンは鍵を取って、すぐ終える（届いたものを渡し終えたことにする）。runs に入るのは渡し終えてから
    // ——先に入れると、runs を見た試験が書き込みの途中の deliveries を見る
    deliveries.setTurnRunner(async (threadId, hop) => {
      const release = turns.tryAcquire(threadId, hop);
      if (!release) return false;
      for (const d of store.getThread(threadId)!.deliveries ?? []) {
        await store.appendMessage(threadId, "user", d.text, undefined, { from: d.from, title: d.title, hop: d.hop, deliveryId: d.deliveryId });
      }
      runs.push({ threadId, hop });
      release();
      return true;
    });
    new ManagedTurnNotices({ projectThread: store, turns, deliveries });
    await fn({
      store,
      turns,
      runs,
      notices,
      managed: { projectId: a.id, baseId: aBase.id },
      other: { projectId: b.id, baseId: bBase.id },
      meta: { projectId: meta.id, forkId: fork.id },
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** 「起きない・届かない」を見るための間。届く・起きるほうは決まった時間で見ず、waitFor で中身が出るまで待つ（規則14） */
const settle = () => new Promise((res) => setTimeout(res, 20));

async function waitFor(cond: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.fail(`待ちきれませんでした: ${what}`);
}

test("管理対象 Project でターンが終わると、メタ Project の専用 Fork に知らせが届き、AI が起きる（ホップは＋1）", async () => {
  await setup(async ({ store, turns, runs, managed, meta }) => {
    turns.tryAcquire(managed.baseId, 0)!();
    await waitFor(() => runs.length > 0, "専用 Fork が起きない");
    assert.deepEqual(runs, [{ threadId: meta.forkId, hop: 1 }], "専用 Fork が起きない");
    assert.equal(store.getThread(meta.forkId)!.deliveries?.length ?? 0, 0, "起きたターンに渡っていない");
  });
});

test("知らせの中身：管理対象の Project と Thread を指し、banto 自身の知らせとして渡る。送り元（返事の口）は付けない", async () => {
  await setup(async ({ store, turns, managed, meta }) => {
    // 専用 Fork が走っている間に終わらせて、知らせを溜めたまま中身を見る
    const releaseFork = turns.tryAcquire(meta.forkId, 0)!;
    turns.tryAcquire(managed.baseId, 0)!();
    await waitFor(() => (store.getThread(meta.forkId)!.deliveries?.length ?? 0) > 0, "知らせが届かない");
    const delivered = store.getThread(meta.forkId)!.deliveries ?? [];
    assert.equal(delivered.length, 1);
    const d = delivered[0]!;
    assert.equal(d.from, MANAGED_TURN_FROM);
    assert.equal(d.kind, "banto");
    assert.equal(d.sender, undefined, "送り元を付けると「返事は承認なし」の対象になる");
    assert.match(d.title, /「banto」/);
    assert.match(d.text, new RegExp(`project-id: ${managed.projectId}`));
    assert.match(d.text, new RegExp(`thread-id: ${managed.baseId}`));
    assert.match(d.text, /read_thread/);
    assert.match(composeTurnPrompt(delivered, ""), /kind="banto"/);
    releaseFork();
    await settle();
  });
});

test("同じ Thread の知らせがまだ渡っていなければ積み増さない。別の Thread の分は届く", async () => {
  await setup(async ({ store, turns, managed, meta }) => {
    const releaseFork = turns.tryAcquire(meta.forkId, 0)!;
    turns.tryAcquire(managed.baseId, 0)!();
    await waitFor(() => (store.getThread(meta.forkId)!.deliveries?.length ?? 0) > 0, "知らせが届かない");
    turns.tryAcquire(managed.baseId, 0)!();
    await settle();
    assert.equal(store.getThread(meta.forkId)!.deliveries!.length, 1, "同じ Thread の知らせを積み増した");
    const sub = await store.forkThread(managed.baseId, { title: "調べもの" });
    turns.tryAcquire(sub.id, 0)!();
    await waitFor(() => store.getThread(meta.forkId)!.deliveries!.length >= 2, "別の Thread の知らせが届かない");
    assert.equal(store.getThread(meta.forkId)!.deliveries!.length, 2, "別の Thread の知らせが届かない");
    releaseFork();
    await settle();
  });
});

test("管理対象でない Project・メタ Project 自身・冷める前の要約のターンでは知らせない", async () => {
  await setup(async ({ store, turns, runs, other, meta }) => {
    turns.tryAcquire(other.baseId, 0)!();
    turns.tryAcquireForIdleCompaction(store.listThreadsForProject(meta.projectId).find((t) => t.kind === "base")!.id)!();
    await settle();
    assert.deepEqual(runs, []);
    assert.equal(store.getThread(meta.forkId)!.deliveries?.length ?? 0, 0);
  });
});

test("管理対象から外した・メタ Project を閉じたら届けない", async () => {
  await setup(async ({ store, turns, runs, managed, other, meta }) => {
    await store.setManagedProjects(meta.projectId, [other.projectId]);
    turns.tryAcquire(managed.baseId, 0)!();
    await settle();
    assert.deepEqual(runs, [], "外した Project の知らせが届いた");
    await store.setManagedProjects(meta.projectId, [managed.projectId]);
    await store.closeProject(meta.projectId);
    turns.tryAcquire(managed.baseId, 0)!();
    await settle();
    assert.deepEqual(runs, [], "閉じたメタ Project に届いた");
  });
});

test("往復が止まらないときは、連鎖の上限で留まる（ホップは終わったターンの＋1）", async () => {
  await setup(async ({ store, turns, runs, managed, meta }) => {
    turns.tryAcquire(managed.baseId, 10)!();
    await settle();
    assert.deepEqual(runs, [], "ホップ 11 で起こした");
    assert.equal(store.getThread(meta.forkId)!.deliveries![0]!.hop, 11);
  });
});

test("読める Project（read_thread）は、開いたメタ Project の開いた専用 Fork が受け持つ管理対象だけ", async () => {
  await setup(async ({ store, managed, other, meta }) => {
    assert.equal(managedProjectOf(store, meta.forkId), managed.projectId);
    assert.equal(managedProjectOf(store, managed.baseId), undefined, "普通の Thread に読ませた");
    const metaBase = store.listThreadsForProject(meta.projectId).find((t) => t.kind === "base")!;
    assert.equal(managedProjectOf(store, metaBase.id), undefined, "メタ Project の Base Thread に読ませた");
    await store.setManagedProjects(meta.projectId, [other.projectId]);
    assert.equal(managedProjectOf(store, meta.forkId), undefined, "外した Project を読ませた");
  });
});

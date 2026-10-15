import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventLog } from "../event-store/log.js";
import { ProjectThreadStore } from "../project-thread/store.js";
import { AUTOMATION_RUNS_KEPT } from "./fold.js";
import { AutomationInputError, AutomationStore } from "./store.js";
import { previousRunUnfinished } from "./busy.js";

async function withDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "banto-automation-test-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function open(dir: string): Promise<{ log: EventLog; store: AutomationStore }> {
  const log = new EventLog(dir);
  await log.init();
  const store = new AutomationStore(dir, log);
  await store.load();
  return { log, store };
}

const morning = {
  name: "毎朝のまとめ",
  instruction: "昨日からのコミットをまとめて",
  source: { kind: "time", repeat: { kind: "weekdays", time: "9:00" }, timeZone: "Asia/Tokyo" },
};

test("作る・直す・一時停止・消すが fold に反映され、起こし直しても残る", async () => {
  await withDir(async (dir) => {
    const { store } = await open(dir);
    const a = await store.create({ projectId: "p1", createdBy: { kind: "human" }, fields: morning });
    const b = await store.create({ projectId: "p1", createdBy: { kind: "human" }, fields: { ...morning, name: "週の依存" } });
    await store.create({ projectId: "p2", createdBy: { kind: "human" }, fields: morning });
    // 既定：毎回まっさらの専用の Fork、終わった回は受信箱に出す
    assert.deepEqual(a.target, { kind: "dedicated", mode: "fresh" });
    assert.equal(a.reviewOnDone, true);
    assert.equal(a.paused, false);
    assert.deepEqual(store.list("p1").map((x) => x.name), ["毎朝のまとめ", "週の依存"]);

    const edited = await store.update(a.id, { name: "朝のまとめ", reviewOnDone: false });
    assert.equal(edited.name, "朝のまとめ");
    assert.equal(edited.reviewOnDone, false);
    assert.equal(edited.instruction, morning.instruction, "渡していない欄はそのまま");
    const paused = await store.pause(a.id, "人が一時停止しました");
    assert.equal(paused.paused, true);
    assert.equal(paused.pausedReason, "人が一時停止しました");
    await store.remove(b.id);
    assert.deepEqual(store.list("p1").map((x) => x.id), [a.id]);

    // 起こし直す（スナップショットあり・なしの両方）
    const fromLog = (await open(dir)).store;
    await store.save();
    const fromSnapshot = (await open(dir)).store;
    for (const s of [fromLog, fromSnapshot]) {
      const got = s.get(a.id)!;
      assert.equal(got.name, "朝のまとめ");
      assert.equal(got.reviewOnDone, false);
      assert.equal(got.paused, true);
      assert.equal(s.get(b.id), undefined);
      assert.equal(s.list("p2").length, 1);
    }
    const resumed = await fromSnapshot.resume(a.id);
    assert.equal(resumed.paused, false);
    assert.equal(resumed.pausedReason, undefined);
    assert.equal((await open(dir)).store.get(a.id)!.paused, false);
  });
});

test("直近の回は1件 50 件まで。同じ回の後の記録は置き換える", async () => {
  await withDir(async (dir) => {
    const { store } = await open(dir);
    const a = await store.create({ projectId: "p1", createdBy: { kind: "human" }, fields: morning });
    for (let i = 0; i < AUTOMATION_RUNS_KEPT + 10; i++) {
      await store.recordRun(a.id, { runId: `r${i}`, at: new Date(i * 60_000).toISOString(), cause: "clock", result: "done" });
    }
    let runs = store.get(a.id)!.runs;
    assert.equal(runs.length, AUTOMATION_RUNS_KEPT);
    assert.equal(runs[0]!.runId, `r${AUTOMATION_RUNS_KEPT + 9}`, "新しい順");

    await store.recordRun(a.id, { runId: "now", at: new Date().toISOString(), cause: "manual", result: "running" });
    await store.recordRun(a.id, { runId: "now", at: new Date().toISOString(), cause: "manual", result: "failed", reason: "止まった" });
    runs = store.get(a.id)!.runs;
    assert.equal(runs.filter((r) => r.runId === "now").length, 1);
    assert.equal(runs[0]!.result, "failed");
  });
});

test("automation.fired を大量に積んでも project-thread の snapshot は大きくならない", async () => {
  await withDir(async (dir) => {
    const { log, store } = await open(dir);
    const projectThread = new ProjectThreadStore(dir, log);
    await projectThread.load();
    const project = await projectThread.createProject("p", dir);
    await projectThread.save();
    const snapshotFile = async () => {
      const { readdir } = await import("node:fs/promises");
      const name = (await readdir(dir)).find((f) => f.startsWith("project-thread") && f.endsWith(".snapshot.json"))!;
      return join(dir, name);
    };
    const before = (await stat(await snapshotFile())).size;

    const a = await store.create({ projectId: project.id, createdBy: { kind: "human" }, fields: morning });
    for (let i = 0; i < 500; i++) {
      await store.recordRun(a.id, { runId: `r${i}`, at: new Date().toISOString(), cause: "clock", result: "skipped", reason: "前の回のターンがまだ走っています" });
    }
    // 起こし直しても同じ（ログの続きを畳むときも project-thread は自動化の出来事を持たない）
    const reloaded = new ProjectThreadStore(dir, log);
    await reloaded.load();
    await reloaded.save();
    const after = (await stat(await snapshotFile())).size;
    // seq の桁が増えるぶんだけ
    assert.ok(after - before < 16, `project-thread の snapshot が ${before} → ${after} バイトに増えた`);
    await store.save();
    assert.equal((await open(dir)).store.get(a.id)!.runs.length, AUTOMATION_RUNS_KEPT);
  });
});

test("入力が決まりに合わなければ断る（台帳に残さない）", async () => {
  await withDir(async (dir) => {
    const { log, store } = await open(dir);
    const bad: unknown[] = [
      { ...morning, name: " " },
      { ...morning, instruction: "" },
      { ...morning, source: { kind: "time", repeat: { kind: "daily", time: "25:00" }, timeZone: "Asia/Tokyo" } },
      { ...morning, source: { kind: "time", repeat: { kind: "weekly", day: 7, time: "9:00" }, timeZone: "Asia/Tokyo" } },
      { ...morning, source: { kind: "time", repeat: { kind: "interval", hours: 0 }, timeZone: "Asia/Tokyo" } },
      { ...morning, source: { kind: "time", repeat: { kind: "daily", time: "9:00" }, timeZone: "Mars/Olympus" } },
      { ...morning, source: { kind: "time", repeat: { kind: "cron", expr: "*/5 * * * *" }, timeZone: "Asia/Tokyo" } },
      { ...morning, source: { kind: "time", repeat: { kind: "cron", expr: "0 9 * *" }, timeZone: "Asia/Tokyo" } },
      { ...morning, source: { kind: "time", repeat: { kind: "cron" }, timeZone: "Asia/Tokyo" } },
      { ...morning, source: { kind: "webhook" } },
      { ...morning, target: { kind: "thread" } },
      { ...morning, reviewOnDone: "yes" },
    ];
    for (const fields of bad) {
      await assert.rejects(store.create({ projectId: "p1", createdBy: { kind: "human" }, fields }), AutomationInputError);
    }
    const a = await store.create({ projectId: "p1", createdBy: { kind: "human" }, fields: morning });
    await assert.rejects(store.update(a.id, {}), AutomationInputError);
    // 専用の Fork の threadId は人・AI からは入れられない
    const updated = await store.update(a.id, { target: { kind: "dedicated", mode: "continue", threadId: "t-other" } });
    assert.deepEqual(updated.target, { kind: "dedicated", mode: "continue" });
    let count = 0;
    for await (const _e of log.readFrom(0)) count++;
    assert.equal(count, 2, "作った1件と直した1件だけ");
  });
});

test("cron の式は読めて15分以上なら受ける。時計の数え始めは作った・きっかけを変えた・再開した・時計で動いた回の予定の一番後", async () => {
  await withDir(async (dir) => {
    const { store } = await open(dir);
    const a = await store.create({
      projectId: "p1",
      createdBy: { kind: "human" },
      fields: { ...morning, source: { kind: "time", repeat: { kind: "cron", expr: " 30  9 * * 1-5 " }, timeZone: "Asia/Tokyo" } },
    });
    assert.deepEqual(a.source.repeat, { kind: "cron", expr: "30 9 * * 1-5" });
    assert.equal(a.clockFrom, a.createdAt);
    // 時計で動いた回の予定の時刻まで進む。前の時刻・予定の無い回（今すぐ動かす）では戻らない
    await store.recordRun(a.id, { runId: "r1", at: "2099-01-01T00:00:10.000Z", cause: "clock", result: "running", scheduledFor: "2099-01-01T00:00:00.000Z" });
    assert.equal(store.get(a.id)!.clockFrom, "2099-01-01T00:00:00.000Z");
    await store.recordRun(a.id, { runId: "r2", at: "2099-01-02T00:00:00.000Z", cause: "manual", result: "running" });
    await store.recordRun(a.id, { runId: "r3", at: "2099-01-02T00:00:00.000Z", cause: "clock", result: "skipped", scheduledFor: "2098-12-31T00:00:00.000Z" });
    assert.equal(store.get(a.id)!.clockFrom, "2099-01-01T00:00:00.000Z");
    // 名前を変えても数え始めは変わらない。きっかけを変える・再開すると、その時刻から
    await store.update(a.id, { name: "別の名前" });
    assert.equal(store.get(a.id)!.clockFrom, "2099-01-01T00:00:00.000Z");
    const changed = await store.update(a.id, { source: morning.source });
    assert.equal(changed.clockFrom, changed.updatedAt);
    await store.pause(a.id);
    const resumed = await store.resume(a.id);
    assert.ok(resumed.clockFrom >= changed.updatedAt);
    assert.notEqual(resumed.clockFrom, "2099-01-01T00:00:00.000Z");
  });
});

test("前の回が終わっていない：走っている・届けもの・返事待ち・生きた判断待ち", () => {
  const thread = { id: "t1" } as Parameters<typeof previousRunUnfinished>[0] & object;
  const idle = { isRunning: () => false, listJudgmentsForThread: () => [] };
  assert.equal(previousRunUnfinished(undefined, idle), undefined, "専用の Fork をまだ立てていない");
  assert.equal(previousRunUnfinished(thread, idle), undefined);
  assert.match(previousRunUnfinished(thread, { ...idle, isRunning: () => true })!, /走って/);
  assert.match(previousRunUnfinished({ ...thread, deliveries: [{}] } as never, idle)!, /届けもの/);
  assert.match(previousRunUnfinished({ ...thread, awaitingReplies: [{}] } as never, idle)!, /返事/);
  const judgment = (liveness: string) => ({ isRunning: () => false, listJudgmentsForThread: () => [{ liveness }] as never });
  assert.match(previousRunUnfinished(thread, judgment("live"))!, /判断/);
  assert.equal(previousRunUnfinished(thread, judgment("answered")), undefined);
});

test("台帳が変わるたびに、どの Project のどの自動化かを知らせる（消したときも）", async () => {
  await withDir(async (dir) => {
    const { store } = await open(dir);
    const seen: Array<{ projectId: string; id: string }> = [];
    store.onChange((c) => seen.push(c));
    const a = await store.create({ projectId: "p1", createdBy: { kind: "human" }, fields: morning });
    await store.pause(a.id);
    await store.recordRun(a.id, { runId: "r1", at: new Date().toISOString(), cause: "manual", result: "skipped", reason: "x" });
    await store.remove(a.id);
    assert.deepEqual(seen, Array(4).fill({ projectId: "p1", id: a.id }));
  });
});

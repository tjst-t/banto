import { test } from "node:test";
import assert from "node:assert/strict";
import { CacheKeepAlive, type CacheUsage, type ObservedRequest, type WarmOutcome } from "../claude-login/keep-alive.js";
import { IdleCompactions, type IdleCompactionView } from "./idle-compaction.js";
import type { ThreadState } from "../project-thread/types.js";

const MIN = 60_000;
const T0 = Date.parse("2026-10-20T00:00:00Z");

const hit = (total: number): CacheUsage => ({ inputTokens: 10, cacheReadTokens: total - 10, cacheCreationTokens: 0 });

function request(minute = 0): ObservedRequest {
  return {
    projectId: "p1",
    threadId: "t1",
    key: "p1\u0000s1",
    sessionId: "s1",
    path: "/v1/messages?beta=true",
    accountId: "host",
    startedAt: T0 + minute * MIN,
    usage: hit(60_000),
    body: Buffer.from(JSON.stringify({ model: "m", max_tokens: 1, stream: true, messages: [] })),
    headers: {},
  };
}

function harness() {
  const clock = { now: T0 };
  const replies: WarmOutcome[] = [];
  // 中継の温め直しの知らせ（本物は relay の `keepAliveOnChange`）
  let ic: IdleCompactions | undefined;
  const ka = new CacheKeepAlive({
    onChange: (id) => ic?.refresh(id),
    send: async () => replies.shift() ?? { kind: "ok", usage: hit(60_000), utilization: "" },
    margin: () => ({ ok: true }),
    now: () => clock.now,
    random: () => 0,
    timers: false,
    log: () => undefined,
  });
  const thread = { id: "t1", projectId: "p1", resumePoint: "s1" } as unknown as ThreadState;
  const ended: Array<{ threadId: string; turnId: string; outcome: string }> = [];
  const running = new Set<string>();
  const fingerprint = { value: "fp" as string | undefined };
  const views: Array<{ threadId: string } & IdleCompactionView> = [];
  const logs: string[] = [];
  ic = new IdleCompactions({
    keepAlive: ka,
    turns: { isRunning: (id) => running.has(id) },
    projectThread: {
      getThread: (id) => (id === "t1" ? thread : undefined),
      listProjects: () => [{ id: "p1" }] as never,
      listThreadsForProject: () => [thread],
      endTurn: async (threadId, turnId, outcome) => {
        ended.push({ threadId, turnId, outcome });
      },
    },
    fingerprint: () => fingerprint.value,
    onChange: (threadId, view) => views.push({ threadId, ...view }),
    now: () => clock.now,
    timers: false,
    log: (line) => logs.push(line),
  });
  const runs: string[] = [];
  const compactions = ic;
  compactions.setRunner(async (threadId) => {
    runs.push(threadId);
    // 要約のターンが始まれば温め直しは止まる（host の聞き手）
    ka.turnStarted(threadId);
    ka.turnEnded(threadId, undefined);
    return true;
  });
  const at = async (minutes: number) => {
    clock.now = T0 + minutes * MIN;
    await ka.runDue();
    await compactions.runDue();
  };
  const turn = () => {
    ka.turnStarted("t1");
    ka.observe(request(clock.now === T0 ? 0 : (clock.now - T0) / MIN));
    ka.turnEnded("t1", { sessionId: "s1", fingerprint: "fp" });
  };
  return { ka, ic: compactions, clock, replies, thread, ended, running, fingerprint, views, logs, runs, at, turn };
}

test("最後の要求から 225 分に、200 分の温め直しが当たっていれば要約する。予定と帯の時刻を知らせる", async () => {
  const h = harness();
  h.turn();
  const planned = h.ic.view("t1");
  assert.equal(planned.at, new Date(T0 + 225 * MIN).toISOString());
  assert.equal(planned.noticeAt, new Date(T0 + 220 * MIN).toISOString());
  assert.equal(planned.compacting, false);
  assert.deepEqual(h.ic.list().map((v) => v.threadId), ["t1"]);
  for (const m of [50, 100, 150, 200]) await h.at(m);
  assert.equal(h.ic.view("t1").warms, 4);
  await h.at(224);
  assert.deepEqual(h.runs, []);
  await h.at(225);
  assert.deepEqual(h.runs, ["t1"]);
  // 要約したら予定は消える（もう温めない）
  assert.equal(h.ic.view("t1").at, undefined);
  assert.equal(h.ic.view("t1").compacting, false);
  assert.ok(h.views.some((v) => v.compacting), "要約している間を知らせた");
  await h.at(400);
  assert.deepEqual(h.runs, ["t1"]);
});

test("温め直しが外れた・止まった会話は要約しない（予定も消える）", async () => {
  const h = harness();
  h.turn();
  h.replies.push({ kind: "ok", usage: { inputTokens: 10, cacheReadTokens: 0, cacheCreationTokens: 59_990 }, utilization: "" });
  await h.at(50);
  assert.equal(h.ic.view("t1").at, undefined);
  await h.at(300);
  assert.deepEqual(h.runs, []);

  const failed = harness();
  failed.turn();
  await failed.at(50);
  failed.replies.push({ kind: "failed", reason: "429" });
  await failed.at(100);
  assert.equal(failed.ic.view("t1").at, undefined);
  await failed.at(300);
  assert.deepEqual(failed.runs, []);
});

test("200 分の温め直しのあと 60 分を越えて当たっていなければ・会話が変わっていれば要約しない（ログに理由）", async () => {
  // 時計が遅れて 225 分を大きく過ぎてから見た（直前に当たったのが 60 分より前）
  const late = harness();
  late.turn();
  for (const m of [50, 100, 150, 200]) await late.at(m);
  // 要約の時計が先に起きた（温め直しの時計は本文をまだ捨てていない）
  late.clock.now = T0 + 261 * MIN;
  await late.ic.runDue();
  assert.deepEqual(late.runs, []);
  assert.ok(late.logs.some((l) => l.includes("60 分以内に当たっていません")), late.logs.join("\n"));

  const changed = harness();
  changed.turn();
  for (const m of [50, 100, 150, 200]) await changed.at(m);
  changed.fingerprint.value = "other";
  await changed.at(225);
  assert.deepEqual(changed.runs, []);
  // 持っていた本文も捨てる
  assert.equal(changed.ka.warmingCount(), 0);
});

test("人が戻ったら予定は消え、次のターンの終わりからまた数える", async () => {
  const h = harness();
  h.turn();
  await h.at(50);
  h.clock.now = T0 + 60 * MIN;
  h.turn();
  assert.equal(h.ic.view("t1").at, new Date(T0 + (60 + 225) * MIN).toISOString());
  for (const m of [110, 160, 210, 260]) await h.at(m);
  await h.at(284);
  assert.deepEqual(h.runs, []);
  await h.at(285);
  assert.deepEqual(h.runs, ["t1"]);
});

test("取りやめ：要約をやめて温め直しを続ける。予定が無ければ 409、無い会話は 404", async () => {
  const h = harness();
  h.turn();
  for (const m of [50, 100, 150, 200]) await h.at(m);
  assert.deepEqual(h.ic.cancel("t1"), { ok: true });
  assert.equal(h.ic.view("t1").at, undefined);
  await h.at(225);
  assert.deepEqual(h.runs, []);
  // 4時間を越えても温め続ける
  await h.at(250);
  assert.equal(h.ic.view("t1").warms, 5);
  assert.equal(h.ic.view("t1").at, undefined, "取りやめた基準ではもう予定を立てない");
  const again = h.ic.cancel("t1");
  assert.equal(again.ok, false);
  assert.equal(!again.ok && again.status, 409);
  const none = h.ic.cancel("t9");
  assert.equal(!none.ok && none.status, 404);
});

test("起こし直しで切れた要約の記録は、続けずに締める", async () => {
  const h = harness();
  (h.thread as { idleCompactionTurn?: unknown }).idleCompactionTurn = { turnId: "turn-1", startedSeq: 10, startedAt: "x" };
  await h.ic.start();
  assert.deepEqual(h.ended, [{ threadId: "t1", turnId: "turn-1", outcome: "failed" }]);
});

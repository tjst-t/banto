// アーキ仕様 §4.3「時計」——1分の刻み・止まっていた間の取り戻し・同時本数（時計を差し替えて）
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Automation, AutomationRepeat, AutomationRun, AutomationRunCause } from "./fold.js";
import type { AutomationRunExtras, AutomationRunStarted } from "./runner.js";
import { AutomationClock } from "./clock.js";

interface Fired {
  id: string;
  scheduledFor?: string;
  delayed?: string;
}

/** 台帳と届ける層の代わり。届けた回は `active` に数え、`finish` で終わらせる */
function setup(opts: { now: string; maxConcurrent?: number; busy?: Set<string> }) {
  let now = new Date(opts.now);
  const automations = new Map<string, Automation>();
  const projects = new Map<string, { status: "active" | "closed" }>([["p1", { status: "active" }]]);
  const fired: Fired[] = [];
  const records: Array<{ id: string } & AutomationRun> = [];
  const active = new Set<string>();
  const clock = new AutomationClock({
    automations: {
      listAll: () => [...automations.values()],
      recordRun: async (id, run) => clock_record(id, run),
    },
    projectThread: { getProject: (id: string) => projects.get(id) as never },
    runner: {
      activeRuns: () => active.size,
      run: async (a: Automation, cause: AutomationRunCause, extras: AutomationRunExtras = {}): Promise<AutomationRunStarted> => {
        assert.equal(cause, "clock");
        const run = { runId: `r${records.length}`, at: now.toISOString(), cause, ...extras };
        if (opts.busy?.has(a.id)) {
          await clock_record(a.id, { ...run, result: "skipped", reason: "前の回のターンがまだ走っています" });
          return { runId: run.runId, result: "skipped", reason: "前の回のターンがまだ走っています" };
        }
        fired.push({ id: a.id, ...extras });
        active.add(a.id);
        await clock_record(a.id, { ...run, result: "running" });
        return { runId: run.runId, result: "running" };
      },
    },
    now: () => now,
    ...(opts.maxConcurrent ? { maxConcurrent: opts.maxConcurrent } : {}),
    log: () => {},
  });
  async function clock_record(id: string, run: AutomationRun) {
    records.push({ id, ...run });
    const a = automations.get(id)!;
    if (run.scheduledFor && run.scheduledFor > a.clockFrom) a.clockFrom = run.scheduledFor;
  }
  const add = (id: string, repeat: AutomationRepeat, clockFrom: string, extra: Partial<Automation> = {}) => {
    automations.set(id, {
      id,
      projectId: "p1",
      name: id,
      instruction: "やって",
      source: { kind: "time", repeat, timeZone: "Asia/Tokyo" },
      target: { kind: "dedicated", mode: "fresh", threadId: `t-${id}` },
      reviewOnDone: true,
      createdBy: { kind: "human" },
      createdAt: clockFrom,
      updatedAt: clockFrom,
      paused: false,
      clockFrom,
      runs: [],
      received: [],
      ...extra,
    });
  };
  return {
    clock,
    add,
    fired,
    records,
    active,
    projects,
    automations,
    at: (iso: string) => {
      now = new Date(iso);
    },
  };
}

test("時刻が来た刻みで1回だけ動き、同じ時刻ではもう動かない", async () => {
  const c = setup({ now: "2026-10-15T23:50:00Z" });
  // 平日 9:00（東京）。木曜に作った
  c.add("morning", { kind: "weekdays", time: "9:00" }, "2026-10-15T10:00:00Z");
  await c.clock.tick();
  assert.equal(c.fired.length, 0);
  c.at("2026-10-16T00:00:30Z");
  await c.clock.tick();
  c.at("2026-10-16T00:01:30Z");
  await c.clock.tick();
  assert.deepEqual(c.fired, [{ id: "morning", scheduledFor: "2026-10-16T00:00:00.000Z" }]);
  // 次は月曜
  c.active.clear();
  c.at("2026-10-18T23:59:00Z");
  await c.clock.tick();
  c.at("2026-10-19T00:00:30Z");
  await c.clock.tick();
  assert.deepEqual(c.fired.map((f) => f.scheduledFor), ["2026-10-16T00:00:00.000Z", "2026-10-19T00:00:00.000Z"]);
});

test("止まっていた間の時刻は、起きた最初の刻みで一番最近の1回だけ動き、残りは skipped（理由つき）", async () => {
  // 3時間ごと。最後に動いたのは 10/14 12:00（東京）、起きたのは 10/15 10:10（東京）——15:00〜9:00 の7回
  const c = setup({ now: "2026-10-15T01:10:00Z" });
  c.add("every3", { kind: "interval", hours: 3 }, "2026-10-14T03:00:00Z");
  await c.clock.tick();
  assert.deepEqual(c.fired, [{ id: "every3", scheduledFor: "2026-10-15T00:00:00.000Z" }]);
  const skipped = c.records.filter((r) => r.result === "skipped");
  assert.equal(skipped.length, 1, "止まっていた間の回を1件にまとめて残す");
  assert.equal(skipped[0]!.cause, "clock");
  assert.equal(skipped[0]!.scheduledFor, "2026-10-14T06:00:00.000Z");
  assert.match(skipped[0]!.reason ?? "", /banto が止まっていた間/);
  assert.match(skipped[0]!.reason ?? "", /6 回/);
  // 次の刻みでは同じ時刻を取り戻し直さない
  c.at("2026-10-15T01:11:00Z");
  await c.clock.tick();
  assert.equal(c.fired.length, 1);
  assert.equal(c.records.length, 2);
});

test("止まっていた間に1回だけなら、飛ばした記録は残さずその回を動かす", async () => {
  const c = setup({ now: "2026-10-16T00:30:00Z" });
  c.add("morning", { kind: "daily", time: "9:00" }, "2026-10-15T00:00:00Z");
  await c.clock.tick();
  assert.deepEqual(c.fired, [{ id: "morning", scheduledFor: "2026-10-16T00:00:00.000Z" }]);
  assert.deepEqual(c.records.map((r) => r.result), ["running"]);
});

test("前の回が終わっていなければ、取り戻す回も飛ばす（届ける層の判断）", async () => {
  const c = setup({ now: "2026-10-16T00:30:00Z", busy: new Set(["morning"]) });
  c.add("morning", { kind: "daily", time: "9:00" }, "2026-10-14T00:00:00Z");
  await c.clock.tick();
  assert.equal(c.fired.length, 0);
  assert.deepEqual(
    c.records.map((r) => [r.result, r.scheduledFor]),
    [
      ["skipped", "2026-10-15T00:00:00.000Z"],
      ["skipped", "2026-10-16T00:00:00.000Z"],
    ],
  );
  assert.match(c.records[1]!.reason ?? "", /走っています/);
  // 飛ばした回の時刻から数え直す（同じ時刻をもう一度試さない）
  c.at("2026-10-16T00:31:00Z");
  await c.clock.tick();
  assert.equal(c.records.length, 2);
});

test("同時本数の上限を超えた分はずらし、空いたら理由つきで動かす。ずらしている間に次の時刻が来たら飛ばす", async () => {
  const c = setup({ now: "2026-10-15T23:59:00Z", maxConcurrent: 2 });
  for (const id of ["a", "b", "c"]) c.add(id, { kind: "daily", time: "9:00" }, "2026-10-15T10:00:00Z");
  c.add("hourly", { kind: "interval", hours: 1 }, "2026-10-15T23:30:00Z");
  c.at("2026-10-16T00:00:30Z");
  await c.clock.tick();
  // 4本が同じ時刻——2本だけ動く
  assert.equal(c.fired.length, 2);
  const waiting = ["a", "b", "c", "hourly"].filter((id) => !c.fired.some((f) => f.id === id));
  assert.equal(waiting.length, 2);
  // ずらす長さが過ぎる前は動かさない
  c.active.clear();
  c.at("2026-10-16T00:01:30Z");
  await c.clock.tick();
  assert.equal(c.fired.length, 2);
  // 過ぎたら、ずらした理由つきで動く
  c.at("2026-10-16T00:02:40Z");
  await c.clock.tick();
  assert.equal(c.fired.length, 4);
  for (const f of c.fired.slice(2)) {
    assert.equal(f.scheduledFor, "2026-10-16T00:00:00.000Z");
    assert.match(f.delayed ?? "", /上限（2 本）/);
  }

  // ずらしている間に次の時刻が来た：古い回は飛ばし、新しい回を動かす
  const d = setup({ now: "2026-10-15T23:59:00Z", maxConcurrent: 1 });
  d.add("hourly", { kind: "interval", hours: 1 }, "2026-10-15T23:30:00Z");
  d.active.add("other");
  d.at("2026-10-16T00:00:30Z");
  await d.clock.tick();
  assert.equal(d.fired.length, 0);
  d.at("2026-10-16T01:00:30Z");
  d.active.clear();
  await d.clock.tick();
  assert.deepEqual(d.fired, [{ id: "hourly", scheduledFor: "2026-10-16T01:00:00.000Z" }]);
  const superseded = d.records.find((r) => r.result === "skipped");
  assert.equal(superseded?.scheduledFor, "2026-10-16T00:00:00.000Z");
  assert.match(superseded?.reason ?? "", /次の時刻が来た/);
});

test("一時停止中・Project が閉じている間は動かさず、記録もしない", async () => {
  const c = setup({ now: "2026-10-16T00:00:30Z" });
  c.add("paused", { kind: "daily", time: "9:00" }, "2026-10-15T10:00:00Z", { paused: true });
  c.add("closed", { kind: "daily", time: "9:00" }, "2026-10-15T10:00:00Z");
  c.projects.set("p1", { status: "closed" });
  await c.clock.tick();
  assert.equal(c.fired.length, 0);
  assert.equal(c.records.length, 0);
  // 開き直しても、閉じていた間の時刻は動かさない（次の時刻から）
  c.projects.set("p1", { status: "active" });
  c.at("2026-10-16T00:05:00Z");
  await c.clock.tick();
  assert.equal(c.fired.length, 0);
  c.at("2026-10-17T00:00:30Z");
  await c.clock.tick();
  assert.deepEqual(c.fired.map((f) => f.id), ["closed"]);
});

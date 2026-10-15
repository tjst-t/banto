// アーキ仕様 §4.3「判断は届ける口の手前に置く」「専用の Fork」——自動化を1回動かす層
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventLog } from "../event-store/log.js";
import { ProjectThreadStore } from "../project-thread/store.js";
import type { TurnOutcome } from "../project-thread/types.js";
import { ThreadTurns } from "../delivery/thread-turns.js";
import { DELIVERY_LIMITS, ThreadDeliveries } from "../delivery/thread-deliveries.js";
import type { JudgmentItem } from "../inbox/types.js";
import { AUTOMATION_FORK_RUNS } from "./fold.js";
import { AutomationStore } from "./store.js";
import { AutomationRunner } from "./runner.js";

interface Ctx {
  store: ProjectThreadStore;
  automations: AutomationStore;
  turns: ThreadTurns;
  deliveries: ThreadDeliveries;
  runner: AutomationRunner;
  projectId: string;
  baseId: string;
  /** 届いたもので起こしたターン（Thread の id） */
  woke: string[];
  /** 受信箱に出したお知らせ（自動化の層・届ける口の両方） */
  notices: Array<{ dedupeKey: string; title: string }>;
  judgments: Map<string, JudgmentItem[]>;
  /** 届ける口が起こさずに留める理由（起こし直しの回復中など）。`undefined` なら留めない */
  hold: { reason: string | undefined };
  /** 次に起こすターンの終わり方。`hang` は鍵を持ったまま止まる（走っている間を作る） */
  next: { outcome: TurnOutcome | "hang" };
  /** 止まっているターンを終わらせる */
  finishHung(outcome?: TurnOutcome): Promise<void>;
  /** 乗り換えで閉じたと画面に知らせたもの */
  announced: Array<{ threadId: string; projectId: string; reason: string }>;
}

/** turn-runner の代わり：鍵を取り、届いたものを会話に積み、ターンの終わりを書いてから鍵を返す */
async function setup(fn: (ctx: Ctx) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "banto-automation-runner-"));
  try {
    const log = new EventLog(dir);
    await log.init();
    const store = new ProjectThreadStore(dir, log);
    await store.load();
    const automations = new AutomationStore(dir, log);
    await automations.load();
    const project = await store.createProject("demo", dir);
    const base = await store.createBaseThread(project.id);
    const turns = new ThreadTurns();
    const notices: Ctx["notices"] = [];
    const notify = async (n: { dedupeKey: string; title: string }) => void notices.push({ dedupeKey: n.dedupeKey, title: n.title });
    const hold: Ctx["hold"] = { reason: undefined };
    const deliveries = new ThreadDeliveries({ projectThread: store, turns, notify, hold: () => hold.reason });
    const judgments = new Map<string, JudgmentItem[]>();
    const woke: string[] = [];
    const announced: Ctx["announced"] = [];
    const next: Ctx["next"] = { outcome: "completed" };
    let hung: ((outcome: TurnOutcome) => Promise<void>) | undefined;
    deliveries.setTurnRunner(async (threadId, hop) => {
      const release = turns.tryAcquire(threadId, hop);
      if (!release) return false;
      woke.push(threadId);
      const turnId = await store.startTurn(threadId, { cause: "delivery", attempt: 0 });
      for (const d of [...(store.getThread(threadId)!.deliveries ?? [])]) {
        await store.appendMessage(threadId, "user", d.text, undefined, {
          from: d.from,
          title: d.title,
          hop: d.hop,
          deliveryId: d.deliveryId,
          ...(d.automation ? { automation: d.automation } : {}),
        });
      }
      const end = async (outcome: TurnOutcome) => {
        await store.appendMessage(threadId, "assistant", "やりました");
        await store.endTurn(threadId, turnId, outcome);
        release();
      };
      if (next.outcome === "hang") hung = end;
      else await end(next.outcome);
      return true;
    });
    const runner = new AutomationRunner({
      projectThread: store,
      automations,
      turns,
      deliveries,
      listJudgmentsForThread: (id) => judgments.get(id) ?? [],
      notify,
      announceClosed: (input) => void announced.push(input),
    });
    await fn({
      announced,
      store,
      automations,
      turns,
      deliveries,
      runner,
      projectId: project.id,
      baseId: base.id,
      woke,
      notices,
      judgments,
      hold,
      next,
      finishHung: async (outcome = "completed") => {
        // 止まる位置（届いたものを積み終えたところ）に来るまで待つ
        const deadline = Date.now() + 2000;
        while (!hung) {
          if (Date.now() > deadline) assert.fail("止めておくターンが始まらない");
          await new Promise((res) => setTimeout(res, 5));
        }
        const end = hung;
        hung = undefined;
        await end(outcome);
      },
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const fields = (instruction = "昨日からのコミットをまとめて") => ({
  name: "毎朝のまとめ",
  instruction,
  source: { kind: "time", repeat: { kind: "weekdays", time: "9:00" }, timeZone: "Asia/Tokyo" },
});

/**
 * **その回の結末が書かれるまで待つ**（終わりの聞き手は非同期に書く）。時間で待たない——結末（`running` 以外）が
 * 台帳に出るまで。2秒で出なければ落とす
 */
async function finished(ctx: Ctx, automationId: string, runId: string) {
  const deadline = Date.now() + 2000;
  for (;;) {
    const run = ctx.automations.get(automationId)!.runs.find((r) => r.runId === runId);
    if (run && run.result !== "running") return run;
    if (Date.now() > deadline) assert.fail(`回 ${runId} の結末が書かれない（${run?.result}）`);
    await new Promise((res) => setTimeout(res, 5));
  }
}

async function createDedicated(ctx: Ctx, mode: "fresh" | "continue" = "fresh") {
  const created = await ctx.automations.create({
    projectId: ctx.projectId,
    createdBy: { kind: "human" },
    fields: { ...fields(), target: { kind: "dedicated", mode } },
  });
  return ctx.runner.prepare(created);
}

test("作るときに専用の Fork を立てる（会話を引き継がない・名前は自動化の名前）", async () => {
  await setup(async (ctx) => {
    const a = await createDedicated(ctx);
    const forkId = a.target.threadId!;
    const fork = ctx.store.getThread(forkId)!;
    assert.equal(fork.kind, "fork");
    assert.equal(fork.parentThreadId, ctx.baseId);
    assert.equal(fork.title, "毎朝のまとめ");
    assert.equal(fork.resumePoint, undefined, "Base の会話を引き継いでいる");
    // もう一度用意しても立て直さない
    assert.equal((await ctx.runner.prepare(a)).target.threadId, forkId);
  });
});

test("空いていれば Clear してから届け、専用の Fork でターンが走り、結末が台帳に残る", async () => {
  await setup(async (ctx) => {
    const a = await createDedicated(ctx);
    const forkId = a.target.threadId!;
    const first = await ctx.runner.run(a, "manual");
    assert.equal(first.result, "running");
    assert.equal(first.threadId, forkId);
    await finished(ctx, a.id, first.runId);
    assert.deepEqual(ctx.woke, [forkId], "専用の Fork を起こしていない");
    const fork = ctx.store.getThread(forkId)!;
    assert.deepEqual(fork.markers.map((m) => m.kind), ["clear"], "届ける前に Clear していない");
    const delivered = fork.messages.find((m) => m.origin?.automation);
    assert.ok(delivered, "届いたものが会話に積まれていない");
    assert.deepEqual(delivered!.origin!.automation, { id: a.id, runId: first.runId });
    assert.equal(delivered!.origin!.hop, 0, "ホップは人の発言と同じ 0 から");
    assert.equal(delivered!.text, "昨日からのコミットをまとめて");
    // Clear の印は届いたものより前
    assert.ok(fork.markers[0]!.seq < delivered!.seq);
    const run = ctx.automations.get(a.id)!.runs[0]!;
    assert.equal(run.runId, first.runId);
    assert.equal(run.result, "done");
    assert.equal(run.threadId, forkId);
    assert.equal(run.cause, "manual");
    assert.equal(ctx.automations.get(a.id)!.threadRuns, 1);

    // 2回目も Clear してから
    const second = await ctx.runner.run(ctx.automations.get(a.id)!, "clock");
    await finished(ctx, a.id, second.runId);
    assert.equal(ctx.store.getThread(forkId)!.markers.filter((m) => m.kind === "clear").length, 2);
    assert.deepEqual(ctx.notices, [], "受信箱にお知らせを積んだ");
  });
});

test("前の回を引き継ぐなら Clear しない", async () => {
  await setup(async (ctx) => {
    const a = await createDedicated(ctx, "continue");
    const r = await ctx.runner.run(a, "manual");
    await finished(ctx, a.id, r.runId);
    assert.deepEqual(ctx.store.getThread(a.target.threadId!)!.markers, []);
    assert.equal(ctx.automations.get(a.id)!.runs[0]!.result, "done");
  });
});

test("前の回が終わっていなければ飛ばす：走っている・届けもの・返事待ち・生きた判断待ち", async () => {
  await setup(async (ctx) => {
    const a = await createDedicated(ctx);
    const forkId = a.target.threadId!;
    ctx.next.outcome = "hang";
    const first = await ctx.runner.run(a, "manual");
    assert.equal(first.result, "running");
    const busy = await ctx.runner.run(ctx.automations.get(a.id)!, "clock");
    assert.equal(busy.result, "skipped");
    assert.match(busy.reason!, /走って/);
    await ctx.finishHung();
    await finished(ctx, a.id, first.runId);
    assert.equal(ctx.automations.get(a.id)!.runs.find((r) => r.runId === first.runId)!.result, "done");

    ctx.next.outcome = "completed";
    await ctx.store.recordAwaitingReply({ threadId: forkId, replyTo: "r1", connName: "c", moduleName: "subagent", hop: 0 });
    assert.match((await ctx.runner.run(ctx.automations.get(a.id)!, "clock")).reason!, /返事/);
    await ctx.store.settleReply(forkId, "r1");

    ctx.judgments.set(forkId, [{ liveness: "live" } as JudgmentItem]);
    assert.match((await ctx.runner.run(ctx.automations.get(a.id)!, "clock")).reason!, /判断/);
    ctx.judgments.clear();

    await ctx.store.recordDelivery({ threadId: forkId, deliveryId: "d1", from: "subagent", title: "t", text: "x", hop: 1 });
    assert.match((await ctx.runner.run(ctx.automations.get(a.id)!, "clock")).reason!, /届けもの/);

    const skipped = ctx.automations.get(a.id)!.runs.filter((r) => r.result === "skipped");
    assert.equal(skipped.length, 4);
    assert.ok(skipped.every((r) => r.threadId === forkId && r.reason));
    assert.equal(ctx.store.getThread(forkId)!.markers.length, 1, "飛ばした回で Clear した");
  });
});

test("人がその Fork に送った発言は Clear されない（走っている・並んでいる間は鍵を取れない）", async () => {
  await setup(async (ctx) => {
    const a = await createDedicated(ctx);
    const forkId = a.target.threadId!;
    // 人がその Fork で送ったターンが走っている
    const human = ctx.turns.tryAcquire(forkId, 0)!;
    await ctx.store.appendMessage(forkId, "user", "人の発言");
    const r = await ctx.runner.run(a, "clock");
    assert.equal(r.result, "skipped");
    assert.deepEqual(ctx.store.getThread(forkId)!.markers, [], "人のターンの途中で Clear した");
    human();

    // Clear のために押さえている間に人が送ったら、並んで、押さえ終えたあとに鍵がそのまま渡る（started が出る）
    const hold = ctx.turns.tryHold(forkId)!;
    assert.equal(ctx.turns.tryAcquire(forkId, 0), undefined, "押さえている間に届いたもので起こした");
    assert.equal(ctx.turns.isRunning(forkId), false, "押さえているのをターンとして数えた");
    const started: string[] = [];
    const stop = ctx.turns.onChange((c) => started.push(c.type));
    const queued = ctx.turns.acquire(forkId, 0);
    hold();
    const release = await queued;
    assert.ok(release);
    assert.deepEqual(started, ["started"]);
    release!();
    stop();
    assert.equal(ctx.store.getThread(forkId)!.messages.filter((m) => m.text === "人の発言").length, 1);
  });
});

test("閉じた Fork・閉じた Project・移している Project には届けず、受信箱にも積もらない", async () => {
  await setup(async (ctx) => {
    const a = await createDedicated(ctx);
    const forkId = a.target.threadId!;
    // 自動化の層を通さず閉じる（一時停止させないで、閉じた Fork に届けようとしたときを見る）
    await ctx.store.closeThread(forkId);
    for (let i = 0; i < 3; i++) {
      const r = await ctx.runner.run(ctx.automations.get(a.id)!, "clock");
      assert.equal(r.result, "skipped");
      assert.match(r.reason!, /閉じられて/);
    }
    assert.deepEqual(ctx.store.getThread(forkId)!.deliveries ?? [], [], "閉じた Fork に届けた");
    assert.deepEqual(ctx.notices, []);

    // 届ける口に直に届けても、自動化の届けものは留めたときに知らせない
    const held = await ctx.deliveries.deliver({ threadId: forkId, from: "banto", title: "t", text: "x", hop: 0, kind: "automation" });
    assert.equal(held.wake, "held");
    assert.deepEqual(ctx.notices, [], "閉じた Fork への自動化の届けもので受信箱にお知らせが出た");

    await ctx.store.reopenThread(forkId);
    await ctx.store.closeProject(ctx.projectId);
    assert.match((await ctx.runner.run(ctx.automations.get(a.id)!, "clock")).reason!, /Project は閉じられて/);
    await ctx.store.reopenProject(ctx.projectId);
    await ctx.store.startRuntimeMove(ctx.projectId, {
      from: { runtime: "host-container", root: "/a" },
      to: { runtime: "remote:box", root: "/b" },
      created: { rootCreated: true, moduleDirs: [], movedAside: [] },
    });
    assert.match((await ctx.runner.run(ctx.automations.get(a.id)!, "clock")).reason!, /移して/);
  });
});

test("自動化の届けものは、1時間に起こす回数の上限に数えない", async () => {
  await setup(async (ctx) => {
    const a = await createDedicated(ctx);
    for (let i = 0; i < DELIVERY_LIMITS.wakesPerHour + 3; i++) {
      const r = await ctx.runner.run(ctx.automations.get(a.id)!, "clock");
      assert.equal(r.result, "running", `${i} 回目で ${r.reason}`);
      await finished(ctx, a.id, r.runId);
    }
    assert.equal(ctx.woke.length, DELIVERY_LIMITS.wakesPerHour + 3);
    assert.deepEqual(ctx.notices, []);
  });
});

test("人が専用の Fork を閉じたら一時停止して1件知らせる。開き直しても再開しない。再開したら新しい Fork を立てる", async () => {
  await setup(async (ctx) => {
    const a = await createDedicated(ctx);
    const forkId = a.target.threadId!;
    await ctx.store.closeThread(forkId, { by: "human" });
    await ctx.runner.threadClosed(forkId);
    await ctx.runner.threadClosed(forkId);
    const paused = ctx.automations.get(a.id)!;
    assert.equal(paused.paused, true);
    assert.match(paused.pausedReason!, /専用の Fork/);
    assert.equal(ctx.notices.length, 1, "知らせが1件でない");
    assert.match(ctx.notices[0]!.title, /一時停止/);

    await ctx.store.reopenThread(forkId);
    assert.equal(ctx.automations.get(a.id)!.paused, true, "開き直したら再開した");

    // 閉じた Fork のまま再開したら、新しい Fork を立てる
    await ctx.store.closeThread(forkId, { by: "human" });
    const resumed = await ctx.runner.prepare(await ctx.automations.resume(a.id));
    assert.notEqual(resumed.target.threadId, forkId);
    assert.equal(ctx.store.getThread(resumed.target.threadId!)!.status, "active");

    // 別の Thread を閉じても止めない
    const other = await ctx.store.forkThread(ctx.baseId, { title: "ほか" });
    await ctx.runner.threadClosed(other.id);
    assert.equal(ctx.automations.get(a.id)!.paused, false);
  });
});

test(`${AUTOMATION_FORK_RUNS} 回届けたら新しい Fork に乗り換え、古い Fork は閉じる`, async () => {
  await setup(async (ctx) => {
    const a = await createDedicated(ctx);
    const oldId = a.target.threadId!;
    for (let i = 0; i < AUTOMATION_FORK_RUNS; i++) {
      await ctx.automations.recordRun(a.id, { runId: `r${i}`, at: new Date().toISOString(), cause: "clock", result: "done", threadId: oldId });
    }
    // 飛ばした回は数えない
    await ctx.automations.recordRun(a.id, { runId: "s", at: new Date().toISOString(), cause: "clock", result: "skipped", threadId: oldId });
    assert.equal(ctx.automations.get(a.id)!.threadRuns, AUTOMATION_FORK_RUNS);

    const r = await ctx.runner.run(ctx.automations.get(a.id)!, "clock");
    await finished(ctx, a.id, r.runId);
    const after = ctx.automations.get(a.id)!;
    assert.notEqual(r.threadId, oldId);
    assert.equal(after.target.threadId, r.threadId);
    assert.equal(after.threadRuns, 1, "乗り換えたら 0 から数え直す");
    assert.equal(ctx.store.getThread(oldId)!.status, "closed");
    assert.equal(ctx.store.getThread(oldId)!.closedBy, "automation");
    // 開いている画面のサイドバーから外れるように、閉じたことを流す（Backlog #318）
    assert.deepEqual(ctx.announced.map((x) => x.threadId), [oldId]);
    assert.equal(after.paused, false, "乗り換えで閉じたのを人が閉じたと読んだ");
    const run = after.runs.find((x) => x.runId === r.runId)!;
    assert.equal(run.rotatedFrom, oldId, "境目が記録に無い");
    assert.equal(run.result, "done");
    const fresh = ctx.store.getThread(r.threadId!)!;
    assert.equal(fresh.title, "毎朝のまとめ");
    assert.ok(fresh.messages.some((m) => m.origin?.automation?.runId === r.runId));
  });
});

test("ターンの結末：失敗・人が止めた・判断待ちで止まった", async () => {
  await setup(async (ctx) => {
    const a = await createDedicated(ctx, "continue");
    const forkId = a.target.threadId!;
    ctx.next.outcome = "failed";
    let r = await ctx.runner.run(a, "manual");
    await finished(ctx, a.id, r.runId);
    assert.equal(ctx.automations.get(a.id)!.runs.find((x) => x.runId === r.runId)!.result, "failed");

    ctx.next.outcome = "stopped";
    r = await ctx.runner.run(ctx.automations.get(a.id)!, "manual");
    await finished(ctx, a.id, r.runId);
    const stopped = ctx.automations.get(a.id)!.runs.find((x) => x.runId === r.runId)!;
    assert.equal(stopped.result, "failed");
    assert.match(stopped.reason!, /止め/);

    // ターンが判断待ちを残して終わった
    ctx.next.outcome = "hang";
    r = await ctx.runner.run(ctx.automations.get(a.id)!, "manual");
    ctx.judgments.set(forkId, [{ liveness: "live" } as JudgmentItem]);
    await ctx.finishHung("completed");
    await finished(ctx, a.id, r.runId);
    assert.equal(ctx.automations.get(a.id)!.runs.find((x) => x.runId === r.runId)!.result, "waiting");
  });
});

test("届け先が既存の Thread なら Fork を立てず、Clear せずに届ける", async () => {
  await setup(async (ctx) => {
    const created = await ctx.automations.create({
      projectId: ctx.projectId,
      createdBy: { kind: "human" },
      fields: { ...fields(), target: { kind: "thread", threadId: ctx.baseId } },
    });
    const a = await ctx.runner.prepare(created);
    assert.deepEqual(a.target, { kind: "thread", threadId: ctx.baseId });
    await ctx.store.appendMessage(ctx.baseId, "user", "前からの会話");
    const r = await ctx.runner.run(a, "manual");
    await finished(ctx, a.id, r.runId);
    assert.equal(r.threadId, ctx.baseId);
    const base = ctx.store.getThread(ctx.baseId)!;
    assert.deepEqual(base.markers, []);
    assert.equal(ctx.store.listThreadsForProject(ctx.projectId).length, 1, "Fork を立てた");
    assert.equal(ctx.automations.get(a.id)!.runs[0]!.result, "done");
  });
});

test("留めで届いた回は running のまま理由を残し、留めが解けてターンが終わったら結末を書く", async () => {
  await setup(async (ctx) => {
    const a = await createDedicated(ctx, "continue");
    const forkId = a.target.threadId!;
    ctx.hold.reason = "起こし直しの回復中です";
    const r = await ctx.runner.run(a, "clock");
    assert.equal(r.result, "running");
    assert.match(r.reason!, /回復中/);
    assert.deepEqual(ctx.woke, [], "留めているのに起こした");
    let run = ctx.automations.get(a.id)!.runs.find((x) => x.runId === r.runId)!;
    assert.equal(run.result, "running", "留めた回を running のままにしていない");
    assert.match(run.reason!, /回復中/);
    assert.equal(ctx.runner.activeRuns(), 0, "留めている回を同時本数に数えた");

    // 留めが解けて起こされる
    ctx.hold.reason = undefined;
    ctx.deliveries.resumeAll();
    run = await finished(ctx, a.id, r.runId);
    assert.equal(run.result, "done");
    assert.equal(run.reason, undefined, "留めた理由が結末に残った");
    assert.deepEqual(ctx.woke, [forkId]);

    // ターンが失敗したら failed
    ctx.hold.reason = "続けるか聞いています";
    const second = await ctx.runner.run(ctx.automations.get(a.id)!, "clock");
    assert.equal(second.result, "running");
    ctx.hold.reason = undefined;
    ctx.next.outcome = "failed";
    ctx.deliveries.resumeAll();
    assert.equal((await finished(ctx, a.id, second.runId)).result, "failed");
    assert.deepEqual(ctx.notices, []);
  });
});

test("留めが解けないまま届け先が閉じられたら、留めた理由を添えて skipped にする", async () => {
  await setup(async (ctx) => {
    const a = await createDedicated(ctx);
    const forkId = a.target.threadId!;
    ctx.hold.reason = "起こし直しの回復中です";
    const r = await ctx.runner.run(a, "clock");
    assert.equal(r.result, "running");
    await ctx.store.closeThread(forkId, { by: "human" });
    await ctx.runner.threadClosed(forkId);
    const run = ctx.automations.get(a.id)!.runs.find((x) => x.runId === r.runId)!;
    assert.equal(run.result, "skipped");
    assert.match(run.reason!, /閉じられ/);
    assert.match(run.reason!, /回復中/, "留めた理由が残っていない");
    assert.deepEqual(ctx.woke, []);
  });
});

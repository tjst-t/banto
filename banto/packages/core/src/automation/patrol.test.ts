// アーキ仕様 §4.4「見回り（patrol）」——mode・notify の上限と手帳・届ける文・読むだけの Fork・閾値越えで飛ばす
import { mock, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventLog } from "../event-store/log.js";
import { ProjectThreadStore } from "../project-thread/store.js";
import { ThreadTurns } from "../delivery/thread-turns.js";
import { ThreadDeliveries } from "../delivery/thread-deliveries.js";
import { InboxStore } from "../inbox/store.js";
import type { FindingItem } from "../inbox/types.js";
import { PATROL_NOTEBOOK_MAX, automationFold, type AutomationReadModel } from "./fold.js";
import type { StoredEvent } from "../event-store/log.js";
import { AutomationInputError, AutomationStore } from "./store.js";
import { AutomationRunner, PATROL_SKIPPED_OVER_THRESHOLD } from "./runner.js";
import { PATROL_NOTIFY_PER_RUN, Patrols, patrolDeliveryText } from "./patrol.js";

const patrolFields = {
  mode: "patrol",
  name: "CI の見回り",
  instruction: "main の CI を見て、落ちていたら知らせて",
  source: { kind: "time", repeat: { kind: "interval", hours: 1 }, timeZone: "Asia/Tokyo" },
};

interface Ctx {
  store: ProjectThreadStore;
  automations: AutomationStore;
  inbox: InboxStore;
  runner: AutomationRunner;
  patrols: Patrols;
  projectId: string;
  over: { value: boolean };
  /** 時計を進める（Event Store の ts と notify の「今」は同じ時計——Date を差し替える） */
  setNow(at: Date): void;
  delivered: string[];
}

async function setup(fn: (ctx: Ctx) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "banto-patrol-"));
  mock.timers.enable({ apis: ["Date"], now: new Date("2026-10-20T01:00:00Z") });
  try {
    const log = new EventLog(dir);
    await log.init();
    const store = new ProjectThreadStore(dir, log);
    await store.load();
    const automations = new AutomationStore(dir, log);
    await automations.load();
    const inbox = new InboxStore(dir, log);
    await inbox.load();
    const project = await store.createProject("demo", dir);
    await store.createBaseThread(project.id);
    const turns = new ThreadTurns();
    const deliveries = new ThreadDeliveries({ projectThread: store, turns, notify: async () => {} });
    const delivered: string[] = [];
    // 起こさない（届けた文だけ見る）
    deliveries.setTurnRunner(async (threadId) => {
      delivered.push(...(store.getThread(threadId)!.deliveries ?? []).map((d) => d.text));
      return true;
    });
    const over = { value: false };
    const runner = new AutomationRunner({
      projectThread: store,
      automations,
      turns,
      deliveries,
      listJudgmentsForThread: () => [],
      notify: async () => {},
      allAccountsOver: () => over.value,
    });
    const patrols = new Patrols({ automations, inbox, projectThread: store });
    const setNow = (at: Date) => mock.timers.setTime(at.getTime());
    await fn({ store, automations, inbox, runner, patrols, projectId: project.id, over, setNow, delivered });
  } finally {
    mock.timers.reset();
    await rm(dir, { recursive: true, force: true });
  }
}

async function createPatrol(ctx: Ctx, fields: Record<string, unknown> = patrolFields) {
  const created = await ctx.automations.create({ projectId: ctx.projectId, createdBy: { kind: "human" }, fields });
  return ctx.runner.prepare(created);
}

const notifyArgs = (key: string, extra: Record<string, unknown> = {}) => ({ key, title: `題 ${key}`, finding: `${key} を見つけました`, ...extra });

test("見回りは届け先が専用の Fork・毎回まっさらに決まり、完了した回を出さず、mode は変えられない", async () => {
  await setup(async (ctx) => {
    const a = await createPatrol(ctx);
    assert.equal(a.mode, "patrol");
    assert.equal(a.target.kind, "dedicated");
    assert.equal(a.target.kind === "dedicated" && a.target.mode, "fresh");
    assert.equal(a.reviewOnDone, false);
    assert.equal(a.dailyFindingLimit, 10);
    // 専用の Fork は読むだけの印つきで立つ
    const fork = ctx.store.getThread(a.target.threadId!)!;
    assert.equal(fork.restriction, "read-only");

    await assert.rejects(ctx.automations.update(a.id, { mode: "normal" }), AutomationInputError);
    await assert.rejects(ctx.automations.update(a.id, { target: { kind: "dedicated", mode: "continue" } }), AutomationInputError);
    await assert.rejects(ctx.automations.update(a.id, { reviewOnDone: true }), AutomationInputError);
    await assert.rejects(
      ctx.automations.create({ projectId: ctx.projectId, createdBy: { kind: "human" }, fields: { ...patrolFields, reviewOnDone: true } }),
      AutomationInputError,
    );
    await assert.rejects(
      ctx.automations.create({
        projectId: ctx.projectId,
        createdBy: { kind: "human" },
        fields: { ...patrolFields, target: { kind: "thread", threadId: fork.id } },
      }),
      AutomationInputError,
    );
    // ふつうの自動化に見回りの欄は渡せない・見回りにはできない
    const normal = await ctx.automations.create({
      projectId: ctx.projectId,
      createdBy: { kind: "human" },
      fields: { ...patrolFields, mode: undefined, name: "ふつう" },
    });
    assert.equal(normal.mode, undefined);
    assert.equal(ctx.store.getThread(normal.target.threadId ?? "")?.restriction, undefined);
    await assert.rejects(ctx.automations.update(normal.id, { mode: "patrol" }), AutomationInputError);
    await assert.rejects(ctx.automations.update(normal.id, { dailyFindingLimit: 3 }), AutomationInputError);
    // 見回りは判断役になれない
    await assert.rejects(
      ctx.automations.create({
        projectId: ctx.projectId,
        createdBy: { kind: "human" },
        fields: { ...patrolFields, source: { kind: "event", event: "banto.turn-decisions" } },
      }),
      AutomationInputError,
    );
  });
});

test("閉じられた見回りの Fork を立て直すときも読むだけの印を刻む", async () => {
  await setup(async (ctx) => {
    const a = await createPatrol(ctx);
    await ctx.store.closeThread(a.target.threadId!, { by: "human" });
    const again = await ctx.runner.prepare(ctx.automations.get(a.id)!);
    assert.notEqual(again.target.threadId, a.target.threadId);
    assert.equal(ctx.store.getThread(again.target.threadId!)!.restriction, "read-only");
  });
});

test("Claude のアカウントが全部閾値を越えていたら、見回りの回は飛ばす（ふつうの自動化は飛ばさない）", async () => {
  await setup(async (ctx) => {
    const a = await createPatrol(ctx);
    ctx.over.value = true;
    const skipped = await ctx.runner.run(a, "manual");
    assert.equal(skipped.result, "skipped");
    assert.equal(skipped.reason, PATROL_SKIPPED_OVER_THRESHOLD);
    assert.equal(ctx.automations.get(a.id)!.runs[0]!.reason, PATROL_SKIPPED_OVER_THRESHOLD);
    const normal = await ctx.runner.prepare(
      await ctx.automations.create({ projectId: ctx.projectId, createdBy: { kind: "human" }, fields: { ...patrolFields, mode: undefined, name: "ふつう" } }),
    );
    assert.equal((await ctx.runner.run(normal, "manual")).result, "running");
  });
});

test("見回りの届ける文には、決まり・人の指示・手帳の直近を添える", async () => {
  await setup(async (ctx) => {
    const a = await createPatrol(ctx);
    await ctx.patrols.notify(a.target.threadId!, notifyArgs("ci-red"), { notified: 0 });
    await ctx.patrols.noteHuman({ patrol: { id: a.id, name: a.name }, key: "ci-red" }, "muted");
    const started = await ctx.runner.run(ctx.automations.get(a.id)!, "manual");
    assert.equal(started.result, "running");
    const text = ctx.delivered.at(-1)!;
    assert.match(text, /これは見回りの回です/);
    assert.ok(text.includes(patrolFields.instruction));
    assert.ok(text.includes("- ci-red — 題 ci-red（知らせない）"));
    assert.equal(ctx.store.getThread(a.target.threadId!)!.deliveries?.[0]?.title, `見回り「${a.name}」`);
    assert.match(patrolDeliveryText({ instruction: "x" }), /まだ何も知らせていません/);
  });
});

test("notify：受信箱に気づきを出し、同じ key は7日の間出し直さず、知らせないにした key は出さない", async () => {
  await setup(async (ctx) => {
    const a = await createPatrol(ctx);
    const forkId = a.target.threadId!;
    const turn = { notified: 0 };
    const first = await ctx.patrols.notify(forkId, notifyArgs("pr-1", { evidence: "https://github.com/x/y/pull/1", suggestion: "直す", urgent: true }), turn);
    assert.equal(first.ok, true);
    const findings = ctx.inbox.listOpen().filter((i): i is FindingItem => i.kind === "finding");
    assert.equal(findings.length, 1);
    assert.deepEqual(
      { ...findings[0]!, id: "", createdAt: "" },
      {
        kind: "finding",
        id: "",
        createdAt: "",
        projectId: ctx.projectId,
        threadId: forkId,
        patrol: { id: a.id, name: a.name },
        key: "pr-1",
        title: "題 pr-1",
        finding: "pr-1 を見つけました",
        evidence: "https://github.com/x/y/pull/1",
        suggestion: "直す",
        urgent: true,
      },
    );
    // 同じ key：出し直さない（最後に見た時刻だけ進む）
    ctx.setNow(new Date("2026-10-21T01:00:00Z"));
    const again = await ctx.patrols.notify(forkId, notifyArgs("pr-1"), turn);
    assert.equal(again.ok, true);
    assert.match(again.text, /前に知らせ済み/);
    assert.equal(ctx.inbox.listOpen().filter((i) => i.kind === "finding").length, 1);
    const note = ctx.automations.get(a.id)!.notebook!.find((n) => n.key === "pr-1")!;
    assert.equal(note.status, "notified");
    assert.ok(note.lastSeenAt > note.notifiedAt!, "最後に見た時刻が進まない");
    // 7日を過ぎたら出し直す
    ctx.setNow(new Date("2026-10-28T02:00:00Z"));
    assert.match((await ctx.patrols.notify(forkId, notifyArgs("pr-1"), { notified: 0 })).text, /受信箱に気づき/);
    assert.equal(ctx.inbox.listOpen().filter((i) => i.kind === "finding").length, 2);
    // 知らせないにした key は、7日を過ぎても出さない
    await ctx.patrols.noteHuman({ patrol: { id: a.id, name: a.name }, key: "pr-1" }, "muted");
    ctx.setNow(new Date("2026-11-10T02:00:00Z"));
    const muted = await ctx.patrols.notify(forkId, notifyArgs("pr-1"), { notified: 0 });
    assert.match(muted.text, /今後知らせない/);
    assert.equal(ctx.inbox.listOpen().filter((i) => i.kind === "finding").length, 2);
    // 「知らせない」を外せば、また出せる
    await ctx.automations.notePatrol(a.id, "pr-1", "unmuted");
    assert.match((await ctx.patrols.notify(forkId, notifyArgs("pr-1"), { notified: 0 })).text, /受信箱に気づき/);
  });
});

test("notify：1回に5件・1日の上限（自動化のタイムゾーンで数える）を越えたら断る。引数が合わなければ断る", async () => {
  await setup(async (ctx) => {
    const a = await createPatrol(ctx, { ...patrolFields, dailyFindingLimit: 7 });
    const forkId = a.target.threadId!;
    // 東京の 10/20 の朝（UTC では 10/19 の夜）
    ctx.setNow(new Date("2026-10-19T23:30:00Z"));
    const turn = { notified: 0 };
    for (let i = 0; i < PATROL_NOTIFY_PER_RUN; i++) assert.equal((await ctx.patrols.notify(forkId, notifyArgs(`k${i}`), turn)).ok, true);
    const sixth = await ctx.patrols.notify(forkId, notifyArgs("k5"), turn);
    assert.equal(sixth.ok, false);
    assert.match(sixth.text, /1回に出せる気づきは 5 件まで/);
    // 次の回：あと2件で1日の上限
    const next = { notified: 0 };
    assert.equal((await ctx.patrols.notify(forkId, notifyArgs("k5"), next)).ok, true);
    assert.equal((await ctx.patrols.notify(forkId, notifyArgs("k6"), next)).ok, true);
    const over = await ctx.patrols.notify(forkId, notifyArgs("k7"), next);
    assert.equal(over.ok, false);
    assert.match(over.text, /今日もう 7 件/);
    // 東京の日付が変わったら出せる（UTC ではまだ 10/20）
    ctx.setNow(new Date("2026-10-20T15:30:00Z"));
    assert.equal((await ctx.patrols.notify(forkId, notifyArgs("k7"), { notified: 0 })).ok, true);

    assert.equal((await ctx.patrols.notify(forkId, { key: "空白 は だめ", title: "t", finding: "f" }, { notified: 0 })).ok, false);
    assert.equal((await ctx.patrols.notify(forkId, { key: "k", title: "", finding: "f" }, { notified: 0 })).ok, false);
    // 見回りの Fork でない会話・見回りを消したあと
    const base = ctx.store.listThreadsForProject(ctx.projectId).find((t) => t.kind === "base")!;
    assert.equal((await ctx.patrols.notify(base.id, notifyArgs("x"), { notified: 0 })).ok, false);
    await ctx.automations.remove(a.id);
    const gone = await ctx.patrols.notify(forkId, notifyArgs("x"), { notified: 0 });
    assert.equal(gone.ok, false);
    assert.match(gone.text, /見回りはもうありません/);
    assert.equal(ctx.store.getThread(forkId)!.restriction, "read-only", "見回りを消したら Fork の読むだけの印が外れた");
  });
});

test("手帳は500件まで。超えたら最後に見た時刻の古いものから捨て、「知らせない」は残す", () => {
  // fold だけで確かめる（500 回 Event Store に書くと遅い）
  let seq = 0;
  const apply = (state: AutomationReadModel, type: string, payload: Record<string, unknown>) =>
    automationFold.apply(state, { seq: ++seq, ts: new Date(Date.UTC(2026, 9, 20, 0, 0, seq)).toISOString(), type, payload } as unknown as StoredEvent);
  let state = apply(automationFold.initial(), "automation.created", {
    id: "a1",
    projectId: "p1",
    createdBy: { kind: "human" },
    ...patrolFields,
    target: { kind: "dedicated", mode: "fresh" },
    reviewOnDone: false,
  });
  const note = (key: string, change: string, title?: string) => {
    state = apply(state, "automation.patrol_noted", { id: "a1", key, change, ...(title ? { title } : {}) });
  };
  note("old-muted", "notified", "古い");
  note("old-muted", "muted");
  note("old-plain", "notified", "古い2");
  for (let i = 0; i < PATROL_NOTEBOOK_MAX; i++) note(`n${i}`, "notified", `t${i}`);
  const notebook = state.automations.get("a1")!.notebook!;
  assert.equal(notebook.length, PATROL_NOTEBOOK_MAX);
  assert.ok(notebook.some((n) => n.key === "old-muted"), "「知らせない」を捨てた");
  assert.ok(!notebook.some((n) => n.key === "old-plain"), "古いものを捨てていない");
  assert.equal(notebook[0]!.key, `n${PATROL_NOTEBOOK_MAX - 1}`, "新しい順でない");
});

test("受信箱：気づきは返ってきた会話の次に並び、急ぎが先頭。片づけたら一覧から外れる", async () => {
  await setup(async (ctx) => {
    const a = await createPatrol(ctx);
    const forkId = a.target.threadId!;
    // 出した順に時刻を進める（並びは新しいものが先）
    ctx.setNow(new Date("2026-10-20T01:01:00Z"));
    await ctx.patrols.notify(forkId, notifyArgs("plain"), { notified: 0 });
    ctx.setNow(new Date("2026-10-20T01:02:00Z"));
    await ctx.patrols.notify(forkId, notifyArgs("hot", { urgent: true }), { notified: 0 });
    ctx.setNow(new Date("2026-10-20T01:03:00Z"));
    await ctx.patrols.notify(forkId, notifyArgs("later"), { notified: 0 });
    ctx.setNow(new Date("2026-10-20T01:04:00Z"));
    const base = ctx.store.listThreadsForProject(ctx.projectId).find((t) => t.kind === "base")!;
    await ctx.inbox.raiseReview({ threadId: base.id, summary: "終わりました" });
    const open = ctx.inbox.listOpen();
    assert.deepEqual(
      open.map((i) => (i.kind === "finding" ? i.key : i.kind)),
      ["review", "hot", "later", "plain"],
    );
    const hot = open.find((i): i is FindingItem => i.kind === "finding" && i.key === "hot")!;
    assert.equal(await ctx.inbox.closeFinding(hot.id, { how: "dismissed" }), true);
    assert.equal(await ctx.inbox.closeFinding(hot.id, { how: "muted" }), false, "片づけたものをもう一度片づけた");
    assert.equal((ctx.inbox.get(hot.id) as FindingItem).closed?.how, "dismissed");
    assert.ok(!ctx.inbox.listOpen().some((i) => i.id === hot.id));
  });
});

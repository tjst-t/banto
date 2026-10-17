// アーキ仕様 §4.3「人と AI の作り方」——AI が会話の tool から自動化を作る・直す口
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventLog } from "../event-store/log.js";
import { ProjectThreadStore } from "../project-thread/store.js";
import { InboxStore } from "../inbox/store.js";
import { PendingApprovalRegistry } from "../inbox/pending-approvals.js";
import { AutomationStore } from "./store.js";
import { AutomationTools, automationForAi, describeAutomationSource } from "./tools.js";
import type { Automation } from "./fold.js";

interface Ctx {
  store: ProjectThreadStore;
  automations: AutomationStore;
  inbox: InboxStore;
  approvals: PendingApprovalRegistry;
  tools: AutomationTools;
  projectId: string;
  baseId: string;
  judgments: Array<{ threadId: string; id: string; message: string; choices: string[] }>;
  prepared: string[];
  /** 鍵を捨てた自動化の id（消したとき） */
  forgotten: string[];
}

async function setup(fn: (ctx: Ctx) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "banto-automation-tools-"));
  try {
    const log = new EventLog(dir);
    await log.init();
    const store = new ProjectThreadStore(dir, log);
    await store.load();
    const inbox = new InboxStore(dir, log);
    await inbox.load();
    const automations = new AutomationStore(dir, log);
    await automations.load();
    // この Project の Module は出来事を名乗らない（banto 自身の出来事だけ待てる）
    automations.setEventCatalog({ find: () => undefined, list: () => [] });
    const project = await store.createProject("demo", dir);
    const base = await store.createBaseThread(project.id);
    const approvals = new PendingApprovalRegistry();
    const judgments: Ctx["judgments"] = [];
    const prepared: string[] = [];
    const forgotten: string[] = [];
    const tools = new AutomationTools({
      projectThread: store,
      now: () => NOW,
      automations,
      runner: {
        prepare: async (a: Automation) => {
          prepared.push(a.id);
          return a;
        },
      },
      webhooks: { forgetSecret: (id: string) => forgotten.push(id) },
      inbox,
      pendingApprovals: approvals,
      publishJudgment: (threadId, j) => judgments.push({ threadId, id: j.id, message: j.message, choices: j.choices }),
      judgeNotices: () => ["この Project はターンの終わりのまとめがオフなので、出来事 banto.turn-decisions が出ません"],
    });
    await fn({ store, automations, inbox, approvals, tools, projectId: project.id, baseId: base.id, judgments, prepared, forgotten });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** 試験の今（木曜 07:46 UTC。作った時刻（実時間）より後に置く——次の時刻は作った時刻より前から数えない） */
const NOW = new Date("2027-01-07T07:46:00Z");

const FIELDS = {
  name: "毎朝のまとめ",
  instruction: "昨日のコミットをまとめて",
  source: { kind: "time", repeat: { kind: "weekdays", time: "9:00" }, timeZone: "Asia/Tokyo" },
};

/** 判断待ちが出るまで待つ */
async function nextJudgment(ctx: Ctx, count: number): Promise<Ctx["judgments"][number]> {
  for (let i = 0; i < 100 && ctx.judgments.length < count; i++) await new Promise((r) => setTimeout(r, 5));
  const j = ctx.judgments[count - 1];
  assert.ok(j, "確認のカードが出ていない");
  return j;
}

test("作るときは必ずカードで聞き、許したら作って専用の Fork を用意する。作った人は AI と頼まれた会話", async () => {
  await setup(async (ctx) => {
    const pending = ctx.tools.create(ctx.baseId, FIELDS);
    const j = await nextJudgment(ctx, 1);
    assert.equal(j.threadId, ctx.baseId);
    assert.equal(j.message, "この自動化を作ってよいですか");
    assert.deepEqual(j.choices, ["作る", "作らない"]);
    const item = ctx.inbox.get(j.id);
    assert.equal(item?.kind === "judgment" && item.source, "automation");
    const shown = (item as { toolInput: Record<string, string> }).toolInput;
    assert.equal(shown["名前"], "毎朝のまとめ");
    assert.equal(shown["いつ"], "平日 9:00（Asia/Tokyo）");
    assert.match(shown["何が起きるか"]!, /「毎朝のまとめ」という名前の Fork が立ち/);
    assert.equal(ctx.automations.list(ctx.projectId).length, 0, "答える前に作っている");

    assert.ok(ctx.approvals.resolve(j.id, { behavior: "allow" }));
    const result = await pending;
    assert.equal(result.ok, true, result.text);
    const [created] = ctx.automations.list(ctx.projectId);
    assert.ok(created);
    assert.deepEqual(created.createdBy, { kind: "ai", threadId: ctx.baseId });
    assert.deepEqual(ctx.prepared, [created.id]);
  });
});

test("断ったら作らない", async () => {
  await setup(async (ctx) => {
    const pending = ctx.tools.create(ctx.baseId, FIELDS);
    const j = await nextJudgment(ctx, 1);
    ctx.approvals.resolve(j.id, { behavior: "deny", message: "作らない" });
    const result = await pending;
    assert.equal(result.ok, false);
    assert.match(result.text, /作っていません/);
    assert.equal(ctx.automations.list(ctx.projectId).length, 0);
  });
});

test("入力が決まりに合わなければ、聞く前に断る", async () => {
  await setup(async (ctx) => {
    const result = await ctx.tools.create(ctx.baseId, { ...FIELDS, source: { kind: "time", repeat: { kind: "cron", expr: "*/5 * * * *" }, timeZone: "Asia/Tokyo" } });
    assert.equal(result.ok, false);
    assert.equal(ctx.judgments.length, 0, "直せない入力でカードを出している");
    const other = await ctx.tools.create(ctx.baseId, { ...FIELDS, target: { kind: "thread", threadId: "nope" } });
    assert.equal(other.ok, false);
    assert.match(other.text, /この Project にありません/);
  });
});

test("出来事のきっかけ：名乗っていない出来事は聞く前に待てる出来事つきで断り、判断役の届け先は専用の Fork だけ。作れたら判断役には案内を添える", async () => {
  await setup(async (ctx) => {
    const judge = { name: "判断役", instruction: "決めることに答えて", source: { kind: "event", event: "banto.turn-decisions", where: { readExternal: false } } };
    const unknown = await ctx.tools.create(ctx.baseId, { ...judge, source: { kind: "event", event: "service.crashed" } });
    assert.equal(unknown.ok, false);
    assert.match(unknown.text, /待てる出来事：banto\.turn-decisions/);
    const onThread = await ctx.tools.create(ctx.baseId, { ...judge, target: { kind: "thread", threadId: ctx.baseId } });
    assert.equal(onThread.ok, false);
    assert.match(onThread.text, /専用の Fork だけ/);
    const badWhere = await ctx.tools.create(ctx.baseId, { ...judge, source: { ...judge.source, where: { nope: 1 } } });
    assert.equal(badWhere.ok, false);
    assert.equal(ctx.judgments.length, 0, "直せない入力でカードを出している");

    const pending = ctx.tools.create(ctx.baseId, judge);
    const j = await nextJudgment(ctx, 1);
    const shown = (ctx.inbox.get(j.id) as { toolInput: Record<string, string> }).toolInput;
    assert.equal(shown["いつ"], "出来事 banto.turn-decisions が起きたとき（readExternal が false）");
    assert.match(shown["何が起きるか"]!, /その出来事が起きるたびに動きます/);
    ctx.approvals.resolve(j.id, { behavior: "allow" });
    const result = await pending;
    assert.equal(result.ok, true, result.text);
    assert.match(result.text, /注意：この Project はターンの終わりのまとめがオフ/);
    const [created] = ctx.automations.list(ctx.projectId);
    assert.deepEqual(created?.source, { kind: "event", event: "banto.turn-decisions", where: { readExternal: false }, batchSeconds: 30, allowSelfTriggered: false });
  });
});

test("ターンが止められたら待つのをやめ、判断待ちを畳み、作らない", async () => {
  await setup(async (ctx) => {
    const abort = new AbortController();
    const pending = ctx.tools.create(ctx.baseId, FIELDS, abort.signal);
    const j = await nextJudgment(ctx, 1);
    abort.abort();
    const result = await pending;
    assert.equal(result.ok, false);
    assert.equal(ctx.automations.list(ctx.projectId).length, 0);
    const item = ctx.inbox.get(j.id);
    assert.equal(item?.kind === "judgment" && item.liveness, "answered");
  });
});

test("一覧と一時停止は聞かない。変える・再開するは聞く", async () => {
  await setup(async (ctx) => {
    const a = await ctx.automations.create({ projectId: ctx.projectId, createdBy: { kind: "human" }, fields: FIELDS });
    const listed = ctx.tools.list(ctx.baseId);
    assert.equal(listed.ok, true);
    assert.match(listed.text, /毎朝のまとめ/);

    const paused = await ctx.tools.pause(ctx.baseId, a.id);
    assert.equal(paused.ok, true);
    assert.equal(ctx.automations.get(a.id)?.paused, true);
    assert.equal(ctx.judgments.length, 0, "一覧・一時停止で聞いている");

    const resuming = ctx.tools.resume(ctx.baseId, a.id);
    const r = await nextJudgment(ctx, 1);
    assert.equal(r.message, "この自動化を再開してよいですか");
    assert.deepEqual(r.choices, ["再開する", "再開しない"]);
    ctx.approvals.resolve(r.id, { behavior: "allow" });
    assert.equal((await resuming).ok, true);
    assert.equal(ctx.automations.get(a.id)?.paused, false);

    const updating = ctx.tools.update(ctx.baseId, a.id, { name: "夕方のまとめ" });
    const u = await nextJudgment(ctx, 2);
    assert.equal(u.message, "この自動化を変えてよいですか");
    assert.deepEqual(u.choices, ["変える", "変えない"]);
    ctx.approvals.resolve(u.id, { behavior: "deny", message: "変えない" });
    assert.equal((await updating).ok, false);
    assert.equal(ctx.automations.get(a.id)?.name, "毎朝のまとめ", "断ったのに変わっている");
  });
});

test("消すときは必ずカードで聞き、許したら台帳から消して Webhook の鍵を捨てる。専用の Fork とその会話は残す", async () => {
  await setup(async (ctx) => {
    const a = await ctx.automations.create({ projectId: ctx.projectId, createdBy: { kind: "human" }, fields: FIELDS });
    const fork = await ctx.store.forkThread(ctx.baseId, { title: "毎朝のまとめ", fresh: true });
    await ctx.automations.setDedicatedThread(a.id, fork.id);

    const removing = ctx.tools.remove(ctx.baseId, a.id);
    const j = await nextJudgment(ctx, 1);
    assert.equal(j.threadId, ctx.baseId);
    assert.equal(j.message, "この自動化を消してよいですか");
    assert.deepEqual(j.choices, ["消す", "消さない"]);
    const item = ctx.inbox.get(j.id);
    assert.equal(item?.kind === "judgment" && item.source, "automation");
    const shown = (item as { toolInput: Record<string, string> }).toolInput;
    assert.equal(shown["自動化"], "毎朝のまとめ");
    assert.equal(shown["いつ"], "平日 9:00（Asia/Tokyo）");
    assert.equal(shown["どの会話で動かすか"], "専用の Fork で、毎回まっさらから");
    assert.match(shown["何が起きるか"]!, /専用の Fork とその会話は残ります（要らなければ Fork を閉じてください）/);
    assert.ok(ctx.automations.get(a.id), "答える前に消している");

    ctx.approvals.resolve(j.id, { behavior: "allow" });
    const result = await removing;
    assert.equal(result.ok, true, result.text);
    assert.match(result.text, /専用の Fork とその会話は残っている/);
    assert.equal(ctx.automations.get(a.id), undefined);
    assert.deepEqual(ctx.forgotten, [a.id]);
    assert.equal(ctx.store.getThread(fork.id)?.status, "active", "専用の Fork を閉じている");
  });
});

test("消さないと答えたら残す", async () => {
  await setup(async (ctx) => {
    const a = await ctx.automations.create({ projectId: ctx.projectId, createdBy: { kind: "human" }, fields: FIELDS });
    const removing = ctx.tools.remove(ctx.baseId, a.id);
    const j = await nextJudgment(ctx, 1);
    ctx.approvals.resolve(j.id, { behavior: "deny", message: "消さない" });
    const result = await removing;
    assert.equal(result.ok, false);
    assert.match(result.text, /消していません/);
    assert.ok(ctx.automations.get(a.id));
    assert.deepEqual(ctx.forgotten, []);
  });
});

test("ほかの Project の自動化・無い id は、聞く前に理由つきで断る", async () => {
  await setup(async (ctx) => {
    const other = await ctx.store.createProject("other", "/tmp");
    const a = await ctx.automations.create({ projectId: other.id, createdBy: { kind: "human" }, fields: FIELDS });
    for (const id of [a.id, "no-such-automation"]) {
      const r = await ctx.tools.remove(ctx.baseId, id);
      assert.equal(r.ok, false);
      assert.match(r.text, /この Project に自動化 .* はありません（list_automations で id が分かります）/);
    }
    assert.ok(ctx.automations.get(a.id));
    assert.equal(ctx.judgments.length, 0, "断るのに聞いている");
  });
});

test("ほかの Project の自動化には触れない（あるかどうかも漏らさない）", async () => {
  await setup(async (ctx) => {
    const other = await ctx.store.createProject("other", "/tmp");
    const a = await ctx.automations.create({ projectId: other.id, createdBy: { kind: "human" }, fields: FIELDS });
    const paused = await ctx.tools.pause(ctx.baseId, a.id);
    assert.equal(paused.ok, false);
    assert.match(paused.text, /この Project に自動化/);
    assert.equal(ctx.automations.get(a.id)?.paused, false);
    assert.equal(ctx.tools.list(ctx.baseId).text, "この Project に自動化はありません。");
  });
});

test("AI に返すのは選んだ欄だけ", async () => {
  await setup(async (ctx) => {
    const a = await ctx.automations.create({ projectId: ctx.projectId, createdBy: { kind: "human" }, fields: FIELDS });
    // 台帳に後から足した欄（Webhook の印など）が黙って AI に渡らない
    const shown = automationForAi({ ...a, webhookToken: "secret-token" } as Automation);
    assert.ok(!JSON.stringify(shown).includes("secret-token"));
    assert.equal(shown.when, "平日 9:00（Asia/Tokyo）");
    assert.equal(describeAutomationSource({ kind: "time", repeat: { kind: "weekly", day: 1, time: "8:30" }, timeZone: "UTC" }), "毎週月曜 8:30（UTC）");
  });
});

test("一覧に直近の回（結果・飛ばした理由）と次の時刻が出る。一時停止中は次の時刻が無い", async () => {
  await setup(async (ctx) => {
    const a = await ctx.automations.create({
      projectId: ctx.projectId,
      createdBy: { kind: "ai", threadId: ctx.baseId },
      fields: { ...FIELDS, source: { kind: "time", repeat: { kind: "cron", expr: "*/15 * * * *" }, timeZone: "UTC" } },
    });
    await ctx.automations.recordRun(a.id, {
      runId: "r1",
      at: "2027-01-07T07:30:00Z",
      cause: "clock",
      result: "done",
      scheduledFor: "2027-01-07T07:30:00Z",
    });
    await ctx.automations.recordRun(a.id, {
      runId: "r2",
      at: "2027-01-07T07:45:00Z",
      cause: "clock",
      result: "skipped",
      reason: "前の回がまだ動いているので飛ばしました",
      scheduledFor: "2027-01-07T07:45:00Z",
    });
    for (let i = 0; i < 6; i++) {
      await ctx.automations.recordRun(a.id, { runId: `m${i}`, at: `2027-01-07T07:4${i}:30Z`, cause: "manual", result: "done" });
    }

    const [shown] = JSON.parse(ctx.tools.list(ctx.baseId).text) as Array<Record<string, unknown>>;
    assert.equal(shown?.nextFireAt, "2027-01-07T08:00:00.000Z");
    const runs = shown?.recentRuns as Array<Record<string, unknown>>;
    assert.equal(runs.length, 5, "数件に絞っていない");
    assert.equal(runs[0]?.runId, undefined, "内部の id を返している");

    // 飛ばした回の理由が読める（新しい回に押し出されない数で確かめる）
    const few = automationForAi({ ...ctx.automations.get(a.id)!, runs: ctx.automations.get(a.id)!.runs.slice(-2) }, NOW);
    assert.deepEqual(few.recentRuns, [
      {
        at: "2027-01-07T07:45:00Z",
        cause: "clock",
        result: "skipped",
        reason: "前の回がまだ動いているので飛ばしました",
        scheduledFor: "2027-01-07T07:45:00Z",
      },
      { at: "2027-01-07T07:30:00Z", cause: "clock", result: "done", scheduledFor: "2027-01-07T07:30:00Z" },
    ]);

    await ctx.tools.pause(ctx.baseId, a.id);
    const [paused] = JSON.parse(ctx.tools.list(ctx.baseId).text) as Array<Record<string, unknown>>;
    assert.equal(paused?.nextFireAt, undefined, "一時停止中に次の時刻を出している");
    assert.equal(paused?.paused, true);
  });
});

test("作った直後の返り値にも次の時刻と（まだ空の）直近の回が出る", async () => {
  await setup(async (ctx) => {
    const pending = ctx.tools.create(ctx.baseId, FIELDS);
    const j = await nextJudgment(ctx, 1);
    ctx.approvals.resolve(j.id, { behavior: "allow" });
    const result = await pending;
    assert.equal(result.ok, true);
    const shown = JSON.parse(result.text.slice(result.text.indexOf("\n") + 1)) as Record<string, unknown>;
    assert.deepEqual(shown.recentRuns, []);
    // 平日 9:00 Asia/Tokyo ＝ 00:00 UTC。作った時刻（実時間）より後の最初の平日
    assert.match(String(shown.nextFireAt), /T00:00:00\.000Z$/);
  });
});

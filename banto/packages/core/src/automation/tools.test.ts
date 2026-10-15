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
    const project = await store.createProject("demo", dir);
    const base = await store.createBaseThread(project.id);
    const approvals = new PendingApprovalRegistry();
    const judgments: Ctx["judgments"] = [];
    const prepared: string[] = [];
    const tools = new AutomationTools({
      projectThread: store,
      automations,
      runner: {
        prepare: async (a: Automation) => {
          prepared.push(a.id);
          return a;
        },
      },
      inbox,
      pendingApprovals: approvals,
      publishJudgment: (threadId, j) => judgments.push({ threadId, id: j.id, message: j.message, choices: j.choices }),
    });
    await fn({ store, automations, inbox, approvals, tools, projectId: project.id, baseId: base.id, judgments, prepared });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

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

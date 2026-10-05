// Thread 間・Project 間のメッセージ（アーキ仕様 §4.2「Thread 間・Project 間の送り方」）
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventLog } from "../event-store/log.js";
import { InboxStore } from "../inbox/store.js";
import { PendingApprovalRegistry } from "../inbox/pending-approvals.js";
import { ProjectThreadStore } from "../project-thread/store.js";
import { ThreadTurns } from "./thread-turns.js";
import { ThreadDeliveries, composeTurnPrompt } from "./thread-deliveries.js";
import { MESSAGE_ALLOW_REMEMBER, REPLY_WINDOW_MS, ThreadMessaging } from "./thread-messages.js";
import { AUTO_APPROVED_ANSWER_TEXT } from "../inbox/auto-approve.js";

interface Ctx {
  store: ProjectThreadStore;
  inbox: InboxStore;
  approvals: PendingApprovalRegistry;
  messaging: ThreadMessaging;
  turns: ThreadTurns;
  /** Project A（送り元）と B（宛先） */
  a: { projectId: string; base: string; fork: string };
  b: { projectId: string; base: string };
  judgments: Array<{ threadId: string; id: string; choices: string[] }>;
  runs: string[];
  clock: { now: number };
  /** 「承認をすべて自動で許可する」がオンの Project（試験の途中で変える） */
  autoApprove: Set<string>;
  answered: Array<{ threadId: string; id: string; answer: string }>;
}

async function setup(fn: (ctx: Ctx) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "banto-messages-test-"));
  try {
    const log = new EventLog(dir);
    await log.init();
    const store = new ProjectThreadStore(dir, log);
    await store.load();
    const inbox = new InboxStore(dir, log);
    await inbox.load();
    const approvals = new PendingApprovalRegistry();
    const turns = new ThreadTurns();
    const clock = { now: Date.now() };
    const deliveries = new ThreadDeliveries({ projectThread: store, turns, notify: async () => undefined, now: () => clock.now });
    const runs: string[] = [];
    deliveries.setTurnRunner(async (threadId) => {
      runs.push(threadId);
      return true;
    });
    const judgments: Ctx["judgments"] = [];
    const autoApprove = new Set<string>();
    const answered: Ctx["answered"] = [];
    const messaging = new ThreadMessaging({
      projectThread: store,
      inbox,
      pendingApprovals: approvals,
      deliveries,
      threadTurns: turns,
      publishJudgment: (threadId, j) => judgments.push({ threadId, id: j.id, choices: j.choices }),
      publishAnswered: (threadId, a) => answered.push({ threadId, ...a }),
      autoApproveAll: (projectId) => autoApprove.has(projectId),
      now: () => clock.now,
    });
    const pa = await store.createProject("infra", dir);
    const aBase = await store.createBaseThread(pa.id);
    const aFork = await store.forkThread(aBase.id, { title: "作業" });
    const pb = await store.createProject("app", dir);
    const bBase = await store.createBaseThread(pb.id);
    await fn({
      store,
      inbox,
      approvals,
      messaging,
      turns,
      a: { projectId: pa.id, base: aBase.id, fork: aFork.id },
      b: { projectId: pb.id, base: bBase.id },
      judgments,
      runs,
      clock,
      autoApprove,
      answered,
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** 判断待ちが出るまで待つ */
async function nextJudgment(ctx: Ctx, count: number) {
  for (let i = 0; i < 100 && ctx.judgments.length < count; i++) await new Promise((r) => setTimeout(r, 5));
  assert.equal(ctx.judgments.length, count, "判断待ちが出ない");
  return ctx.judgments[count - 1]!;
}

test("同じ Project の中は承認なしで届き、送り元が付く", async () => {
  await setup(async ({ store, messaging, a, judgments, runs }) => {
    const r = await messaging.send(a.fork, { threadId: a.base, title: "結果", text: "終わった" });
    assert.equal(r.ok, true, r.text);
    assert.equal(judgments.length, 0, "同じ Project で承認を求めた");
    const pending = store.getThread(a.base)!.deliveries!;
    assert.equal(pending.length, 1);
    assert.deepEqual(pending[0]!.sender, { projectId: a.projectId, projectName: "infra", threadId: a.fork, threadLabel: "作業" });
    assert.deepEqual(runs, [a.base]);
    // AI に渡す文に送り元の id が載る（返事の宛先）
    const prompt = composeTurnPrompt(pending, "");
    assert.match(prompt, new RegExp(`sender-thread-id="${a.fork}"`));
    assert.match(prompt, /send_message/);
  });
});

test("Project だけを指すと、会話を引き継がない新しい Fork が立って届く", async () => {
  await setup(async ({ store, messaging, a, judgments, approvals }) => {
    // B の Base に会話があっても、新しい Fork には写らない
    const project = store.listProjects().find((p) => p.name === "app")!;
    const bBase = store.listThreadsForProject(project.id).find((t) => t.kind === "base")!;
    await store.appendMessage(bBase.id, "user", "前の話");
    await store.updateResumePoint(bBase.id, "session-b");
    const sending = messaging.send(a.base, { projectId: project.id, title: "DB を足して", text: "詳細" });
    const j = await nextJudgment({ judgments } as Ctx, 1);
    approvals.resolve(j.id, { behavior: "allow" });
    const r = await sending;
    assert.equal(r.ok, true, r.text);
    assert.ok(r.ok && r.createdFork);
    const fork = store.getThread(r.ok ? r.threadId : "")!;
    assert.equal(fork.kind, "fork");
    assert.equal(fork.title, "DB を足して");
    assert.equal(fork.resumePoint, undefined, "親のセッションを引き継いでいる");
    assert.deepEqual(fork.messages, [], "親の会話が写っている");
    assert.equal(fork.deliveries?.length, 1);
  });
});

test("Project をまたぐ送信は人に聞く。拒否なら届かない", async () => {
  await setup(async ({ store, messaging, a, b, judgments, approvals }) => {
    const sending = messaging.send(a.fork, { threadId: b.base, title: "t", text: "x" });
    const j = await nextJudgment({ judgments } as Ctx, 1);
    assert.equal(j.threadId, a.fork, "送り元の会話で聞いていない");
    assert.ok(j.choices.includes(MESSAGE_ALLOW_REMEMBER));
    approvals.resolve(j.id, { behavior: "deny", message: "拒否する" });
    const r = await sending;
    assert.equal(r.ok, false);
    assert.equal(store.getThread(b.base)!.deliveries?.length ?? 0, 0);
  });
});

test("「以後聞かない」を選ぶと、宛先の Project の一覧に足され、次からは聞かない", async () => {
  await setup(async ({ store, messaging, a, b, judgments, approvals }) => {
    const first = messaging.send(a.base, { threadId: b.base, title: "1", text: "x" });
    const j = await nextJudgment({ judgments } as Ctx, 1);
    approvals.resolve(j.id, { behavior: "allow", remember: true } as never);
    assert.equal((await first).ok, true);
    assert.deepEqual(store.getProject(b.projectId)!.acceptMessagesFrom, [a.projectId]);
    const second = await messaging.send(a.fork, { threadId: b.base, title: "2", text: "y" });
    assert.equal(second.ok, true);
    assert.equal(judgments.length, 1, "一覧に載っているのにまた聞いた");
  });
});

test("受け取ったメッセージの送り元への返事は、24時間以内なら承認なし", async () => {
  await setup(async ({ messaging, a, b, judgments, approvals, clock }) => {
    const sending = messaging.send(a.fork, { threadId: b.base, title: "質問", text: "?" });
    const j = await nextJudgment({ judgments } as Ctx, 1);
    approvals.resolve(j.id, { behavior: "allow" });
    assert.equal((await sending).ok, true);
    // B から A の Fork へ返す
    const reply = await messaging.send(b.base, { threadId: a.fork, title: "答え", text: "!" });
    assert.equal(reply.ok, true, reply.text);
    assert.equal(judgments.length, 1, "返事で聞いた");
    // 送り元以外（A の Base）には返事扱いにならない
    const other = messaging.send(b.base, { threadId: a.base, title: "別", text: "z" });
    await nextJudgment({ judgments } as Ctx, 2);
    approvals.resolve(judgments[1]!.id, { behavior: "deny", message: "拒否する" });
    assert.equal((await other).ok, false);
    // 24時間を過ぎたら、また聞く
    clock.now += REPLY_WINDOW_MS + 60_000; // 記録の時刻は実時間なので、少し余らせる
    const late = messaging.send(b.base, { threadId: a.fork, title: "遅い答え", text: "!" });
    await nextJudgment({ judgments } as Ctx, 3);
    approvals.resolve(judgments[2]!.id, { behavior: "allow" });
    assert.equal((await late).ok, true);
  });
});

test("止められたら待つのをやめて断り、判断待ちも畳む", async () => {
  await setup(async ({ inbox, messaging, a, b, judgments }) => {
    const ac = new AbortController();
    const sending = messaging.send(a.base, { threadId: b.base, title: "t", text: "x" }, ac.signal);
    const j = await nextJudgment({ judgments } as Ctx, 1);
    ac.abort();
    const r = await sending;
    assert.equal(r.ok, false);
    await new Promise((res) => setTimeout(res, 10));
    assert.notEqual(inbox.get(j.id)?.kind === "judgment" && (inbox.get(j.id) as { liveness: string }).liveness, "live");
  });
});

test("宛先の誤りは理由を返して断る", async () => {
  await setup(async ({ messaging, a, b }) => {
    assert.match((await messaging.send(a.base, { threadId: a.base, title: "t", text: "x" })).text, /自分自身/);
    assert.match((await messaging.send(a.base, { title: "t", text: "x" })).text, /宛先/);
    assert.match((await messaging.send(a.base, { threadId: "nope", title: "t", text: "x" })).text, /見つかりません/);
    assert.match(
      (await messaging.send(a.base, { projectId: a.projectId, threadId: b.base, title: "t", text: "x" })).text,
      /のものではありません/,
    );
  });
});

test("一覧は既定でこの Project だけ、指定でほかの Project も。中身は返さない", async () => {
  await setup(async ({ messaging, a }) => {
    const mine = messaging.listThreads(a.fork, false);
    assert.equal(mine.length, 2);
    assert.ok(mine.find((e) => e.threadId === a.fork)?.self);
    const all = messaging.listThreads(a.fork, true);
    assert.equal(all.length, 3);
    assert.ok(all.every((e) => !("messages" in e)));
  });
});

// **承認をすべて自動で許可する**（決定・2026-10-05、ユーザー。v4-frontend.md §6.4）。送り元の Project のスイッチで決める
test("送り元の Project が「承認をすべて自動で許可する」なら聞かずに届き、答え済みのカードだけ残る——覚えず、切ればまた聞く", async () => {
  await setup(async ({ store, inbox, messaging, a, b, judgments, approvals, autoApprove, answered }) => {
    // 宛先の Project のスイッチは効かない（頼んだのは送り元）
    autoApprove.add(b.projectId);
    const viaTarget = messaging.send(a.base, { threadId: b.base, title: "0", text: "x" });
    const asked = await nextJudgment({ judgments } as Ctx, 1);
    approvals.resolve(asked.id, { behavior: "deny", message: "拒否する" });
    assert.equal((await viaTarget).ok, false);
    autoApprove.delete(b.projectId);

    autoApprove.add(a.projectId);
    const r = await messaging.send(a.fork, { threadId: b.base, title: "1", text: "y" });
    assert.equal(r.ok, true, r.text);
    assert.equal(store.getThread(b.base)!.deliveries?.length, 1);
    const card = judgments[1]!;
    assert.equal(card.threadId, a.fork, "送り元の会話にカードを残す");
    assert.deepEqual(answered, [{ threadId: a.fork, id: card.id, answer: AUTO_APPROVED_ANSWER_TEXT }]);
    const item = inbox.get(card.id);
    assert.equal(item?.kind === "judgment" ? item.liveness : undefined, "answered", "受信箱に未解決を残さない");
    assert.equal(store.getProject(b.projectId)!.acceptMessagesFrom, undefined, "「受け取ってよい Project」には足さない");

    autoApprove.delete(a.projectId);
    const again = messaging.send(a.fork, { threadId: b.base, title: "2", text: "z" });
    const j = await nextJudgment({ judgments } as Ctx, 3);
    approvals.resolve(j.id, { behavior: "allow" });
    assert.equal((await again).ok, true);
  });
});

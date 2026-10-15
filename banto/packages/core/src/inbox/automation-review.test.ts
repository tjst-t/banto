// 自動化の回の受信箱（アーキ仕様 §4.3「受信箱」）
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventLog } from "../event-store/log.js";
import { ProjectThreadStore } from "../project-thread/store.js";
import type { AutomationRun } from "../automation/fold.js";
import { InboxStore } from "./store.js";
import { acknowledgesReviewsOnStart, automationRunOfLastTurn, planAutomationReview, unseenRunsOf } from "./automation-review.js";
import { reviewDueAfterTurn, reviewTurnOf } from "./review-turn.js";
import type { ReviewItem } from "./types.js";

const AUTOMATION = "a1";

async function withStores(fn: (s: { store: ProjectThreadStore; inbox: InboxStore; threadId: string }) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "banto-automation-review-"));
  try {
    const log = new EventLog(dir);
    await log.init();
    const store = new ProjectThreadStore(dir, log);
    await store.load();
    const inbox = new InboxStore(dir, log);
    await inbox.load();
    const project = await store.createProject("demo", dir);
    const thread = await store.createBaseThread(project.id);
    await fn({ store, inbox, threadId: thread.id });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const decisions = [{ question: "どちらで進めますか", options: [{ label: "A", reply: "A で" }] }];

/**
 * 自動化の1回分のターンを積む（届けもの→AI の返事→結末）。毎回まっさらと同じく、回の前に Clear する。
 * `cli.ts` のターンの終わりと同じ順で、出すかを決めて受信箱に出す
 */
async function runOnce(
  s: { store: ProjectThreadStore; inbox: InboxStore; threadId: string },
  opts: { runId: string; reviewOnDone: boolean; outcome: "completed" | "failed"; decisions?: boolean; runs: AutomationRun[] },
): Promise<ReviewItem | "skipped" | undefined> {
  const { store, inbox, threadId } = s;
  await store.clearThread(threadId);
  const at = new Date(Date.now() + opts.runs.length).toISOString();
  opts.runs.unshift({ runId: opts.runId, at, cause: "clock", result: "running", threadId });
  const turnId = await store.startTurn(threadId, { cause: "delivery", attempt: 0 });
  await store.appendMessage(threadId, "user", "毎朝の確認をして", undefined, {
    from: "banto",
    title: "自動化「朝」",
    hop: 0,
    deliveryId: `d-${opts.runId}`,
    automation: { id: AUTOMATION, runId: opts.runId },
  });
  await store.appendMessage(threadId, "assistant", `${opts.runId} の返事`);
  if (opts.decisions) {
    await store.recordTurnSummary(threadId, {
      summary: { request: "毎朝の確認", outcome: { status: "done", headline: "見ました", points: [] }, decisions },
      at: new Date().toISOString(),
    });
  }
  await store.endTurn(threadId, turnId, opts.outcome);
  opts.runs[0] = { ...opts.runs[0]!, result: opts.outcome === "completed" ? "done" : "failed" };

  const thread = store.getThread(threadId)!;
  assert.equal(reviewDueAfterTurn(thread), true);
  const plan = planAutomationReview(thread, {
    automation: () => ({ reviewOnDone: opts.reviewOnDone, runs: opts.runs }),
    hasLiveJudgment: false,
  });
  if (plan.kind === "skip") return "skipped";
  assert.equal(plan.kind, "automation");
  if (plan.kind !== "automation") return undefined;
  return inbox.raiseAutomationReview({ threadId, summary: `${opts.runId} の終わり`, automation: plan.automation });
}

const openReviews = (inbox: InboxStore) => inbox.listOpen().filter((i): i is ReviewItem => i.kind === "review");

test("「出さない」自動化：完了した回は出さず、決めることのある回・失敗した回は出す", async () => {
  await withStores(async (s) => {
    const runs: AutomationRun[] = [];
    assert.equal(await runOnce(s, { runId: "r1", reviewOnDone: false, outcome: "completed", runs }), "skipped", "何も無く完了した回を出した");
    assert.equal(openReviews(s.inbox).length, 0);

    const withDecisions = await runOnce(s, { runId: "r2", reviewOnDone: false, outcome: "completed", decisions: true, runs });
    assert.ok(withDecisions && withDecisions !== "skipped", "決めることのある回を出さない");
    assert.equal(withDecisions.automation?.attention, "decisions");

    const failed = await runOnce(s, { runId: "r3", reviewOnDone: false, outcome: "failed", runs });
    assert.ok(failed && failed !== "skipped", "失敗した回を出さない");
    assert.equal(failed.automation?.attention, "failed");
    // 見ないといけない回が続いたら、前のものも消さずに並べる
    assert.deepEqual(openReviews(s.inbox).map((r) => r.automation?.runId).sort(), ["r2", "r3"]);
  });
});

test("「出す」自動化：何も無い回は前の何も無い回を置き換え、まだ見ていない回を引き継いで数える", async () => {
  await withStores(async (s) => {
    const runs: AutomationRun[] = [];
    await runOnce(s, { runId: "r1", reviewOnDone: true, outcome: "completed", runs });
    const second = await runOnce(s, { runId: "r2", reviewOnDone: true, outcome: "completed", runs });
    const open = openReviews(s.inbox);
    assert.equal(open.length, 1, "1つの Thread に未確認が2件ある");
    assert.equal(open[0]!.automation?.runId, "r2");
    assert.ok(second && second !== "skipped");
    assert.equal(unseenRunsOf(open[0]!, { runs }), 2, "置き換えた前の回を数えない");
  });
});

test("決めることのある未確認のカードは、後の何も無い回で消えない（「出す」でも「出さない」でも）", async () => {
  for (const reviewOnDone of [true, false]) {
    await withStores(async (s) => {
      const runs: AutomationRun[] = [];
      const first = await runOnce(s, { runId: "r1", reviewOnDone, outcome: "completed", decisions: true, runs });
      assert.ok(first && first !== "skipped");
      const later = await runOnce(s, { runId: "r2", reviewOnDone, outcome: "completed", runs });
      if (reviewOnDone) assert.equal(later, undefined, "何も無い回のカードを足した");
      else assert.equal(later, "skipped");
      await runOnce(s, { runId: "r3", reviewOnDone, outcome: "completed", runs });

      const open = openReviews(s.inbox);
      assert.equal(open.length, 1, `reviewOnDone=${reviewOnDone}：決めることのあるカードが消えた・何も無い回が足された`);
      const card = open[0]!;
      assert.equal(card.id, first.id);
      assert.equal(card.automation?.attention, "decisions");
      assert.equal(unseenRunsOf(card, { runs }), 3, "まだ見ていない回の数が違う");

      // 残したカードは、後の回で記録が進んでも自分のターンの中身を出す
      const thread = s.store.getThread(s.threadId)!;
      assert.notEqual(card.automation!.startedSeq, thread.lastTurn!.startedSeq);
      const turn = reviewTurnOf(thread, {
        running: false,
        earlier: { startedSeq: card.automation!.startedSeq, beforeSeq: card.automation!.raisedSeq, outcome: card.automation!.outcome! },
      });
      assert.equal(turn.reply, "r1 の返事");
      assert.ok(Array.isArray(turn.summary?.decisions) && turn.summary.decisions.length === 1);
      assert.equal(turn.outcome, "completed");
    });
  }
});

test("失敗した未確認のカードも、後の何も無い回で消えない", async () => {
  await withStores(async (s) => {
    const runs: AutomationRun[] = [];
    const failed = await runOnce(s, { runId: "r1", reviewOnDone: true, outcome: "failed", runs });
    assert.ok(failed && failed !== "skipped");
    await runOnce(s, { runId: "r2", reviewOnDone: true, outcome: "completed", runs });
    assert.deepEqual(openReviews(s.inbox).map((r) => r.id), [failed.id]);
  });
});

test("人が後から送ったターンは自動化の回ではない。自動化の届けもので起きた続きのターンはその回", async () => {
  await withStores(async ({ store, threadId }) => {
    const origin = { from: "banto", title: "自動化「朝」", hop: 0, deliveryId: "d1", automation: { id: AUTOMATION, runId: "r1" } };
    await store.appendMessage(threadId, "user", "指示", undefined, origin);
    await store.appendMessage(threadId, "assistant", "サブエージェントに頼みました");
    // 裏の仕事の結果が届いて起きた続きのターン
    await store.appendMessage(threadId, "user", "結果", undefined, { from: "subagent", title: "終わりました", hop: 1, deliveryId: "d2" });
    assert.deepEqual(automationRunOfLastTurn(store.getThread(threadId)!), { id: AUTOMATION, runId: "r1" });
    await store.appendMessage(threadId, "user", "これはどう？");
    assert.equal(automationRunOfLastTurn(store.getThread(threadId)!), undefined);
    const turnId = await store.startTurn(threadId, { cause: "human", attempt: 0 });
    await store.endTurn(threadId, turnId, "completed");
    assert.deepEqual(planAutomationReview(store.getThread(threadId)!, { automation: () => undefined, hasLiveJudgment: false }), { kind: "plain" });
  });
});

test("判断待ちで止まった回は「出さない」でも出す", async () => {
  await withStores(async ({ store, threadId }) => {
    const turnId = await store.startTurn(threadId, { cause: "delivery", attempt: 0 });
    await store.appendMessage(threadId, "user", "指示", undefined, {
      from: "banto",
      title: "自動化「朝」",
      hop: 0,
      deliveryId: "d1",
      automation: { id: AUTOMATION, runId: "r1" },
    });
    await store.endTurn(threadId, turnId, "completed");
    const plan = planAutomationReview(store.getThread(threadId)!, {
      automation: () => ({ reviewOnDone: false, runs: [] }),
      hasLiveJudgment: true,
    });
    assert.equal(plan.kind, "automation");
    assert.equal(plan.kind === "automation" ? plan.automation.attention : undefined, "waiting");
  });
});

test("ターンの始まりに「見た」にするのは人が送ったターンだけ——自動化の届けもので起きたターンでは消さない", async () => {
  await withStores(async ({ store, threadId }) => {
    assert.equal(acknowledgesReviewsOnStart(store.getThread(threadId), 0), true, "人が送ったターンで消さない");
    assert.equal(acknowledgesReviewsOnStart(store.getThread(threadId), 1), false, "届いたもので起きたターンで消した");
    await store.recordDelivery({
      threadId,
      deliveryId: "d1",
      from: "banto",
      title: "自動化「朝」",
      text: "毎朝の確認をして",
      hop: 0,
      kind: "automation",
      automation: { id: AUTOMATION, runId: "r1" },
    });
    assert.equal(acknowledgesReviewsOnStart(store.getThread(threadId), 0), false, "自動化の回の始まりで前の回のカードを消した");
  });
});

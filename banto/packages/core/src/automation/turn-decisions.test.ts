import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventLog } from "../event-store/log.js";
import { ProjectThreadStore } from "../project-thread/store.js";
import type { PendingDelivery } from "../project-thread/types.js";
import { InboxStore } from "../inbox/store.js";
import type { ReviewItem } from "../inbox/types.js";
import { reviewTurnOf } from "../inbox/review-turn.js";
import type { DeliverInput } from "../delivery/thread-deliveries.js";
import { composeTurnPrompt } from "../delivery/thread-deliveries.js";
import { AutomationInputError, AutomationStore } from "./store.js";
import {
  TURN_DECISIONS_EVENT,
  TurnDecisions,
  autoApproveAllFor,
  judgeNotices,
  movedOnReason,
  turnDecisionsEventOf,
} from "./turn-decisions.js";

const SUMMARY = {
  request: "設定画面の並びを直す",
  outcome: { status: "partial", headline: "案を2つ作った", points: [] },
  decisions: [
    {
      question: "どちらの並びにしますか",
      options: [
        { label: "案A", reply: "案A で。一般を先頭にして", recommended: true },
        { label: "案B", reply: "案B で。Module を先頭にして" },
      ],
    },
    {
      question: "モックを残しますか",
      options: [
        { label: "残す", reply: "モックは残して" },
        { label: "消す", reply: "モックは消して" },
      ],
    },
  ],
};

interface Harness {
  projectThread: ProjectThreadStore;
  automations: AutomationStore;
  inbox: InboxStore;
  decisions: TurnDecisions;
  emitted: Array<{ projectId: string; fields: Record<string, unknown>; text?: string; causedBy?: unknown }>;
  delivered: DeliverInput[];
  turns: { running: Set<string>; queued: Map<string, number> };
  summaryOn: { value: boolean };
  projectId: string;
  baseId: string;
  judgeThreadId: string;
  judgeId: string;
}

async function withHarness(fn: (h: Harness) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "banto-turn-decisions-test-"));
  try {
    const log = new EventLog(dir);
    await log.init();
    const projectThread = new ProjectThreadStore(dir, log);
    await projectThread.load();
    const automations = new AutomationStore(dir, log);
    await automations.load();
    const inbox = new InboxStore(dir, log);
    await inbox.load();
    const project = await projectThread.createProject("P", dir);
    const base = await projectThread.createBaseThread(project.id);
    const judgeFork = await projectThread.forkThread(base.id, { title: "判断役", fresh: true });
    const judge = await automations.create({
      projectId: project.id,
      createdBy: { kind: "human" },
      fields: {
        name: "判断役",
        instruction: "決めて",
        source: { kind: "event", event: TURN_DECISIONS_EVENT, batchSeconds: 0 },
        target: { kind: "dedicated", mode: "continue" },
      },
    });
    await automations.setDedicatedThread(judge.id, judgeFork.id);
    const emitted: Harness["emitted"] = [];
    const delivered: DeliverInput[] = [];
    const turns = { running: new Set<string>(), queued: new Map<string, number>() };
    const summaryOn = { value: true };
    const decisions = new TurnDecisions({
      projectThread,
      automations,
      events: {
        emitFromCore: async (projectId, _decl, event, causedBy) => {
          emitted.push({ projectId, fields: event.fields, ...(event.text ? { text: event.text } : {}), causedBy });
          return 1;
        },
      },
      deliveries: {
        deliver: async (input) => {
          delivered.push(input);
          return { deliveryId: `d${delivered.length}`, wake: "now" };
        },
      },
      turns: { isRunning: (id) => turns.running.has(id), queued: (id) => turns.queued.get(id) ?? 0 },
      inbox,
      turnSummaryEnabled: () => summaryOn.value,
      log: () => {},
    });
    await fn({
      projectThread,
      automations,
      inbox,
      decisions,
      emitted,
      delivered,
      turns,
      summaryOn,
      projectId: project.id,
      baseId: base.id,
      judgeThreadId: judgeFork.id,
      judgeId: judge.id,
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** 人が頼み、AI がまとめつきで答えて終わったターン。ターンの id を返す */
async function decidedTurn(h: Harness, summary: Record<string, unknown> = SUMMARY, outcome: "completed" | "failed" = "completed"): Promise<string> {
  const turnId = await h.projectThread.startTurn(h.baseId, { cause: "human", attempt: 0 });
  await h.projectThread.appendMessage(h.baseId, "user", "並びを直して");
  await h.projectThread.appendMessage(h.baseId, "assistant", "案を2つ作りました");
  await h.projectThread.recordTurnSummary(h.baseId, { summary, at: new Date().toISOString() });
  await h.projectThread.endTurn(h.baseId, turnId, outcome);
  await h.inbox.raiseReview({ threadId: h.baseId, summary: "ターンが終わりました" });
  return turnId;
}

/** 判断役の自動化が届けた出来事（turn-runner が積んだ届けもの） */
function judgeDelivery(h: Harness, turnId: string): PendingDelivery {
  return {
    from: "banto",
    title: "自動化「判断役」",
    hop: 1,
    deliveryId: "dj",
    text: "決めて",
    receivedAt: new Date().toISOString(),
    kind: "automation",
    automation: { id: h.judgeId, runId: "r1" },
    external: [
      {
        source: "event",
        receivedAt: new Date().toISOString(),
        body: "",
        event: {
          name: TURN_DECISIONS_EVENT,
          title: "決めることのあるターンが終わった",
          eventId: `${h.baseId}:${turnId}`,
          occurredAt: new Date().toISOString(),
          fields: { thread: h.baseId, turnId, threadTitle: "Base Thread", count: 2, hop: 0, readExternal: false },
        },
      },
    ],
  };
}

const reviewOf = (h: Harness) =>
  h.inbox.listOpen().find((i): i is ReviewItem => i.kind === "review" && i.threadId === h.baseId);

test("決めることのある、最後まで行ったターンで出す。属性・本文・起こしたターンの印", async () => {
  await withHarness(async (h) => {
    const turnId = await decidedTurn(h);
    await h.decisions.emitIfDecided(h.baseId, 3);
    assert.equal(h.emitted.length, 1);
    assert.deepEqual(h.emitted[0]!.fields, {
      thread: h.baseId,
      turnId,
      threadTitle: "Base Thread",
      count: 2,
      hop: 3,
      readExternal: false,
    });
    const text = JSON.parse(h.emitted[0]!.text!);
    assert.equal(text.request, "設定画面の並びを直す");
    assert.equal(text.headline, "案を2つ作った");
    assert.deepEqual(text.decisions[0].options[0], { number: 1, label: "案A", reply: "案A で。一般を先頭にして", recommended: true });
    assert.equal(text.decisions[1].number, 2);
    assert.deepEqual(h.emitted[0]!.causedBy, { threadId: h.baseId, turnId, hop: 3 });
  });
});

test("まとめがオフ・決めることが無い・失敗したターン・残りがあるターンでは出さない", async () => {
  await withHarness(async (h) => {
    await decidedTurn(h);
    h.summaryOn.value = false;
    await h.decisions.emitIfDecided(h.baseId, 0);
    h.summaryOn.value = true;
    await decidedTurn(h, { ...SUMMARY, decisions: [] });
    await h.decisions.emitIfDecided(h.baseId, 0);
    await decidedTurn(h, SUMMARY, "failed");
    await h.decisions.emitIfDecided(h.baseId, 0);
    assert.equal(h.emitted.length, 0);
    // 届いたものが残っている（結果が届いて AI がまとめ終える最後のターンで出る）
    await decidedTurn(h);
    await h.projectThread.recordDelivery({ threadId: h.baseId, deliveryId: "x", from: "m", title: "t", text: "x", hop: 1 });
    assert.equal(turnDecisionsEventOf(h.projectThread.getThread(h.baseId)!, 0), undefined);
  });
});

test("外から来たものを積んだターンは readExternal が真", async () => {
  await withHarness(async (h) => {
    const turnId = await h.projectThread.startTurn(h.baseId, { cause: "delivery", attempt: 0 });
    await h.projectThread.appendMessage(h.baseId, "user", "見て", undefined, {
      from: "banto",
      title: "自動化",
      hop: 0,
      deliveryId: "w",
      external: [{ source: "webhook", receivedAt: new Date().toISOString(), body: "PR が来た" }],
    });
    await h.projectThread.appendMessage(h.baseId, "assistant", "見ました");
    await h.projectThread.recordTurnSummary(h.baseId, { summary: SUMMARY, at: new Date().toISOString() });
    await h.projectThread.endTurn(h.baseId, turnId, "completed");
    assert.equal(turnDecisionsEventOf(h.projectThread.getThread(h.baseId)!, 0)?.fields.readExternal, true);
  });
});

test("全部の問いに答えが揃ったら、元の会話に1回だけ届ける。書き手は decision、ホップは元のターン＋2、カードは「判断役が決めました」", async () => {
  await withHarness(async (h) => {
    const turnId = await decidedTurn(h);
    h.decisions.beginTurn(h.judgeThreadId, [judgeDelivery(h, turnId)]);
    assert.deepEqual(h.decisions.watching(h.baseId), { id: h.judgeId, name: "判断役" });

    const first = await h.decisions.answer(h.judgeThreadId, { thread: h.baseId, turnId, question: 1, choice: 1, reason: "おすすめに異論が無い" });
    assert.equal(first.ok, true, first.text);
    assert.match(first.text, /預かりました/);
    assert.equal(h.delivered.length, 0, "揃う前に届けた");

    const second = await h.decisions.answer(h.judgeThreadId, { thread: h.baseId, turnId, question: 2, choice: 2, reason: "要らない" });
    assert.equal(second.ok, true, second.text);
    assert.equal(h.delivered.length, 1);
    const d = h.delivered[0]!;
    assert.equal(d.threadId, h.baseId);
    assert.equal(d.kind, "decision");
    assert.equal(d.hop, 2);
    assert.match(d.title, /判断役（自動化「判断役」）が選んだ答え/);
    assert.match(d.text, /案A で。一般を先頭にして/);
    assert.match(d.text, /モックは消して/);
    assert.doesNotMatch(d.text, /案B で/);

    const card = reviewOf(h)!;
    assert.equal(card.judge?.kind, "decided-by-automation");
    assert.deepEqual(card.judge?.answers, [
      { question: 1, choice: 1, label: "案A", reason: "おすすめに異論が無い" },
      { question: 2, choice: 2, label: "消す", reason: "要らない" },
    ]);
    // 決めたターンの記録の位置——元の会話が次のターンへ進んでも、カードはこのターンの中身を出す
    const judgedThread = h.projectThread.getThread(h.baseId)!;
    assert.deepEqual(card.judge?.turn, {
      startedSeq: judgedThread.lastTurn!.startedSeq,
      beforeSeq: judgedThread.messages.at(-1)!.seq + 1,
      outcome: "completed",
    });
    const shown = reviewTurnOf(judgedThread, { running: false, earlier: card.judge!.turn! });
    assert.equal((shown.summary as { decisions?: unknown[] } | undefined)?.decisions?.length, 2);
    assert.equal(h.decisions.watching(h.baseId), undefined);

    // もう片づいている——二度届けない
    const again = await h.decisions.answer(h.judgeThreadId, { thread: h.baseId, turnId, question: 1, choice: 2, reason: "x" });
    assert.equal(again.ok, false);
    assert.equal(h.delivered.length, 1);

    // 判断役の答えで進んだ次のターンのカードは、前のカードの決めを引き継ぐ
    const next = await h.inbox.raiseReview({ threadId: h.baseId, summary: "次のターン" });
    assert.equal(next.carriedJudge?.kind, "decided-by-automation");
    assert.equal(next.judge, undefined);
    // その次のカードまでは引き継がない
    const third = await h.inbox.raiseReview({ threadId: h.baseId, summary: "その次" });
    assert.equal(third.carriedJudge, undefined);
  });
});

test("1問でも人に任せたら、何も届けずにカードに理由を添える", async () => {
  await withHarness(async (h) => {
    const turnId = await decidedTurn(h);
    h.decisions.beginTurn(h.judgeThreadId, [judgeDelivery(h, turnId)]);
    await h.decisions.answer(h.judgeThreadId, { thread: h.baseId, turnId, question: 1, choice: 1, reason: "よい" });
    const deferred = await h.decisions.answer(h.judgeThreadId, { thread: h.baseId, turnId, question: 2, defer: true, reason: "取り消せない操作" });
    assert.equal(deferred.ok, true, deferred.text);
    assert.equal(h.delivered.length, 0);
    assert.equal(reviewOf(h)!.judge?.kind, "deferred");
    assert.equal(reviewOf(h)!.judge?.reason, "取り消せない操作");
    const after = await h.decisions.answer(h.judgeThreadId, { thread: h.baseId, turnId, question: 2, choice: 1, reason: "やっぱり" });
    assert.equal(after.ok, false);
    assert.equal(h.delivered.length, 0);
  });
});

test("人が先に答えた・次のターンが走っている・並んでいるなら断り、何も届けない", async () => {
  await withHarness(async (h) => {
    const turnId = await decidedTurn(h);
    const thread = () => h.projectThread.getThread(h.baseId)!;
    h.turns.running.add(h.baseId);
    assert.equal(movedOnReason(thread(), turnId, { isRunning: (id) => h.turns.running.has(id), queued: () => 0 }), "その会話でいまターンが走っています");
    h.turns.running.clear();
    assert.equal(movedOnReason(thread(), turnId, { isRunning: () => false, queued: () => 1 }), "その会話で人の発言が順番を待っています");

    // 人がまとめの後に送った
    await h.projectThread.appendMessage(h.baseId, "user", "案B で");
    h.decisions.beginTurn(h.judgeThreadId, [judgeDelivery(h, turnId)]);
    const r = await h.decisions.answer(h.judgeThreadId, { thread: h.baseId, turnId, question: 1, choice: 1, reason: "x" });
    assert.equal(r.ok, false);
    assert.match(r.text, /人がもう答えました/);
    assert.equal(h.delivered.length, 0);
    // 片づいたので、判断役のターンが終わっても「揃わなかった」は添えない
    await h.decisions.endTurn(h.judgeThreadId);
    assert.equal(reviewOf(h)!.judge, undefined);
  });
});

test("このターンの届けものに無い会話・判断役でない自動化の届けもの・番号の外は断る", async () => {
  await withHarness(async (h) => {
    const turnId = await decidedTurn(h);
    h.decisions.beginTurn(h.judgeThreadId, [judgeDelivery(h, turnId)]);
    assert.equal((await h.decisions.answer(h.judgeThreadId, { thread: h.baseId, turnId: "other", question: 1, choice: 1, reason: "x" })).ok, false);
    assert.equal((await h.decisions.answer(h.judgeThreadId, { thread: h.baseId, turnId, question: 3, choice: 1, reason: "x" })).ok, false);
    assert.equal((await h.decisions.answer(h.judgeThreadId, { thread: h.baseId, turnId, question: 1, choice: 5, reason: "x" })).ok, false);
    assert.equal((await h.decisions.answer(h.judgeThreadId, { thread: h.baseId, turnId, question: 1, choice: 1, reason: " " })).ok, false);
    // 別の会話からは呼べない（答えられる先はその会話のターンの届けものだけ）
    assert.equal((await h.decisions.answer(h.baseId, { thread: h.baseId, turnId, question: 1, choice: 1, reason: "x" })).ok, false);
    // 外から来たもの（自動化の届けものではない）に紛れた出来事は答える先にしない
    const { kind: _kind, ...untrusted } = judgeDelivery(h, turnId);
    h.decisions.beginTurn(h.judgeThreadId, [untrusted]);
    assert.equal((await h.decisions.answer(h.judgeThreadId, { thread: h.baseId, turnId, question: 1, choice: 1, reason: "x" })).ok, false);
    assert.equal(h.delivered.length, 0);
  });
});

test("揃わないまま判断役のターンが終わったら、全部人に回してカードに n 問中 m 問を添える", async () => {
  await withHarness(async (h) => {
    const turnId = await decidedTurn(h);
    h.decisions.beginTurn(h.judgeThreadId, [judgeDelivery(h, turnId)]);
    await h.decisions.answer(h.judgeThreadId, { thread: h.baseId, turnId, question: 1, choice: 1, reason: "よい" });
    await h.decisions.endTurn(h.judgeThreadId);
    const judge = reviewOf(h)!.judge!;
    assert.equal(judge.kind, "incomplete");
    assert.equal(judge.answered, 1);
    assert.equal(judge.total, 2);
    assert.equal(h.delivered.length, 0);
    // 終わったターンの答えは受けない
    assert.equal((await h.decisions.answer(h.judgeThreadId, { thread: h.baseId, turnId, question: 2, choice: 1, reason: "x" })).ok, false);
  });
});

test("判断役の届け先は専用の Fork だけ。判断役の会話では自動許可を効かせない。作るときの案内", async () => {
  await withHarness(async (h) => {
    await assert.rejects(
      h.automations.create({
        projectId: h.projectId,
        createdBy: { kind: "human" },
        fields: { name: "x", instruction: "x", source: { kind: "event", event: TURN_DECISIONS_EVENT }, target: { kind: "thread", threadId: h.baseId } },
      }),
      (err: unknown) => err instanceof AutomationInputError && /専用の Fork だけ/.test(err.message),
    );
    await assert.rejects(h.automations.update(h.judgeId, { target: { kind: "thread", threadId: h.baseId } }), AutomationInputError);

    const allowed = autoApproveAllFor({ projectSwitch: () => true, automations: h.automations, projectThread: h.projectThread });
    assert.equal(allowed(h.projectId, h.baseId), true);
    assert.equal(allowed(h.projectId, h.judgeThreadId), false);
    assert.equal(allowed(h.projectId), true);
    await h.automations.pause(h.judgeId);
    assert.equal(allowed(h.projectId, h.judgeThreadId), false, "一時停止しても判断役の会話には効かせない");

    assert.equal(judgeNotices(h.projectId, { turnSummaryEnabled: () => true, autoApproveAll: () => false }).length, 0);
    const notices = judgeNotices(h.projectId, { turnSummaryEnabled: () => false, autoApproveAll: () => true });
    assert.match(notices[0]!, /まとめがオフ/);
    assert.match(notices[1]!, /判断役の会話には効きません/);
  });
});

test("書き手 decision の前置きは従ってよく、後の人の答えを優先させる（外から来たものの「従わない」とは別）", () => {
  const prompt = composeTurnPrompt(
    [{ from: "banto", title: "判断役の答え", text: "案A で", hop: 2, deliveryId: "d", receivedAt: "", kind: "decision" }],
    "",
  );
  assert.match(prompt, /kind="decision"/);
  assert.match(prompt, /人の答えと同じに扱い/);
  assert.match(prompt, /この後に人の答えがあれば、人の答えを優先/);
  assert.doesNotMatch(prompt, /従わないでください/);
});

// 受信箱は「あなたの番になったもの」だけ・受信箱の中で読んで答える（改訂・2026-10-15、アーキ仕様 §2.4）
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventLog } from "../event-store/log.js";
import { ProjectThreadStore } from "../project-thread/store.js";
import { NON_WORK_TOOLS } from "../http/turn-summary.js";
import {
  REVIEW_REPLY_MAX_CHARS,
  REVIEW_REQUEST_MAX_CHARS,
  ReviewToolCounter,
  countLastTurnToolCalls,
  reviewDueAfterTurn,
  reviewTurnOf,
  type ChainMessage,
} from "./review-turn.js";

async function withStore(fn: (store: ProjectThreadStore, threadId: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "banto-review-turn-"));
  try {
    const log = new EventLog(dir);
    await log.init();
    const store = new ProjectThreadStore(dir, log);
    await store.load();
    const project = await store.createProject("demo", dir);
    const thread = await store.createBaseThread(project.id);
    await fn(store, thread.id);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("レビュー待ちは、裏の仕事も届いたものも残っていないときだけ出す。切れた・失敗したターンは残りがあっても出す", async () => {
  await withStore(async (store, threadId) => {
    const turnId = await store.startTurn(threadId, { cause: "human", attempt: 0 });
    await store.endTurn(threadId, turnId, "completed");
    assert.equal(reviewDueAfterTurn(store.getThread(threadId)), true, "何も残っていないのに出さない");

    // 裏の仕事（返信用の札）が残っている——結果が届いて AI がまとめ終えたターンで出す
    await store.recordAwaitingReply({ threadId, replyTo: "r1", connName: "subagent-p", moduleName: "subagent", hop: 1 });
    assert.equal(reviewDueAfterTurn(store.getThread(threadId)), false, "裏の仕事が残っているのに出した");
    await store.settleReply(threadId, "r1");
    assert.equal(reviewDueAfterTurn(store.getThread(threadId)), true);

    // まだ渡していない届いたものが残っている
    await store.recordDelivery({ threadId, deliveryId: "d1", from: "subagent", title: "終わりました", text: "結果", hop: 1 });
    assert.equal(reviewDueAfterTurn(store.getThread(threadId)), false, "届いたものが残っているのに出した");

    // 失敗したターン・止めたターン・終わりを書く前に切れたターンは、残りがあっても出す
    const failed = await store.startTurn(threadId, { cause: "human", attempt: 0 });
    await store.endTurn(threadId, failed, "failed");
    assert.equal(reviewDueAfterTurn(store.getThread(threadId)), true, "失敗したターンを出さない");
    const stopped = await store.startTurn(threadId, { cause: "human", attempt: 0 });
    await store.endTurn(threadId, stopped, "stopped");
    assert.equal(reviewDueAfterTurn(store.getThread(threadId)), true, "止めたターンを出さない");
    await store.startTurn(threadId, { cause: "human", attempt: 0 });
    assert.equal(reviewDueAfterTurn(store.getThread(threadId)), true, "切れたターンを出さない");
  });
});

test("ターンの中身：まとめがあれば request はまとめから、返事はそのターンの AI の発言。結末と tool の数を添える", async () => {
  await withStore(async (store, threadId) => {
    // 前のターン（返事つき）
    const first = await store.startTurn(threadId, { cause: "human", attempt: 0 });
    await store.appendMessage(threadId, "user", "前の頼みごと");
    await store.appendMessage(threadId, "assistant", "前の返事");
    await store.endTurn(threadId, first, "completed");

    const second = await store.startTurn(threadId, { cause: "human", attempt: 0 });
    await store.appendMessage(threadId, "user", "それでお願い");
    await store.appendMessage(threadId, "assistant", "案A と案B を作りました。");
    const summary = {
      request: "アシスタントの発言の見せ方の案を作る",
      outcome: { status: "done", headline: "2案作りました", points: [], artifacts: [{ label: "案A", detail: "mock", url: "https://mock.example.net/a" }] },
      decisions: [],
    };
    await store.recordTurnSummary(threadId, { summary, at: new Date().toISOString() });
    await store.endTurn(threadId, second, "completed");

    const turn = reviewTurnOf(store.getThread(threadId)!, { running: false, toolCalls: 6 });
    assert.equal(turn.request, "アシスタントの発言の見せ方の案を作る", "まとめの request を使っていない");
    assert.equal(turn.reply, "案A と案B を作りました。");
    assert.equal(turn.replyTruncated, undefined);
    assert.deepEqual(turn.summary, summary);
    assert.equal(turn.outcome, "completed");
    assert.equal(turn.toolCalls, 6);
  });
});

test("ターンの中身：外から来たもの（Webhook の本文・別の会話からのメッセージ）を積んだターンだけ readExternal（Backlog #511）", async () => {
  await withStore(async (store, threadId) => {
    const first = await store.startTurn(threadId, { cause: "human", attempt: 0 });
    await store.appendMessage(threadId, "user", "人の頼み");
    await store.appendMessage(threadId, "assistant", "やりました");
    await store.endTurn(threadId, first, "completed");
    assert.equal(reviewTurnOf(store.getThread(threadId)!, { running: false }).readExternal, undefined, "人の発言だけのターンを外から来たとした");

    const second = await store.startTurn(threadId, { cause: "delivery", attempt: 0 });
    await store.appendMessage(threadId, "user", "PR が来た", undefined, {
      from: "banto",
      title: "自動化「PR」",
      hop: 1,
      deliveryId: "d1",
      external: [{ source: "webhook", receivedAt: new Date().toISOString(), body: "PR の本文" }],
    });
    await store.appendMessage(threadId, "assistant", "読みました");
    await store.endTurn(threadId, second, "completed");
    assert.equal(reviewTurnOf(store.getThread(threadId)!, { running: false }).readExternal, true);
    // 前のターンの中身を組むときは、そのターンの範囲だけを見る
    const earlier = store.getThread(threadId)!.messages.find((m) => m.text === "PR が来た")!.seq;
    assert.equal(
      reviewTurnOf(store.getThread(threadId)!, { running: false, earlier: { startedSeq: 0, beforeSeq: earlier } }).readExternal,
      undefined,
      "前のターンに後のターンの届けものを数えた",
    );
  });
});

test("ターンの中身：まとめが無ければ人の最後の発言の頭。長い返事は切って印を付け、返事を書く前に切れたターンは前の返事を出さない", async () => {
  await withStore(async (store, threadId) => {
    const first = await store.startTurn(threadId, { cause: "human", attempt: 0 });
    const longRequest = "あ".repeat(REVIEW_REQUEST_MAX_CHARS + 50);
    await store.appendMessage(threadId, "user", longRequest);
    await store.appendMessage(threadId, "assistant", "い".repeat(REVIEW_REPLY_MAX_CHARS + 1));
    await store.endTurn(threadId, first, "completed");
    const done = reviewTurnOf(store.getThread(threadId)!, { running: false });
    assert.equal(done.request?.length, REVIEW_REQUEST_MAX_CHARS);
    assert.equal(done.reply?.length, REVIEW_REPLY_MAX_CHARS);
    assert.equal(done.replyTruncated, true);
    assert.equal(done.summary, undefined);
    assert.equal(done.toolCalls, undefined, "数えていないのに数を出した");

    // 届いたもので起きたターンが、返事を書く前に切れた（終わりが書かれていない）
    await store.startTurn(threadId, { cause: "delivery", attempt: 0 });
    await store.appendMessage(threadId, "user", "結果です", undefined, { from: "subagent", title: "終わりました", hop: 1, deliveryId: "d1" });
    assert.equal(reviewTurnOf(store.getThread(threadId)!, { running: true }).outcome, undefined, "走っているのに結末を出した");
    const cut = reviewTurnOf(store.getThread(threadId)!, { running: false });
    assert.equal(cut.outcome, "interrupted");
    assert.equal(cut.reply, undefined, "前のターンの返事を出した");
    assert.equal(cut.request, longRequest.slice(0, REVIEW_REQUEST_MAX_CHARS), "届いたものを人の発言として拾った");
  });
});

const user = (text: string): ChainMessage => ({ type: "user", message: { role: "user", content: text } });
const toolResult = (): ChainMessage => ({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "x", content: "ok" }] } });
const assistant = (...tools: string[]): ChainMessage => ({
  type: "assistant",
  message: { role: "assistant", content: [{ type: "text", text: "…" }, ...tools.map((name, i) => ({ type: "tool_use", id: `t${i}`, name, input: {} }))] },
});

test("tool の数は最後の人の発言より後ろだけ。まとめ・決まったことの記録と Stop hook の差し戻しは数えない", () => {
  const chain = [
    user("前の頼み"),
    assistant("Bash"),
    toolResult(),
    user("次の頼み"),
    assistant("Read", "Edit"),
    toolResult(),
    assistant("Bash"),
    toolResult(),
    user("Stop hook feedback:\nまだこのターンのまとめを出していません"),
    assistant("mcp__banto-thread__report_turn", "mcp__banto-memory__remember_decision"),
    toolResult(),
  ];
  assert.equal(countLastTurnToolCalls(chain, NON_WORK_TOOLS), 3);
  assert.equal(countLastTurnToolCalls([], NON_WORK_TOOLS), 0);
});

test("tool の数は resume-point を書いたターンだけ数え、同じ resume-point なら読み直さない", async () => {
  await withStore(async (store, threadId) => {
    let reads = 0;
    const counter = new ReviewToolCounter(async () => {
      reads++;
      return [user("頼み"), assistant("Bash", "Bash")];
    }, NON_WORK_TOOLS);
    const turnId = await store.startTurn(threadId, { cause: "human", attempt: 0 });
    assert.equal(await counter.count(store.getThread(threadId)!, undefined), undefined, "resume-point を書いていないのに数えた");
    await store.updateResumePoint(threadId, "session-1");
    await store.endTurn(threadId, turnId, "completed");
    assert.equal(await counter.count(store.getThread(threadId)!, undefined), 2);
    assert.equal(await counter.count(store.getThread(threadId)!, undefined), 2);
    assert.equal(reads, 1, "同じ resume-point を読み直した");
  });
});

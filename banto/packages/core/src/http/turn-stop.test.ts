// **人がターンを止める**（決定・2026-10-01、ユーザー要望。v4-frontend.md §6.31）。
//
// 停止ボタンを押したら、その瞬間に止まる。AI がまだ何も出していなければ、送った発言ごと取り消して
// 入力欄へ戻せるようにする——記録にも、次のターンの AI の文脈にも残さない。

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventLog } from "../event-store/log.js";
import { ProjectThreadStore } from "../project-thread/store.js";
import { GlobalMemoryStore } from "../global-memory/store.js";
import { InboxStore } from "../inbox/store.js";
import { PendingApprovalRegistry } from "../inbox/pending-approvals.js";
import { runThreadTurn, STOPPED_NOTE, TURN_STOPPED_ANSWER, type TurnStreamEvent } from "./turn-runner.js";
import { TurnEventBus } from "./turn-events.js";
import { TurnStops } from "./turn-stops.js";
import { ThreadTurns } from "../delivery/thread-turns.js";
import type { runTurn, RunnerTurnOptions } from "../runner/adapter.js";

const init = (sessionId: string) => ({ type: "system", subtype: "init", session_id: sessionId, mcp_servers: [] });
const assistant = (text: string, uuid: string) => ({
  type: "assistant",
  uuid,
  message: { content: [{ type: "text", text }] },
});
const result = { type: "result", uuid: "result-uuid" };

/**
 * 差し替え用の Runner。`messages` を流したあと、`hang` なら止められるまで待つ（止められたら終わる。
 * `ignoreAbort` なら止められても終わらない——CLI が止まらないとき）。渡された options を覚える
 */
function scriptedRunner(script: { messages: unknown[]; hang?: boolean; ignoreAbort?: boolean; sessionId?: string }) {
  const seen: { opts?: RunnerTurnOptions; aborted: boolean; reachedHang: Promise<void> } = {
    aborted: false,
    reachedHang: Promise.resolve(),
  };
  let reached!: () => void;
  seen.reachedHang = new Promise((r) => (reached = r));
  const fake = (async function* (opts: RunnerTurnOptions) {
    seen.opts = opts;
    for (const message of script.messages) yield { type: "message" as const, message } as never;
    if (script.hang) {
      reached();
      await new Promise<void>((resolve) => {
        opts.signal?.addEventListener("abort", () => {
          seen.aborted = true;
          if (!script.ignoreAbort) resolve();
        });
      });
      throw new Error("aborted");
    }
    return { sessionId: script.sessionId ?? "session-1", compactionCount: 0 } as never;
  }) as unknown as typeof runTurn;
  return { fake, seen };
}

async function withThread(
  fn: (ctx: { deps: Parameters<typeof runThreadTurn>[0]; threadId: string; store: ProjectThreadStore; inbox: InboxStore }) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "banto-turn-stop-"));
  try {
    const log = new EventLog(dir);
    await log.init();
    const projectThread = new ProjectThreadStore(dir, log);
    await projectThread.load();
    const globalMemory = new GlobalMemoryStore(dir, log);
    await globalMemory.load();
    const inbox = new InboxStore(dir, log);
    await inbox.load();
    const project = await projectThread.createProject("demo", dir);
    const thread = await projectThread.createBaseThread(project.id);
    await fn({
      deps: { projectThread, globalMemory, inbox, pendingApprovals: new PendingApprovalRegistry() },
      threadId: thread.id,
      store: projectThread,
      inbox,
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function collect(gen: AsyncGenerator<TurnStreamEvent>): Promise<TurnStreamEvent[]> {
  const out: TurnStreamEvent[] = [];
  for await (const e of gen) out.push(e);
  return out;
}

/** Runner が待ちに入ったら止める。止めてから終わるまでの時間も返す */
async function runAndStop(
  deps: Parameters<typeof runThreadTurn>[0],
  threadId: string,
  prompt: string,
  runner: ReturnType<typeof scriptedRunner>,
): Promise<{ events: TurnStreamEvent[]; afterStopMs: number }> {
  const stop = new AbortController();
  const done = collect(runThreadTurn({ ...deps, runTurn: runner.fake }, { threadId, prompt, modules: [], stop: stop.signal }));
  await runner.seen.reachedHang;
  const at = Date.now();
  stop.abort();
  const events = await done;
  return { events, afterStopMs: Date.now() - at };
}

/** 最後まで走るターン（resume-point と、切る位置を残す） */
async function completeTurn(
  deps: Parameters<typeof runThreadTurn>[0],
  threadId: string,
  prompt: string,
  sessionId: string,
  uuid: string,
) {
  const runner = scriptedRunner({ messages: [init(sessionId), assistant(`${prompt}の返事`, uuid), result], sessionId });
  await collect(runThreadTurn({ ...deps, runTurn: runner.fake }, { threadId, prompt, modules: [] }));
  return runner;
}

test("AI が何も出していないうちに止めたら、すぐ終わり、発言ごと取り消す（最初のターン）", async () => {
  await withThread(async ({ deps, threadId, store }) => {
    const runner = scriptedRunner({ messages: [init("session-1")], hang: true });
    const { events, afterStopMs } = await runAndStop(deps, threadId, "まちがえた依頼", runner);

    const last = events.at(-1);
    assert.deepEqual(last, { type: "stopped", withdrawn: { text: "まちがえた依頼", images: [] } });
    assert.equal(runner.seen.aborted, true, "CLI を止めていない");
    assert.ok(afterStopMs < 1_000, `止めてから終わるまで ${afterStopMs}ms かかった`);
    const thread = store.getThread(threadId)!;
    assert.equal(thread.messages.length, 0, "取り消した発言が記録に残っている");
    assert.equal(thread.resumePoint, undefined, "取り消したターンのセッションを続けようとしている");
    assert.equal(thread.rewindTo, undefined, "新しいセッションなのに切る位置を立てた");
  });
});

test("続きのターンで取り消したら、次のターンは前のターンの最後で切って resume する", async () => {
  await withThread(async ({ deps, threadId, store }) => {
    await completeTurn(deps, threadId, "りんご", "session-1", "uuid-apple");
    assert.equal(store.getThread(threadId)!.resumeAnchor, "uuid-apple");

    const stopped = scriptedRunner({ messages: [init("session-1")], hang: true });
    const { events } = await runAndStop(deps, threadId, "バナナ", stopped);
    assert.equal(events.at(-1)?.type, "stopped");
    assert.ok((events.at(-1) as { withdrawn?: unknown }).withdrawn, "取り消していない");
    let thread = store.getThread(threadId)!;
    assert.deepEqual(
      thread.messages.map((m) => m.text),
      ["りんご", "りんごの返事"],
      "取り消した発言が会話に残っている",
    );
    assert.equal(thread.rewindTo, "uuid-apple");

    const next = await completeTurn(deps, threadId, "ぶどう", "session-2", "uuid-grape");
    assert.equal(next.seen.opts?.resumeSessionId, "session-1");
    assert.equal(next.seen.opts?.resumeSessionAt, "uuid-apple", "取り消した発言の手前で切っていない");
    thread = store.getThread(threadId)!;
    assert.equal(thread.rewindTo, undefined, "切ったあとも切り続けようとしている");
    assert.equal(thread.resumePoint, "session-2");
    assert.equal(thread.resumeAnchor, "uuid-grape");

    const after = await completeTurn(deps, threadId, "もも", "session-2", "uuid-peach");
    assert.equal(after.seen.opts?.resumeSessionAt, undefined, "ふつうのターンまで切っている");
  });
});

test("AI が文を出したあとに止めたら、取り消さず、出た分を「止めました」と一緒に残す", async () => {
  await withThread(async ({ deps, threadId, store }) => {
    await completeTurn(deps, threadId, "りんご", "session-1", "uuid-apple");
    const runner = scriptedRunner({ messages: [init("session-1"), assistant("途中まで", "uuid-half")], hang: true });
    const { events } = await runAndStop(deps, threadId, "長い話", runner);

    assert.deepEqual(events.at(-1), { type: "stopped" });
    const thread = store.getThread(threadId)!;
    assert.deepEqual(thread.messages.slice(-2).map((m) => [m.role, m.text]), [
      ["user", "長い話"],
      ["assistant", `途中まで\n\n${STOPPED_NOTE}`],
    ]);
    assert.equal(thread.resumePoint, "session-1");
    assert.equal(thread.resumeAnchor, undefined, "途中で止めたやり取りを切る位置にしている");
  });
});

test("切る位置を覚えていない会話（この仕組みより前の記録）では、CLI の記録から手前を引いて取り消す", async () => {
  await withThread(async ({ deps, threadId, store }) => {
    await store.updateResumePoint(threadId, "old-session"); // anchor 無し
    const asked: Array<{ sessionId: string; sentPrompt: string }> = [];
    const findRewindPoint = async (sessionId: string, sentPrompt: string) => {
      asked.push({ sessionId, sentPrompt });
      return "uuid-before";
    };
    const runner = scriptedRunner({ messages: [init("old-session")], hang: true });
    const { events } = await runAndStop({ ...deps, findRewindPoint }, threadId, "まちがえた依頼", runner);

    assert.ok((events.at(-1) as { withdrawn?: unknown }).withdrawn, "取り消していない");
    assert.equal(asked[0]?.sessionId, "old-session");
    assert.ok(asked[0]?.sentPrompt.endsWith("まちがえた依頼"), "送った発言の文で探していない");
    assert.equal(store.getThread(threadId)!.messages.length, 0);
    assert.equal(store.getThread(threadId)!.rewindTo, "uuid-before");
  });
});

test("CLI の記録から手前を引けなければ、取り消さずに止めるだけ（何度止めても次で引き直す）", async () => {
  await withThread(async ({ deps, threadId, store }) => {
    await store.updateResumePoint(threadId, "old-session");
    let calls = 0;
    const findRewindPoint = async () => {
      calls += 1;
      throw new Error("読めない");
    };
    const runner = scriptedRunner({ messages: [init("old-session")], hang: true });
    const { events } = await runAndStop({ ...deps, findRewindPoint }, threadId, "まちがえた依頼", runner);
    assert.deepEqual(events.at(-1), { type: "stopped" });
    assert.deepEqual(store.getThread(threadId)!.messages.map((m) => [m.role, m.text]), [
      ["user", "まちがえた依頼"],
      ["assistant", STOPPED_NOTE],
    ]);
    const again = scriptedRunner({ messages: [init("old-session")], hang: true });
    await runAndStop({ ...deps, findRewindPoint }, threadId, "もう一度", again);
    assert.equal(calls, 2, "止めたあとの次のターンで引き直していない");
  });
});

test("CLI が止まらなくても、止めたターンは待ち切らずに終わる", async () => {
  await withThread(async ({ deps, threadId }) => {
    const runner = scriptedRunner({ messages: [init("session-1")], hang: true, ignoreAbort: true });
    const { events, afterStopMs } = await runAndStop(deps, threadId, "まちがえた依頼", runner);
    assert.equal(events.at(-1)?.type, "stopped");
    assert.ok(afterStopMs < 5_000, `止めてから終わるまで ${afterStopMs}ms かかった`);
  });
});

test("始まる前に止められていたら、何も記録せずに取り消す", async () => {
  await withThread(async ({ deps, threadId, store }) => {
    const runner = scriptedRunner({ messages: [init("session-1"), assistant("返事", "u")] });
    const stop = new AbortController();
    stop.abort();
    const events = await collect(
      runThreadTurn({ ...deps, runTurn: runner.fake }, { threadId, prompt: "やっぱりなし", modules: [], stop: stop.signal }),
    );
    assert.deepEqual(events, [{ type: "stopped", withdrawn: { text: "やっぱりなし", images: [] } }]);
    assert.equal(runner.seen.opts, undefined, "止められていたのに CLI を起こした");
    assert.equal(store.getThread(threadId)!.messages.length, 0);
  });
});

test("止めたら、そのターンが出した判断待ちは畳む", async () => {
  await withThread(async ({ deps, threadId, inbox }) => {
    const approvals: Array<{ behavior: string }> = [];
    const fake = (async function* (opts: RunnerTurnOptions) {
      yield { type: "message" as const, message: init("session-1") } as never;
      yield {
        type: "approval_requested" as const,
        pending: { toolCallId: "t1", toolName: "mcp__shell__runCommand", input: {}, resolve: (r: { behavior: string }) => approvals.push(r) },
      } as never;
      await new Promise<void>((resolve) => opts.signal?.addEventListener("abort", () => resolve()));
      throw new Error("aborted");
    }) as unknown as typeof runTurn;
    const stop = new AbortController();
    const done = collect(runThreadTurn({ ...deps, runTurn: fake }, { threadId, prompt: "消して", modules: [], stop: stop.signal }));
    // 判断待ちが立つまで待つ
    for (let i = 0; i < 50 && inbox.listOpen().length === 0; i++) await new Promise((r) => setTimeout(r, 10));
    assert.equal(inbox.listOpen().length, 1);
    stop.abort();
    await done;
    assert.equal(inbox.listOpen().length, 0, "止めたのに判断待ちが受信箱に残っている");
    assert.deepEqual(approvals.map((a) => a.behavior), ["deny"]);
  });
});

test("順番を待っている発言は、名前で止めると列を抜け、走っているターンは止めない", async () => {
  const turns = new ThreadTurns();
  const stops = new TurnStops();
  const running = turns.tryAcquire("t1", 0)!;
  const runningStop = stops.open("t1");
  runningStop.markRunning();

  const queued = stops.open("t1", "turn-b");
  const acquiring = turns.acquire("t1", 0, queued.signal);
  const outcome = stops.stop("t1", "turn-b");
  assert.equal(await acquiring, undefined, "止めたのに鍵を待ち続けている");
  queued.markStopped({ text: "後から送った", images: [] });
  queued.finish();
  assert.deepEqual(await outcome, { stopped: true, withdrawn: { text: "後から送った", images: [] } });
  assert.equal(runningStop.signal.aborted, false, "走っているほうまで止めた");

  // 走っているほうが終わっても、抜けた発言には鍵が渡らない
  running();
  assert.equal(turns.isRunning("t1"), false);
  runningStop.finish();
});

test("止めるターンが無ければ、止めなかったと答える", async () => {
  const stops = new TurnStops();
  assert.deepEqual(await stops.stop("nothing"), { stopped: false });
});

test("Fork でも、最初のターン・続きのターンのどちらで止めても発言を取り消す", async () => {
  await withThread(async ({ deps, threadId, store }) => {
    await completeTurn(deps, threadId, "りんご", "base-1", "uuid-apple");
    const fork = await store.forkThread(threadId);

    // Fork の最初のターン（親のセッションから枝を分ける）
    const first = scriptedRunner({ messages: [init("fork-x")], hang: true });
    const a = await runAndStop(deps, fork.id, "まちがえた1", first);
    assert.ok((a.events.at(-1) as { withdrawn?: unknown }).withdrawn, `最初のターンで取り消していない: ${JSON.stringify(a.events.at(-1))}`);

    // 最後まで走らせて、Fork 自身のセッションにする
    await completeTurn(deps, fork.id, "ぶどう", "fork-1", "uuid-grape");
    assert.equal(store.getThread(fork.id)!.ownsSession, true);
    assert.equal(store.getThread(fork.id)!.resumeAnchor, "uuid-grape");

    // Fork の続きのターン
    const second = scriptedRunner({ messages: [init("fork-1")], hang: true });
    const b = await runAndStop(deps, fork.id, "まちがえた2", second);
    assert.ok((b.events.at(-1) as { withdrawn?: unknown }).withdrawn, `続きのターンで取り消していない: ${JSON.stringify(b.events.at(-1))}`);
    assert.equal(store.getThread(fork.id)!.rewindTo, "uuid-grape");
  });
});

// **止めても、中継の承認のカードは会話に残る**（追加・2026-10-05、ユーザー決定「止めたことを忘れそうなので残してほしい」）。
// 記録には判断待ちの id だけを残し、止めたら CLI を止めるより先に「止めた」で畳む——先に CLI を止めると、聞いた呼び出しが
// 終わったとして別の理由で畳まれる
test("止めたら、中継の承認は CLI を止めるより先に「止めた」で畳み、カードの id は会話の記録に残る", async () => {
  await withThread(async ({ deps, threadId, inbox, store }) => {
    const turnEvents = new TurnEventBus();
    let answeredBeforeAbort: string | undefined;
    let judgmentId = "";
    let reached!: () => void;
    const hanging = new Promise<void>((r) => (reached = r));
    const fake = (async function* (opts: RunnerTurnOptions) {
      yield { type: "message" as const, message: init("session-1") } as never;
      yield {
        type: "message" as const,
        message: { type: "assistant", uuid: "u1", message: { content: [{ type: "tool_use", id: "tu1", name: "mcp__backlog__createItem", input: {} }] } },
      } as never;
      reached();
      await new Promise<void>((resolve) =>
        opts.signal?.addEventListener("abort", () => {
          // CLI が止められた瞬間に、判断待ちがもう「止めた」で畳まれているか
          const item = inbox.get(judgmentId) as { liveness?: string; answer?: { message?: string } } | undefined;
          answeredBeforeAbort = item?.liveness === "answered" ? item.answer?.message : undefined;
          resolve();
        }),
      );
      throw new Error("aborted");
    }) as unknown as typeof runTurn;
    const stop = new AbortController();
    const done = collect(
      runThreadTurn({ ...deps, turnEvents, runTurn: fake }, { threadId, prompt: "足して", modules: [], stop: stop.signal }),
    );
    await hanging;
    // 中継の承認が立った（host のゲートと同じ形：受信箱に立て、ターンの外から流す）
    const judgment = await inbox.raiseJudgment({ threadId, source: "relay", message: "Module 間の呼び出しの確認：backlog が repositories の fetch_branch を呼ぼうとしています", serverName: "backlog", toolInput: { 呼び出し元: "backlog", 宛先: "repositories" } });
    judgmentId = judgment.id;
    turnEvents.publish(threadId, { type: "judgment", judgmentId: judgment.id, kind: "approval", serverName: "backlog", message: judgment.message } as never);
    for (let i = 0; i < 50 && !store.getThread(threadId)!.messages.some((m) => m.judgmentIds?.includes(judgment.id)); i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    stop.abort();
    await done;

    assert.equal(answeredBeforeAbort, TURN_STOPPED_ANSWER, "CLI を止めるより先に「止めた」で畳んでいない");
    const messages = store.getThread(threadId)!.messages;
    const ai = messages.filter((m) => m.role === "assistant");
    assert.equal(ai.length, 1, "1ターンの AI の発言が1つにまとまっていない");
    assert.deepEqual(ai[0]!.judgmentIds, [judgment.id], "カードの id が会話の記録に残っていない");
    assert.equal(ai[0]!.text, STOPPED_NOTE, "止めた印と同じ発言にまとまっていない");
  });
});

test("中継の承認でない判断待ち（ターンの外から来たもの）は、カードの id を記録に残さない", async () => {
  await withThread(async ({ deps, threadId, inbox, store }) => {
    const turnEvents = new TurnEventBus();
    const runner = scriptedRunner({ messages: [init("session-1")], hang: true });
    const stop = new AbortController();
    const done = collect(runThreadTurn({ ...deps, turnEvents, runTurn: runner.fake }, { threadId, prompt: "送って", modules: [], stop: stop.signal }));
    await runner.seen.reachedHang;
    const judgment = await inbox.raiseJudgment({ threadId, source: "message", message: "Project をまたぐメッセージの確認" });
    turnEvents.publish(threadId, { type: "judgment", judgmentId: judgment.id, kind: "approval", message: judgment.message } as never);
    await new Promise((r) => setTimeout(r, 50));
    stop.abort();
    await done;
    assert.equal(store.getThread(threadId)!.messages.some((m) => m.judgmentIds !== undefined), false);
  });
});

// **AI の発言を、書き終えるごとに記録する**（追加・2026-10-05、アーキ仕様 §2.5「起こし直しをまたいで続ける」の
// 「書き終えた発言ごとに記録する」）。
//
// 以前は AI の返事をターンの最後にまとめて1回だけ書いていた——途中で host が落ちると、AI が何を言ったかが1つも
// 残らない。記録（Event Store）には書き終えた発言ごとに足し、会話の1件（＝画面の吹き出し1つ）はターンごとにまとめる。

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
import {
  INTERRUPTED_NOTE,
  noteInterruptedTurn,
  runThreadTurn,
  STOPPED_NOTE,
  type TurnStreamEvent,
  type UiToolBinding,
} from "./turn-runner.js";
import { TurnEventBus } from "./turn-events.js";
import type { runTurn, RunnerTurnOptions } from "../runner/adapter.js";

const init = (sessionId: string) => ({ type: "system", subtype: "init", session_id: sessionId, mcp_servers: [] });
const say = (text: string, uuid: string) => ({ type: "assistant", uuid, message: { content: [{ type: "text", text }] } });
const callTool = (id: string, name: string, uuid: string, text?: string) => ({
  type: "assistant",
  uuid,
  message: {
    content: [...(text ? [{ type: "text", text }] : []), { type: "tool_use", id, name, input: { path: "a.md" } }],
  },
});
const toolResult = (id: string, content: string, uuid: string) => ({
  type: "user",
  uuid,
  message: { content: [{ type: "tool_result", tool_use_id: id, content }] },
});
const thinking = (uuid: string) => ({ type: "assistant", uuid, message: { content: [{ type: "thinking", thinking: "…" }] } });

const UI_TOOLS: UiToolBinding[] = [{ toolName: "mcp__viewer__open", server: "viewer", resourceUri: "ui://viewer/open" }];

/** 台本どおりに流す Runner。台本の `"pause"` で止まり、`resume()` で続ける（止められたら投げて終わる） */
function pausingRunner(script: Array<unknown | "pause">, sessionId = "session-1") {
  let resume!: () => void;
  let paused!: () => void;
  const state = {
    reachedPause: new Promise<void>((r) => (paused = r)),
    resume: () => resume(),
  };
  const fake = (async function* (opts: RunnerTurnOptions) {
    for (const step of script) {
      if (step === "pause") {
        await new Promise<void>((resolve, reject) => {
          resume = resolve;
          opts.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
          paused();
        });
        continue;
      }
      yield { type: "message" as const, message: step } as never;
    }
    return { sessionId, compactionCount: 0 } as never;
  }) as unknown as typeof runTurn;
  return { fake, state };
}

async function withThread(
  fn: (ctx: {
    deps: Parameters<typeof runThreadTurn>[0];
    threadId: string;
    store: ProjectThreadStore;
    dir: string;
  }) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "banto-turn-replies-"));
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
      dir,
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

/** 同じ置き場を、起動し直したように開き直す（ログだけから畳む） */
async function reopenStore(dir: string): Promise<ProjectThreadStore> {
  const log = new EventLog(dir);
  await log.init();
  const store = new ProjectThreadStore(dir, log);
  await store.load();
  return store;
}

/** その Thread に書いた AI の発言（記録の1件ずつ。会話の1件にまとめる前） */
async function assistantAppends(dir: string, threadId: string): Promise<Array<{ text: string; uiToolCalls?: unknown[] }>> {
  const log = new EventLog(dir);
  await log.init();
  const out: Array<{ text: string; uiToolCalls?: unknown[] }> = [];
  for await (const e of log.readFrom(0)) {
    const p = e.payload as { threadId?: string; role?: string; text: string; uiToolCalls?: unknown[] };
    if (e.type === "message.appended" && p.threadId === threadId && p.role === "assistant") {
      out.push({ text: p.text, ...(p.uiToolCalls ? { uiToolCalls: p.uiToolCalls } : {}) });
    }
  }
  return out;
}

const view = (store: ProjectThreadStore, threadId: string) =>
  store.getThread(threadId)!.messages.map((m) => [m.role, m.text, (m.uiToolCalls ?? []).length]);

test("AI の発言は書き終えるごとに記録に入り、会話ではターンごとに1件にまとまる", async () => {
  await withThread(async ({ deps, threadId, store, dir }) => {
    const runner = pausingRunner([init("session-1"), say("まず見ます", "u1"), "pause", say("終わりました", "u2")]);
    const done = collect(runThreadTurn({ ...deps, runTurn: runner.fake }, { threadId, prompt: "見て", modules: [] }));
    await runner.state.reachedPause;
    // 走っている途中：書き終えた1つめがもう記録にある（host がここで止まっても残る）
    assert.deepEqual(view(store, threadId), [
      ["user", "見て", 0],
      ["assistant", "まず見ます", 0],
    ]);
    assert.deepEqual(view(await reopenStore(dir), threadId), view(store, threadId), "書き終えた発言が記録（ログ）に無い");

    runner.state.resume();
    const events = await done;
    assert.equal(events.at(-1)?.type, "done");
    // ターンの最後にまとめて書き直さない（二重にしない）——記録は発言ごとに1件ずつ、会話は1件
    assert.deepEqual(await assistantAppends(dir, threadId), [{ text: "まず見ます" }, { text: "終わりました" }]);
    assert.deepEqual(view(store, threadId), [
      ["user", "見て", 0],
      ["assistant", "まず見ます\n\n終わりました", 0],
    ]);
    assert.equal(store.getThread(threadId)!.resumePoint, "session-1");

    // 次のターンの返事は、前のターンの吹き出しにまとめない
    const next = pausingRunner([init("session-1"), say("次の返事", "u3")]);
    await collect(runThreadTurn({ ...deps, runTurn: next.fake }, { threadId, prompt: "次", modules: [] }));
    assert.deepEqual(view(store, threadId).slice(2), [
      ["user", "次", 0],
      ["assistant", "次の返事", 0],
    ]);
  });
});

test("画面つきの tool の呼び出しは、結果が揃ってから書く（画面を持たない tool は書かない）", async () => {
  await withThread(async ({ deps, threadId, store, dir }) => {
    const runner = pausingRunner([
      init("session-1"),
      callTool("t1", "mcp__viewer__open", "u1", "開きます"),
      "pause",
      toolResult("t1", "開いた", "u2"),
      callTool("t2", "mcp__shell__run", "u3"),
      toolResult("t2", "済み", "u4"),
      say("開きました", "u5"),
    ]);
    const done = collect(
      runThreadTurn({ ...deps, runTurn: runner.fake }, { threadId, prompt: "開いて", modules: [], uiTools: UI_TOOLS }),
    );
    await runner.state.reachedPause;
    // 文は書き終えた時点で入る。呼び出しは結果がまだ無いので書かない
    assert.deepEqual(view(store, threadId).at(-1), ["assistant", "開きます", 0]);

    runner.state.resume();
    await done;
    const reply = store.getThread(threadId)!.messages.at(-1)!;
    assert.equal(reply.text, "開きます\n\n開きました");
    assert.deepEqual(reply.uiToolCalls, [
      { toolCallId: "t1", toolName: "mcp__viewer__open", server: "viewer", resourceUri: "ui://viewer/open", args: { path: "a.md" }, result: "開いた" },
    ]);
    assert.deepEqual((await assistantAppends(dir, threadId)).map((a) => [a.text, a.uiToolCalls?.length ?? 0]), [
      ["開きます", 0],
      ["", 1],
      ["開きました", 0],
    ]);
  });
});

test("結果が来ないまま終わった画面つきの呼び出しも、ターンの終わりに書く（黙って落とさない）", async () => {
  await withThread(async ({ deps, threadId, store }) => {
    const runner = pausingRunner([init("session-1"), callTool("t1", "mcp__viewer__open", "u1"), say("返事", "u2")]);
    await collect(runThreadTurn({ ...deps, runTurn: runner.fake }, { threadId, prompt: "開いて", modules: [], uiTools: UI_TOOLS }));
    const reply = store.getThread(threadId)!.messages.at(-1)!;
    assert.equal(reply.text, "返事");
    assert.deepEqual(reply.uiToolCalls?.map((c) => [c.toolCallId, c.result]), [["t1", undefined]]);
  });
});

test("途中で host が止まっても書き終えた発言は残り、起こし直しで切れた印をその吹き出しの最後に足せる", async () => {
  await withThread(async ({ deps, threadId, dir }) => {
    const runner = pausingRunner([init("session-1"), say("半分まで", "u1"), "pause", say("残り", "u2")]);
    void collect(runThreadTurn({ ...deps, runTurn: runner.fake }, { threadId, prompt: "長い仕事", modules: [] }));
    await runner.state.reachedPause;

    // host がここで止まった——ログから起き直す
    const reopened = await reopenStore(dir);
    const [cut] = reopened.listInterruptedTurns();
    assert.ok(cut, "切れたターンが見つからない");
    await noteInterruptedTurn(reopened, cut);
    assert.deepEqual(view(reopened, threadId), [
      ["user", "長い仕事", 0],
      ["assistant", `半分まで\n\n${INTERRUPTED_NOTE}`, 0],
    ]);
    // 印を足しても「切れた」ままに見える（続けるかを決めるのは続ける処理）
    assert.equal(reopened.listInterruptedTurns().length, 1);

    // もう最後のターンでないものには付けない（後のターンの吹き出しに付く）
    await assert.rejects(noteInterruptedTurn(reopened, { threadId, turnId: "another-turn" }), /最後のターンは/);
  });
});

test("AI が何も言わないうちに切れたターンは、印だけの吹き出しになる", async () => {
  await withThread(async ({ deps, threadId, dir }) => {
    const runner = pausingRunner([init("session-1"), "pause"]);
    void collect(runThreadTurn({ ...deps, runTurn: runner.fake }, { threadId, prompt: "長い仕事", modules: [] }));
    await runner.state.reachedPause;
    const reopened = await reopenStore(dir);
    await noteInterruptedTurn(reopened, reopened.listInterruptedTurns()[0]!);
    assert.deepEqual(view(reopened, threadId), [
      ["user", "長い仕事", 0],
      ["assistant", INTERRUPTED_NOTE, 0],
    ]);
  });
});

test("止めたら、まだ書いていない残りだけを「止めました」と一緒に書く（書いた発言を二重にしない）", async () => {
  await withThread(async ({ deps, threadId, store, dir }) => {
    const runner = pausingRunner([
      init("session-1"),
      say("一つめ", "u1"),
      callTool("t1", "mcp__viewer__open", "u2", "二つめ"),
      "pause",
    ]);
    const stop = new AbortController();
    const done = collect(
      runThreadTurn({ ...deps, runTurn: runner.fake }, { threadId, prompt: "やって", modules: [], uiTools: UI_TOOLS, stop: stop.signal }),
    );
    await runner.state.reachedPause;
    stop.abort();
    assert.deepEqual((await done).at(-1), { type: "stopped" });

    assert.deepEqual((await assistantAppends(dir, threadId)).map((a) => [a.text, a.uiToolCalls?.length ?? 0]), [
      ["一つめ", 0],
      ["二つめ", 0],
      [STOPPED_NOTE, 1],
    ]);
    const reply = store.getThread(threadId)!.messages.at(-1)!;
    assert.equal(reply.text, `一つめ\n\n二つめ\n\n${STOPPED_NOTE}`);
    assert.deepEqual(reply.uiToolCalls?.map((c) => [c.toolCallId, c.result]), [["t1", undefined]]);
    assert.equal(store.getThread(threadId)!.messages.length, 2);
  });
});

test("考えただけで止めたら発言ごと取り消す——AI の発言は記録に1つも書いていない", async () => {
  await withThread(async ({ deps, threadId, store, dir }) => {
    const runner = pausingRunner([init("session-1"), thinking("u1"), say("", "u2"), "pause"]);
    const stop = new AbortController();
    const done = collect(runThreadTurn({ ...deps, runTurn: runner.fake }, { threadId, prompt: "まちがい", modules: [], stop: stop.signal }));
    await runner.state.reachedPause;
    stop.abort();
    assert.deepEqual((await done).at(-1), { type: "stopped", withdrawn: { text: "まちがい", images: [] } });
    assert.deepEqual(await assistantAppends(dir, threadId), [], "取り消したのに AI の発言が記録に残っている");
    assert.equal(store.getThread(threadId)!.messages.length, 0);
  });
});

test("最初のターンの返事から Fork を分けると、そのターンの会話から続く（返事は resume-point より前に記録される）", async () => {
  await withThread(async ({ deps, threadId, store }) => {
    const runner = pausingRunner([init("session-1"), say("りんごの話", "u1"), say("続き", "u2")]);
    await collect(runThreadTurn({ ...deps, runTurn: runner.fake }, { threadId, prompt: "りんご", modules: [] }));
    const reply = store.getThread(threadId)!.messages.at(-1)!;
    assert.equal(reply.role, "assistant");

    const fork = await store.forkThread(threadId, { fromSeq: reply.seq });
    assert.equal(fork.resumePoint, "session-1", "返事から分けたのに、そのターンの会話を引き継いでいない");
    assert.deepEqual(fork.messages.map((m) => m.text), ["りんご", "りんごの話\n\n続き"]);

    // 次のターン（同じ会話）の返事から分けても同じ会話。Clear のあとの返事は新しい会話
    const second = pausingRunner([init("session-1"), say("ぶどうの話", "u3")]);
    await collect(runThreadTurn({ ...deps, runTurn: second.fake }, { threadId, prompt: "ぶどう", modules: [] }));
    await store.clearThread(threadId);
    const third = pausingRunner([init("session-2"), say("ももの話", "u4")], "session-2");
    await collect(runThreadTurn({ ...deps, runTurn: third.fake }, { threadId, prompt: "もも", modules: [] }));
    const replies = store.getThread(threadId)!.messages.filter((m) => m.role === "assistant");
    assert.deepEqual(
      await Promise.all(replies.map(async (m) => (await store.forkThread(threadId, { fromSeq: m.seq })).resumePoint)),
      ["session-1", "session-1", "session-2"],
    );
  });
});

test("走っているターンの流し直しは、始まりの seq（記録との境界）を持つ", async () => {
  await withThread(async ({ deps, threadId, store }) => {
    const turnEvents = new TurnEventBus();
    const runner = pausingRunner([init("session-1"), say("途中", "u1"), "pause"]);
    const done = collect(runThreadTurn({ ...deps, turnEvents, runTurn: runner.fake }, { threadId, prompt: "やって", modules: [] }));
    await runner.state.reachedPause;
    const startedSeq = store.getThread(threadId)!.lastTurn!.startedSeq;
    assert.equal(turnEvents.snapshot(threadId)?.startedSeq, startedSeq);
    // このターンの AI の発言は、境界より後ろに入っている（画面は流し直す分としてこれを外す）
    const reply = store.getThread(threadId)!.messages.at(-1)!;
    assert.equal(reply.role, "assistant");
    assert.ok(reply.seq > startedSeq);
    runner.state.resume();
    await done;
  });
});

test("前のターンの吹き出しには足さない——発言を1つも積まないうちに切れたターンの印も、別の吹き出しになる", async () => {
  await withThread(async ({ deps, threadId, store }) => {
    const runner = pausingRunner([init("session-1"), say("前の返事", "u1")]);
    await collect(runThreadTurn({ ...deps, runTurn: runner.fake }, { threadId, prompt: "前", modules: [] }));
    // 始まりを書いたが、発言を積む前に切れたターン（直前の1件は前のターンの AI の発言）
    const turnId = await store.startTurn(threadId, { cause: "delivery", attempt: 0, resumePoint: "session-1" });
    await noteInterruptedTurn(store, { threadId, turnId });
    assert.deepEqual(view(store, threadId), [
      ["user", "前", 0],
      ["assistant", "前の返事", 0],
      ["assistant", INTERRUPTED_NOTE, 0],
    ]);
  });
});

test("tool を呼んだあとに止めたら取り消さない——画面を持たない tool でも（呼んだことは記録に無くても、何か起きている）", async () => {
  await withThread(async ({ deps, threadId, store }) => {
    const runner = pausingRunner([init("session-1"), callTool("t1", "mcp__shell__run", "u1"), "pause"]);
    const stop = new AbortController();
    const done = collect(
      runThreadTurn({ ...deps, runTurn: runner.fake }, { threadId, prompt: "消して", modules: [], uiTools: UI_TOOLS, stop: stop.signal }),
    );
    await runner.state.reachedPause;
    stop.abort();
    assert.deepEqual((await done).at(-1), { type: "stopped" }, "tool を呼んだのに発言ごと取り消した");
    assert.deepEqual(view(store, threadId), [
      ["user", "消して", 0],
      ["assistant", STOPPED_NOTE, 0],
    ]);
  });
});

test("失敗したターンでも、結果の来ていない画面つきの呼び出しは書く", async () => {
  await withThread(async ({ deps, threadId, store }) => {
    const fake = (async function* () {
      yield { type: "message" as const, message: init("session-1") } as never;
      yield { type: "message" as const, message: callTool("t1", "mcp__viewer__open", "u1", "開きます") } as never;
      throw new Error("API が落ちた");
    }) as unknown as typeof runTurn;
    const events = await collect(runThreadTurn({ ...deps, runTurn: fake }, { threadId, prompt: "開いて", modules: [], uiTools: UI_TOOLS }));
    assert.equal(events.at(-1)?.type, "error");
    const reply = store.getThread(threadId)!.messages.at(-1)!;
    assert.equal(reply.text, "開きます");
    assert.deepEqual(reply.uiToolCalls?.map((c) => [c.toolCallId, c.result]), [["t1", undefined]]);
  });
});

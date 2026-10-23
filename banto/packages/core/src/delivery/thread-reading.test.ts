// 管理対象 Project の Thread を読む（アーキ仕様 §4.6「読む——Thread 全体を、人が見るのと同じ範囲で」）
//
// 確かめること：メタ Project の専用 Fork から、対応する管理対象 Project の Thread の発言・tool 呼び出しと結果・承認待ちの
// カード・区切りが読める。範囲の外（ほかの Project・読める Project の決まっていない Thread）は読めず、tool も見せない。
// 読んでも何も変わらない（承認待ちは承認待ちのまま）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventLog } from "../event-store/log.js";
import { InboxStore } from "../inbox/store.js";
import { ProjectThreadStore } from "../project-thread/store.js";
import type { TurnStreamEvent } from "../http/turn-runner.js";
import { createForkMcpServer, READ_THREAD_TOOL_NAME } from "../http/fork-tool.js";
import { READ_THREAD_VALUE_MAX_CHARS, ThreadReading, type ReadThreadView } from "./thread-reading.js";

interface Ctx {
  store: ProjectThreadStore;
  inbox: InboxStore;
  reading: ThreadReading;
  /** メタ Project の Base と、管理対象 Project（app）の専用 Fork */
  meta: { base: string; appFork: string };
  /** 管理対象の Project */
  app: { projectId: string; base: string };
  /** 管理対象でない Project */
  other: { base: string };
  live: Map<string, { events: TurnStreamEvent[]; startedAt: string }>;
}

async function setup(fn: (ctx: Ctx) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "banto-thread-reading-test-"));
  try {
    const log = new EventLog(dir);
    await log.init();
    const store = new ProjectThreadStore(dir, log);
    await store.load();
    const inbox = new InboxStore(dir, log);
    await inbox.load();
    const pm = await store.createProject("meta", dir);
    const metaBase = await store.createBaseThread(pm.id);
    const appFork = await store.forkThread(metaBase.id, { title: "app 担当" });
    const pa = await store.createProject("app", dir);
    const appBase = await store.createBaseThread(pa.id);
    const po = await store.createProject("other", dir);
    const otherBase = await store.createBaseThread(po.id);
    const live = new Map<string, { events: TurnStreamEvent[]; startedAt: string }>();
    // 専用 Fork（app 担当）だけが app を読める。Base はどこも読めない
    const reading = new ThreadReading({
      projectThread: store,
      inbox,
      readableProjectOf: (threadId) => (threadId === appFork.id ? pa.id : undefined),
      liveTurn: (threadId) => live.get(threadId),
      isRunning: (threadId) => live.has(threadId),
    });
    await fn({
      store,
      inbox,
      reading,
      meta: { base: metaBase.id, appFork: appFork.id },
      app: { projectId: pa.id, base: appBase.id },
      other: { base: otherBase.id },
      live,
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function view(r: ReturnType<ThreadReading["read"]>): ReadThreadView {
  assert.ok(r.ok, r.ok ? "" : r.text);
  return r.view;
}

type Handler = (args: unknown, extra: unknown) => Promise<{ isError?: boolean; content: Array<{ text: string }> }>;
function registeredTools(server: unknown): Record<string, { handler: Handler }> {
  return (server as { instance: { _registeredTools: Record<string, { handler: Handler }> } }).instance._registeredTools;
}

/** 管理対象 Project の会話：人の発言・画面つき tool を呼んだ AI の発言・承認待ちのカード・届いたもの */
async function fillAppThread(ctx: Ctx): Promise<{ judgmentId: string }> {
  const { store, inbox, app } = ctx;
  await store.appendMessage(app.base, "user", "ログインを直して");
  // 1ターンの中の発言と承認のカード（fold が同じターンの AI の発言1件にまとめる——人の画面と同じ）
  const turnId = await store.startTurn(app.base, { cause: "human", attempt: 0 });
  await store.appendMessage(app.base, "assistant", "原因を調べました。", [
    {
      toolCallId: "tc-1",
      toolName: "mcp__Browser__open",
      server: "Browser",
      resourceUri: "ui://browser/view",
      args: { url: "http://localhost:3000/login" },
      result: { status: 500 },
    },
  ]);
  const judgment = await inbox.raiseJudgment({
    threadId: app.base,
    source: "relay",
    message: "Shell が rm -rf dist を走らせようとしています",
    serverName: "Shell",
    toolInput: { command: "rm -rf dist" },
  });
  await store.recordJudgmentCard(app.base, judgment.id);
  await store.endTurn(app.base, turnId, "completed");
  return { judgmentId: judgment.id };
}

test("専用 Fork から、管理対象 Project の Thread の発言・tool 呼び出しと結果・承認待ちのカードが読める", async () => {
  await setup(async (ctx) => {
    const { judgmentId } = await fillAppThread(ctx);
    const v = view(ctx.reading.read(ctx.meta.appFork, { threadId: ctx.app.base }));
    assert.equal(v.projectName, "app");
    assert.equal(v.label, "Base Thread");
    assert.equal(v.kind, "base");
    assert.equal(v.state, "waitingOnHuman");

    const messages = v.entries.filter((e) => e.type === "message");
    assert.equal(messages.length, 2, "人の発言と AI の発言（承認のカードは同じターンの発言にまとまる）");
    const [human, ai] = messages;
    assert.equal(human!.role, "user");
    assert.equal(human!.text, "ログインを直して");
    assert.equal(human!.from, undefined, "人の発言には届けた印が無い");
    assert.equal(ai!.role, "assistant");
    assert.equal(ai!.text, "原因を調べました。");
    assert.deepEqual(ai!.toolCalls, [
      { id: "tc-1", name: "mcp__Browser__open", input: { url: "http://localhost:3000/login" }, result: { status: 500 } },
    ]);
    assert.deepEqual(ai!.judgments, [
      {
        id: judgmentId,
        message: "Shell が rm -rf dist を走らせようとしています",
        serverName: "Shell",
        toolInput: { command: "rm -rf dist" },
        liveness: "live",
      },
    ]);
    // いま人を待っているカード
    assert.deepEqual(
      v.waitingJudgments.map((j) => j.id),
      [judgmentId],
    );
    assert.equal(v.runningTurn, undefined);
    assert.equal(v.hasOlder, false);
    assert.equal(v.hasNewer, false);
    assert.equal(v.lastSeq, ai!.seq);

    // 読んでも何も変わらない——承認待ちは承認待ちのまま
    const item = ctx.inbox.get(judgmentId);
    assert.equal(item?.kind === "judgment" ? item.liveness : undefined, "live");
  });
});

test("答えのついたカードは答えつきで読め、承認待ちからは外れる", async () => {
  await setup(async (ctx) => {
    const { judgmentId } = await fillAppThread(ctx);
    await ctx.inbox.answerJudgment(judgmentId, { behavior: "deny" });
    const v = view(ctx.reading.read(ctx.meta.appFork, { threadId: ctx.app.base }));
    const ai = v.entries.find((e) => e.type === "message" && e.role === "assistant");
    assert.ok(ai && ai.type === "message");
    assert.equal(ai.judgments?.[0]?.liveness, "answered");
    assert.equal(ai.judgments?.[0]?.answer, "拒否する");
    assert.deepEqual(v.waitingJudgments, []);
    assert.equal(v.state, "idle");
  });
});

test("走っているターンの途中の tool 呼び出しと結果も読める", async () => {
  await setup(async (ctx) => {
    await ctx.store.appendMessage(ctx.app.base, "user", "テストを回して");
    ctx.live.set(ctx.app.base, {
      startedAt: "2026-10-23T00:00:00.000Z",
      events: [
        {
          type: "message",
          message: {
            type: "assistant",
            message: { content: [{ type: "text", text: "回します" }, { type: "tool_use", id: "tu-1", name: "mcp__Shell__run", input: { command: "npm test" } }] },
          },
        },
        {
          type: "message",
          message: { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tu-1", content: "2 failing", is_error: true }] } },
        },
        {
          type: "message",
          message: { type: "assistant", message: { content: [{ type: "tool_use", id: "tu-2", name: "Read", input: { file_path: "a.ts" } }] } },
        },
        { type: "judgment", judgmentId: "j-live", kind: "approval", message: "書いてよいか" },
      ],
    });
    const v = view(ctx.reading.read(ctx.meta.appFork, { threadId: ctx.app.base }));
    assert.equal(v.state, "running");
    assert.deepEqual(v.runningTurn, {
      startedAt: "2026-10-23T00:00:00.000Z",
      toolCalls: [
        { id: "tu-1", name: "mcp__Shell__run", input: { command: "npm test" }, result: "2 failing", isError: true },
        { id: "tu-2", name: "Read", input: { file_path: "a.ts" } },
      ],
      judgmentIds: ["j-live"],
    });
  });
});

test("区切り（Clear）と届いたものの送り元が読め、長い値は切られる", async () => {
  await setup(async (ctx) => {
    await ctx.store.appendMessage(ctx.app.base, "user", "前の話");
    await ctx.store.clearThread(ctx.app.base);
    await ctx.store.appendMessage(ctx.app.base, "user", "メタからの依頼", undefined, {
      from: "meta の app 担当",
      title: "依頼",
      hop: 1,
      deliveryId: "d-1",
      sender: { projectId: "pm", projectName: "meta", threadId: ctx.meta.appFork, threadLabel: "app 担当" },
    });
    await ctx.store.appendMessage(ctx.app.base, "assistant", "了解", [
      { toolCallId: "tc-big", toolName: "mcp__FileSystem__read", server: "FileSystem", resourceUri: "ui://fs", result: "x".repeat(READ_THREAD_VALUE_MAX_CHARS + 10) },
    ]);
    const v = view(ctx.reading.read(ctx.meta.appFork, { threadId: ctx.app.base }));
    assert.deepEqual(
      v.entries.map((e) => e.type),
      ["message", "clear", "message", "message"],
    );
    const delivered = v.entries[2]!;
    assert.ok(delivered.type === "message");
    assert.deepEqual(delivered.from, {
      name: "meta の app 担当",
      title: "依頼",
      sender: { projectName: "meta", threadLabel: "app 担当", threadId: ctx.meta.appFork },
    });
    const big = v.entries[3]!;
    assert.ok(big.type === "message");
    const result = big.toolCalls?.[0]?.result as { truncated: boolean; chars: number; head: string };
    assert.equal(result.truncated, true);
    assert.equal(result.head.length, READ_THREAD_VALUE_MAX_CHARS);
  });
});

test("新しいほうから limit 件、afterSeq で差分、beforeSeq で遡る", async () => {
  await setup(async (ctx) => {
    const seqs: number[] = [];
    for (let i = 0; i < 5; i++) {
      seqs.push(await ctx.store.appendMessage(ctx.app.base, "user", `発言${i}`));
      seqs.push(await ctx.store.appendMessage(ctx.app.base, "assistant", `返事${i}`));
    }
    const texts = (v: ReadThreadView) => v.entries.map((e) => (e.type === "message" ? e.text : e.type));

    const latest = view(ctx.reading.read(ctx.meta.appFork, { threadId: ctx.app.base, limit: 3 }));
    assert.deepEqual(texts(latest), ["返事3", "発言4", "返事4"]);
    assert.equal(latest.hasOlder, true);
    assert.equal(latest.hasNewer, false);

    const older = view(ctx.reading.read(ctx.meta.appFork, { threadId: ctx.app.base, beforeSeq: latest.entries[0]!.seq, limit: 3 }));
    assert.deepEqual(texts(older), ["発言2", "返事2", "発言3"]);
    assert.equal(older.hasOlder, true);
    assert.equal(older.hasNewer, true);

    const diff = view(ctx.reading.read(ctx.meta.appFork, { threadId: ctx.app.base, afterSeq: seqs[6]!, limit: 2 }));
    assert.deepEqual(texts(diff), ["返事3", "発言4"]);
    assert.equal(diff.hasNewer, true);
    const rest = view(ctx.reading.read(ctx.meta.appFork, { threadId: ctx.app.base, afterSeq: diff.lastSeq! }));
    assert.deepEqual(texts(rest), ["返事4"]);
    assert.equal(rest.hasNewer, false);
    // 何も増えていなければ空で、lastSeq は渡した値のまま
    const none = view(ctx.reading.read(ctx.meta.appFork, { threadId: ctx.app.base, afterSeq: rest.lastSeq! }));
    assert.deepEqual(none.entries, []);
    assert.equal(none.lastSeq, rest.lastSeq);

    const both = ctx.reading.read(ctx.meta.appFork, { threadId: ctx.app.base, afterSeq: 1, beforeSeq: 5 });
    assert.equal(both.ok, false);
  });
});

test("範囲の外は読めない：ほかの Project の Thread・自分の Project の Thread・読める Project が決まっていない Thread", async () => {
  await setup(async (ctx) => {
    await ctx.store.appendMessage(ctx.other.base, "user", "秘密の相談");
    await ctx.store.appendMessage(ctx.meta.base, "user", "メタの相談");
    const toOther = ctx.reading.read(ctx.meta.appFork, { threadId: ctx.other.base });
    assert.equal(toOther.ok, false);
    assert.doesNotMatch(toOther.ok ? "" : toOther.text, /秘密/);
    // 無い Thread と同じ答え（ほかの Project の Thread の有無を探らせない）
    const missing = ctx.reading.read(ctx.meta.appFork, { threadId: "no-such-thread" });
    assert.equal(missing.ok ? "" : missing.text.replace("no-such-thread", "X"), toOther.ok ? "" : toOther.text.replace(ctx.other.base, "X"));
    assert.equal(ctx.reading.read(ctx.meta.appFork, { threadId: ctx.meta.base }).ok, false);
    // メタ Project の Base は読める Project が決まっていない
    assert.equal(ctx.reading.scopeOf(ctx.meta.base), undefined);
    assert.equal(ctx.reading.read(ctx.meta.base, { threadId: ctx.app.base }).ok, false);
  });
});

test("read_thread は渡されたときだけ見え、専用 Fork から呼ぶと読める", async () => {
  await setup(async (ctx) => {
    await fillAppThread(ctx);
    // 渡さなければ見せない（ふつうの会話）
    assert.equal(registeredTools(createForkMcpServer(ctx.store, ctx.meta.base, []))[READ_THREAD_TOOL_NAME], undefined);
    // 読むだけの回にも出さない
    const readOnlyTools = registeredTools(
      createForkMcpServer(ctx.store, ctx.meta.appFork, [], undefined, undefined, {}, undefined, undefined, true, undefined, undefined, ctx.reading),
    );
    assert.equal(readOnlyTools[READ_THREAD_TOOL_NAME], undefined);

    const tools = registeredTools(
      createForkMcpServer(ctx.store, ctx.meta.appFork, [], undefined, undefined, {}, undefined, undefined, false, undefined, undefined, ctx.reading),
    );
    const res = await tools[READ_THREAD_TOOL_NAME]!.handler({ threadId: ctx.app.base }, {});
    assert.equal(res.isError, undefined);
    const v = JSON.parse(res.content[0]!.text) as ReadThreadView;
    assert.equal(v.threadId, ctx.app.base);
    assert.ok(v.entries.some((e) => e.type === "message" && e.text === "ログインを直して"));
    assert.equal(v.waitingJudgments.length, 1);

    const refused = await tools[READ_THREAD_TOOL_NAME]!.handler({ threadId: ctx.other.base }, {});
    assert.equal(refused.isError, true);
  });
});

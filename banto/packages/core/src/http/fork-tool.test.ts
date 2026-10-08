// **AI が tool から Fork を立てる**（決定・2026-09-27、アーキ仕様 §2.2「AI が Fork を立てる」）。
//
// 確かめること：tool は予約だけ受け、**親のターンが終わってから**（resume-point と返事を記録したあと）Fork を
// 作る。名前が付き、最初の指示が「届いたもの」として渡って AI が起きる。Fork の中からは断る。途中で終わった
// ターンの予約は立てずに人に知らせる。ターンが終わったらレビュー待ちが出る。

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { EventLog } from "../event-store/log.js";
import { ProjectThreadStore } from "../project-thread/store.js";
import { GlobalMemoryStore } from "../global-memory/store.js";
import { InboxStore } from "../inbox/store.js";
import { PendingApprovalRegistry } from "../inbox/pending-approvals.js";
import { RuntimeConfigStore } from "../config/runtime.js";
import { HostRelayEndpoint, RelayRegistry } from "../relay/host-relay-endpoint.js";
import { AgentRelayEndpoint } from "../relay/agent-relay-endpoint.js";
import { ThreadTurns } from "../delivery/thread-turns.js";
import { ThreadDeliveries } from "../delivery/thread-deliveries.js";
import { createApp } from "./app.js";
import { AppEventBus, type AppEvent } from "./app-events.js";
import {
  CLOSE_FORK_TOOL_NAME,
  composeForkInstruction,
  FORK_SERVER_NAME,
  FORK_TOOL_NAME,
  MAX_FORKS_PER_CALL,
  validateForkRequests,
} from "./fork-tool.js";

type RunnerOpts = {
  prompt: string;
  resumeSessionId?: string;
  forkSession?: boolean;
  mcpServers: Record<string, unknown>;
};

/** Runner に渡った MCP サーバから、Fork を閉じる tool を直接呼ぶ */
async function callCloseTool(opts: RunnerOpts, reason: string) {
  const server = opts.mcpServers[FORK_SERVER_NAME] as {
    instance: { _registeredTools: Record<string, { handler: (args: unknown, extra: unknown) => Promise<unknown> }> };
  };
  return (await server.instance._registeredTools[CLOSE_FORK_TOOL_NAME]!.handler({ reason }, {})) as {
    isError?: boolean;
    content: Array<{ text: string }>;
  };
}

/** Runner に渡った MCP サーバから、Fork の tool を直接呼ぶ（SDK が呼ぶのと同じ handler） */
async function callForkTool(opts: RunnerOpts, forks: Array<{ title: string; instruction: string }>) {
  const server = opts.mcpServers[FORK_SERVER_NAME] as {
    instance: { _registeredTools: Record<string, { handler: (args: unknown, extra: unknown) => Promise<unknown> }> };
  };
  return (await server.instance._registeredTools[FORK_TOOL_NAME]!.handler({ forks }, {})) as {
    isError?: boolean;
    content: Array<{ text: string }>;
  };
}

function init(sessionId: string) {
  return { type: "message" as const, message: { type: "system", subtype: "init", session_id: sessionId, mcp_servers: [] } };
}
function say(text: string) {
  return { type: "message" as const, message: { type: "assistant", message: { content: [{ type: "text", text }] } } };
}

interface Harness {
  base: string;
  headers: Record<string, string>;
  projectThread: ProjectThreadStore;
  inbox: InboxStore;
  turns: ThreadTurns;
  notices: string[];
  /** 画面への知らせ（`AppEventBus`） */
  events: AppEvent[];
}

async function withForkApp(
  runner: (opts: RunnerOpts) => AsyncGenerator<unknown, unknown>,
  fn: (h: Harness) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "banto-fork-tool-"));
  try {
    const log = new EventLog(dir);
    await log.init();
    const projectThread = new ProjectThreadStore(dir, log);
    await projectThread.load();
    const globalMemory = new GlobalMemoryStore(dir, log);
    await globalMemory.load();
    const inbox = new InboxStore(dir, log);
    await inbox.load();
    const runtimeConfig = new RuntimeConfigStore(dir, log);
    await runtimeConfig.load();
    const turns = new ThreadTurns();
    const notices: string[] = [];
    const deliveries = new ThreadDeliveries({
      projectThread,
      turns,
      notify: async (n) => {
        notices.push(n.title);
      },
    });
    // cli.ts と同じ配線：ターンが終わったらレビュー待ち
    turns.onChange((change) => {
      if (change.type === "ended") {
        void inbox.raiseReview({ threadId: change.threadId, summary: "終わった" });
      }
    });
    const token = "test-token";
    const appEvents = new AppEventBus();
    const events: AppEvent[] = [];
    appEvents.subscribe((e) => events.push(e));
    const server = createApp({
      appEvents,
      projectThread,
      globalMemory,
      inbox,
      pendingApprovals: new PendingApprovalRegistry(),
      runtimeConfig,
      relayEndpoint: new HostRelayEndpoint({ registry: new RelayRegistry() }),
      agentRelayEndpoint: new AgentRelayEndpoint(token),
      authToken: token,
      resolveModulesForThread: async () => [],
      dataDir: dir,
      configDir: dir,
      threadTurns: turns,
      deliveries,
      runTurn: runner as unknown as Parameters<typeof createApp>[0]["runTurn"],
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      await fn({
        base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        projectThread,
        inbox,
        turns,
        notices,
        events,
      });
    } finally {
      server.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function waitFor(cond: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.fail(`待ちきれませんでした: ${what}`);
}

/** 親のターンの中から Fork の数を見る（ターンの中では store を直接持っていないので、外から差し込む） */
let forkCount: () => number = () => 0;

test("親のターンが終わってから Fork を立て、名前を付け、最初の指示で起こす——親のこのターンを引き継ぐ", async () => {
  const forkCalls: RunnerOpts[] = [];
  let parentId = "";
  let createdDuringTurn = -1;
  await withForkApp(
    async function* (opts) {
      if (opts.prompt.includes("3つの課題")) {
        yield init("parent-session");
        const r = await callForkTool(opts, [
          { title: "認証", instruction: "ログインの不具合を直す" },
          { title: "画面", instruction: "一覧の並びを直す" },
        ]);
        assert.equal(r.isError, undefined, r.content[0]!.text);
        // **呼んだ時点では立てない**
        createdDuringTurn = forkCount();
        yield say("2つ Fork を立てます");
        return { sessionId: "parent-session", compactionCount: 0 };
      }
      forkCalls.push(opts);
      yield init(`fork-session-${forkCalls.length}`);
      yield say("了解");
      return { sessionId: `fork-session-${forkCalls.length}`, compactionCount: 0 };
    },
    async (h) => {
      const project = await h.projectThread.createProject("demo", "/tmp");
      const base = await h.projectThread.createBaseThread(project.id);
      parentId = base.id;
      forkCount = () => h.projectThread.listThreadsForProject(project.id).filter((t) => t.kind === "fork").length;

      const res = await fetch(`${h.base}/api/threads/${base.id}/messages`, {
        method: "POST",
        headers: h.headers,
        body: JSON.stringify({ prompt: "3つの課題があります" }),
      });
      assert.match(await res.text(), /"type":"done"/);
      assert.equal(createdDuringTurn, 0, "tool を呼んだ時点で Fork ができていた");

      await waitFor(() => forkCalls.length === 2, "2つの Fork の最初のターン");
      const forks = h.projectThread.listThreadsForProject(project.id).filter((t) => t.kind === "fork");
      assert.deepEqual(forks.map((f) => f.title).sort(), ["画面", "認証"]);
      for (const f of forks) assert.equal(f.parentThreadId, parentId);

      // 親のこのターンのセッションから枝を分ける
      for (const call of forkCalls) {
        assert.equal(call.resumeSessionId, "parent-session");
        assert.equal(call.forkSession, true);
      }
      // 最初の指示は届いたものとして渡り、ほかの Fork の担当も添えてある
      const auth = forkCalls.find((c) => c.prompt.includes("Fork「認証」"))!;
      assert.match(auth.prompt, /banto-delivery/);
      assert.match(auth.prompt, /ログインの不具合を直す/);
      assert.match(auth.prompt, /「画面」：一覧の並びを直す/);

      // 受信箱に「届きました」は出さない
      assert.deepEqual(h.notices, []);
      // Fork の会話の記録：届いたものの印つき（人の発言ではない）
      await waitFor(() => !h.turns.isRunning(forks[0]!.id) && !h.turns.isRunning(forks[1]!.id), "Fork のターンの終わり");
      // （親の発言は引き継いでいるので、最後の人の役の発言が Fork に届いたもの）
      const firstMsg = h.projectThread.getThread(forks[0]!.id)!.messages.filter((m) => m.role === "user").at(-1)!;
      assert.equal(firstMsg.origin?.from, "Base Thread");

      // ターンが終わったらレビュー待ち——親も Fork も1件ずつ
      await waitFor(
        () => h.inbox.listOpen().filter((i) => i.kind === "review").length === 3,
        "レビュー待ち3件",
      );
    },
  );
});
test("名前は作るときに一緒に記録する（名前の無い Fork が一覧に見える瞬間を作らない）", async () => {
  const dir = await mkdtemp(join(tmpdir(), "banto-fork-title-"));
  try {
    const log = new EventLog(dir);
    await log.init();
    const store = new ProjectThreadStore(dir, log);
    await store.load();
    const project = await store.createProject("demo", "/tmp");
    const base = await store.createBaseThread(project.id);
    const fork = await store.forkThread(base.id, { title: "認証の修正" });
    assert.equal(fork.title, "認証の修正");
    // 読み直しても残る
    const again = new ProjectThreadStore(dir, log);
    await again.load();
    assert.equal(again.getThread(fork.id)?.title, "認証の修正");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Fork の中からは立てられない（tool は見えるが断る）", async () => {
  await withForkApp(
    async function* (opts) {
      yield init("s");
      const r = await callForkTool(opts, [{ title: "a", instruction: "b" }]);
      assert.equal(r.isError, true);
      assert.match(r.content[0]!.text, /Fork Thread の中からは/);
      yield say("立てられませんでした");
      return { sessionId: "s2", compactionCount: 0 };
    },
    async (h) => {
      const project = await h.projectThread.createProject("demo", "/tmp");
      const base = await h.projectThread.createBaseThread(project.id);
      const fork = await h.projectThread.forkThread(base.id);
      const res = await fetch(`${h.base}/api/threads/${fork.id}/messages`, {
        method: "POST",
        headers: h.headers,
        body: JSON.stringify({ prompt: "Fork を立てて" }),
      });
      assert.match(await res.text(), /"type":"done"/);
      assert.equal(h.projectThread.listThreadsForProject(project.id).length, 2);
    },
  );
});

test("途中で終わったターンの予約は立てず、人に知らせる", async () => {
  await withForkApp(
    async function* (opts) {
      yield init("s");
      await callForkTool(opts, [{ title: "a", instruction: "b" }]);
      throw new Error("CLI が落ちた");
    },
    async (h) => {
      const project = await h.projectThread.createProject("demo", "/tmp");
      const base = await h.projectThread.createBaseThread(project.id);
      const res = await fetch(`${h.base}/api/threads/${base.id}/messages`, {
        method: "POST",
        headers: h.headers,
        body: JSON.stringify({ prompt: "やって" }),
      });
      assert.match(await res.text(), /"type":"error"/);
      assert.equal(h.projectThread.listThreadsForProject(project.id).length, 1, "Fork が立っている");
      const notice = h.inbox.listOpen().find((i) => i.kind === "notice");
      assert.ok(notice && notice.kind === "notice");
      assert.equal(notice.title, "Fork を立てませんでした");
      assert.match(notice.detail, /「a」/);
    },
  );
});

test("予約の確かめ：空・重複・数の上限", async () => {
  const dir = await mkdtemp(join(tmpdir(), "banto-fork-validate-"));
  try {
    const log = new EventLog(dir);
    await log.init();
    const store = new ProjectThreadStore(dir, log);
    await store.load();
    const project = await store.createProject("demo", "/tmp");
    const base = await store.createBaseThread(project.id);
    const f = (title: string, instruction = "x") => ({ title, instruction });
    assert.equal(validateForkRequests(store, base.id, [f("a"), f("b")], 0), undefined);
    assert.match(validateForkRequests(store, base.id, [], 0)!, /1つもありません/);
    assert.match(validateForkRequests(store, base.id, [f(" ")], 0)!, /名前/);
    assert.match(validateForkRequests(store, base.id, [f("a", " ")], 0)!, /最初の指示/);
    assert.match(validateForkRequests(store, base.id, [f("a"), f("a ")], 0)!, /同じ名前/);
    const many = Array.from({ length: MAX_FORKS_PER_CALL }, (_, i) => f(`n${i}`));
    assert.equal(validateForkRequests(store, base.id, many, 0), undefined);
    assert.match(validateForkRequests(store, base.id, many, 1)!, /まで/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("最初の指示：自分の担当と、ほかの Fork の担当", () => {
  const a = { title: "A", instruction: "Aをやる" };
  const b = { title: "B", instruction: "Bをやる" };
  const text = composeForkInstruction(a, [a, b], "Base Thread");
  assert.match(text, /Base Thread の AI が立てた Fork「A」/);
  assert.match(text, /Aをやる/);
  assert.match(text, /「B」：Bをやる/);
  assert.doesNotMatch(text, /「A」：/);
  assert.doesNotMatch(composeForkInstruction(a, [a], "Base Thread"), /ほかの Fork/);
});

test("レビュー待ちは1つの Thread に1件まで。その Thread のものをまとめて「見た」にできる", async () => {
  const dir = await mkdtemp(join(tmpdir(), "banto-review-"));
  try {
    const log = new EventLog(dir);
    await log.init();
    const inbox = new InboxStore(dir, log);
    await inbox.load();
    await inbox.raiseReview({ threadId: "t1", summary: "1回目" });
    await inbox.raiseReview({ threadId: "t1", summary: "2回目" });
    await inbox.raiseReview({ threadId: "t2", summary: "別" });
    const open = inbox.listOpen().filter((i) => i.kind === "review");
    assert.deepEqual(open.map((i) => (i.kind === "review" ? i.summary : "")).sort(), ["2回目", "別"]);
    assert.equal(await inbox.acknowledgeReviewsFor("t1"), 1);
    assert.equal(inbox.listOpen().filter((i) => i.kind === "review").length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---- AI が自分の Fork を閉じる（決定・2026-10-08、アーキ仕様 §2.2「AI が自分の Fork を閉じる」） ----

async function send(h: Harness, threadId: string, prompt: string): Promise<string> {
  const res = await fetch(`${h.base}/api/threads/${threadId}/messages`, {
    method: "POST",
    headers: h.headers,
    body: JSON.stringify({ prompt }),
  });
  return res.text();
}

/** 返事待ちの札を1枚置く（待たない形で頼んだ裏の仕事） */
async function awaitWork(h: Harness, threadId: string, title: string): Promise<void> {
  await h.projectThread.recordAwaitingReply({
    threadId,
    replyTo: `r-${title}`,
    connName: "c",
    moduleName: "subagent",
    hop: 0,
    work: { toolName: "spawnAgent", title },
  });
}

/** ターンの中から Fork の状態を見る（`forkCount` と同じく外から差し込む） */
let closedState: () => string = () => "";

test("Fork で close_fork を呼ぶと、ターンが最後まで終わってから閉じ、by: ai と理由を残して画面に知らせる", async () => {
  let forkId = "";
  let statusDuringTurn = "";
  let reply = "";
  await withForkApp(
    async function* (opts) {
      yield init("s");
      const r = await callCloseTool(opts, "  引き継ぎ先へ\n送り終えた  ");
      assert.equal(r.isError, undefined, r.content[0]!.text);
      reply = r.content[0]!.text;
      // **呼んだ時点では閉じない**——このあとの返事が切れる
      statusDuringTurn = closedState();
      yield say("閉じます");
      return { sessionId: "s2", compactionCount: 0 };
    },
    async (h) => {
      const project = await h.projectThread.createProject("demo", "/tmp");
      const base = await h.projectThread.createBaseThread(project.id);
      const fork = await h.projectThread.forkThread(base.id, { title: "認証" });
      forkId = fork.id;
      closedState = () => h.projectThread.getThread(forkId)!.status;
      assert.match(await send(h, fork.id, "終わったら閉じて"), /"type":"done"/);
      assert.equal(statusDuringTurn, "active", "ターンの途中で閉じていた");
      assert.match(reply, /このターンが終わったら/);
      assert.match(reply, /report_turn/);

      await waitFor(() => h.projectThread.getThread(forkId)!.status === "closed", "Fork が閉じる");
      const t = h.projectThread.getThread(forkId)!;
      assert.equal(t.closedBy, "ai");
      assert.equal(t.closedReason, "引き継ぎ先へ 送り終えた", "理由を1行に丸めていない");
      // 閉じたのはターンの終わりを書いたあと（順番は turn-runner の試験が見る）
      assert.equal(t.lastTurn?.outcome, "completed");
      assert.deepEqual(
        h.events.filter((e) => e.type === "thread.closed"),
        [{ type: "thread.closed", threadId: forkId, projectId: project.id, by: "ai", reason: "引き継ぎ先へ 送り終えた" }],
      );
      // 一覧にも中身にも、誰が閉じたか・理由が出る
      const list = (await (await fetch(`${h.base}/api/projects/${project.id}/threads`, { headers: h.headers })).json()) as Array<{
        id: string;
        closedBy?: string;
        closedReason?: string;
      }>;
      const row = list.find((r) => r.id === forkId)!;
      assert.equal(row.closedBy, "ai");
      assert.equal(row.closedReason, "引き継ぎ先へ 送り終えた");
      const detail = (await (await fetch(`${h.base}/api/threads/${forkId}`, { headers: h.headers })).json()) as {
        closedBy?: string;
        closedReason?: string;
      };
      assert.equal(detail.closedBy, "ai");
      assert.equal(detail.closedReason, "引き継ぎ先へ 送り終えた");
      // 受信箱には知らせない
      assert.equal(h.inbox.listOpen().filter((i) => i.kind === "notice").length, 0);
    },
  );
});
test("Base Thread で close_fork を呼ぶと断る（閉じない）", async () => {
  let r: Awaited<ReturnType<typeof callCloseTool>> | undefined;
  await withForkApp(
    async function* (opts) {
      yield init("s");
      r = await callCloseTool(opts, "終わった");
      yield say("閉じられませんでした");
      return { sessionId: "s2", compactionCount: 0 };
    },
    async (h) => {
      const project = await h.projectThread.createProject("demo", "/tmp");
      const base = await h.projectThread.createBaseThread(project.id);
      assert.match(await send(h, base.id, "閉じて"), /"type":"done"/);
      assert.equal(r?.isError, true);
      assert.match(r!.content[0]!.text, /Base Thread は閉じられません/);
      assert.equal(h.projectThread.getThread(base.id)!.status, "active");
      assert.equal(h.events.filter((e) => e.type === "thread.closed").length, 0);
    },
  );
});

test("その Fork が頼んだ裏の仕事が残っていると断り、残っている仕事の題と Module を返す", async () => {
  let r: Awaited<ReturnType<typeof callCloseTool>> | undefined;
  await withForkApp(
    async function* (opts) {
      yield init("s");
      r = await callCloseTool(opts, "終わった");
      yield say("閉じられませんでした");
      return { sessionId: "s2", compactionCount: 0 };
    },
    async (h) => {
      const project = await h.projectThread.createProject("demo", "/tmp");
      const base = await h.projectThread.createBaseThread(project.id);
      const fork = await h.projectThread.forkThread(base.id);
      await awaitWork(h, fork.id, "ログを集める");
      assert.match(await send(h, fork.id, "閉じて"), /"type":"done"/);
      assert.equal(r?.isError, true);
      assert.match(r!.content[0]!.text, /止めるか、引き継ぎ先へ/);
      assert.match(r!.content[0]!.text, /「ログを集める」（subagent）/);
      // 断ったので、ターンが終わっても閉じない
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.equal(h.projectThread.getThread(fork.id)!.status, "active");
    },
  );
});

test("予約のあとに裏の仕事を頼んだら、ターンが終わっても閉じず、人に知らせる", async () => {
  let forkId = "";
  let store!: ProjectThreadStore;
  await withForkApp(
    async function* (opts) {
      yield init("s");
      const r = await callCloseTool(opts, "終わった");
      assert.equal(r.isError, undefined);
      // 閉じると言ったあとで、待たない形で仕事を頼んだ
      await store.recordAwaitingReply({
        threadId: forkId,
        replyTo: "r1",
        connName: "c",
        moduleName: "shell",
        hop: 0,
        work: { toolName: "runCommand", title: "テストを回す" },
      });
      yield say("閉じます");
      return { sessionId: "s2", compactionCount: 0 };
    },
    async (h) => {
      store = h.projectThread;
      const project = await h.projectThread.createProject("demo", "/tmp");
      const base = await h.projectThread.createBaseThread(project.id);
      forkId = (await h.projectThread.forkThread(base.id)).id;
      assert.match(await send(h, forkId, "閉じて"), /"type":"done"/);
      await waitFor(() => h.inbox.listOpen().some((i) => i.kind === "notice"), "閉じなかったお知らせ");
      const notice = h.inbox.listOpen().find((i) => i.kind === "notice");
      assert.ok(notice && notice.kind === "notice");
      assert.equal(notice.title, "Fork を閉じませんでした");
      assert.match(notice.detail, /「テストを回す」（shell）/);
      assert.equal(h.projectThread.getThread(forkId)!.status, "active");
      assert.equal(h.events.filter((e) => e.type === "thread.closed").length, 0);
    },
  );
});

test("途中で終わったターンでは閉じず、「閉じるのをやめました」を人に知らせる", async () => {
  await withForkApp(
    async function* (opts) {
      yield init("s");
      await callCloseTool(opts, "終わった");
      throw new Error("CLI が落ちた");
    },
    async (h) => {
      const project = await h.projectThread.createProject("demo", "/tmp");
      const base = await h.projectThread.createBaseThread(project.id);
      const fork = await h.projectThread.forkThread(base.id);
      assert.match(await send(h, fork.id, "閉じて"), /"type":"error"/);
      await waitFor(() => h.inbox.listOpen().some((i) => i.kind === "notice"), "やめたお知らせ");
      const notice = h.inbox.listOpen().find((i) => i.kind === "notice");
      assert.ok(notice && notice.kind === "notice");
      assert.equal(notice.title, "Fork を閉じるのをやめました");
      assert.match(notice.detail, /終わった/);
      assert.equal(h.projectThread.getThread(fork.id)!.status, "active");
    },
  );
});

test("人が POST /close で閉じても、画面に thread.closed（by: human）を出し、記録に残す", async () => {
  await withForkApp(
    async function* () {
      yield init("s");
      return { sessionId: "s", compactionCount: 0 };
    },
    async (h) => {
      const project = await h.projectThread.createProject("demo", "/tmp");
      const base = await h.projectThread.createBaseThread(project.id);
      const fork = await h.projectThread.forkThread(base.id);
      const res = await fetch(`${h.base}/api/threads/${fork.id}/close`, { method: "POST", headers: h.headers });
      assert.equal(res.status, 200);
      assert.equal(h.projectThread.getThread(fork.id)!.closedBy, "human");
      assert.deepEqual(
        h.events.filter((e) => e.type === "thread.closed"),
        [{ type: "thread.closed", threadId: fork.id, projectId: project.id, by: "human" }],
      );
    },
  );
});

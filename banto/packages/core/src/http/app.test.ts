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
import { HostRelayEndpoint, RelayRegistry } from "../relay/host-relay-endpoint.js";
import { AgentRelayEndpoint } from "../relay/agent-relay-endpoint.js";
import { PendingApprovalRegistry } from "../inbox/pending-approvals.js";
import { RuntimeConfigStore } from "../config/runtime.js";
import { ThreadTurns } from "../delivery/thread-turns.js";
import { AppEventBus } from "./app-events.js";
import { TurnEventBus } from "./turn-events.js";
import { ModuleCallTracker } from "../relay/module-calls.js";
import type { ActivityReport } from "./activity.js";
import { createApp, resolvePermissionMode, DEFAULT_PERMISSION_MODE } from "./app.js";

interface TestDeps {
  inbox: InboxStore;
  pendingApprovals: PendingApprovalRegistry;
  projectThread: ProjectThreadStore;
  runtimeConfig: RuntimeConfigStore;
}

async function withApp(
  fn: (base: string, token: string, dir: string, deps: TestDeps) => Promise<void>,
  /** 試験だけの差し替え（Runner を偽物にする等）。 */
  extra?: Partial<Parameters<typeof createApp>[0]>,
) {
  const dir = await mkdtemp(join(tmpdir(), "banto-app-test-"));
  try {
    const log = new EventLog(dir);
    await log.init();
    const projectThread = new ProjectThreadStore(dir, log);
    await projectThread.load();
    const globalMemory = new GlobalMemoryStore(dir, log);
    await globalMemory.load();
    const inbox = new InboxStore(dir, log);
    await inbox.load();
    const relayEndpoint = new HostRelayEndpoint({ registry: new RelayRegistry() });
    const token = "test-token";
    const agentRelayEndpoint = new AgentRelayEndpoint(token);

    const pendingApprovals = new PendingApprovalRegistry();
    const runtimeConfig = new RuntimeConfigStore(dir, log);
    await runtimeConfig.load();
    const server = createApp({
      projectThread,
      globalMemory,
      inbox,
      pendingApprovals,
      runtimeConfig,
      relayEndpoint,
      agentRelayEndpoint,
      authToken: token,
      resolveModulesForThread: async () => [],
      dataDir: dir,
      configDir: dir,
      ...extra,
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    try {
      await fn(`http://127.0.0.1:${port}`, token, dir, { inbox, pendingApprovals, projectThread, runtimeConfig });
    } finally {
      server.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("rejects requests without the bearer token", async () => {
  await withApp(async (base) => {
    const res = await fetch(`${base}/api/projects`);
    assert.equal(res.status, 401);
  });
});

test("full REST round-trip: create project, create thread, list, inbox", async () => {
  await withApp(async (base, token, dir) => {
    const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };

    const createRes = await fetch(`${base}/api/projects`, {
      method: "POST",
      headers,
      body: JSON.stringify({ name: "demo", root: dir }),
    });
    assert.equal(createRes.status, 201);
    const project = await createRes.json();
    assert.equal(project.name, "demo");

    const listRes = await fetch(`${base}/api/projects`, { headers });
    const projects = await listRes.json();
    assert.equal(projects.length, 1);

    const threadRes = await fetch(`${base}/api/projects/${project.id}/threads`, {
      method: "POST",
      headers,
    });
    assert.equal(threadRes.status, 201);
    const thread = await threadRes.json();
    assert.equal(thread.projectId, project.id);

    const getThreadRes = await fetch(`${base}/api/threads/${thread.id}`, { headers });
    assert.equal(getThreadRes.status, 200);

    const inboxRes = await fetch(`${base}/api/inbox`, { headers });
    assert.deepEqual(await inboxRes.json(), []);
  });
});

test("POST /api/threads/:id/fork creates a fork thread with the parent as base", async () => {
  await withApp(async (base, token, dir) => {
    const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };

    const project = await (
      await fetch(`${base}/api/projects`, { method: "POST", headers, body: JSON.stringify({ name: "demo", root: dir }) })
    ).json();
    const thread = await (
      await fetch(`${base}/api/projects/${project.id}/threads`, { method: "POST", headers })
    ).json();

    const forkRes = await fetch(`${base}/api/threads/${thread.id}/fork`, { method: "POST", headers });
    assert.equal(forkRes.status, 201);
    const fork = await forkRes.json();
    assert.equal(fork.kind, "fork");
    assert.equal(fork.parentThreadId, thread.id);

    const missingRes = await fetch(`${base}/api/threads/does-not-exist/fork`, { method: "POST", headers });
    assert.equal(missingRes.status, 404);
  });
});

test("POST /api/threads/:id/fork は名前と「まっさらで始める」を作るときに受ける（v4-frontend.md §6.32）", async () => {
  await withApp(async (base, token, dir) => {
    const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
    const project = await (
      await fetch(`${base}/api/projects`, { method: "POST", headers, body: JSON.stringify({ name: "demo", root: dir }) })
    ).json();
    const thread = await (
      await fetch(`${base}/api/projects/${project.id}/threads`, { method: "POST", headers })
    ).json();
    const fork = (body: unknown) =>
      fetch(`${base}/api/threads/${thread.id}/fork`, { method: "POST", headers, body: JSON.stringify(body) });

    const named = await fork({ title: "  調べる  " });
    assert.equal(named.status, 201);
    assert.equal((await named.json()).title, "調べる");

    // 空白だけの名前は「付けていない」——連番は画面が出す
    const blank = await fork({ title: "   ", fresh: true });
    assert.equal(blank.status, 201);
    const blankFork = await blank.json();
    assert.equal(blankFork.title, undefined);
    assert.equal(blankFork.kind, "fork");

    assert.equal((await fork({ title: 3 })).status, 400);
    assert.equal((await fork({ fresh: "yes" })).status, 400);
    assert.equal((await fork({ fresh: true, fromSeq: 1 })).status, 400);
  });
});

test("GET /api/events は繋いだ時点で走っている Thread を hello に載せる（v4-frontend.md §6.33）", async () => {
  const threadTurns = new ThreadTurns();
  await withApp(
    async (base, token, _dir, deps) => {
      const project = await deps.projectThread.createProject("P", "/tmp");
      const thread = await deps.projectThread.createBaseThread(project.id);
      const helloOf = async () => {
        const controller = new AbortController();
        const res = await fetch(`${base}/api/events`, {
          headers: { authorization: `Bearer ${token}` },
          signal: controller.signal,
        });
        const reader = res.body!.getReader();
        let text = "";
        while (!text.includes("\n\n")) text += new TextDecoder().decode((await reader.read()).value);
        controller.abort();
        return JSON.parse(text.slice(text.indexOf("data: ") + 6, text.indexOf("\n\n")));
      };

      assert.deepEqual(await helloOf(), { type: "hello", running: [] });
      const release = threadTurns.tryAcquire(thread.id, 0)!;
      assert.deepEqual(await helloOf(), { type: "hello", running: [{ threadId: thread.id, projectId: project.id }] });
      release();
      assert.deepEqual(await helloOf(), { type: "hello", running: [] });
    },
    { threadTurns, appEvents: new AppEventBus() },
  );
});

test("404 for unknown thread", async () => {
  await withApp(async (base, token) => {
    const res = await fetch(`${base}/api/threads/does-not-exist`, {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(res.status, 404);
  });
});

test("thread close/reopen round-trips over HTTP, 404 for unknown thread", async () => {
  await withApp(async (base, token, dir) => {
    const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
    const project = await (
      await fetch(`${base}/api/projects`, { method: "POST", headers, body: JSON.stringify({ name: "demo", root: dir }) })
    ).json();
    const thread = await (
      await fetch(`${base}/api/projects/${project.id}/threads`, { method: "POST", headers })
    ).json();

    const closeRes = await fetch(`${base}/api/threads/${thread.id}/close`, { method: "POST", headers });
    assert.equal(closeRes.status, 200);
    assert.equal((await (await fetch(`${base}/api/threads/${thread.id}`, { headers })).json()).status, "closed");

    const reopenRes = await fetch(`${base}/api/threads/${thread.id}/reopen`, { method: "POST", headers });
    assert.equal(reopenRes.status, 200);
    assert.equal((await (await fetch(`${base}/api/threads/${thread.id}`, { headers })).json()).status, "active");

    assert.equal((await fetch(`${base}/api/threads/does-not-exist/close`, { method: "POST", headers })).status, 404);
    assert.equal((await fetch(`${base}/api/threads/does-not-exist/reopen`, { method: "POST", headers })).status, 404);
  });
});

test("project close/reopen round-trips over HTTP, 404 for unknown project", async () => {
  await withApp(async (base, token, dir) => {
    const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
    const project = await (
      await fetch(`${base}/api/projects`, { method: "POST", headers, body: JSON.stringify({ name: "demo", root: dir }) })
    ).json();

    const closeRes = await fetch(`${base}/api/projects/${project.id}/close`, { method: "POST", headers });
    assert.equal(closeRes.status, 200);
    const afterClose = (await (await fetch(`${base}/api/projects`, { headers })).json()) as Array<{ id: string; status: string }>;
    assert.equal(afterClose.find((p) => p.id === project.id)?.status, "closed");

    const reopenRes = await fetch(`${base}/api/projects/${project.id}/reopen`, { method: "POST", headers });
    assert.equal(reopenRes.status, 200);
    const afterReopen = (await (await fetch(`${base}/api/projects`, { headers })).json()) as Array<{ id: string; status: string }>;
    assert.equal(afterReopen.find((p) => p.id === project.id)?.status, "active");

    assert.equal((await fetch(`${base}/api/projects/does-not-exist/close`, { method: "POST", headers })).status, 404);
    assert.equal((await fetch(`${base}/api/projects/does-not-exist/reopen`, { method: "POST", headers })).status, 404);
  });
});

// Global Memory（§2.2、決定・2026-09-05）。Project Memoryと同じ規律
// （追記のみ・無効化イベント・上限で400）を、banto全体の入口で確かめる。
test("global memory append/invalidate round-trips over HTTP, 400 over the char limit", async () => {
  await withApp(async (base, token) => {
    const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };

    assert.deepEqual(await (await fetch(`${base}/api/global/memory`, { headers })).json(), []);

    const appendRes = await fetch(`${base}/api/global/memory`, {
      method: "POST",
      headers,
      body: JSON.stringify({ text: "人の名前は たくみ" }),
    });
    assert.equal(appendRes.status, 201);

    const listed = await (await fetch(`${base}/api/global/memory`, { headers })).json();
    assert.equal(listed.length, 1);
    assert.equal(listed[0].text, "人の名前は たくみ");
    assert.equal(listed[0].invalidated, false);

    const invalidateRes = await fetch(`${base}/api/global/memory/${listed[0].seq}/invalidate`, {
      method: "POST",
      headers,
    });
    assert.equal(invalidateRes.status, 200);
    const afterInvalidate = await (await fetch(`${base}/api/global/memory`, { headers })).json();
    assert.equal(afterInvalidate[0].invalidated, true, "物理削除ではなく無効化（規則3）");

    const overLimitRes = await fetch(`${base}/api/global/memory`, {
      method: "POST",
      headers,
      body: JSON.stringify({ text: "x".repeat(20_001) }),
    });
    assert.equal(overLimitRes.status, 400);
  });
});

// MemoryはProjectが持つ（§1.1・§2.2、決定・2026-09-05）——入口もProject配下。
test("memory append/invalidate round-trips over HTTP, 400 over the char limit, 404 for unknown project", async () => {
  await withApp(async (base, token, dir) => {
    const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
    const project = await (
      await fetch(`${base}/api/projects`, { method: "POST", headers, body: JSON.stringify({ name: "demo", root: dir }) })
    ).json();

    const appendRes = await fetch(`${base}/api/projects/${project.id}/memory`, {
      method: "POST",
      headers,
      body: JSON.stringify({ text: "決定事項" }),
    });
    assert.equal(appendRes.status, 201);

    const afterAppend = await (await fetch(`${base}/api/projects/${project.id}/memory`, { headers })).json();
    assert.equal(afterAppend.length, 1);
    assert.equal(afterAppend[0].text, "決定事項");
    assert.equal(afterAppend[0].invalidated, false);
    const seq = afterAppend[0].seq;

    const invalidateRes = await fetch(`${base}/api/projects/${project.id}/memory/${seq}/invalidate`, {
      method: "POST",
      headers,
    });
    assert.equal(invalidateRes.status, 200);
    const afterInvalidate = await (await fetch(`${base}/api/projects/${project.id}/memory`, { headers })).json();
    assert.equal(afterInvalidate[0].invalidated, true);

    const overLimitRes = await fetch(`${base}/api/projects/${project.id}/memory`, {
      method: "POST",
      headers,
      body: JSON.stringify({ text: "x".repeat(20_001) }),
    });
    assert.equal(overLimitRes.status, 400);

    assert.equal(
      (await fetch(`${base}/api/projects/does-not-exist/memory`, { method: "POST", headers, body: JSON.stringify({ text: "x" }) }))
        .status,
      404,
    );
  });
});

// --- 見直し（2026-09-06）で見つかった穴の回帰 ---
// docs/notes/2026-09-06-tool-approval-review.md

test("答えられない承認には409を返す——200で握りつぶさない（規則2）", async () => {
  await withApp(async (base, token, _dir, deps) => {
    const h = { authorization: `Bearer ${token}`, "content-type": "application/json" };
    const project = await (
      await fetch(`${base}/api/projects`, {
        method: "POST",
        headers: h,
        body: JSON.stringify({ name: "P", root: "/tmp" }),
      })
    ).json();
    const thread = await (
      await fetch(`${base}/api/projects/${project.id}/threads`, { method: "POST", headers: h })
    ).json();
    const threadId = thread.id;

    // 存在しない判断待ち
    const missing = await fetch(`${base}/api/inbox/does-not-exist/answer`, {
      method: "POST",
      headers: h,
      body: JSON.stringify({ answer: { behavior: "allow" } }),
    });
    assert.equal(missing.status, 404);

    // 解決先が無い判断待ち（host再起動後の幽霊、Elicitation由来もこれ）
    const judgment = await deps.inbox.raiseJudgment({
      threadId,
      source: "text",
      message: "tool呼び出しの承認: test",
    });
    const res = await fetch(`${base}/api/inbox/${judgment.id}/answer`, {
      method: "POST",
      headers: h,
      body: JSON.stringify({ answer: { behavior: "allow" } }),
    });
    assert.equal(res.status, 409, "解決先が無いのに200を返してはいけない");
    const body = await res.json();
    assert.equal(body.reason, "unresolvable");

    // 決着していないままであること——「答えた」という嘘の記録を残さない
    const open = await (await fetch(`${base}/api/inbox`, { headers: h })).json();
    assert.ok(open.some((i: { id: string }) => i.id === judgment.id));
  });
});

test("承認の答えの形を検証する——不正な値をSDKへ流さない", async () => {
  await withApp(async (base, token, _dir, deps) => {
    const h = { authorization: `Bearer ${token}`, "content-type": "application/json" };
    const project = await (
      await fetch(`${base}/api/projects`, {
        method: "POST",
        headers: h,
        body: JSON.stringify({ name: "P", root: "/tmp" }),
      })
    ).json();
    const thread = await (
      await fetch(`${base}/api/projects/${project.id}/threads`, { method: "POST", headers: h })
    ).json();
    const judgment = await deps.inbox.raiseJudgment({
      threadId: thread.id,
      source: "text",
      message: "tool呼び出しの承認: test",
    });
    // 解決先を登録しておく——形の検証は「解決できるかどうか」より前に効くべき
    deps.pendingApprovals.register(judgment.id, () => {});

    for (const answer of ["はい", { behavior: "maybe" }, {}, null]) {
      const res = await fetch(`${base}/api/inbox/${judgment.id}/answer`, {
        method: "POST",
        headers: h,
        body: JSON.stringify({ answer }),
      });
      assert.equal(res.status, 400, `不正な答えを受け入れてはいけない: ${JSON.stringify(answer)}`);
    }
  });
});

// **どこで答えても、そのターンの流れに載る**（決定・2026-09-26、ユーザー要望「戻ったら最新の状況を」）。
// 流れはターンの外から中へ（side）入り、ターンが流すので、繋ぎ直した画面が流し直しても「回答済み」が出る
test("判断待ちに答えると、その答えが走っているターンの流れに載る（許可も拒否も、画面に出す言葉で）", async () => {
  const turnEvents = new TurnEventBus();
  await withApp(
    async (base, token, _dir, deps) => {
      const h = { authorization: `Bearer ${token}`, "content-type": "application/json" };
      const project = await deps.projectThread.createProject("P", "/tmp");
      const thread = await deps.projectThread.createBaseThread(project.id);
      const seen: unknown[] = [];
      turnEvents.subscribeSide(thread.id, (event) => seen.push(event));

      for (const [answer, label] of [
        [{ behavior: "allow" }, "許可する"],
        [{ behavior: "deny", message: "今はやめて" }, "今はやめて"],
      ] as const) {
        const judgment = await deps.inbox.raiseJudgment({ threadId: thread.id, source: "text", message: "承認: t" });
        deps.pendingApprovals.register(judgment.id, () => {});
        const res = await fetch(`${base}/api/inbox/${judgment.id}/answer`, {
          method: "POST",
          headers: h,
          body: JSON.stringify({ answer }),
        });
        assert.equal(res.status, 200);
        assert.deepEqual(seen.at(-1), { type: "answered", judgmentId: judgment.id, answer: label });
      }
    },
    { turnEvents },
  );
});

// **鍵を取ってから走り始めるまでの間に、繋ぎ直しに来た画面を帰さない**（決定・2026-09-26、実測）。
// `turn.started` の知らせは鍵を取った時点で出るが、走り始めるのは Module を起こしてから（数秒）。その間に
// idle と答えると、画面はそのターンを見逃したままになっていた
test("走り始める前のターンに繋ぎに来たら、走り始めるまで待って流す／走らずに鍵が返れば idle", async () => {
  const turnEvents = new TurnEventBus();
  const threadTurns = new ThreadTurns();
  await withApp(
    async (base, token, _dir, deps) => {
      const project = await deps.projectThread.createProject("P", "/tmp");
      const thread = await deps.projectThread.createBaseThread(project.id);
      const read = () =>
        fetch(`${base}/api/threads/${thread.id}/stream`, { headers: { authorization: `Bearer ${token}` } }).then((r) => r.text());

      // 鍵は取られたが、まだ走っていない——少しして走り始め、終わる
      const release = threadTurns.tryAcquire(thread.id, 0)!;
      const body = read();
      await new Promise((r) => setTimeout(r, 100));
      turnEvents.begin(thread.id, "2026-09-26T00:00:00.000Z");
      // 本物のターンは、走り始めてから中身を出すまでに必ず手番をまたぐ（Skill を決める・記録に書く）
      await new Promise((r) => setTimeout(r, 50));
      turnEvents.record(thread.id, { type: "message", message: { type: "assistant", marker: "途中" } });
      turnEvents.record(thread.id, { type: "done", compactionCount: 0 });
      turnEvents.end(thread.id);
      release();
      const text = await body;
      assert.match(text, /"type":"attached"/, "走り始めるのを待たずに idle と答えた");
      assert.match(text, /"marker":"途中"/);
      assert.match(text, /"type":"done"/);

      // 鍵は取られたが、走らずに返された（始める前に失敗した等）——idle で閉じる（待ち続けない）
      const release2 = threadTurns.tryAcquire(thread.id, 0)!;
      const body2 = read();
      await new Promise((r) => setTimeout(r, 100));
      release2();
      assert.match(await body2, /"type":"idle"/);

      // 鍵も取られていない——すぐ idle
      assert.match(await read(), /"type":"idle"/);
    },
    { turnEvents, threadTurns },
  );
});

// **いま動いているもの**（決定・2026-09-28）——再起動の頃合いを計る口。ターン・返事待ちの札・Module の呼び出しを数え、
// 人の返事を待って止まっているだけのターンは見分けられる
test("GET /api/admin/activity は動いているものを数え、人の返事待ちだけかを見分ける", async () => {
  const threadTurns = new ThreadTurns();
  const moduleCalls = new ModuleCallTracker();
  await withApp(
    async (base, token, _dir, deps) => {
      const read = async () => {
        const res = await fetch(`${base}/api/admin/activity`, { headers: { authorization: `Bearer ${token}` } });
        assert.equal(res.status, 200);
        return (await res.json()) as ActivityReport;
      };
      assert.equal((await fetch(`${base}/api/admin/activity`)).status, 401, "合言葉なしでは見せない");

      const project = await deps.projectThread.createProject("P", "/tmp");
      const thread = await deps.projectThread.createBaseThread(project.id);
      let a = await read();
      assert.equal(a.idle, true);
      assert.equal(a.onlyWaitingOnHuman, false);

      // ターンが走り、その中で Module を呼んでいる
      const release = threadTurns.tryAcquire(thread.id, 0)!;
      const endCall = moduleCalls.begin(`shell-${project.id}`, thread.id, "turn", project.id);
      a = await read();
      assert.equal(a.idle, false);
      assert.equal(a.onlyWaitingOnHuman, false);
      assert.equal(a.turns.length, 1);
      assert.equal(a.turns[0]!.projectName, "P");
      assert.equal(a.turns[0]!.waitingOnHuman, false);
      assert.equal(a.moduleCalls[0]!.connName, `shell-${project.id}`);

      // 承認を待って止まった
      const judgment = await deps.inbox.raiseJudgment({ threadId: thread.id, source: "text", message: "承認" });
      a = await read();
      assert.equal(a.turns[0]!.waitingOnHuman, true);
      assert.equal(a.onlyWaitingOnHuman, true);

      await deps.inbox.answerJudgment(judgment.id, { behavior: "allow" });
      endCall();
      release();
      assert.equal((await read()).idle, true);

      // 待たない形で頼んだ仕事の返事待ち——再起動すると「途中で終わりました」になるので数える
      await deps.projectThread.recordAwaitingReply({
        threadId: thread.id,
        replyTo: "r1",
        connName: `subagent-${project.id}`,
        moduleName: "subagent",
        hop: 1,
      });
      a = await read();
      assert.equal(a.idle, false);
      assert.equal(a.onlyWaitingOnHuman, false);
      assert.equal(a.awaitingReplies[0]!.module, "subagent");
      await deps.projectThread.settleReply(thread.id, "r1");
      assert.equal((await read()).idle, true);
    },
    { threadTurns, moduleCalls },
  );
});

test("permissionModeは6値だけ受け付ける", async () => {
  await withApp(async (base, token) => {
    const h = { authorization: `Bearer ${token}`, "content-type": "application/json" };
    const project = await (
      await fetch(`${base}/api/projects`, {
        method: "POST",
        headers: h,
        body: JSON.stringify({ name: "P", root: "/tmp" }),
      })
    ).json();
    const created = await (
      await fetch(`${base}/api/projects/${project.id}/threads`, { method: "POST", headers: h })
    ).json();
    const threadId = created.id;

    const ok = await fetch(`${base}/api/threads/${threadId}/permission-mode`, {
      method: "POST",
      headers: h,
      body: JSON.stringify({ mode: "default" }),
    });
    assert.equal(ok.status, 204);
    const thread = await (await fetch(`${base}/api/threads/${threadId}`, { headers: h })).json();
    assert.equal(thread.permissionMode, "default");

    const bad = await fetch(`${base}/api/threads/${threadId}/permission-mode`, {
      method: "POST",
      headers: h,
      body: JSON.stringify({ mode: "らくらくモード" }),
    });
    assert.equal(bad.status, 400, "型の嘘をEvent Storeへ永続化してはいけない");
  });
});

test("ターンは host が持つ permissionMode で走る——ボディに無くてもautoへ落ちない", async () => {
  await withApp(async (base, token, _dir, deps) => {
    const h = { authorization: `Bearer ${token}`, "content-type": "application/json" };
    const project = await (
      await fetch(`${base}/api/projects`, {
        method: "POST",
        headers: h,
        body: JSON.stringify({ name: "P", root: "/tmp" }),
      })
    ).json();
    const base_ = await (
      await fetch(`${base}/api/projects/${project.id}/threads`, { method: "POST", headers: h })
    ).json();

    await fetch(`${base}/api/threads/${base_.id}/permission-mode`, {
      method: "POST",
      headers: h,
      body: JSON.stringify({ mode: "default" }),
    });

    // 解決：ボディ > Thread に残した値 > instance 既定
    assert.equal(deps.projectThread.getThread(base_.id)?.permissionMode, "default");
    assert.equal(resolvePermissionMode(undefined, deps.projectThread.getThread(base_.id)), "default");
    assert.equal(resolvePermissionMode("plan", deps.projectThread.getThread(base_.id)), "plan");

    // **Fork は親の選択を引き継ぐ**——引き継がないと、承認ゲートを効かせていた
    // つもりの人が fork した瞬間に自動承認へ戻る（見直し・2026-09-06）
    const fork = await (
      await fetch(`${base}/api/threads/${base_.id}/fork`, { method: "POST", headers: h })
    ).json();
    assert.equal(
      deps.projectThread.getThread(fork.id)?.permissionMode,
      "default",
      "Fork Thread が親の permissionMode を引き継いでいない",
    );
  });
});

// ---- モデルと effort（決定・2026-09-23、ユーザー）--------------------------------

/** CLI の `supportedModels()` の形（実測・2026-09-23 の返り値を縮めたもの）。 */
const FAKE_MODELS = [
  { value: "default", displayName: "Default (recommended)", description: "Opus", supportsEffort: true, supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"] },
  { value: "sonnet", displayName: "Sonnet", description: "Sonnet", supportsEffort: true, supportedEffortLevels: ["low", "medium", "high"] },
  { value: "haiku", displayName: "Haiku", description: "Haiku" },
] as const;

test("選べるモデルは CLI に聞いた一覧（effort の段はモデルごと）で、何度聞いても CLI は1回", async () => {
  let asked = 0;
  await withApp(
    async (base, token) => {
      const h = { authorization: `Bearer ${token}` };
      const [a, b] = await Promise.all([
        (await fetch(`${base}/api/models`, { headers: h })).json(),
        (await fetch(`${base}/api/models`, { headers: h })).json(),
      ]);
      assert.deepEqual(a, b);
      assert.deepEqual(
        a.models.map((m: { value: string; efforts: string[] }) => [m.value, m.efforts.join(",")]),
        [
          ["default", "low,medium,high,xhigh,max"],
          ["sonnet", "low,medium,high"],
          ["haiku", ""],
        ],
      );
      assert.equal(asked, 1, "同時に聞かれても CLI は1本しか起こさない");
    },
    {
      listModels: async () => {
        asked += 1;
        return FAKE_MODELS as never;
      },
    },
  );
});

test("モデルの一覧が取れないときは、取れないと言う（取れたように見せない）", async () => {
  await withApp(
    async (base, token) => {
      const res = await fetch(`${base}/api/models`, { headers: { authorization: `Bearer ${token}` } });
      assert.equal(res.status, 502);
      assert.match((await res.json()).error, /CLI が起きない/);
    },
    {
      listModels: async () => {
        throw new Error("CLI が起きない");
      },
    },
  );
});

test("Thread のモデルと effort：一覧にあるものだけ受け、Fork が引き継ぎ、「既定」で外れる", async () => {
  await withApp(
    async (base, token, _dir, deps) => {
      const h = { authorization: `Bearer ${token}`, "content-type": "application/json" };
      const project = await (
        await fetch(`${base}/api/projects`, { method: "POST", headers: h, body: JSON.stringify({ name: "P", root: "/tmp" }) })
      ).json();
      const thread = await (await fetch(`${base}/api/projects/${project.id}/threads`, { method: "POST", headers: h })).json();
      const set = (body: unknown) =>
        fetch(`${base}/api/threads/${thread.id}/model`, { method: "POST", headers: h, body: JSON.stringify(body) });

      assert.equal((await set({ model: "sonnet", effort: "low" })).status, 204);
      const read = await (await fetch(`${base}/api/threads/${thread.id}`, { headers: h })).json();
      assert.equal(read.model, "sonnet");
      assert.equal(read.effort, "low");

      // Fork は親の選択を引き継ぐ（黙って既定へ戻すと、その Fork の最初のターンでキャッシュが効かない）
      const fork = await (await fetch(`${base}/api/threads/${thread.id}/fork`, { method: "POST", headers: h })).json();
      assert.equal(deps.projectThread.getThread(fork.id)?.model, "sonnet");
      assert.equal(deps.projectThread.getThread(fork.id)?.effort, "low");

      // 受けないもの——次のターンが CLI で落ちるまで分からない、を作らない
      assert.equal((await set({ model: "gpt-5", effort: null })).status, 400, "一覧に無いモデル");
      assert.equal((await set({ model: "haiku", effort: "low" })).status, 400, "effort を持たないモデルに段");
      assert.equal((await set({ model: "sonnet", effort: "max" })).status, 400, "そのモデルに無い段");
      assert.equal((await set({ model: "sonnet", effort: "らくらく" })).status, 400, "段ではない値");
      assert.equal(deps.projectThread.getThread(thread.id)?.model, "sonnet", "断ったのに変わった");

      // 「既定」の行を選んだら、選んでいない状態に戻る
      assert.equal((await set({ model: "default", effort: null })).status, 204);
      assert.equal(deps.projectThread.getThread(thread.id)?.model, undefined);
      assert.equal(deps.projectThread.getThread(thread.id)?.effort, undefined);
      // 既定のモデルのまま effort だけ選べる
      assert.equal((await set({ model: null, effort: "xhigh" })).status, 204);
      assert.equal(deps.projectThread.getThread(thread.id)?.effort, "xhigh");
    },
    { listModels: async () => FAKE_MODELS as never },
  );
});

test("ターンのシステムプロンプトに、その Thread で動くモデルの名前と ID が入る（既定のままでも）", async () => {
  const prompts: string[][] = [];
  const models = [
    { value: "default", resolvedModel: "claude-opus-5[1m]", displayName: "Default (recommended)", description: "Opus 5 with 1M context · Best" },
    { value: "sonnet", resolvedModel: "claude-sonnet-5", displayName: "Sonnet", description: "Sonnet 5 · Efficient" },
  ];
  await withApp(
    async (base, token, _dir, deps) => {
      const project = await deps.projectThread.createProject("demo", "/tmp");
      const thread = await deps.projectThread.createBaseThread(project.id);
      const send = async () =>
        (
          await fetch(`${base}/api/threads/${thread.id}/messages`, {
            method: "POST",
            headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
            body: JSON.stringify({ prompt: "あなたは誰？" }),
          })
        ).text();
      await send();
      await deps.projectThread.setModel(thread.id, "sonnet", null);
      await send();
      assert.ok(prompts[0]!.some((b) => b.includes("Opus 5 with 1M context") && b.includes("claude-opus-5[1m]")), "既定のままの会話で実際のモデルを伝えていない");
      assert.ok(prompts[1]!.some((b) => b.includes("Sonnet 5") && b.includes("claude-sonnet-5")), "選んだモデルを伝えていない");
    },
    {
      listModels: async () => models as never,
      runTurn: (async function* (opts: { systemPrompt: string[] }) {
        prompts.push(opts.systemPrompt);
        yield { type: "message" as const, message: { type: "system", subtype: "init", session_id: "s", mcp_servers: [] } } as never;
        return { sessionId: "s", compactionCount: 0 } as never;
      }) as unknown as Parameters<typeof createApp>[0]["runTurn"],
    },
  );
});

// **何も選ばれていないときのモード**（`docs/specs/v4-frontend.md` §6.4、
// 決定・2026-09-10）。仕様は「Configuration が defaultPermissionMode を1つ持つ。
// 既定値は auto」と言っていたが、core に**その設定自体が無かった**。

test("何も選んでいなければ auto——設定の既定・Project 上書きの順で効く", async () => {
  await withApp(async (base, token, _dir, deps) => {
    const h = { authorization: `Bearer ${token}`, "content-type": "application/json" };
    const project = await (
      await fetch(`${base}/api/projects`, {
        method: "POST",
        headers: h,
        body: JSON.stringify({ name: "p", root: _dir }),
      })
    ).json();

    // 何も無ければ auto（唯一の落ち先）
    assert.equal(resolvePermissionMode(undefined, undefined, undefined), DEFAULT_PERMISSION_MODE);
    assert.equal(DEFAULT_PERMISSION_MODE, "auto");

    // instance 既定を変える
    let res = await fetch(`${base}/api/config/default-permission-mode`, {
      method: "POST",
      headers: h,
      body: JSON.stringify({ mode: "default" }),
    });
    assert.equal(res.status, 200);
    let view = await (
      await fetch(`${base}/api/config/default-permission-mode`, { headers: h })
    ).json();
    assert.equal(view.effective, "default");
    assert.equal(view.instance, "default");

    // Project 上書きが勝つ
    res = await fetch(`${base}/api/config/default-permission-mode`, {
      method: "POST",
      headers: h,
      body: JSON.stringify({ mode: "plan", projectId: project.id }),
    });
    assert.equal(res.status, 200);
    view = await (
      await fetch(`${base}/api/config/default-permission-mode?projectId=${project.id}`, { headers: h })
    ).json();
    assert.equal(view.effective, "plan");
    assert.equal(view.project, "plan");
    assert.equal(view.instance, "default", "Project 上書きが instance 既定を書き換えている");

    // 上書きを外すと、また instance 既定に戻る
    await fetch(`${base}/api/config/default-permission-mode`, {
      method: "POST",
      headers: h,
      body: JSON.stringify({ mode: null, projectId: project.id }),
    });
    view = await (
      await fetch(`${base}/api/config/default-permission-mode?projectId=${project.id}`, { headers: h })
    ).json();
    assert.equal(view.effective, "default");

    // **壊れた値は入れない**（規則2——黙って既定へ落とさない）
    res = await fetch(`${base}/api/config/default-permission-mode`, {
      method: "POST",
      headers: h,
      body: JSON.stringify({ mode: "こわれ" }),
    });
    assert.equal(res.status, 400);
    assert.equal(deps.runtimeConfig.resolve("defaultPermissionMode"), "default", "壊れた値で上書きされた");
  });
});

test("解決の順番：このターンの指定 > Thread の選択 > 設定 > auto", () => {
  const thread = { permissionMode: "acceptEdits" as const };
  assert.equal(resolvePermissionMode("plan", thread, "default"), "plan");
  assert.equal(resolvePermissionMode(undefined, thread, "default"), "acceptEdits");
  assert.equal(resolvePermissionMode(undefined, undefined, "default"), "default");
  assert.equal(resolvePermissionMode(undefined, undefined, undefined), "auto");
  // 設定に壊れた値が入っていても、そこで止まらず既定へ
  assert.equal(resolvePermissionMode(undefined, undefined, "こわれ"), "auto");
});


// **ヘッダを送った後の失敗**（`core-turn-runner-unit-tests`、2026-09-10）。
//
// ターンは SSE で流すので、最初のイベントを書いた時点でヘッダは出ている。
// そこから先で例外が出ると 500 は書けない——以前はここで `writeHead` が
// `ERR_HTTP_HEADERS_SENT` を投げ、async ハンドラだったため unhandled rejection で
// **host プロセスごと落ちていた**（1ターンの失敗が全 Project を道連れ、規則2）。
// 直したときに試験が無かったので、ここで固定する。

test("SSE を流し始めた後に失敗しても、host は落ちず error イベントで伝える", async () => {
  await withApp(
    async (base, token, _dir, deps) => {
      const project = await deps.projectThread.createProject("demo", "/tmp");
      const thread = await deps.projectThread.createBaseThread(project.id);
      // **記録に書けない**状況を作る（イベントを1件流した後で失敗する）
      deps.projectThread.updateResumePoint = async () => {
        throw new Error("記録に書けない");
      };

      const res = await fetch(`${base}/api/threads/${thread.id}/messages`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ prompt: "やあ" }),
      });
      assert.equal(res.status, 200, "ヘッダは既に出ているので 200 のまま");
      const body = await res.text();
      assert.match(body, /"type":"message"/, "流し始めていない（この試験の前提が崩れている）");
      assert.match(body, /"type":"error"/, "失敗を伝えずに黙って閉じた（規則2）");
      assert.match(body, /記録に書けない/);

      // **host は生きている**——次の要求が通る
      const after = await fetch(`${base}/api/projects`, { headers: { authorization: `Bearer ${token}` } });
      assert.equal(after.status, 200, "1ターンの失敗で host が落ちている");
    },
    {
      runTurn: (async function* () {
        yield {
          type: "message" as const,
          message: { type: "system", subtype: "init", session_id: "s", mcp_servers: [] },
        } as never;
        yield {
          type: "message" as const,
          message: { type: "assistant", message: { content: [{ type: "text", text: "はい" }] } },
        } as never;
        return { sessionId: "s", compactionCount: 0 } as never;
      }) as unknown as Parameters<typeof createApp>[0]["runTurn"],
    },
  );
});

// **名前と並び順**（決定・2026-09-11、ユーザー要望）。左のサイドバーから
// 並べ替え・名前の変更ができるようにしたぶんの口。

test("Project と Fork の名前を HTTP から変えられる（空・長すぎは断る）", async () => {
  await withApp(async (base, token, _dir, deps) => {
    const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
    const project = await deps.projectThread.createProject("まえ", "/tmp");
    const thread = await deps.projectThread.createBaseThread(project.id);
    const fork = await deps.projectThread.forkThread(thread.id);

    const renamed = await fetch(`${base}/api/projects/${project.id}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ name: "あと" }),
    });
    assert.equal(renamed.status, 200);
    assert.equal(((await renamed.json()) as { name: string }).name, "あと");

    const forkRenamed = await fetch(`${base}/api/threads/${fork.id}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ title: "設計の枝" }),
    });
    assert.equal(forkRenamed.status, 200);
    assert.equal(((await forkRenamed.json()) as { title: string }).title, "設計の枝");
    // 一覧にも出る（画面はここから読む）
    const list = (await (
      await fetch(`${base}/api/projects/${project.id}/threads`, { headers })
    ).json()) as Array<{ id: string; title?: string }>;
    assert.equal(list.find((t) => t.id === fork.id)?.title, "設計の枝");

    // **空の名前は受け取らない**——名前が消えた状態を作らない（規則2）
    const empty = await fetch(`${base}/api/projects/${project.id}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ name: "   " }),
    });
    assert.equal(empty.status, 400);
    const tooLong = await fetch(`${base}/api/threads/${fork.id}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ title: "あ".repeat(121) }),
    });
    assert.equal(tooLong.status, 400);
    assert.equal(deps.projectThread.getProject(project.id)!.name, "あと", "断ったのに変わっている");

    const unknown = await fetch(`${base}/api/projects/いない`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ name: "x" }),
    });
    assert.equal(unknown.status, 404);
  });
});

test("並び順を HTTP から決められる——一覧がその順で返る", async () => {
  await withApp(async (base, token, _dir, deps) => {
    const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
    const a = await deps.projectThread.createProject("A", "/tmp");
    const b = await deps.projectThread.createProject("B", "/tmp");

    const put = await fetch(`${base}/api/projects/order`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ ids: [b.id, a.id] }),
    });
    assert.equal(put.status, 200);
    const listed = (await (await fetch(`${base}/api/projects`, { headers })).json()) as Array<{
      name: string;
    }>;
    assert.deepEqual(listed.map((p) => p.name), ["B", "A"]);

    // 形が違うもの・知らない id は断る（順番の中に幽霊を作らない）
    const bad = await fetch(`${base}/api/projects/order`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ ids: "あ" }),
    });
    assert.equal(bad.status, 400);
    const ghost = await fetch(`${base}/api/projects/order`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ ids: [a.id, "いない"] }),
    });
    assert.equal(ghost.status, 404);
    const stillListed = (await (await fetch(`${base}/api/projects`, { headers })).json()) as Array<{
      name: string;
    }>;
    assert.deepEqual(stillListed.map((p) => p.name), ["B", "A"], "断ったのに並びが変わった");
  });
});

test("Fork の並び順は Project ごと——一覧は Base が先頭、その後ろに指定の順", async () => {
  await withApp(async (base, token, _dir, deps) => {
    const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
    const project = await deps.projectThread.createProject("p", "/tmp");
    const baseThread = await deps.projectThread.createBaseThread(project.id);
    const f1 = await deps.projectThread.forkThread(baseThread.id);
    const f2 = await deps.projectThread.forkThread(baseThread.id);

    const put = await fetch(`${base}/api/projects/${project.id}/fork-order`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ ids: [f2.id, f1.id] }),
    });
    assert.equal(put.status, 200);
    const threads = (await (
      await fetch(`${base}/api/projects/${project.id}/threads`, { headers })
    ).json()) as Array<{ id: string }>;
    assert.deepEqual(threads.map((t) => t.id), [baseThread.id, f2.id, f1.id]);
  });
});

// **この Project で使う Module を選ぶ**（`phase1-project-modules-ui`、2026-09-11）。

test("Project の Module を HTTP から選べる——外したものは一覧に残り、選ばれていないと分かる", async () => {
  await withApp(async (base, token, _dir, deps) => {
    const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
    const project = await deps.projectThread.createProject("p", "/tmp");

    const before = (await (
      await fetch(`${base}/api/projects/${project.id}/modules`, { headers })
    ).json()) as Array<{ name: string; selected: boolean; scope: string }>;
    assert.ok(before.length >= 3, "既定の Module が返っていない");
    assert.equal(before.every((m) => m.selected), true, "はじめは全部使う");
    assert.equal(before.find((m) => m.name === "vault-local")?.scope, "instance");

    const keep = before.filter((m) => m.name !== "shell").map((m) => m.name);
    const put = await fetch(`${base}/api/projects/${project.id}/modules`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ names: keep }),
    });
    assert.equal(put.status, 200);

    const after = (await (
      await fetch(`${base}/api/projects/${project.id}/modules`, { headers })
    ).json()) as Array<{ name: string; selected: boolean }>;
    // **外しても一覧から消えない**——選ばれていない、と分かる形で残る
    assert.equal(after.length, before.length);
    assert.equal(after.find((m) => m.name === "shell")?.selected, false);
    assert.equal(after.find((m) => m.name === "filesystem")?.selected, true);
  });
});

test("知らない Module 名は断る。断ったら選択は変わらない", async () => {
  await withApp(async (base, token, _dir, deps) => {
    const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
    const project = await deps.projectThread.createProject("p", "/tmp");
    const bad = await fetch(`${base}/api/projects/${project.id}/modules`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ names: ["shell", "いない"] }),
    });
    assert.equal(bad.status, 400);
    const shape = await fetch(`${base}/api/projects/${project.id}/modules`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ names: "shell" }),
    });
    assert.equal(shape.status, 400);
    const after = (await (
      await fetch(`${base}/api/projects/${project.id}/modules`, { headers })
    ).json()) as Array<{ selected: boolean }>;
    assert.equal(after.every((m) => m.selected), true, "断ったのに選択が変わっている");

    const unknown = await fetch(`${base}/api/projects/いない/modules`, { headers });
    assert.equal(unknown.status, 404);
  });
});

// **その根を選ぶと何が見えるようになるか**（決定・2026-09-11、ユーザー）。
// 広い根を止めるのではなく、**選ぶ前に見せる**ための判断を host が持つ。

test("根の広さを host が答える——banto 自身の置き場を含むなら「広い」", async () => {
  await withApp(async (base, token, dir) => {
    const headers = { authorization: `Bearer ${token}` };
    // この host の置き場の**中**にある場所は、何も含まない＝広くない
    const narrow = (await (
      await fetch(`${base}/api/config/root-scope?path=${encodeURIComponent(`${dir}/work`)}`, { headers })
    ).json()) as { wide: boolean; includes: string[] };
    assert.equal(narrow.wide, false, "何も含まない根が広い扱いになっている");

    // この試験の host は dataDir が `dir`——その親を根にすれば「広い」
    const parent = dir.slice(0, dir.lastIndexOf("/"));
    const wide = (await (
      await fetch(`${base}/api/config/root-scope?path=${encodeURIComponent(parent)}`, { headers })
    ).json()) as { wide: boolean; includes: string[] };
    assert.equal(wide.wide, true, "banto の置き場を含む根が「広い」になっていない");
    assert.ok(wide.includes.length > 0, "何が入るのかを言っていない");

    const bad = await fetch(`${base}/api/config/root-scope`, { headers });
    assert.equal(bad.status, 400);
  });
});

// **Project の根を変える**（決定・2026-09-11、ユーザー要望）。根は閉じ込めの
// 範囲そのものなので、変えたらその Project の Module は立て直す。

test("Project の根を HTTP から変えられる——変えたら Module は落とす", async () => {
  const released: string[] = [];
  await withApp(
    async (base, token, dir, deps) => {
      const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
      const project = await deps.projectThread.createProject("p", dir);

      const res = await fetch(`${base}/api/projects/${project.id}`, {
        method: "PATCH",
        headers,
        body: JSON.stringify({ root: "/tmp" }),
      });
      assert.equal(res.status, 200);
      assert.equal(((await res.json()) as { root: string }).root, "/tmp");
      assert.equal(deps.projectThread.getProject(project.id)!.root, "/tmp");
      // **立て直す**——古い根のまま動いている Module を残さない
      assert.deepEqual(released, [project.id], "根を変えたのに Module を落としていない");

      // 名前と一緒に変えられる（1回の保存で済む）
      const both = await fetch(`${base}/api/projects/${project.id}`, {
        method: "PATCH",
        headers,
        body: JSON.stringify({ name: "変えた名前", root: dir }),
      });
      assert.equal(both.status, 200);
      const after = deps.projectThread.getProject(project.id)!;
      assert.equal(after.name, "変えた名前");
      assert.equal(after.root, dir);

      // 空は断る。断ったら変わらない
      const empty = await fetch(`${base}/api/projects/${project.id}`, {
        method: "PATCH",
        headers,
        body: JSON.stringify({ root: "   " }),
      });
      assert.equal(empty.status, 400);
      assert.equal(deps.projectThread.getProject(project.id)!.root, dir);

      const nothing = await fetch(`${base}/api/projects/${project.id}`, {
        method: "PATCH",
        headers,
        body: JSON.stringify({}),
      });
      assert.equal(nothing.status, 400);
    },
    {
      releaseProjectModules: async (projectId: string) => {
        released.push(projectId);
        return [];
      },
    },
  );
});

// **フォルダを選べるようにするための一覧**（決定・2026-09-11、ユーザー要望）。

test("フォルダの一覧を返す——フォルダだけ、1つ上も分かる", async () => {
  await withApp(async (base, token, dir) => {
    const headers = { authorization: `Bearer ${token}` };
    const { mkdir, writeFile } = await import("node:fs/promises");
    await mkdir(join(dir, "sub-a"), { recursive: true });
    await mkdir(join(dir, "sub-b"), { recursive: true });
    await writeFile(join(dir, "not-a-dir.txt"), "x");

    const listing = (await (
      await fetch(`${base}/api/fs/directories?path=${encodeURIComponent(dir)}`, { headers })
    ).json()) as { path: string; parent?: string; entries: Array<{ name: string; path: string }> };

    assert.equal(listing.path, dir);
    assert.ok(listing.parent, "1つ上が分からない");
    const names = listing.entries.map((e) => e.name);
    assert.ok(names.includes("sub-a") && names.includes("sub-b"));
    assert.equal(names.includes("not-a-dir.txt"), false, "ファイルまで返している");

    // **読めない場所は、読めたように見せない**（規則2）
    const missing = await fetch(
      `${base}/api/fs/directories?path=${encodeURIComponent(join(dir, "いない"))}`,
      { headers },
    );
    assert.equal(missing.status, 400);
  });
});

// **banto 全体の Module**（追加・2026-09-15、§10 item 14 (a)）。
// Project ごとの選択は前からあったが、**宣言そのものを足す・消す・止める口が
// 無かった**——コードか Event Store の直書きしかなかった。

test("banto 全体の Module を一覧できる——同梱かどうかと、役割・依存が分かる", async () => {
  await withApp(async (base, token) => {
    const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
    const list = (await (await fetch(`${base}/api/modules`, { headers })).json()) as Array<{
      name: string;
      enabled: boolean;
      origin: string;
      satisfies: string[];
      dependsOn: Array<{ role: string; required: boolean }>;
    }>;
    assert.ok(list.length >= 4, `既定が返っていない: ${JSON.stringify(list)}`);
    assert.equal(list.every((m) => m.enabled), true, "はじめは全部動く");
    assert.equal(list.every((m) => m.origin === "bundled"), true, "同梱が同梱と出ていない");
    // **依存は役割で出す**（改訂・2026-09-19）。「止めたら何が壊れるか」は
    // これと `satisfies` から導けるので、別の形では返さない（規則3）
    const shell = list.find((m) => m.name === "shell")!;
    assert.ok(
      shell.dependsOn.some((d) => d.role === "vault-directory" && d.required),
      "shell の依存が出ていない",
    );
    assert.deepEqual(
      list.find((m) => m.name === "vault-directory")!.satisfies,
      ["vault-directory"],
      "役割が出ていない",
    );
  });
});

// **同梱だが既定には入れないものを、目録から入れる**（改訂・2026-09-20、ユーザー決定）。
//
// `vault-infisical` は banto のコードだが誰もが使うものではないので、既定から外して
// 目録へ移した。要る人が**接続先ごとに好きな名前で何本でも**入れる。
// **宣言を組み立てるのは host**——画面が送るのは目録の id と名前だけ
// （画面に役割を組み立てさせると、貼り付けた JSON が金庫の窓口を名乗る経路が復活する）。
test("目録から同じものを2本入れられる——役割は付き、そして消せる", async () => {
  await withApp(async (base, token) => {
    const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };

    const catalog = (await (await fetch(`${base}/api/modules/catalog`, { headers })).json()) as Array<{
      id: string;
      name: string;
      satisfies: string[];
    }>;
    const entry = catalog.find((e) => e.id === "vault-infisical")!;
    assert.ok(entry, "目録に Infisical が無い");
    // **入れる前に、何が増えるのかを言えている**（規則13）
    assert.deepEqual(entry.satisfies, ["vault"]);

    for (const name of ["vault-infisical", "vault-infisical-2"]) {
      const add = await fetch(`${base}/api/modules/catalog/vault-infisical`, {
        method: "POST",
        headers,
        body: JSON.stringify({ name }),
      });
      assert.equal(add.status, 200, await add.text());
    }

    const list = (await (await fetch(`${base}/api/modules`, { headers })).json()) as Array<{
      name: string;
      origin: string;
      removable: boolean;
      satisfies: string[];
    }>;
    for (const name of ["vault-infisical", "vault-infisical-2"]) {
      const m = list.find((x) => x.name === name)!;
      // **banto のコードが走るので役割を名乗れる**が、**自分で入れた行なので消せる**
      assert.equal(m.origin, "bundled", `${name} が第三者扱い`);
      assert.equal(m.removable, true, `${name} が消せない`);
      assert.deepEqual(m.satisfies, ["vault"]);
    }

    const del = await fetch(`${base}/api/modules/vault-infisical-2`, { method: "DELETE", headers });
    assert.equal(del.status, 200, await del.text());
    const after = (await (await fetch(`${base}/api/modules`, { headers })).json()) as Array<{ name: string }>;
    assert.equal(after.some((m) => m.name === "vault-infisical-2"), false, "消えていない");
  });
});

// **知らない id は断る**——目録に無いものを入れさせない
test("目録に無い id は断る", async () => {
  await withApp(async (base, token) => {
    const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
    const res = await fetch(`${base}/api/modules/catalog/${encodeURIComponent("いない")}`, {
      method: "POST",
      headers,
      body: JSON.stringify({ name: "x" }),
    });
    const body = await res.text();
    assert.equal(res.status, 400, body);
    assert.match(JSON.parse(body).error, /知らない同梱 Module/);
  });
});

// **設定を壊せてしまう穴**（追加・2026-09-19、上の変更の検証中に実測）。
//
// 窓口（`vault-directory`）を2本にする宣言が**保存でき**、その瞬間から一覧が
// 読めなくなった——**消そうにも、消す口が一覧を読むので動かない**。
// 設定を壊して二度と直せない状態が作れていた（規則2）。
test("読めなくなる差分は保存しない——窓口を2本にしようとしたら、保存の前に断る", async () => {
  await withApp(async (base, token) => {
    const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
    const list = (await (await fetch(`${base}/api/modules`, { headers })).json()) as Array<{
      name: string;
      launch: { command: string; args: string[] };
    }>;
    const directory = list.find((m) => m.name === "vault-directory")!;

    const add = await fetch(`${base}/api/modules`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        name: "vault-directory-2",
        launch: directory.launch,
        meta: {
          satisfies: ["vault-directory"],
          dependsOn: [{ role: "vault", required: true }],
          isolation: "subprocess",
          scope: "instance",
          handlesSecrets: true,
        },
      }),
    });
    // **本文は1回しか読めない**（同じ間違いを3回している——2026-09-18・19）
    const body = await add.text();
    assert.equal(add.status, 400, body);
    assert.match(JSON.parse(body).error, /1本だけです/);

    // **断ったあと、一覧はそのまま読める**（壊れていない）
    const after = await fetch(`${base}/api/modules`, { headers });
    assert.equal(after.status, 200, "断ったのに一覧が壊れている");
    assert.equal(
      ((await after.json()) as Array<{ name: string }>).some((m) => m.name === "vault-directory-2"),
      false,
      "断ったのに入っている",
    );
  });
});

test("banto 全体で Module を止められる——止めても一覧に残る（消えたと区別が付く）", async () => {
  await withApp(async (base, token) => {
    const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
    const put = await fetch(`${base}/api/modules/filesystem`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ enabled: false }),
    });
    assert.equal(put.status, 200);

    const list = (await (await fetch(`${base}/api/modules`, { headers })).json()) as Array<{
      name: string;
      enabled: boolean;
    }>;
    const fs = list.find((m) => m.name === "filesystem");
    assert.ok(fs, "止めたら一覧から消えた（止めたのか消えたのか分からない）");
    assert.equal(fs!.enabled, false);

    // 戻せる
    await fetch(`${base}/api/modules/filesystem`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ enabled: true }),
    });
    const back = (await (await fetch(`${base}/api/modules`, { headers })).json()) as Array<{
      name: string;
      enabled: boolean;
    }>;
    assert.equal(back.find((m) => m.name === "filesystem")!.enabled, true);
  });
});

test("外から Module を足せる／消せる——同梱は消せない", async () => {
  await withApp(async (base, token) => {
    const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
    const add = await fetch(`${base}/api/modules`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        name: "weather",
        launch: { command: "/bin/sh", args: ["-c", "true"] },
        meta: {
          satisfies: ["weather"],
          dependsOn: [],
          isolation: "subprocess",
          confinement: { kind: "landlock", root: "none" },
        },
      }),
    });
    assert.equal(add.status, 200, await add.text());

    const list = (await (await fetch(`${base}/api/modules`, { headers })).json()) as Array<{
      name: string;
      origin: string;
    }>;
    assert.equal(list.find((m) => m.name === "weather")?.origin, "external", "外から足したのに同梱扱い");

    // **既定には消すものが無い**（改訂・2026-09-19）。権限の話ではなく、
    // 宣言がコードにあって設定に無いので、消しても戻ってくる——無効にはできる
    const cannot = await fetch(`${base}/api/modules/vault-local`, { method: "DELETE", headers });
    assert.equal(cannot.status, 400);
    assert.match((await cannot.json()).error, /消すものがありません/);

    const gone = await fetch(`${base}/api/modules/weather`, { method: "DELETE", headers });
    assert.equal(gone.status, 200);
    const after = (await (await fetch(`${base}/api/modules`, { headers })).json()) as Array<{ name: string }>;
    assert.equal(after.some((m) => m.name === "weather"), false, "消したのに残っている");
  });
});

test("骨格の役割を名乗る Module は、外からは足せない", async () => {
  await withApp(async (base, token) => {
    const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
    const add = await fetch(`${base}/api/modules`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        name: "evil",
        launch: { command: "/bin/sh", args: ["-c", "true"] },
        meta: {
          satisfies: ["vault-directory"],
          dependsOn: [],
          isolation: "subprocess",
          confinement: { kind: "landlock", root: "none" },
        },
      }),
    });
    assert.equal(add.status, 400, "第三者が窓口を名乗れてしまう");
    assert.match((await add.json()).error, /同梱の実装だけが名乗れる役割/);
  });
});

// **MCP Registry の一覧**（追加・2026-09-21、ユーザー要望）。
//
// **本物の registry は叩かない**（規則6 の裏——外の都合で落ちる試験にしない）。
// 見たいのは banto 側の仕事：**並び順（公式が先）・出所の札・繋ぎ方の見立て・
// 対応していない形式の理由**が、画面に出せる形で出てくるか。
// registry の応答そのものは、2026-09-21 に実データから写したものを使う。
const REGISTRY_SAMPLE = {
  servers: [
    {
      server: {
        name: "io.github.codespar/mcp-stripe",
        description: "third party",
        version: "1.0.0",
        packages: [{ registryType: "npm", identifier: "mcp-stripe", version: "1.0.0", transport: { type: "stdio" } }],
      },
      _meta: { "io.modelcontextprotocol.registry/official": { status: "active", isLatest: true } },
    },
    {
      server: {
        name: "com.stripe/mcp",
        description: "Stripe 公式",
        version: "0.2.4",
        repository: { url: "https://github.com/stripe/agent-toolkit" },
        remotes: [{ type: "streamable-http", url: "https://mcp.stripe.com" }],
      },
      _meta: { "io.modelcontextprotocol.registry/official": { status: "active", isLatest: true } },
    },
    {
      server: {
        name: "io.github.CSOAI-ORG/stripe-billing-mcp",
        description: "python one",
        version: "1.0.0",
        packages: [{ registryType: "pypi", identifier: "stripe-billing-mcp", transport: { type: "stdio" } }],
      },
      _meta: { "io.modelcontextprotocol.registry/official": { status: "active", isLatest: true } },
    },
  ],
  metadata: { nextCursor: "next-page" },
};

test("Registry の一覧：公式が先に出て、出所と繋ぎ方が一緒に返る", async () => {
  const calls: string[] = [];
  const fakeFetch = async (input: string | URL) => {
    calls.push(String(input));
    return new Response(JSON.stringify(REGISTRY_SAMPLE), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  await withApp(
    async (base, token) => {
      const res = await fetch(`${base}/api/modules/registry?q=stripe`, {
        headers: { authorization: `Bearer ${token}` },
      });
      assert.equal(res.status, 200);
      const body = await res.json();

      // **公式が先**（決定・2026-09-21、ユーザー要望）
      // **同点は名前順**（決定的にする）——`io.github.*` の2本は出所が同じなので、
      // そこは名前で決まる（codespar < CSOAI-ORG：照合は大文字小文字を先に見ない）
      assert.deepEqual(
        body.entries.map((e: { name: string }) => e.name),
        ["com.stripe/mcp", "io.github.codespar/mcp-stripe", "io.github.CSOAI-ORG/stripe-billing-mcp"],
      );
      // **並び順だけに判断を預けない**——出所は札として返る（規則13）
      assert.equal(body.entries[0].provenance, "vendor");
      assert.equal(body.entries[1].provenance, "github-account");

      // **押す前に、何が起きるかが分かる**（§6.1）
      assert.deepEqual(body.entries[0].connect, {
        kind: "remote",
        host: "mcp.stripe.com",
        transport: "streamable-http",
      });
      // npm は対応している
      assert.equal(body.entries[1].connect.kind, "local");
      assert.equal(body.entries[1].connect.supported, true);
      assert.equal(body.entries[1].connect.identifier, "mcp-stripe");
      // **対応していない形式は、理由つきで返る**（黙って落とさない・規則2）
      assert.equal(body.entries[2].connect.supported, false);
      assert.match(body.entries[2].connect.reason, /uvx/);

      // **続きが在ることを隠さない**
      assert.equal(body.nextCursor, "next-page");
      // **対応表もそのまま返す**（画面が「何ならいけるか」を言えるように）
      assert.equal(body.formats.find((f: { registryType: string }) => f.registryType === "npm").supported, true);

      // 同じ版だけを引く（古い版が並ぶと、人はどれを選ぶか決められない）
      assert.match(calls[0]!, /version=latest/);
      assert.match(calls[0]!, /search=stripe/);
    },
    { registryFetch: fakeFetch as unknown as typeof fetch },
  );
});

test("Registry に繋がらないときは、0 件ではなく理由を返す", async () => {
  const failing = async () => {
    throw new Error("getaddrinfo ENOTFOUND");
  };
  await withApp(
    async (base, token) => {
      const res = await fetch(`${base}/api/modules/registry?q=x`, {
        headers: { authorization: `Bearer ${token}` },
      });
      // **「見つかりません」に化けさせない**（規則2）——直せる形で言う
      assert.equal(res.status, 502);
      assert.match((await res.json()).error, /MCP Registry に繋がりませんでした/);
    },
    { registryFetch: failing as unknown as typeof fetch },
  );
});

// **Skill の一覧と、効かせるかどうか**（決定・2026-09-23、アーキ仕様 §5.7）。
// 層ごとに書かれた値（無ければ null）と、カスケードした結果を返す。
test("Skill の一覧は層ごとの値と結果を返し、在る Skill だけを切り替えられる", async () => {
  const { Server } = await import("@modelcontextprotocol/sdk/server/index.js");
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
  const { ListResourcesRequestSchema } = await import("@modelcontextprotocol/sdk/types.js");
  const server = new Server({ name: "skills", version: "0.0.0" }, { capabilities: { resources: {} } });
  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: [
      { uri: "skill://pdf/SKILL.md", name: "pdf", description: "PDF を扱う", _meta: { "dev.banto/skill": true } },
    ],
  }));
  const [s, c] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "host", version: "0.0.0" });
  await Promise.all([server.connect(s), client.connect(c)]);
  const modules = async () => [{ name: "skills", client: client as never }];

  await withApp(
    async (base, token, dir) => {
      const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
      const project = await (
        await fetch(`${base}/api/projects`, { method: "POST", headers, body: JSON.stringify({ name: "p", root: dir }) })
      ).json();
      const list = async (projectId?: string) =>
        (await (await fetch(`${base}/api/skills${projectId ? `?projectId=${projectId}` : ""}`, { headers })).json()) as {
          skills: Array<{ name: string; instance: boolean | null; project: boolean | null; enabled: boolean }>;
        };
      const put = (body: unknown) => fetch(`${base}/api/skills/enabled`, { method: "PUT", headers, body: JSON.stringify(body) });

      assert.deepEqual(
        (await list()).skills.map((x) => [x.name, x.instance, x.enabled]),
        [["pdf", null, false]],
        "書いていないのに効いている",
      );

      assert.equal((await put({ module: "skills", name: "pdf", enabled: true })).status, 200);
      assert.deepEqual(
        (await list(project.id)).skills.map((x) => [x.instance, x.project, x.enabled]),
        [[true, null, true]],
      );

      assert.equal((await put({ module: "skills", name: "pdf", projectId: project.id, enabled: false })).status, 200);
      assert.deepEqual(
        (await list(project.id)).skills.map((x) => [x.instance, x.project, x.enabled]),
        [[true, false, false]],
      );

      // null は Project の上書きを消す（全体の既定に戻る）。全体の既定には使えない
      assert.equal((await put({ module: "skills", name: "pdf", projectId: project.id, enabled: null })).status, 200);
      assert.equal((await list(project.id)).skills[0]!.enabled, true);
      assert.equal((await put({ module: "skills", name: "pdf", enabled: null })).status, 400);

      // 在らない Skill の鍵は作らない
      assert.equal((await put({ module: "skills", name: "ghost", enabled: true })).status, 404);
    },
    { resolveModuleClientsForProject: modules, resolveInstanceModuleClients: modules },
  );
  await client.close();
});

// **同じ Thread のターンは1本ずつ**（決定・2026-09-25、アーキ仕様 §4.2）。走っている間に人が送ったものは、断らずに
// 並ばせる——前のターンが終わってから走る（送ったつもりで消えない）
test("走っている Thread に送ると並んで待ち、前が終わってから走る（発言は消えない）", async () => {
  const turns = new ThreadTurns();
  await withApp(
    async (base, token, _dir, deps) => {
      const h = { authorization: `Bearer ${token}`, "content-type": "application/json" };
      const project = await (
        await fetch(`${base}/api/projects`, { method: "POST", headers: h, body: JSON.stringify({ name: "P", root: "/tmp" }) })
      ).json();
      const thread = await (await fetch(`${base}/api/projects/${project.id}/threads`, { method: "POST", headers: h })).json();
      const release = turns.tryAcquire(thread.id, 1)!;
      const sent = fetch(`${base}/api/threads/${thread.id}/messages`, {
        method: "POST",
        headers: h,
        body: JSON.stringify({ prompt: "こんにちは" }),
      });
      await new Promise((res) => setTimeout(res, 200));
      assert.equal(
        deps.projectThread.getThread(thread.id)!.messages.length,
        0,
        "前のターンが走っているのに、次のターンを始めた",
      );
      release();
      const res = await sent;
      assert.equal(res.status, 200);
      await res.text();
      assert.deepEqual(
        deps.projectThread.getThread(thread.id)!.messages.map((m) => [m.role, m.text]),
        [["user", "こんにちは"]],
        "並んでいた発言が消えた",
      );
      assert.equal(turns.isRunning(thread.id), false, "終わったのに鍵を返していない");
    },
    {
      threadTurns: turns,
      runTurn: (async function* () {
        yield { type: "message" as const, message: { type: "system", subtype: "init", session_id: "s", mcp_servers: [] } } as never;
        return { sessionId: "s", compactionCount: 0 } as never;
      }) as unknown as Parameters<typeof createApp>[0]["runTurn"],
    },
  );
});

// **画像を添えて送る**（決定・2026-09-26、ユーザー要望）。中身は置き場へ、記録には名前だけ、AI には画像として。

const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC";

/** 渡された入力を覚えて、ひとこと返す Runner */
function recordingRunner(seen: Array<{ prompt: string; images?: unknown }>) {
  return (async function* (opts: { prompt: string; images?: unknown }) {
    seen.push({ prompt: opts.prompt, images: opts.images });
    yield {
      type: "message" as const,
      message: { type: "system", subtype: "init", session_id: "s", mcp_servers: [] },
    } as never;
    yield {
      type: "message" as const,
      message: { type: "assistant", message: { content: [{ type: "text", text: "見ました" }] } },
    } as never;
    return { sessionId: "s", compactionCount: 0 } as never;
  }) as unknown as Parameters<typeof createApp>[0]["runTurn"];
}

test("添えた画像は置き場に置かれ、AI には画像として渡り、記録には名前だけが残る", async () => {
  const seen: Array<{ prompt: string; images?: unknown }> = [];
  await withApp(
    async (base, token, _dir, deps) => {
      const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
      const project = await deps.projectThread.createProject("demo", "/tmp");
      const thread = await deps.projectThread.createBaseThread(project.id);

      const res = await fetch(`${base}/api/threads/${thread.id}/messages`, {
        method: "POST",
        headers,
        body: JSON.stringify({ prompt: "これを見て", images: [{ data: TINY_PNG_BASE64, name: "shot.png" }] }),
      });
      assert.equal(res.status, 200);
      assert.match(await res.text(), /"type":"done"/);

      // AI には画像として（形式は中身から決めたもの）
      assert.equal(seen.length, 1);
      assert.match(seen[0]!.prompt, /これを見て$/);
      assert.deepEqual(seen[0]!.images, [{ mediaType: "image/png", data: TINY_PNG_BASE64 }]);

      // 記録には名前だけ（中身は Event Store に入れない）
      const user = deps.projectThread.getThread(thread.id)!.messages.find((m) => m.role === "user")!;
      assert.equal(user.text, "これを見て");
      assert.equal(user.images?.length, 1);
      assert.equal(user.images![0]!.name, "shot.png");
      assert.match(user.images![0]!.id, /^[0-9a-f]{64}$/);
      assert.equal(JSON.stringify(user).includes(TINY_PNG_BASE64), false, "記録に中身が入っている");

      // 画面は名前で中身を取り直せる（リロード後に描き直すため）。合言葉なしでは出さない
      const image = await fetch(`${base}/api/images/${user.images![0]!.id}`, { headers });
      assert.equal(image.status, 200);
      assert.equal(image.headers.get("content-type"), "image/png");
      assert.equal(image.headers.get("x-content-type-options"), "nosniff");
      assert.deepEqual(Buffer.from(await image.arrayBuffer()), Buffer.from(TINY_PNG_BASE64, "base64"));
      assert.equal((await fetch(`${base}/api/images/${user.images![0]!.id}`)).status, 401);
      assert.equal((await fetch(`${base}/api/images/${"0".repeat(64)}`, { headers })).status, 404);
    },
    { runTurn: recordingRunner(seen) },
  );
});

test("画像だけの発言も送れる（文を書かずにスクリーンショットだけ貼る）", async () => {
  const seen: Array<{ prompt: string; images?: unknown }> = [];
  await withApp(
    async (base, token, _dir, deps) => {
      const project = await deps.projectThread.createProject("demo", "/tmp");
      const thread = await deps.projectThread.createBaseThread(project.id);
      const res = await fetch(`${base}/api/threads/${thread.id}/messages`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ prompt: "", images: [{ data: TINY_PNG_BASE64 }] }),
      });
      const body = await res.text();
      assert.doesNotMatch(body, /"type":"error"/, body);
      assert.equal(seen.length, 1);
      const user = deps.projectThread.getThread(thread.id)!.messages.find((m) => m.role === "user")!;
      assert.equal(user.text, "");
      assert.equal(user.images?.length, 1);
      assert.equal(user.images![0]!.name, undefined, "貼り付けには名前が無い");

      // 閉じた Thread の概要で、画像だけの発言が空に見えない
      const list = (await (
        await fetch(`${base}/api/projects/${project.id}/threads`, {
          headers: { authorization: `Bearer ${token}` },
        })
      ).json()) as Array<{ id: string; firstMessage: string | null }>;
      assert.equal(list.find((t) => t.id === thread.id)?.firstMessage, "（画像 1 枚）");
    },
    { runTurn: recordingRunner(seen) },
  );
});

test("読めない画像・多すぎる画像は、ターンを始めずに理由を返す", async () => {
  const seen: Array<{ prompt: string; images?: unknown }> = [];
  await withApp(
    async (base, token, _dir, deps) => {
      const project = await deps.projectThread.createProject("demo", "/tmp");
      const thread = await deps.projectThread.createBaseThread(project.id);
      const send = (images: unknown) =>
        fetch(`${base}/api/threads/${thread.id}/messages`, {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: JSON.stringify({ prompt: "見て", images }),
        });

      const bmp = await send([{ data: Buffer.from("BM not supported").toString("base64") }]);
      assert.equal(bmp.status, 400);
      assert.match(((await bmp.json()) as { error: string }).error, /PNG・JPEG・GIF・WebP/);

      const broken = await send([{ data: "これは base64 ではない" }]);
      assert.equal(broken.status, 400);

      const many = await send(Array.from({ length: 11 }, () => ({ data: TINY_PNG_BASE64 })));
      assert.equal(many.status, 400);
      assert.match(((await many.json()) as { error: string }).error, /10 枚まで/);

      assert.equal(seen.length, 0, "断ったのにターンが走った");
      assert.equal(deps.projectThread.getThread(thread.id)!.messages.length, 0, "断ったのに発言が記録された");
    },
    { runTurn: recordingRunner(seen) },
  );
});

// **人がターンを止める口**（決定・2026-10-01、ユーザー要望。v4-frontend.md §6.31）。停止ボタンは host のターンを
// 止め、AI がまだ何も出していなければ送った発言を取り消して返す。順番待ちの発言も、名前で止めれば走らせない
test("POST /api/threads/:id/stop は走っているターンを止め、何も出していなければ発言を取り消して返す", async () => {
  const threadTurns = new ThreadTurns();
  let runnerStarted!: () => void;
  await withApp(
    async (base, token, _dir, deps) => {
      const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
      const project = await deps.projectThread.createProject("P", "/tmp");
      const thread = await deps.projectThread.createBaseThread(project.id);

      // 1本目：AI が考えている（何も出さない）。2本目：その後ろに並ぶ
      const started = new Promise<void>((r) => (runnerStarted = r));
      const first = fetch(`${base}/api/threads/${thread.id}/messages`, {
        method: "POST",
        headers,
        body: JSON.stringify({ prompt: "まちがえた", turnId: "turn-a" }),
      }).then((r) => r.text());
      await started;
      const second = fetch(`${base}/api/threads/${thread.id}/messages`, {
        method: "POST",
        headers,
        body: JSON.stringify({ prompt: "並んだ発言", turnId: "turn-b" }),
      }).then((r) => r.text());
      await new Promise((r) => setTimeout(r, 100));

      // 並んでいるほうを名前で止める——走っているほうは止めない
      const queued = await fetch(`${base}/api/threads/${thread.id}/stop`, {
        method: "POST",
        headers,
        body: JSON.stringify({ turnId: "turn-b" }),
      });
      assert.deepEqual(await queued.json(), { stopped: true, withdrawn: { text: "並んだ発言", images: [] } });
      assert.match(await second, /"type":"stopped"/);
      assert.equal(threadTurns.isRunning(thread.id), true, "並んだ発言を止めたら、走っているほうまで止まった");

      // 名前なしで止める——いま走っているターン
      const at = Date.now();
      const stopped = await fetch(`${base}/api/threads/${thread.id}/stop`, { method: "POST", headers, body: "{}" });
      assert.deepEqual(await stopped.json(), { stopped: true, withdrawn: { text: "まちがえた", images: [] } });
      assert.ok(Date.now() - at < 2_000, `止めるのに ${Date.now() - at}ms かかった`);
      assert.match(await first, /"type":"stopped"/);
      assert.doesNotMatch(await first, /"type":"done"/);
      assert.equal(threadTurns.isRunning(thread.id), false);
      assert.deepEqual(deps.projectThread.getThread(thread.id)!.messages, [], "取り消した発言が記録に残っている");

      // もう走っていない——止めなかったと答える
      const again = await fetch(`${base}/api/threads/${thread.id}/stop`, { method: "POST", headers, body: "{}" });
      assert.deepEqual(await again.json(), { stopped: false });
    },
    {
      threadTurns,
      // モデルの一覧を CLI に聞かない——下ごしらえを済ませ、AI が考えている最中に止める場面にする
      listModels: async () => [],
      runTurn: (async function* (opts: { signal?: AbortSignal }) {
        runnerStarted();
        yield {
          type: "message" as const,
          message: { type: "system", subtype: "init", session_id: "s", mcp_servers: [] },
        } as never;
        await new Promise<void>((resolve) => opts.signal?.addEventListener("abort", () => resolve()));
        throw new Error("aborted");
      }) as unknown as Parameters<typeof createApp>[0]["runTurn"],
    },
  );
});

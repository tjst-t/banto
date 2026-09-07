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
import { createApp, resolvePermissionMode } from "./app.js";

interface TestDeps {
  inbox: InboxStore;
  pendingApprovals: PendingApprovalRegistry;
  projectThread: ProjectThreadStore;
}

async function withApp(fn: (base: string, token: string, dir: string, deps: TestDeps) => Promise<void>) {
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
    const server = createApp({
      projectThread,
      globalMemory,
      inbox,
      pendingApprovals,
      relayEndpoint,
      agentRelayEndpoint,
      authToken: token,
      resolveModulesForThread: async () => [],
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    try {
      await fn(`http://127.0.0.1:${port}`, token, dir, { inbox, pendingApprovals, projectThread });
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

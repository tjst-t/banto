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

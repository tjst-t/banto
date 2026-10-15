// `/api/projects/:id/automations`（アーキ仕様 §4.3「人と AI の作り方」）
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
import { ThreadTurns } from "../delivery/thread-turns.js";
import { AutomationStore } from "../automation/store.js";
import { createApp } from "./app.js";

async function withApp(
  fn: (call: (path: string, method?: string, body?: unknown) => Promise<{ status: number; body: any }>, deps: { projectThread: ProjectThreadStore; threadTurns: ThreadTurns; automations: AutomationStore; ran: string[] }) => Promise<void>, // any: 試験で応答の形を自由に読む
  opts: { withRunner?: boolean } = {},
) {
  const dir = await mkdtemp(join(tmpdir(), "banto-automations-http-"));
  try {
    const log = new EventLog(dir);
    await log.init();
    const projectThread = new ProjectThreadStore(dir, log);
    await projectThread.load();
    const globalMemory = new GlobalMemoryStore(dir, log);
    await globalMemory.load();
    const inbox = new InboxStore(dir, log);
    await inbox.load();
    const automations = new AutomationStore(dir, log);
    await automations.load();
    const threadTurns = new ThreadTurns();
    const token = "test-token";
    const ran: string[] = [];
    const server = createApp({
      projectThread,
      globalMemory,
      inbox,
      pendingApprovals: new PendingApprovalRegistry(),
      relayEndpoint: new HostRelayEndpoint({ registry: new RelayRegistry() }),
      agentRelayEndpoint: new AgentRelayEndpoint(token),
      authToken: token,
      resolveModulesForThread: async () => [],
      threadTurns,
      automations,
      ...(opts.withRunner
        ? {
            runAutomation: async (a: { id: string }, cause: string) => {
              ran.push(`${a.id}:${cause}`);
              return { runId: "r1" };
            },
          }
        : {}),
      dataDir: dir,
      configDir: dir,
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const call = async (path: string, method = "GET", body?: unknown) => {
      const res = await fetch(`${base}${path}`, {
        method,
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
      return { status: res.status, body: await res.json() };
    };
    try {
      await fn(call, { projectThread, threadTurns, automations, ran });
    } finally {
      server.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const morning = {
  name: "毎朝のまとめ",
  instruction: "昨日からのコミットをまとめて",
  source: { kind: "time", repeat: { kind: "weekdays", time: "9:00" }, timeZone: "Asia/Tokyo" },
};

test("作る・一覧・直す・一時停止・再開・消す", async () => {
  await withApp(async (call, { projectThread }) => {
    const p = await projectThread.createProject("p", tmpdir());
    const path = `/api/projects/${p.id}/automations`;

    const created = await call(path, "POST", morning);
    assert.equal(created.status, 201);
    assert.equal(created.body.reviewOnDone, true);
    assert.deepEqual((await call(path)).body.automations.map((a: { name: string }) => a.name), ["毎朝のまとめ"]);

    const one = `${path}/${created.body.id}`;
    const edited = await call(one, "PATCH", { reviewOnDone: false, instruction: "まとめて" });
    assert.equal(edited.status, 200);
    assert.equal(edited.body.reviewOnDone, false);
    assert.equal(edited.body.instruction, "まとめて");
    assert.equal((await call(one, "PATCH", { paused: true })).body.paused, true);
    assert.equal((await call(one, "PATCH", { paused: false })).body.paused, false);
    assert.equal((await call(one, "PATCH", {})).status, 400);

    assert.equal((await call(path, "POST", { ...morning, name: "" })).status, 400);
    assert.equal((await call(one, "DELETE")).status, 200);
    assert.equal((await call(one)).status, 404);
    assert.equal((await call(`/api/projects/nope/automations`)).status, 404);
  });
});

test("届け先の Thread はこの Project の開いているものだけ", async () => {
  await withApp(async (call, { projectThread }) => {
    const p = await projectThread.createProject("p", tmpdir());
    const other = await projectThread.createProject("q", tmpdir());
    const base = await projectThread.createBaseThread(p.id);
    const foreign = await projectThread.createBaseThread(other.id);
    const path = `/api/projects/${p.id}/automations`;
    assert.equal((await call(path, "POST", { ...morning, target: { kind: "thread", threadId: foreign.id } })).status, 400);
    const ok = await call(path, "POST", { ...morning, target: { kind: "thread", threadId: base.id } });
    assert.equal(ok.status, 201);
    assert.deepEqual(ok.body.target, { kind: "thread", threadId: base.id });
  });
});

test("今すぐ動かす：前の回が終わっていなければ断り、届ける口が無ければ 501", async () => {
  await withApp(
    async (call, { projectThread, threadTurns, ran }) => {
      const p = await projectThread.createProject("p", tmpdir());
      const base = await projectThread.createBaseThread(p.id);
      const created = await call(`/api/projects/${p.id}/automations`, "POST", {
        ...morning,
        target: { kind: "thread", threadId: base.id },
      });
      const run = `/api/projects/${p.id}/automations/${created.body.id}/run`;
      const release = threadTurns.tryAcquire(base.id, 0)!;
      const busy = await call(run, "POST");
      assert.equal(busy.status, 409);
      assert.match(busy.body.error, /走っています/);
      release();
      const started = await call(run, "POST");
      assert.equal(started.status, 202);
      assert.deepEqual(started.body, { runId: "r1" });
      assert.deepEqual(ran, [`${created.body.id}:manual`]);
    },
    { withRunner: true },
  );
  await withApp(async (call, { projectThread }) => {
    const p = await projectThread.createProject("p", tmpdir());
    const created = await call(`/api/projects/${p.id}/automations`, "POST", morning);
    assert.equal((await call(`/api/projects/${p.id}/automations/${created.body.id}/run`, "POST")).status, 501);
  });
});

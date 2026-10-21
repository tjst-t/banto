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
import { AutomationWebhooks } from "../automation/webhook.js";
import { createApp } from "./app.js";
import { Supervisors } from "../supervisor/supervisors.js";
import { supervisorPolicy } from "../supervisor/policy.js";

/** いま開いている試験の口（認証の要らない `/hooks/` を叩くのに使う） */
let lastBase = "";

async function withApp(
  fn: (call: (path: string, method?: string, body?: unknown) => Promise<{ status: number; body: any }>, deps: { projectThread: ProjectThreadStore; threadTurns: ThreadTurns; automations: AutomationStore; ran: string[] }) => Promise<void>, // any: 試験で応答の形を自由に読む
  opts: { withRunner?: boolean; withWebhooks?: boolean } = {},
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
    const webhooks = opts.withWebhooks
      ? new AutomationWebhooks({
          dataDir: dir,
          automations,
          runner: { run: async () => ({ runId: "r1", result: "running" as const }) },
          onTurnEnded: () => {},
          containerProjectOf: async () => undefined,
          resolveSecret: async (alias) => {
            if (alias !== "hook-secret") throw new Error(`alias "${alias}" はどの Vault にもありません`);
            return "k";
          },
          projectClosed: () => false,
        })
      : undefined;
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
      supervisors: new Supervisors({ automations, policy: (id) => supervisorPolicy(undefined, id), defaultTimeZone: "Asia/Tokyo" }),
      ...(opts.withRunner
        ? {
            automationRunner: {
              prepare: async <T>(a: T) => a,
              run: async (a: { id: string }, cause: string) => {
                ran.push(`${a.id}:${cause}`);
                return { runId: "r1", result: "running" as const };
              },
              threadClosed: async () => {},
            },
          }
        : {}),
      ...(webhooks ? { automationWebhooks: webhooks, webhookBaseUrl: "https://banto.example" } : {}),
      dataDir: dir,
      configDir: dir,
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    lastBase = base;
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
    // 「次は」は計算して添える（保存しない）。一時停止中は無い
    assert.ok(Date.parse(edited.body.nextFireAt) > Date.now(), "次の時刻が添えられていない");
    const paused = await call(one, "PATCH", { paused: true });
    assert.equal(paused.body.paused, true);
    assert.equal(paused.body.nextFireAt, undefined);
    assert.equal((await call(one, "PATCH", { paused: false })).body.paused, false);
    assert.equal((await call(one, "PATCH", {})).status, 400);

    assert.equal((await call(path, "POST", { ...morning, name: "" })).status, 400);
    assert.equal((await call(one, "DELETE")).status, 200);
    assert.equal((await call(one)).status, 404);
    assert.equal((await call(`/api/projects/nope/automations`)).status, 404);
  });
});

test("待てる出来事の一覧：出どころごと、banto 自身が先頭。知らない Project は 404", async () => {
  await withApp(async (call, { projectThread, automations }) => {
    const p = await projectThread.createProject("p", tmpdir());
    const crashed = { name: "service.crashed", title: "Service が落ちた", description: "落ちた", fields: { service: { type: "string" as const, title: "名前" } } };
    automations.setEventCatalog({
      find: (projectId, name) => (projectId === p.id && name === crashed.name ? crashed : undefined),
      list: (projectId) => (projectId === p.id ? [{ source: "service", events: [crashed] }] : []),
    });
    const listed = await call(`/api/projects/${p.id}/automation-events`);
    assert.equal(listed.status, 200);
    assert.deepEqual(
      listed.body.sources.map((s: { source: string; events: Array<{ name: string }> }) => [s.source, s.events.map((e) => e.name)]),
      [
        ["banto", ["banto.turn-decisions"]],
        ["service", ["service.crashed"]],
      ],
    );
    assert.equal(listed.body.sources[1].events[0].fields.service.title, "名前");
    assert.equal((await call(`/api/projects/nope/automation-events`)).status, 404);
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
      assert.deepEqual(started.body, { runId: "r1", result: "running" });
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

test("Webhook：作った応答でだけ受け口の URL を返し、印のハッシュは一覧にも出さない。/hooks/ は合言葉なしで届き、知らない印は 404", async () => {
  await withApp(
    async (call, { projectThread }) => {
      const project = await projectThread.createProject("p", tmpdir());
      const fields = {
        name: "CI",
        instruction: "落ちたジョブを調べて",
        source: { kind: "webhook", signature: { alias: "hook-secret" } },
        target: { kind: "dedicated", mode: "fresh" },
      };
      const missing = await call(`/api/projects/${project.id}/automations`, "POST", {
        ...fields,
        source: { kind: "webhook", signature: { alias: "nope" } },
      });
      assert.equal(missing.status, 400);
      assert.match(missing.body.error, /署名の鍵を Vault から引けませんでした/);
      assert.equal((await call(`/api/projects/${project.id}/automations`)).body.automations.length, 0, "引けなかったのに作った");

      const created = await call(`/api/projects/${project.id}/automations`, "POST", fields);
      assert.equal(created.status, 201);
      const url = created.body.webhookUrl as string;
      assert.match(url, /^https:\/\/banto\.example\/hooks\/[A-Za-z0-9_-]{32,}$/);
      assert.equal(created.body.webhookTokenHash, undefined);
      assert.deepEqual(created.body.source, {
        kind: "webhook",
        signature: { header: "X-Hub-Signature-256", alias: "hook-secret" },
        batchSeconds: 30,
        allowProjectContainer: false,
      });
      const listed = await call(`/api/projects/${project.id}/automations`);
      const shown = JSON.stringify(listed.body);
      assert.ok(!shown.includes(url.split("/hooks/")[1]!), "一覧に印が出ている");
      assert.ok(!shown.includes("webhookTokenHash"), "一覧に印のハッシュが出ている");
      // 認証の前で分かれる：合言葉なしで、署名の無い要求は 401、知らない印は 404
      const token = url.split("/hooks/")[1]!;
      const unsigned = await fetch(`${lastBase}/hooks/${token}`, { method: "POST", body: "{}" });
      assert.equal(unsigned.status, 401);
      assert.equal((await fetch(`${lastBase}/hooks/nope`, { method: "POST", body: "{}" })).status, 404);
      assert.equal((await fetch(`${lastBase}/hooks/`, { method: "POST", body: "{}" })).status, 404);
      // きっかけの種類は変えられない
      const kind = await call(`/api/projects/${project.id}/automations/${created.body.id}`, "PATCH", {
        source: { kind: "time", repeat: { kind: "daily", time: "9:00" }, timeZone: "UTC" },
      });
      assert.equal(kind.status, 400);
    },
    { withRunner: true, withWebhooks: true },
  );
});

// **番頭**（アーキ仕様 §4.5「番頭の作り」）。作る・一時停止・再開・消すは番頭の単位。自動化の一覧と1件ずつの口には出さない
test("番頭：作る・一覧・一時停止・再開・消すは番頭の単位。自動化の一覧と1件ずつの口には出ない。判断役がいれば 409、pauseJudges で置ける", async () => {
  await withApp(async (call, { projectThread }) => {
    const p = await projectThread.createProject("p", tmpdir());
    await projectThread.createBaseThread(p.id);
    const path = `/api/projects/${p.id}/supervisor`;
    assert.equal((await call(path)).status, 404);
    const judge = await call(`/api/projects/${p.id}/automations`, "POST", {
      name: "判断役",
      instruction: "決めて",
      source: { kind: "event", event: "banto.turn-decisions", batchSeconds: 0 },
    });
    assert.equal(judge.status, 201);

    const refused = await call(path, "POST", {});
    assert.equal(refused.status, 409);
    assert.match(refused.body.error, /判断役（自動化「判断役」）が動いています/);
    assert.equal((await call(path, "POST", { pauseJudges: "yes" })).status, 400);
    const created = await call(path, "POST", { pauseJudges: true });
    assert.equal(created.status, 201);
    assert.equal(created.body.automations.length, 4);
    assert.equal((await call(path, "POST", {})).status, 409, "2つ目の番頭を置けた");

    // 自動化の一覧には判断役だけ（止まっている）。番頭の自動化は1件ずつの口で触れない
    const listed = (await call(`/api/projects/${p.id}/automations`)).body.automations as Array<{ name: string; paused: boolean }>;
    assert.deepEqual(listed.map((a) => [a.name, a.paused]), [["判断役", true]]);
    const one = `/api/projects/${p.id}/automations/${created.body.automations[0].id}`;
    assert.equal((await call(one)).status, 404);
    assert.equal((await call(one, "PATCH", { paused: true })).status, 404);
    assert.equal((await call(one, "DELETE")).status, 404);
    // 番頭のいる Project では判断役を作れず・再開できない
    assert.equal((await call(`/api/projects/${p.id}/automations`, "POST", { name: "判断役2", instruction: "x", source: { kind: "event", event: "banto.turn-decisions" } })).status, 400);
    assert.equal((await call(`/api/projects/${p.id}/automations/${judge.body.id}`, "PATCH", { paused: false })).status, 400);

    const all = (await call("/api/supervisors")).body.supervisors as Array<{ id: string; projectId: string }>;
    assert.deepEqual(all.map((x) => x.projectId), [p.id]);
    const paused = await call(`${path}/pause`, "POST");
    assert.equal(paused.status, 200);
    assert.equal(paused.body.paused, true);
    assert.ok((paused.body.automations as Array<{ paused: boolean }>).every((a) => a.paused));
    const resumed = await call(`${path}/resume`, "POST");
    assert.equal(resumed.body.paused, false);
    assert.equal((await call(path, "DELETE")).status, 200);
    assert.equal((await call(path)).status, 404);
    assert.equal((await call(`${path}/pause`, "POST")).status, 404);
  });
});

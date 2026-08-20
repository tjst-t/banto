/**
 * AC-S654396-3-1: REST APIでプロジェクト・タスクの一覧/詳細/経緯を取得できる
 *
 * Tests use a real HTTP server bound to an OS-assigned port.
 * All requests go through node fetch (real HTTP client, no handler shortcuts).
 * Handler direct invocation is explicitly prohibited (Rule 2 / scenario note).
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { Daemon } from "@banto/daemon";
import type { BantoHarness, HarnessEvent } from "@banto/core";
import { ThreadRegistry, BantoHostServer } from "@banto/host";
import { TRUNK } from "./threadSpecs.js";

describe("[AC-S654396-3-1] REST API: projects, tasks, events", () => {
  let tmpDir: string;
  let daemon: Daemon;
  let base: string;

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "banto-rest-"));
    daemon = Daemon.create({ port: 0, dataDir: tmpDir, disableAutoSpawn: true });
    await daemon.start();
    base = `http://localhost:${daemon.port}`;
  });

  after(async () => {
    await daemon.stop();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("[AC-S654396-3-1] GET /api/v1/health returns 200 ok", async () => {
    const res = await fetch(`${base}/api/v1/health`);
    assert.equal(res.status, 200);
    const body = await res.json() as Record<string, unknown>;
    assert.equal(body["status"], "ok");
  });

  it("[AC-S654396-3-1] GET /api/v1/projects returns empty list initially", async () => {
    const res = await fetch(`${base}/api/v1/projects`);
    assert.equal(res.status, 200);
    const body = await res.json() as { projects: unknown[] };
    assert.ok(Array.isArray(body.projects));
    assert.equal(body.projects.length, 0);
  });

  it("[AC-S654396-3-1] POST /api/v1/projects registers a project (201)", async () => {
    const res = await fetch(`${base}/api/v1/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "proj-a", repoPath: "/repos/proj-a", profile: "default" }),
    });
    assert.equal(res.status, 201);
    const body = await res.json() as { id: string };
    assert.equal(body.id, "proj-a");
  });

  it("[AC-S654396-3-1] GET /api/v1/projects lists the registered project", async () => {
    const res = await fetch(`${base}/api/v1/projects`);
    assert.equal(res.status, 200);
    const body = await res.json() as { projects: Array<{ id: string; repoPath: string }> };
    assert.ok(Array.isArray(body.projects));
    assert.equal(body.projects.length, 1);
    assert.equal(body.projects[0].id, "proj-a");
    assert.equal(body.projects[0].repoPath, "/repos/proj-a");
  });

  it("[AC-S654396-3-1] POST /api/v1/projects/proj-a/tasks creates a task in draft", async () => {
    const res = await fetch(`${base}/api/v1/projects/proj-a/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "task-0001", title: "Test task one" }),
    });
    assert.equal(res.status, 201);
    const body = await res.json() as { task: { id: string; status: string } };
    assert.equal(body.task.id, "task-0001");
    assert.equal(body.task.status, "draft");
  });

  it("[AC-S654396-3-1] GET /api/v1/projects/proj-a/tasks lists tasks", async () => {
    const res = await fetch(`${base}/api/v1/projects/proj-a/tasks`);
    assert.equal(res.status, 200);
    const body = await res.json() as { tasks: Array<{ id: string; status: string }> };
    assert.ok(Array.isArray(body.tasks));
    const task = body.tasks.find((t) => t.id === "task-0001");
    assert.ok(task !== undefined, "task-0001 must be in list");
    assert.equal(task.status, "draft");
  });

  it("[AC-S654396-3-1] GET /api/v1/projects/proj-a/tasks/task-0001 returns task detail", async () => {
    const res = await fetch(`${base}/api/v1/projects/proj-a/tasks/task-0001`);
    assert.equal(res.status, 200);
    const body = await res.json() as { task: { id: string; status: string; projectTag: string; title: string } };
    assert.equal(body.task.id, "task-0001");
    assert.equal(body.task.status, "draft");
    assert.equal(body.task.projectTag, "proj-a");
    assert.equal(body.task.title, "Test task one");
  });

  it("[AC-S654396-3-1] POST /api/v1/projects/proj-a/tasks/task-0001/transition transitions state", async () => {
    // Also need a second task to test scenario step 2 task status: implementing
    await fetch(`${base}/api/v1/projects/proj-a/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "task-0002", title: "Test task two" }),
    });

    // Transition task-0001 draft → queued.
    // With Scc9152-2 gate evaluation: if task has no deps and no scope overlap,
    // the gate fires immediately and promotes the task to 'ready' within the
    // same HTTP call. The response body reflects the post-gate status.
    const res = await fetch(`${base}/api/v1/projects/proj-a/tasks/task-0001/transition`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ to: "queued" }),
    });
    assert.equal(res.status, 200);
    const body = await res.json() as { task: { id: string; status: string } };
    // Accept 'queued' (gate not yet evaluated) OR 'ready' (gate passed inline).
    const validStatuses = new Set(["queued", "ready"]);
    assert.ok(
      validStatuses.has(body.task.status),
      `task status must be 'queued' or 'ready' after draft→queued transition, got '${body.task.status}'`
    );
  });

  it("[AC-S654396-3-1] POST transition with invalid target returns 400 + rejection", async () => {
    // task-0001 is now in queued or ready state; try to jump to 'closed' (invalid from both)
    const res = await fetch(`${base}/api/v1/projects/proj-a/tasks/task-0001/transition`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ to: "closed" }),
    });
    assert.equal(res.status, 400);
    const body = await res.json() as { error: string };
    assert.ok(typeof body.error === "string" && body.error.length > 0);
  });

  it("[AC-S654396-3-1] GET /api/v1/projects/proj-a/tasks/task-0001/events returns event history", async () => {
    const res = await fetch(`${base}/api/v1/projects/proj-a/tasks/task-0001/events`);
    assert.equal(res.status, 200);
    const body = await res.json() as { events: Array<{ eventId: number; type: string; timestamp: string }> };
    assert.ok(Array.isArray(body.events));
    // Must have task_created + state_transitioned(queued) + transition_rejected(closed)
    assert.ok(body.events.length >= 3, `Expected >= 3 events, got ${body.events.length}`);
    // Events must be in eventId order
    for (let i = 1; i < body.events.length; i++) {
      assert.ok(
        body.events[i].eventId > body.events[i - 1].eventId,
        "events must be in eventId order"
      );
    }
    // First event must be task_created
    assert.equal(body.events[0].type, "task_created");
    // Second event must be state_transitioned to queued
    const transition = body.events.find((e) => e.type === "state_transitioned");
    assert.ok(transition !== undefined, "state_transitioned event must be present");
  });

  it("[AC-S654396-3-1] GET non-existent task returns 404 with error: not_found", async () => {
    const res = await fetch(`${base}/api/v1/projects/proj-a/tasks/task-9999`);
    assert.equal(res.status, 404);
    const body = await res.json() as { error: string };
    assert.equal(body.error, "not_found");
  });

  it("[AC-S654396-3-1] unknown route returns 404", async () => {
    const res = await fetch(`${base}/api/v1/unknown`);
    assert.equal(res.status, 404);
  });

  /**
   * Regression: malformed JSON body must return 400 {"error":"..."}, not 500.
   * Applies to any POST endpoint that reads a body.
   */
  it("[AC-S654396-3-1-reg] POST with invalid JSON body returns 400 with error field", async () => {
    const res = await fetch(`${base}/api/v1/projects/proj-a/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{ not valid json",
    });
    assert.equal(res.status, 400, "invalid JSON body must yield 400, not 500");
    const body = await res.json() as { error: string };
    assert.ok(typeof body.error === "string" && body.error.length > 0, 'response must have {"error":"..."}');
  });

  it("[AC-S654396-3-1-reg] POST /api/v1/projects with invalid JSON body returns 400", async () => {
    const res = await fetch(`${base}/api/v1/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{ bad json",
    });
    assert.equal(res.status, 400, "invalid JSON body on project registration must yield 400");
    const body = await res.json() as { error: string };
    assert.ok(typeof body.error === "string" && body.error.length > 0, 'response must have {"error":"..."}');
  });

  it("[AC-S654396-3-1-reg] POST /api/v1/projects/proj-a/tasks/:id/transition with invalid JSON body returns 400", async () => {
    const res = await fetch(`${base}/api/v1/projects/proj-a/tasks/task-0001/transition`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not-json-at-all",
    });
    assert.equal(res.status, 400, "invalid JSON body on transition must yield 400");
    const body = await res.json() as { error: string };
    assert.ok(typeof body.error === "string" && body.error.length > 0, 'response must have {"error":"..."}');
  });
});

/**
 * [task-0301/a4] banto-host が自分の同一性を名乗る口を持つ。
 *
 * `GET /api/instance` は `packages/banto-host/src/server.ts` の REST 面——Kobo の
 * `Daemon` とは別物だが、この repo の REST API 面をまとめて確かめる場所としてここに置く。
 *
 * レビュー環境（`docker/dev.yaml`）で web が映しているのが本当にブランチのホストかを
 * 機械で見分けるための口。`instanceId` が**起動ごとに変わる**ことまで確かめないと、
 * 「口が存在する」だけでは同一性の証にならない（固定値を返しても素通りしてしまう）。
 */
class FakeSession implements BantoHarness {
  readonly sessionId = "test-session";
  isStreaming = false;
  private listeners = new Set<(event: HarnessEvent) => void>();

  subscribe(listener: (event: HarnessEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async prompt(): Promise<void> {}
  async abort(): Promise<void> {}

  readonly backendId = "fake";
  contextWindow(): number | undefined {
    return undefined;
  }
  contextTokens(): number | undefined {
    return undefined;
  }
  messageCount(): number {
    return 0;
  }
  transcript(): string {
    return "";
  }
  async startChapter(): Promise<void> {}
}

async function startFakeHost(): Promise<BantoHostServer> {
  const threads = new ThreadRegistry(async () => ({ harness: new FakeSession(), tools: [] }));
  await threads.open(TRUNK);
  return BantoHostServer.start({ threads, port: 0 });
}

describe("[task-0301/a4] GET /api/instance — banto-host の同一性", () => {
  it("instanceId・dataDir・startedAt を返す", async () => {
    const server = await startFakeHost();
    try {
      const res = await fetch(`http://127.0.0.1:${server.port}/api/instance`);
      assert.equal(res.status, 200);
      const body = (await res.json()) as { instanceId: string; dataDir: string; startedAt: string };
      assert.ok(typeof body.instanceId === "string" && body.instanceId.length > 0, "instanceId が空");
      assert.ok(typeof body.dataDir === "string" && body.dataDir.length > 0, "dataDir が空");
      assert.ok(typeof body.startedAt === "string" && !Number.isNaN(Date.parse(body.startedAt)), "startedAt が日時になっていない");
    } finally {
      await server.close();
    }
  });

  it("instanceId は起動ごとに変わる", async () => {
    const serverA = await startFakeHost();
    const serverB = await startFakeHost();
    try {
      const [bodyA, bodyB] = await Promise.all([
        fetch(`http://127.0.0.1:${serverA.port}/api/instance`).then((r) => r.json()) as Promise<{ instanceId: string }>,
        fetch(`http://127.0.0.1:${serverB.port}/api/instance`).then((r) => r.json()) as Promise<{ instanceId: string }>,
      ]);
      assert.notEqual(bodyA.instanceId, bodyB.instanceId, "2つの起動が同じ instanceId を名乗っている");
    } finally {
      await serverA.close();
      await serverB.close();
    }
  });
});

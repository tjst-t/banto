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

describe("[AC-S654396-3-1] REST API: projects, tasks, events", () => {
  let tmpDir: string;
  let daemon: Daemon;
  let base: string;

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "banto-rest-"));
    daemon = Daemon.create({ port: 0, dataDir: tmpDir });
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

    // Transition task-0001 draft → queued
    const res = await fetch(`${base}/api/v1/projects/proj-a/tasks/task-0001/transition`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ to: "queued" }),
    });
    assert.equal(res.status, 200);
    const body = await res.json() as { task: { id: string; status: string } };
    assert.equal(body.task.status, "queued");
  });

  it("[AC-S654396-3-1] POST transition with invalid target returns 400 + rejection", async () => {
    // task-0001 is now queued; try to jump to 'closed' (invalid)
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

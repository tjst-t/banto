/**
 * AC-S654396-3-3: 複数プロジェクト登録、<project>/<id>形式のグローバル参照解決
 *
 * Verifies that:
 * - Multiple projects can be registered
 * - Tasks with the same ID in different projects are independent
 * - Global reference GET /api/v1/tasks/:proj/:id correctly isolates by projectTag
 *
 * Uses real HTTP server (port=0) and fetch. No handler shortcuts.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { Daemon } from "@banto/daemon";

describe("[AC-S654396-3-3] Project registry: multi-project, global reference resolution", () => {
  let tmpDir: string;
  let daemon: Daemon;
  let base: string;

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "banto-registry-"));
    daemon = Daemon.create({ port: 0, dataDir: tmpDir, disableAutoSpawn: true });
    await daemon.start();
    base = `http://localhost:${daemon.port}`;
  });

  after(async () => {
    await daemon.stop();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("[AC-S654396-3-3] step 1: POST /api/v1/projects registers proj-a (201)", async () => {
    const res = await fetch(`${base}/api/v1/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "proj-a", repoPath: "/repos/proj-a", profile: "default" }),
    });
    assert.equal(res.status, 201);
    const body = await res.json() as { id: string };
    assert.equal(body.id, "proj-a");
  });

  it("[AC-S654396-3-3] step 2: POST /api/v1/projects registers proj-b (201)", async () => {
    const res = await fetch(`${base}/api/v1/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "proj-b", repoPath: "/repos/proj-b", profile: "default" }),
    });
    assert.equal(res.status, 201);
    const body = await res.json() as { id: string };
    assert.equal(body.id, "proj-b");
  });

  it("[AC-S654396-3-3] GET /api/v1/projects lists both projects", async () => {
    const res = await fetch(`${base}/api/v1/projects`);
    assert.equal(res.status, 200);
    const body = await res.json() as { projects: Array<{ id: string }> };
    const ids = body.projects.map((p) => p.id);
    assert.ok(ids.includes("proj-a"), "proj-a must be in project list");
    assert.ok(ids.includes("proj-b"), "proj-b must be in project list");
  });

  it("[AC-S654396-3-3] step 3: create task-0001 in proj-a", async () => {
    const res = await fetch(`${base}/api/v1/projects/proj-a/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "task-0001", title: "proj-a task one" }),
    });
    assert.equal(res.status, 201);
    const body = await res.json() as { task: { id: string; projectTag: string } };
    assert.equal(body.task.id, "task-0001");
    assert.equal(body.task.projectTag, "proj-a");
  });

  it("[AC-S654396-3-3] step 3: create task-0001 in proj-b (same ID, different project)", async () => {
    const res = await fetch(`${base}/api/v1/projects/proj-b/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "task-0001", title: "proj-b task one" }),
    });
    assert.equal(res.status, 201);
    const body = await res.json() as { task: { id: string; projectTag: string } };
    assert.equal(body.task.id, "task-0001");
    assert.equal(body.task.projectTag, "proj-b");
  });

  it("[AC-S654396-3-3] step 3: GET /api/v1/tasks/proj-a/task-0001 resolves to proj-a", async () => {
    const res = await fetch(`${base}/api/v1/tasks/proj-a/task-0001`);
    assert.equal(res.status, 200);
    const body = await res.json() as { task: { id: string; projectTag: string; title: string } };
    assert.equal(body.task.id, "task-0001");
    assert.equal(body.task.projectTag, "proj-a");
    assert.equal(body.task.title, "proj-a task one");
  });

  it("[AC-S654396-3-3] step 4: GET /api/v1/tasks/proj-b/task-0001 resolves to proj-b (separate object)", async () => {
    const res = await fetch(`${base}/api/v1/tasks/proj-b/task-0001`);
    assert.equal(res.status, 200);
    const body = await res.json() as { task: { id: string; projectTag: string; title: string } };
    assert.equal(body.task.id, "task-0001");
    assert.equal(body.task.projectTag, "proj-b");
    assert.equal(body.task.title, "proj-b task one");
  });

  it("[AC-S654396-3-3] proj-a and proj-b task-0001 are independent objects", async () => {
    const resA = await fetch(`${base}/api/v1/tasks/proj-a/task-0001`);
    const resB = await fetch(`${base}/api/v1/tasks/proj-b/task-0001`);
    const bodyA = await resA.json() as { task: { title: string; projectTag: string } };
    const bodyB = await resB.json() as { task: { title: string; projectTag: string } };

    // Same ID but different projects — must be distinct objects
    assert.notEqual(bodyA.task.title, bodyB.task.title, "Titles must differ");
    assert.notEqual(bodyA.task.projectTag, bodyB.task.projectTag, "ProjectTags must differ");
  });

  it("[AC-S654396-3-3] duplicate project registration returns 409", async () => {
    const res = await fetch(`${base}/api/v1/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "proj-a", repoPath: "/repos/proj-a-dup" }),
    });
    assert.equal(res.status, 409);
    const body = await res.json() as { error: string };
    assert.ok(typeof body.error === "string" && body.error.length > 0);
  });

  it("[AC-S654396-3-3] GET tasks for unknown project returns 404", async () => {
    const res = await fetch(`${base}/api/v1/projects/proj-unknown/tasks`);
    assert.equal(res.status, 404);
  });

  /**
   * Regression: EventIndex project-namespace isolation (spec-multi-project §2).
   * Two projects share the same taskId. /events for each project must return
   * only that project's events — no cross-project leakage.
   */
  it("[AC-S654396-3-3-reg] events endpoint returns only own-project events when same taskId exists in two projects", async () => {
    // Transition task-0001 in proj-a to queued, so it has 2 events (created + transitioned)
    await fetch(`${base}/api/v1/projects/proj-a/tasks/task-0001/transition`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ to: "queued" }),
    });

    // proj-a/task-0001/events must only contain proj-a events
    const resA = await fetch(`${base}/api/v1/projects/proj-a/tasks/task-0001/events`);
    assert.equal(resA.status, 200);
    const bodyA = await resA.json() as { events: Array<{ projectTag: string; type: string }> };
    assert.ok(Array.isArray(bodyA.events), "proj-a events must be an array");
    assert.ok(bodyA.events.length >= 1, "proj-a must have at least 1 event for task-0001");
    for (const evt of bodyA.events) {
      assert.equal(
        evt.projectTag,
        "proj-a",
        `proj-a/task-0001/events must not contain proj-b events (got projectTag=${evt.projectTag})`
      );
    }

    // proj-b/task-0001/events must only contain proj-b events
    const resB = await fetch(`${base}/api/v1/projects/proj-b/tasks/task-0001/events`);
    assert.equal(resB.status, 200);
    const bodyB = await resB.json() as { events: Array<{ projectTag: string; type: string }> };
    assert.ok(Array.isArray(bodyB.events), "proj-b events must be an array");
    assert.ok(bodyB.events.length >= 1, "proj-b must have at least 1 event for task-0001");
    for (const evt of bodyB.events) {
      assert.equal(
        evt.projectTag,
        "proj-b",
        `proj-b/task-0001/events must not contain proj-a events (got projectTag=${evt.projectTag})`
      );
    }

    // The two event sets must be disjoint: no shared eventIds
    const idsA = new Set(bodyA.events.map((e) => (e as { eventId?: number }).eventId));
    for (const evt of bodyB.events) {
      const id = (evt as { eventId?: number }).eventId;
      assert.ok(
        !idsA.has(id),
        `eventId ${String(id)} appears in both proj-a and proj-b event histories — cross-project leakage`
      );
    }
  });
});

/**
 * S75f66b-1: watcherのstatus:queuedのみenqueue（imp-0001 fix）
 *
 * AC-S75f66b-1-1: status:draft ファイルはスキーマ検証のみ — タスク作成なし
 * AC-S75f66b-1-2: draft→queued 書き換えで初めてenqueue（回帰: 直接queued投入も動く）
 * AC-S75f66b-1-3: status:draft でもfrontmatterが不正なら task_ingest_rejected
 *
 * scenario-S75f66b-1.json の全ステップを機械的に実行する。
 *
 * Test discipline (Rule 2, story_type=api):
 *   - Real Daemon instance (port 0), observed via HTTP API only.
 *   - No direct calls to watcher internals.
 *   - pollUntil drives HTTP GETs until the expected state is observed.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { Daemon } from "@banto/daemon";

/** Poll fn() until pred passes or timeout expires. Returns last value. */
async function pollUntil<T>(
  fn: () => Promise<T>,
  pred: (val: T) => boolean,
  timeoutMs: number = 5000,
  intervalMs: number = 200
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const val = await fn();
    if (pred(val)) return val;
    if (Date.now() >= deadline) return val;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

/** Wait for at least N watcher poll cycles (intervalMs * n + margin). */
async function waitPolls(intervalMs: number, n: number): Promise<void> {
  await new Promise((r) => setTimeout(r, intervalMs * n + 100));
}

// ── scenario-1: draft stays out, draft→queued ingest, direct-queued regression ──

describe("[AC-S75f66b-1-1] [AC-S75f66b-1-2] scenario-1: draft→queued flip and regression", () => {
  const INTERVAL_MS = 200;
  let tmpDataDir: string;
  let tmpRepoDir: string;
  let daemon: Daemon;
  let base: string;

  before(async () => {
    tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "banto-ds1-data-"));
    tmpRepoDir = fs.mkdtempSync(path.join(os.tmpdir(), "banto-ds1-repo-"));
    fs.mkdirSync(path.join(tmpRepoDir, "work", "tasks"), { recursive: true });

    await daemon.start();
    base = `http://localhost:${daemon.port}`;

    // Precondition: Project 'proj' registered
    const res = await fetch(`${base}/api/v1/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "proj", repoPath: tmpRepoDir }),
    });
    assert.equal(res.status, 201, "project registration must succeed");
  });

  after(async () => {
    await daemon.stop();
    fs.rmSync(tmpDataDir, { recursive: true, force: true });
    fs.rmSync(tmpRepoDir, { recursive: true, force: true });
  });

  // scenario-1 step 1 → AC-S75f66b-1-1
  it("[AC-S75f66b-1-1] step-1: draft file placed — task NOT created after ≥2 polls", async () => {
    // Action: PO writes task-0001.md with valid frontmatter and status: draft
    const taskFile = path.join(tmpRepoDir, "work", "tasks", "task-0001.md");
    fs.writeFileSync(taskFile, `---
id: task-0001
type: task
kind: feature
title: Draft task
status: draft
scope:
  paths: [src/**]
acceptance:
  - { id: a1, text: Draft acceptance }
---

Draft task body.
`, "utf-8");

    // Wait ≥2 poll cycles
    await waitPolls(INTERVAL_MS, 2);

    // Expected: task-0001 must NOT appear in GET /tasks
    const tasksRes = await fetch(`${base}/api/v1/projects/proj/tasks`);
    assert.equal(tasksRes.status, 200, "GET /tasks must return 200");
    const tasksBody = await tasksRes.json() as { tasks: Array<{ id: string }> };
    const found = tasksBody.tasks.find((t) => t.id === "task-0001");
    assert.equal(found, undefined, "task-0001 must NOT be in the task list when status is draft");

    // Expected: no task_created or state_transitioned event for task-0001 in project events
    const eventsRes = await fetch(`${base}/api/v1/projects/proj/events`);
    assert.equal(eventsRes.status, 200, "GET /events must return 200");
    const eventsBody = await eventsRes.json() as {
      events: Array<{ type: string; taskId?: string; id?: string }>;
    };
    const task0001Events = eventsBody.events.filter(
      (e) => e.taskId === "task-0001" || e.id === "task-0001"
    );
    const hasCreated = task0001Events.some((e) => e.type === "task_created");
    const hasTransitioned = task0001Events.some((e) => e.type === "state_transitioned");
    assert.equal(hasCreated, false, "task_created event must NOT exist for draft task");
    assert.equal(hasTransitioned, false, "state_transitioned event must NOT exist for draft task");
  });

  // scenario-1 step 2 → AC-S75f66b-1-2
  it("[AC-S75f66b-1-2] step-2: draft→queued edit — task ingested and reaches 'queued' or beyond", async () => {
    // Action: PO edits task-0001.md changing status: draft → status: queued (mtime changes)
    const taskFile = path.join(tmpRepoDir, "work", "tasks", "task-0001.md");
    fs.writeFileSync(taskFile, `---
id: task-0001
type: task
kind: feature
title: Draft task
status: queued
scope:
  paths: [src/**]
acceptance:
  - { id: a1, text: Draft acceptance }
---

Draft task body (now queued).
`, "utf-8");

    // Expected: task-0001 appears with status 'queued' (or more advanced after gate eval)
    const PAST_QUEUED = new Set([
      "queued", "ready", "planning", "implementing", "auditing",
      "review-ready", "in-review", "approved", "merging", "merged",
      "evaluating", "closed",
    ]);
    const taskResult = await pollUntil(
      async () => {
        const res = await fetch(`${base}/api/v1/projects/proj/tasks/task-0001`);
        if (res.status !== 200) return null;
        const body = await res.json() as { task: { status: string } };
        return body.task;
      },
      (task) => task !== null && PAST_QUEUED.has(task.status),
      5000
    );

    assert.ok(taskResult !== null, "task-0001 must exist after draft→queued flip");
    assert.ok(
      PAST_QUEUED.has(taskResult!.status),
      `task status must be queued or beyond (got '${taskResult!.status}')`
    );

    // Expected: task_created followed by state_transitioned(draft→queued) events
    const eventsResult = await pollUntil(
      async () => {
        const res = await fetch(`${base}/api/v1/projects/proj/tasks/task-0001/events`);
        if (res.status !== 200) return [] as Array<{ type: string; from?: string; to?: string }>;
        const body = await res.json() as {
          events: Array<{ type: string; from?: string; to?: string }>;
        };
        return body.events;
      },
      (events) => {
        const hasCreated = events.some((e) => e.type === "task_created");
        const hasTransitioned = events.some(
          (e) => e.type === "state_transitioned" && e.from === "draft" && e.to === "queued"
        );
        return hasCreated && hasTransitioned;
      },
      5000
    );

    const hasCreated = eventsResult.some((e) => e.type === "task_created");
    const hasTransitioned = eventsResult.some(
      (e) => e.type === "state_transitioned" && e.from === "draft" && e.to === "queued"
    );
    assert.ok(hasCreated, "events must include task_created after draft→queued flip");
    assert.ok(
      hasTransitioned,
      "events must include state_transitioned(draft→queued) after flip"
    );
  });

  // scenario-1 step 3 → AC-S75f66b-1-2 regression
  it("[AC-S75f66b-1-2] step-3 regression: new file with status:queued directly is ingested", async () => {
    // Action: PO writes a NEW file task-0002.md with status: queued directly
    const taskFile = path.join(tmpRepoDir, "work", "tasks", "task-0002.md");
    fs.writeFileSync(taskFile, `---
id: task-0002
type: task
kind: fix
title: Direct queued task
status: queued
scope:
  paths: [src/**]
acceptance:
  - { id: a1, text: Direct acceptance }
---

Direct queued task body.
`, "utf-8");

    // Expected: task-0002 appears with status 'queued' or beyond
    const PAST_QUEUED = new Set([
      "queued", "ready", "planning", "implementing", "auditing",
      "review-ready", "in-review", "approved", "merging", "merged",
      "evaluating", "closed",
    ]);
    const taskResult = await pollUntil(
      async () => {
        const res = await fetch(`${base}/api/v1/projects/proj/tasks/task-0002`);
        if (res.status !== 200) return null;
        const body = await res.json() as { task: { status: string } };
        return body.task;
      },
      (task) => task !== null && PAST_QUEUED.has(task.status),
      5000
    );

    assert.ok(taskResult !== null, "task-0002 must exist when placed with status:queued directly");
    assert.ok(
      PAST_QUEUED.has(taskResult!.status),
      `task-0002 status must be queued or beyond (got '${taskResult!.status}')`
    );
  });
});

// ── scenario-2: invalid draft emits task_ingest_rejected ──

describe("[AC-S75f66b-1-3] scenario-2: invalid draft file emits task_ingest_rejected", () => {
  const INTERVAL_MS = 200;
  let tmpDataDir: string;
  let tmpRepoDir: string;
  let daemon: Daemon;
  let base: string;

  before(async () => {
    tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "banto-ds2-data-"));
    tmpRepoDir = fs.mkdtempSync(path.join(os.tmpdir(), "banto-ds2-repo-"));
    fs.mkdirSync(path.join(tmpRepoDir, "work", "tasks"), { recursive: true });

    await daemon.start();
    base = `http://localhost:${daemon.port}`;

    const res = await fetch(`${base}/api/v1/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "proj", repoPath: tmpRepoDir }),
    });
    assert.equal(res.status, 201, "project registration must succeed");
  });

  after(async () => {
    await daemon.stop();
    fs.rmSync(tmpDataDir, { recursive: true, force: true });
    fs.rmSync(tmpRepoDir, { recursive: true, force: true });
  });

  // scenario-2 step 1 → AC-S75f66b-1-3
  it("[AC-S75f66b-1-3] step-1: invalid draft (missing scope) → task_ingest_rejected with reason", async () => {
    // Action: PO writes bad-draft.md with status: draft but missing required 'scope' field
    const badFile = path.join(tmpRepoDir, "work", "tasks", "bad-draft.md");
    fs.writeFileSync(badFile, `---
id: task-0099
type: task
kind: feature
title: Invalid draft task
status: draft
acceptance:
  - { id: a1, text: Some acceptance }
---

This draft is missing the required scope field.
`, "utf-8");

    // Expected: task_ingest_rejected event with filePath ending in bad-draft.md
    // and a reason naming the missing field.
    type RejectedEvent = { type: string; filePath?: string; reason?: string; taskId?: string };

    const events = await pollUntil<RejectedEvent[]>(
      async () => {
        const res = await fetch(`${base}/api/v1/projects/proj/events`);
        if (res.status !== 200) return [];
        const body = await res.json() as { events: RejectedEvent[] };
        return body.events;
      },
      (evts) =>
        evts.some(
          (e) =>
            e.type === "task_ingest_rejected" &&
            typeof e.filePath === "string" &&
            e.filePath.endsWith("bad-draft.md")
        ),
      5000
    );

    const rejected = events.find(
      (e) =>
        e.type === "task_ingest_rejected" &&
        typeof e.filePath === "string" &&
        e.filePath.endsWith("bad-draft.md")
    );
    assert.ok(rejected, "must have a task_ingest_rejected event with filePath ending in bad-draft.md");
    assert.ok(
      typeof rejected!.reason === "string" && rejected!.reason.length > 0,
      "rejection event must carry a non-empty reason"
    );
    assert.ok(
      rejected!.reason!.includes("scope"),
      `reason "${rejected!.reason}" must name the missing 'scope' field`
    );

    // Expected: no task created for this file
    const tasksRes = await fetch(`${base}/api/v1/projects/proj/tasks`);
    assert.equal(tasksRes.status, 200);
    const tasksBody = await tasksRes.json() as { tasks: Array<{ id: string }> };
    const badTask = tasksBody.tasks.find((t) => t.id === "task-0099");
    assert.equal(badTask, undefined, "no task must be created for the invalid draft file");

    // Expected: no task_created event for this file
    const taskCreatedEvents = events.filter((e) => e.type === "task_created");
    const hasCreatedForBad = taskCreatedEvents.some((e) => e.taskId === "task-0099");
    assert.equal(hasCreatedForBad, false, "task_created must NOT exist for invalid draft");
  });
});

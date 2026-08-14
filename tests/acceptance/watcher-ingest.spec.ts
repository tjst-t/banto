/**
 * AC-Scc9152-1-1: スキーマ適合のタスク定義を置くと draft→queued に遷移しイベント記録
 *
 * Uses a real Daemon instance (port 0) with a real tmpRepoDir.
 * Polling interval set to 500ms for test speed.
 * Observes only via HTTP API — never calls watcher internals directly.
 *
 * NOTE (Scc9152-2 update): gate re-evaluation now fires immediately after each
 * state transition. A task with no dependencies and no overlapping unreviewed
 * ancestors is promoted directly from queued → ready without waiting for a tick.
 * The AC remains satisfied: draft→queued transition IS recorded in the event log;
 * the task just passes the gate immediately and advances further to 'ready'.
 * Status assertions are updated to accept 'queued' OR any more-advanced state.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { Daemon } from "@banto/daemon";

/** Poll an HTTP GET until predicate passes or timeout expires */
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
    if (Date.now() >= deadline) {
      return val; // return last value; caller will assert
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

describe("[AC-Scc9152-1-1] Watcher ingests valid task definition → draft→queued", () => {
  let tmpDataDir: string;
  let tmpRepoDir: string;
  let daemon: Daemon;
  let base: string;

  before(async () => {
    tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "banto-wi-data-"));
    tmpRepoDir = fs.mkdtempSync(path.join(os.tmpdir(), "banto-wi-repo-"));

    // Create work/tasks/ directory
    fs.mkdirSync(path.join(tmpRepoDir, "work", "tasks"), { recursive: true });

    await daemon.start();
    base = `http://localhost:${daemon.port}`;

    // Register the project
    const res = await fetch(`${base}/api/v1/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "proj-watcher", repoPath: tmpRepoDir }),
    });
    assert.equal(res.status, 201, "project registration should succeed");
  });

  after(async () => {
    await daemon.stop();
    fs.rmSync(tmpDataDir, { recursive: true, force: true });
    fs.rmSync(tmpRepoDir, { recursive: true, force: true });
  });

  it("[AC-Scc9152-1-1] places valid task file → task is ingested and reaches at least 'queued'", async () => {
    const taskFile = path.join(tmpRepoDir, "work", "tasks", "task-0001-test-ingest.md");
    // status: queued — only queued files are ingested by the watcher (imp-0001 PO decision)
    const content = `---
id: task-0001
type: task
kind: feature
title: テスト取り込みタスク
status: queued
scope:
  paths: [src/**]
acceptance:
  - { id: a1, text: 動作確認 }
---

## 背景

テスト用タスク。
`;
    fs.writeFileSync(taskFile, content, "utf-8");

    // Poll until task appears and has passed through queued (may advance to ready
    // immediately if the gate passes on the first evaluation — Scc9152-2 behaviour).
    // Accept 'queued' OR any more-advanced state (ready, planning, …).
    const PAST_QUEUED = new Set(["queued", "ready", "planning", "implementing", "auditing",
      "review-ready", "in-review", "approved", "merging", "merged", "evaluating", "closed"]);
    const taskResult = await pollUntil(
      async () => {
        const res = await fetch(`${base}/api/v1/projects/proj-watcher/tasks/task-0001`);
        if (res.status !== 200) return null;
        const body = await res.json() as { task: { status: string } };
        return body.task;
      },
      (task) => task !== null && PAST_QUEUED.has(task.status),
      5000
    );

    assert.ok(taskResult !== null, "task should exist after watcher polling");
    assert.ok(
      PAST_QUEUED.has(taskResult!.status),
      `task status must be queued or beyond (got '${taskResult!.status}')`
    );
  });

  it("[AC-Scc9152-1-1] GET /tasks/:id/events contains task_created and state_transitioned(draft→queued)", async () => {
    // Poll until events include state_transitioned to queued
    const eventsResult = await pollUntil(
      async () => {
        const res = await fetch(`${base}/api/v1/projects/proj-watcher/tasks/task-0001/events`);
        if (res.status !== 200) return [] as Array<{ type: string; from?: string; to?: string }>;
        const body = await res.json() as { events: Array<{ type: string; from?: string; to?: string }> };
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

    assert.ok(hasCreated, "events must include task_created");
    assert.ok(hasTransitioned, "events must include state_transitioned draft→queued");
  });

  it("[AC-Scc9152-1-1] file content is unchanged after watcher ingest (no write-back)", () => {
    const taskFile = path.join(tmpRepoDir, "work", "tasks", "task-0001-test-ingest.md");
    const contentAfter = fs.readFileSync(taskFile, "utf-8");
    // The frontmatter status must still say "queued" — the daemon must not write back
    // runtime state (e.g. advancing status to 'ready' or 'planning' in the file).
    assert.ok(
      contentAfter.includes("status: queued"),
      "frontmatter status must remain 'queued' — daemon must not write back runtime state"
    );
  });
});

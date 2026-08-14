/**
 * AC-Scc9152-1-2: 不正frontmatterは拒否+理由付きイベント(I2)
 *
 * Uses a real Daemon instance (port 0) with a real tmpRepoDir.
 * Polling interval set to 500ms for test speed.
 * Observes only via HTTP API — never calls watcher internals directly.
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
      return val;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

describe("[AC-Scc9152-1-2] Watcher rejects invalid task frontmatter with reason event", () => {
  let tmpDataDir: string;
  let tmpRepoDir: string;
  let daemon: Daemon;
  let base: string;

  before(async () => {
    tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "banto-wr-data-"));
    tmpRepoDir = fs.mkdtempSync(path.join(os.tmpdir(), "banto-wr-repo-"));

    fs.mkdirSync(path.join(tmpRepoDir, "work", "tasks"), { recursive: true });

    await daemon.start();
    base = `http://localhost:${daemon.port}`;

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

  it("[AC-Scc9152-1-2] malformed file (missing scope.paths) → task_ingest_rejected event with reason", async () => {
    const badFile = path.join(tmpRepoDir, "work", "tasks", "task-bad.md");
    // Missing the required 'scope' field
    const content = `---
id: task-bad
type: task
kind: feature
title: 不正タスク
status: draft
acceptance:
  - { id: a1, text: 動作確認 }
---

## 背景

scope.paths が欠けている不正ファイル。
`;
    fs.writeFileSync(badFile, content, "utf-8");

    // Poll project events until we see a task_ingest_rejected for this file
    type IngestRejectedEvent = {
      type: string;
      filePath?: string;
      reason?: string;
    };

    const events = await pollUntil<IngestRejectedEvent[]>(
      async () => {
        const res = await fetch(`${base}/api/v1/projects/proj-watcher/events`);
        if (res.status !== 200) return [];
        const body = await res.json() as { events: IngestRejectedEvent[] };
        return body.events;
      },
      (evts) =>
        evts.some(
          (e) =>
            e.type === "task_ingest_rejected" &&
            typeof e.filePath === "string" &&
            e.filePath.includes("task-bad.md")
        ),
      5000
    );

    const rejected = events.find(
      (e) =>
        e.type === "task_ingest_rejected" &&
        typeof e.filePath === "string" &&
        e.filePath.includes("task-bad.md")
    );

    assert.ok(rejected, "must have a task_ingest_rejected event for task-bad.md");
    assert.ok(
      typeof rejected!.reason === "string" && rejected!.reason.length > 0,
      "rejection event must carry a non-empty reason"
    );
    // Reason must identify the missing field
    assert.ok(
      rejected!.reason!.includes("scope"),
      `reason "${rejected!.reason}" must mention 'scope' (the missing field)`
    );
  });

  it("[AC-Scc9152-1-2] rejected file produces no task in the registry", async () => {
    const res = await fetch(`${base}/api/v1/projects/proj-watcher/tasks`);
    assert.equal(res.status, 200);
    const body = await res.json() as { tasks: Array<{ id: string }> };
    const badTask = body.tasks.find((t) => t.id === "task-bad");
    assert.ok(
      badTask === undefined,
      "rejected file must not create a task in the registry"
    );
  });

  it("[AC-Scc9152-1-2] file without valid frontmatter delimiter → task_ingest_rejected", async () => {
    const noFmFile = path.join(tmpRepoDir, "work", "tasks", "task-nofm.md");
    const content = `# No frontmatter here\n\nJust plain markdown.`;
    fs.writeFileSync(noFmFile, content, "utf-8");

    type IngestRejectedEvent = { type: string; filePath?: string; reason?: string };

    const events = await pollUntil<IngestRejectedEvent[]>(
      async () => {
        const res = await fetch(`${base}/api/v1/projects/proj-watcher/events`);
        if (res.status !== 200) return [];
        const body = await res.json() as { events: IngestRejectedEvent[] };
        return body.events;
      },
      (evts) =>
        evts.some(
          (e) =>
            e.type === "task_ingest_rejected" &&
            typeof e.filePath === "string" &&
            e.filePath.includes("task-nofm.md")
        ),
      5000
    );

    const rejected = events.find(
      (e) =>
        e.type === "task_ingest_rejected" &&
        typeof e.filePath === "string" &&
        e.filePath.includes("task-nofm.md")
    );
    assert.ok(rejected, "file without frontmatter must emit task_ingest_rejected");
  });
});

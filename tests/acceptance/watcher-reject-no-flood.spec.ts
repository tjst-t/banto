/**
 * Regression test for fix-1: invalid file must not flood events.
 *
 * Before the fix, skip condition was `prev && prev.mtimeMs === mtimeMs && prev.ingested`.
 * A rejected file set ingested=false, so it was re-processed (and re-emitted) on every
 * poll cycle, producing a task_ingest_rejected event flood.
 *
 * After the fix, skip condition is `prev && prev.mtimeMs === mtimeMs` — mtime unchanged
 * means "already processed", regardless of ingested flag.
 *
 * Verifies: invalid file placed once → at most 1 task_ingest_rejected event after
 * multiple polling cycles (3× interval).
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { Daemon } from "@banto/daemon";

describe("[Fix-1] Rejected file does not re-emit task_ingest_rejected on every poll", () => {
  let tmpDataDir: string;
  let tmpRepoDir: string;
  let daemon: Daemon;
  let base: string;
  const INTERVAL_MS = 300;

  before(async () => {
    tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "banto-noflood-data-"));
    tmpRepoDir = fs.mkdtempSync(path.join(os.tmpdir(), "banto-noflood-repo-"));
    fs.mkdirSync(path.join(tmpRepoDir, "work", "tasks"), { recursive: true });

    await daemon.start();
    base = `http://localhost:${daemon.port}`;

    const res = await fetch(`${base}/api/v1/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "proj-noflood", repoPath: tmpRepoDir }),
    });
    assert.equal(res.status, 201, "project registration should succeed");
  });

  after(async () => {
    await daemon.stop();
    fs.rmSync(tmpDataDir, { recursive: true, force: true });
    fs.rmSync(tmpRepoDir, { recursive: true, force: true });
  });

  it("[Fix-1] invalid file produces exactly 1 task_ingest_rejected across 3+ polling cycles", async () => {
    // Place an invalid task file (missing scope field)
    const badFile = path.join(tmpRepoDir, "work", "tasks", "task-flood.md");
    const content = `---
id: task-flood
type: task
kind: feature
title: Flood test task
status: draft
acceptance:
  - { id: a1, text: 確認 }
---

scope.pathsが欠けている不正ファイル
`;
    fs.writeFileSync(badFile, content, "utf-8");

    // Wait for at least 3 poll cycles (INTERVAL_MS × 3 + margin)
    await new Promise((r) => setTimeout(r, INTERVAL_MS * 3 + 200));

    // Fetch project events
    const res = await fetch(`${base}/api/v1/projects/proj-noflood/events`);
    assert.equal(res.status, 200);
    const body = await res.json() as { events: Array<{ type: string; filePath?: string }> };

    const rejectedEvents = body.events.filter(
      (e) =>
        e.type === "task_ingest_rejected" &&
        typeof e.filePath === "string" &&
        e.filePath.includes("task-flood.md")
    );

    // Must have at least 1 rejection (watcher did see the file)
    assert.ok(rejectedEvents.length >= 1, "must have at least one task_ingest_rejected event");
    // Must NOT have more than 1 (no event flood)
    assert.equal(
      rejectedEvents.length,
      1,
      `must have exactly 1 task_ingest_rejected, got ${rejectedEvents.length} (event flood detected)`
    );
  });
});

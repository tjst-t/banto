/**
 * AC-S654396-1-2: セグメント分割+切替時スナップショット。
 * リプレイは最新スナップショット+アクティブセグメントのみで完了することを検証する。
 *
 * Test discipline: consumer-style — only banto-core public API is used.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { EventLog, StateStore } from "@banto/core";

describe("[AC-S654396-1-2] Segment rotation and snapshot", () => {
  let tmpDir: string;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "banto-test-rotation-"));
  });

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("[AC-S654396-1-2] rotation generates snapshot; replay uses snapshot + active segment only", async () => {
    // Step 1: Open log, append events for task-0001, then rotate
    const log1 = EventLog.open(tmpDir);

    log1.append({
      type: "task_created",
      projectTag: "proj-a",
      taskId: "task-0001",
      payload: { title: "pre-rotation task" },
    });

    log1.append({
      type: "state_transitioned",
      projectTag: "proj-a",
      taskId: "task-0001",
      from: "draft",
      to: "queued",
    });

    // Build current state to produce snapshot at rotation time
    const storeBeforeRotation = StateStore.replay(log1);
    const archivedSeg = log1.rotate(storeBeforeRotation.toSnapshotState());

    // Verify archived segment exists
    const archivedSegPath = path.join(tmpDir, "events", archivedSeg);
    assert.ok(fs.existsSync(archivedSegPath), `archived segment ${archivedSeg} should exist`);

    // Verify snapshot file exists
    const snapshotPath = path.join(tmpDir, "snapshot.json");
    assert.ok(fs.existsSync(snapshotPath), "snapshot.json should exist after rotation");

    // Verify new active segment is different from archived
    assert.notEqual(
      log1.activeSegmentName,
      archivedSeg,
      "new active segment should differ from archived"
    );

    // Step 2: Append task-0002 to new active segment
    log1.append({
      type: "task_created",
      projectTag: "proj-a",
      taskId: "task-0002",
      payload: { title: "post-rotation task" },
    });

    log1.close();

    // Step 3: Replay on fresh instance — should use snapshot + active segment only
    const log2 = EventLog.open(tmpDir);
    const store2 = StateStore.replay(log2);
    log2.close();

    const stats = store2.replayStats();
    assert.equal(stats.snapshotUsed, true, "replay should use snapshot");
    // Only 1 event after snapshot (task-0002 creation)
    assert.equal(stats.eventsReplayed, 1, "should replay only 1 event (post-rotation)");

    // Step 4: Both tasks should be accessible
    const task1 = store2.getTask("task-0001");
    assert.ok(task1 !== undefined, "task-0001 should exist (from snapshot)");
    assert.equal(task1.status, "queued", "task-0001 status should be queued");
    assert.equal(task1.projectTag, "proj-a");
    assert.equal(task1.title, "pre-rotation task");

    const task2 = store2.getTask("task-0002");
    assert.ok(task2 !== undefined, "task-0002 should exist (from active segment)");
    assert.equal(task2.status, "draft", "task-0002 should be in draft status");
    assert.equal(task2.title, "post-rotation task");
  });
});

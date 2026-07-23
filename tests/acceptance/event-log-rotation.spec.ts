/**
 * AC-S654396-1-2: セグメント分割+切替時スナップショット。
 * リプレイは最新スナップショット+アクティブセグメントのみで完了することを検証する。
 *
 * Also covers:
 *   - Regression: same-month double-rotation segment name wraparound (fix 1)
 *   - I2: corrupt snapshot emits stderr warning; falls back to full replay
 *   - I2: unknown event type throws in StateStore.applyEvent
 *   - D3: task_approved / task_rejected do NOT update task status
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

describe("[AC-S654396-1-2-reg] Same-month double-rotation segment name wraparound regression", () => {
  it("[AC-S654396-1-2-reg] two rotations in the same month produce distinct segment names and all events survive full replay", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "banto-test-double-rot-"));
    try {
      // ── First rotation ────────────────────────────────────────────────────
      const log1 = EventLog.open(dir);
      log1.append({
        type: "task_created",
        projectTag: "proj-a",
        taskId: "task-0001",
        payload: { title: "first task" },
      });
      log1.append({
        type: "state_transitioned",
        projectTag: "proj-a",
        taskId: "task-0001",
        from: "draft",
        to: "queued",
      });

      const store1 = StateStore.replay(log1);
      const archived1 = log1.rotate(store1.toSnapshotState());
      const active1 = log1.activeSegmentName!;

      // The two names must be distinct
      assert.notEqual(active1, archived1, "first rotation: active segment must differ from archived");

      // Add an event to the new active segment
      log1.append({
        type: "task_created",
        projectTag: "proj-a",
        taskId: "task-0002",
        payload: { title: "second task" },
      });

      // ── Second rotation (same month) ──────────────────────────────────────
      const store2 = StateStore.replay(log1);
      const archived2 = log1.rotate(store2.toSnapshotState());
      const active2 = log1.activeSegmentName!;

      // Regression guard: the newly opened segment must NOT shadow an existing one
      assert.notEqual(active2, archived1, "second rotation: new segment must not reuse first archived name");
      assert.notEqual(active2, archived2, "second rotation: new segment must differ from second archived");
      assert.notEqual(archived2, archived1, "second archived segment must differ from first archived segment");

      // Verify all three segment files exist on disk
      const segsOnDisk = log1.listSegments();
      assert.ok(segsOnDisk.includes(archived1), `${archived1} must exist on disk`);
      assert.ok(segsOnDisk.includes(archived2), `${archived2} must exist on disk`);

      // Append an event to the third segment
      log1.append({
        type: "task_created",
        projectTag: "proj-a",
        taskId: "task-0003",
        payload: { title: "third task" },
      });
      log1.append({
        type: "state_transitioned",
        projectTag: "proj-a",
        taskId: "task-0003",
        from: "draft",
        to: "implementing",
      });

      log1.close();

      // ── Reopen and full replay — all events must be recovered ─────────────
      const log2 = EventLog.open(dir);
      const store3 = StateStore.replay(log2);
      log2.close();

      const t1 = store3.getTask("task-0001");
      assert.ok(t1 !== undefined, "task-0001 must survive after two rotations");
      assert.equal(t1.status, "queued", "task-0001 status must be queued");

      const t2 = store3.getTask("task-0002");
      assert.ok(t2 !== undefined, "task-0002 must survive after second rotation");
      assert.equal(t2.status, "draft", "task-0002 status must be draft");

      const t3 = store3.getTask("task-0003");
      assert.ok(t3 !== undefined, "task-0003 must be in active segment after second rotation");
      assert.equal(t3.status, "implementing", "task-0003 status must be implementing");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("[AC-S654396-I2] I2 — errors are not silently swallowed", () => {
  it("[AC-S654396-I2-snapshot] corrupt snapshot writes warning to stderr and falls back to full replay", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "banto-test-corrupt-snap-"));
    try {
      // Write some events
      const log1 = EventLog.open(dir);
      log1.append({
        type: "task_created",
        projectTag: "proj-x",
        taskId: "task-snap-1",
        payload: { title: "snap test" },
      });
      log1.append({
        type: "state_transitioned",
        projectTag: "proj-x",
        taskId: "task-snap-1",
        from: "draft",
        to: "ready",
      });
      const storeSnap = StateStore.replay(log1);
      log1.rotate(storeSnap.toSnapshotState());
      log1.close();

      // Corrupt the snapshot file
      const snapshotPath = path.join(dir, "snapshot.json");
      fs.writeFileSync(snapshotPath, "NOT VALID JSON {{{{", "utf-8");

      // Capture stderr
      const stderrChunks: string[] = [];
      const origWrite = process.stderr.write.bind(process.stderr);
      process.stderr.write = (chunk: string | Uint8Array): boolean => {
        stderrChunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString());
        return true;
      };

      let store: ReturnType<typeof StateStore.replay> | undefined;
      try {
        const log2 = EventLog.open(dir);
        store = StateStore.replay(log2);
        log2.close();
      } finally {
        process.stderr.write = origWrite;
      }

      // Must have emitted a warning to stderr
      const stderrOutput = stderrChunks.join("");
      assert.ok(
        stderrOutput.includes("corrupt") || stderrOutput.includes("WARNING"),
        `stderr should warn about corrupt snapshot, got: ${stderrOutput}`
      );

      // Full replay must still recover all events
      assert.ok(store !== undefined);
      const stats = store.replayStats();
      assert.equal(stats.snapshotUsed, false, "corrupted snapshot must not be used");
      const task = store.getTask("task-snap-1");
      assert.ok(task !== undefined, "task must be recovered via full replay");
      assert.equal(task.status, "ready", "task status must be recovered");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("[AC-S654396-I2-unknown-event] applyEvent throws on unknown event type", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "banto-test-unknown-evt-"));
    try {
      const log1 = EventLog.open(dir);
      log1.append({
        type: "task_created",
        projectTag: "proj-u",
        taskId: "task-u-1",
        payload: { title: "unknown evt test" },
      });
      log1.close();

      // Inject an unknown event type directly into the JSONL file
      const segName = EventLog.open(dir).listSegments()[0];
      const segPath = path.join(dir, "events", segName);
      const unknownEvent = JSON.stringify({
        eventId: 999,
        timestamp: new Date().toISOString(),
        projectTag: "proj-u",
        type: "future_unknown_event_type_v99",
        somePayload: "data",
      });
      fs.appendFileSync(segPath, unknownEvent + "\n", "utf-8");

      const log2 = EventLog.open(dir);
      assert.throws(
        () => StateStore.replay(log2),
        (err: unknown) => {
          assert.ok(err instanceof Error, "must throw an Error");
          assert.ok(
            err.message.includes("future_unknown_event_type_v99"),
            `error message must name the unknown type, got: ${err.message}`
          );
          return true;
        },
        "StateStore.replay must throw on unknown event type (I2)"
      );
      log2.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("[AC-S654396-D3] D3 — task status canonical source is state_transitioned only", () => {
  it("[AC-S654396-D3] task_approved does not change task status", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "banto-test-d3-approved-"));
    try {
      const log = EventLog.open(dir);
      log.append({
        type: "task_created",
        projectTag: "proj-d3",
        taskId: "task-d3-1",
        payload: { title: "D3 approved test" },
      });
      // Transition to in-review
      log.append({
        type: "state_transitioned",
        projectTag: "proj-d3",
        taskId: "task-d3-1",
        from: "draft",
        to: "in-review",
      });
      // PO approves — must NOT change status
      log.append({
        type: "task_approved",
        projectTag: "proj-d3",
        taskId: "task-d3-1",
        approvedBy: "po@example.com",
      });
      log.close();

      const log2 = EventLog.open(dir);
      const store = StateStore.replay(log2);
      log2.close();

      const task = store.getTask("task-d3-1");
      assert.ok(task !== undefined, "task must exist");
      // Status must remain what state_transitioned set — NOT "approved"
      assert.equal(
        task.status,
        "in-review",
        "task_approved must not overwrite status; status canonical source is state_transitioned"
      );
      // approvedBy metadata must be recorded
      assert.equal(task.approvedBy, "po@example.com", "approvedBy must be recorded as metadata");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("[AC-S654396-D3] task_rejected does not change task status", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "banto-test-d3-rejected-"));
    try {
      const log = EventLog.open(dir);
      log.append({
        type: "task_created",
        projectTag: "proj-d3",
        taskId: "task-d3-2",
        payload: { title: "D3 rejected test" },
      });
      // Transition to in-review
      log.append({
        type: "state_transitioned",
        projectTag: "proj-d3",
        taskId: "task-d3-2",
        from: "draft",
        to: "in-review",
      });
      // PO rejects — must NOT change status to "failed"
      log.append({
        type: "task_rejected",
        projectTag: "proj-d3",
        taskId: "task-d3-2",
        rejectedBy: "po@example.com",
        reason: "needs more work",
      });
      log.close();

      const log2 = EventLog.open(dir);
      const store = StateStore.replay(log2);
      log2.close();

      const task = store.getTask("task-d3-2");
      assert.ok(task !== undefined, "task must exist");
      // Status must remain what state_transitioned set — NOT "failed"
      assert.equal(
        task.status,
        "in-review",
        "task_rejected must not overwrite status; status canonical source is state_transitioned"
      );
      // rejection metadata must be recorded
      assert.equal(task.rejectionReason, "needs more work", "rejectionReason must be recorded as metadata");
      assert.equal(task.rejectedBy, "po@example.com", "rejectedBy must be recorded as metadata");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("[AC-S654396-D3] status transition to approved/failed via state_transitioned works correctly", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "banto-test-d3-transition-"));
    try {
      const log = EventLog.open(dir);
      log.append({
        type: "task_created",
        projectTag: "proj-d3",
        taskId: "task-d3-3",
        payload: { title: "D3 transition test" },
      });
      // Use state_transitioned (the only canonical source) to reach "approved"
      log.append({
        type: "state_transitioned",
        projectTag: "proj-d3",
        taskId: "task-d3-3",
        from: "draft",
        to: "approved",
      });
      // Accompany with task_approved judgment record
      log.append({
        type: "task_approved",
        projectTag: "proj-d3",
        taskId: "task-d3-3",
        approvedBy: "po@example.com",
      });
      log.close();

      const log2 = EventLog.open(dir);
      const store = StateStore.replay(log2);
      log2.close();

      const task = store.getTask("task-d3-3");
      assert.ok(task !== undefined, "task must exist");
      // status comes from state_transitioned
      assert.equal(task.status, "approved", "status must be approved via state_transitioned");
      assert.equal(task.approvedBy, "po@example.com", "approvedBy judgment must be present");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

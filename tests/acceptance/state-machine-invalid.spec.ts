/**
 * AC-S654396-2-2: 不正遷移は拒否され理由がイベントログに残る
 *
 * Verifies that invalid transition requests:
 *   1. Are rejected (transition() returns { ok: false })
 *   2. Are recorded as transition_rejected events in the log (I2)
 *   3. Do NOT change task status
 *
 * Test discipline: consumer-style — only @banto/core public API (index.ts) is used.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { EventLog, StateStore, StateMachine } from "@banto/core";
import type { TransitionRejectedEvent } from "@banto/core";

describe("[AC-S654396-2-2] Invalid transition: rejected and logged", () => {
  it("[AC-S654396-2-2] draft → merged is rejected, reason logged, status unchanged", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "banto-sm-invalid-"));
    try {
      const log = EventLog.open(dir);

      // Create task in draft state
      log.append({
        type: "task_created",
        projectTag: "proj-inv",
        taskId: "task-0001",
        payload: { title: "invalid transition test" },
      });

      // Attempt invalid transition: draft → merged
      const result = StateMachine.transition(log, "task-0001", "draft", "merged", "proj-inv");

      // Step 1: transition() must return failure
      assert.equal(result.ok, false, "invalid transition must be rejected");
      if (!result.ok) {
        assert.equal(result.reason, "invalid_transition", "reason must be invalid_transition");
      }

      // Step 2: transition_rejected event must be in the log (I2: not swallowed)
      const events = log.getEventsByTask("task-0001");
      const rejections = events.filter(
        (e): e is TransitionRejectedEvent => e.type === "transition_rejected"
      );
      assert.equal(rejections.length, 1, "exactly one transition_rejected event must be logged");
      const rejection = rejections[0];
      assert.equal(rejection.taskId, "task-0001");
      assert.equal(rejection.attempted_from, "draft");
      assert.equal(rejection.attempted_to, "merged");
      assert.equal(rejection.reason, "invalid_transition");

      // Step 3: task status must remain draft (invalid transition has no effect)
      const store = StateStore.replay(log);
      const task = store.getTask("task-0001");
      assert.ok(task !== undefined, "task must exist");
      assert.equal(task.status, "draft", "status must remain draft after invalid transition");

      log.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("[AC-S654396-2-2] multiple invalid transitions are all logged independently", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "banto-sm-multi-inv-"));
    try {
      const log = EventLog.open(dir);
      log.append({
        type: "task_created",
        projectTag: "proj-inv2",
        taskId: "task-0002",
        payload: { title: "multi-invalid test" },
      });

      // Multiple invalid transitions
      const r1 = StateMachine.transition(log, "task-0002", "draft", "closed", "proj-inv2");
      const r2 = StateMachine.transition(log, "task-0002", "draft", "evaluating", "proj-inv2");
      const r3 = StateMachine.transition(log, "task-0002", "draft", "implementing", "proj-inv2");

      assert.equal(r1.ok, false, "draft→closed must be rejected");
      assert.equal(r2.ok, false, "draft→evaluating must be rejected");
      assert.equal(r3.ok, false, "draft→implementing must be rejected");

      // All rejections recorded
      const events = log.getEventsByTask("task-0002");
      const rejections = events.filter((e) => e.type === "transition_rejected");
      assert.equal(rejections.length, 3, "all 3 invalid transitions must be logged");

      // Status still draft
      const store = StateStore.replay(log);
      assert.equal(store.getTask("task-0002")?.status, "draft");

      log.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("[AC-S654396-2-2] forward-skip (draft → planning) is rejected", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "banto-sm-fwd-skip-"));
    try {
      const log = EventLog.open(dir);
      log.append({
        type: "task_created",
        projectTag: "proj-fwd",
        taskId: "task-fwd",
        payload: { title: "forward skip test" },
      });

      const result = StateMachine.transition(log, "task-fwd", "draft", "planning", "proj-fwd");
      assert.equal(result.ok, false, "forward skip must be rejected");

      const events = log.getEventsByTask("task-fwd");
      const rejections = events.filter((e) => e.type === "transition_rejected");
      assert.equal(rejections.length, 1, "rejection must be logged");

      const store = StateStore.replay(log);
      assert.equal(store.getTask("task-fwd")?.status, "draft", "status unchanged");

      log.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("[AC-S654396-2-2] backward transition (queued → draft) is rejected", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "banto-sm-backward-"));
    try {
      const log = EventLog.open(dir);
      log.append({
        type: "task_created",
        projectTag: "proj-back",
        taskId: "task-back",
        payload: { title: "backward transition test" },
      });

      // Valid: draft → queued
      StateMachine.transition(log, "task-back", "draft", "queued", "proj-back");

      // Invalid: queued → draft (backward)
      const result = StateMachine.transition(log, "task-back", "queued", "draft", "proj-back");
      assert.equal(result.ok, false, "backward transition must be rejected");

      const events = log.getEventsByTask("task-back");
      const rejections = events.filter((e) => e.type === "transition_rejected");
      assert.equal(rejections.length, 1, "rejection must be logged");

      // Status is queued (valid transition succeeded, backward was rejected)
      const store = StateStore.replay(log);
      assert.equal(store.getTask("task-back")?.status, "queued", "status must remain queued");

      log.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

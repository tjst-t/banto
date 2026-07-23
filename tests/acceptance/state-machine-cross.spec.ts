/**
 * AC-S654396-2-3: paused/failed/superseded が適用でき、pausedは中断元へ復帰できる
 *
 * Verifies cross-cutting transitions:
 *   - pause(): any active execution state → paused, with suspended_from recorded
 *   - resume(): paused → restored to suspended_from state
 *   - fail(): any state → failed, with reason recorded
 *   - supersede(): any state → superseded, with supersededBy recorded
 *
 * Test discipline: consumer-style — only @banto/core public API (index.ts) is used.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { EventLog, StateStore, StateMachine } from "@banto/core";
import type { TaskPausedEvent, TaskResumedEvent, TaskFailedEvent, TaskSupersededEvent, StateTransitionedEvent } from "@banto/core";

/** Helper: advance task to `implementing` via canonical path */
function advanceToImplementing(log: EventLog, taskId: string, projectTag: string): void {
  const steps: [string, string][] = [
    ["draft", "queued"],
    ["queued", "ready"],
    ["ready", "planning"],
    ["planning", "implementing"],
  ];
  for (const [from, to] of steps) {
    const r = StateMachine.transition(log, taskId, from as never, to as never, projectTag);
    if (!r.ok) throw new Error(`Failed to advance to implementing: ${from}→${to}`);
  }
}

describe("[AC-S654396-2-3] Cross-cutting transitions: pause, resume, fail, supersede", () => {
  it("[AC-S654396-2-3] pause from implementing, verify task_paused event and paused status", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "banto-sm-pause-"));
    try {
      const log = EventLog.open(dir);
      log.append({
        type: "task_created",
        projectTag: "proj-cross",
        taskId: "task-0001",
        payload: { title: "cross-cutting pause test" },
      });

      advanceToImplementing(log, "task-0001", "proj-cross");

      // Pause from implementing
      const result = StateMachine.pause(log, "task-0001", "implementing", "proj-cross");
      assert.equal(result.ok, true, "pause() must succeed from implementing");

      // D3: pause() must emit state_transitioned (status source) + task_paused (metadata)
      const events = log.getEventsByTask("task-0001");
      const transitions = events.filter((e): e is StateTransitionedEvent => e.type === "state_transitioned");
      const stPause = transitions.find((e) => e.to === "paused");
      assert.ok(stPause !== undefined, "state_transitioned(to=paused) must be logged (D3: status source)");
      assert.equal(stPause!.from, "implementing", "state_transitioned.from must be implementing");

      const paused = events.filter((e): e is TaskPausedEvent => e.type === "task_paused");
      assert.equal(paused.length, 1, "exactly one task_paused event must be logged");
      assert.equal(paused[0].taskId, "task-0001");
      assert.equal(paused[0].suspended_from, "implementing");

      // StateStore must reflect paused status (from state_transitioned) with suspendedFrom (from task_paused)
      const store = StateStore.replay(log);
      const task = store.getTask("task-0001");
      assert.ok(task !== undefined);
      assert.equal(task.status, "paused", "task status must be paused (derived from state_transitioned)");
      assert.equal(task.suspendedFrom, "implementing", "suspendedFrom must be implementing (from task_paused metadata)");

      log.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("[AC-S654396-2-3] resume from paused restores to implementing", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "banto-sm-resume-"));
    try {
      const log = EventLog.open(dir);
      log.append({
        type: "task_created",
        projectTag: "proj-cross",
        taskId: "task-0001",
        payload: { title: "cross-cutting resume test" },
      });

      advanceToImplementing(log, "task-0001", "proj-cross");
      StateMachine.pause(log, "task-0001", "implementing", "proj-cross");

      // Resume
      const result = StateMachine.resume(log, "task-0001", "paused", "implementing", "proj-cross");
      assert.equal(result.ok, true, "resume() must succeed when task is paused");

      // D3: resume() must emit state_transitioned (status source) + task_resumed (metadata)
      const events = log.getEventsByTask("task-0001");
      const transitions = events.filter((e): e is StateTransitionedEvent => e.type === "state_transitioned");
      const stResume = transitions.find((e) => e.from === "paused");
      assert.ok(stResume !== undefined, "state_transitioned(from=paused) must be logged (D3: status source)");
      assert.equal(stResume!.to, "implementing", "state_transitioned.to must be implementing");

      const resumed = events.filter((e): e is TaskResumedEvent => e.type === "task_resumed");
      assert.equal(resumed.length, 1, "exactly one task_resumed event must be logged");
      assert.equal(resumed[0].restored_to, "implementing");

      // StateStore reflects restored status (from state_transitioned) with suspendedFrom cleared (from task_resumed)
      const store = StateStore.replay(log);
      const task = store.getTask("task-0001");
      assert.ok(task !== undefined);
      assert.equal(task.status, "implementing", "task status must be restored to implementing (derived from state_transitioned)");
      assert.equal(task.suspendedFrom, undefined, "suspendedFrom must be cleared after resume (from task_resumed metadata)");

      log.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("[AC-S654396-2-3] fail() records task_failed event and sets status to failed", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "banto-sm-fail-"));
    try {
      const log = EventLog.open(dir);
      log.append({
        type: "task_created",
        projectTag: "proj-cross",
        taskId: "task-0001",
        payload: { title: "fail test" },
      });

      advanceToImplementing(log, "task-0001", "proj-cross");

      // Fail with reason (I2: unrecoverable error)
      const result = StateMachine.fail(log, "task-0001", { currentStatus: "implementing", reason: "回復不能エラー" }, "proj-cross");
      assert.equal(result.ok, true, "fail() must succeed");

      // D3: fail() must emit state_transitioned (status source) + task_failed (metadata)
      const events = log.getEventsByTask("task-0001");
      const transitions = events.filter((e): e is StateTransitionedEvent => e.type === "state_transitioned");
      const stFail = transitions.find((e) => e.to === "failed");
      assert.ok(stFail !== undefined, "state_transitioned(to=failed) must be logged (D3: status source)");
      assert.equal(stFail!.from, "implementing", "state_transitioned.from must be implementing");

      const failed = events.filter((e): e is TaskFailedEvent => e.type === "task_failed");
      assert.equal(failed.length, 1, "exactly one task_failed event must be logged");
      assert.equal(failed[0].taskId, "task-0001");
      assert.equal(failed[0].reason, "回復不能エラー");

      // StateStore reflects failed status (from state_transitioned) and failureReason (from task_failed)
      const store = StateStore.replay(log);
      const task = store.getTask("task-0001");
      assert.ok(task !== undefined);
      assert.equal(task.status, "failed", "task status must be failed (derived from state_transitioned)");
      assert.equal(task.failureReason, "回復不能エラー", "failureReason must be recorded (from task_failed metadata)");

      log.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("[AC-S654396-2-3] supersede() records task_superseded event and sets status to superseded", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "banto-sm-supersede-"));
    try {
      const log = EventLog.open(dir);

      // Create two tasks: task-0001 (superseding) and task-0002 (to be superseded)
      log.append({
        type: "task_created",
        projectTag: "proj-cross",
        taskId: "task-0001",
        payload: { title: "superseding task" },
      });
      log.append({
        type: "task_created",
        projectTag: "proj-cross",
        taskId: "task-0002",
        payload: { title: "task to be superseded" },
      });

      // Supersede task-0002 by task-0001 (task-0002 is currently in draft)
      const result = StateMachine.supersede(log, "task-0002", { currentStatus: "draft", by: "task-0001" }, "proj-cross");
      assert.equal(result.ok, true, "supersede() must succeed");

      // D3: supersede() must emit state_transitioned (status source) + task_superseded (metadata)
      const events = log.getEventsByTask("task-0002");
      const transitions = events.filter((e): e is StateTransitionedEvent => e.type === "state_transitioned");
      const stSupersede = transitions.find((e) => e.to === "superseded");
      assert.ok(stSupersede !== undefined, "state_transitioned(to=superseded) must be logged (D3: status source)");
      assert.equal(stSupersede!.from, "draft", "state_transitioned.from must be draft");

      const superseded = events.filter((e): e is TaskSupersededEvent => e.type === "task_superseded");
      assert.equal(superseded.length, 1, "exactly one task_superseded event must be logged");
      assert.equal(superseded[0].taskId, "task-0002");
      assert.equal(superseded[0].supersededBy, "task-0001");

      // StateStore reflects superseded status (from state_transitioned) and supersededBy (from task_superseded)
      const store = StateStore.replay(log);
      const task2 = store.getTask("task-0002");
      assert.ok(task2 !== undefined);
      assert.equal(task2.status, "superseded", "task-0002 status must be superseded (derived from state_transitioned)");
      assert.equal(task2.supersededBy, "task-0001", "supersededBy must be recorded (from task_superseded metadata)");

      // task-0001 is unaffected
      const task1 = store.getTask("task-0001");
      assert.ok(task1 !== undefined);
      assert.equal(task1.status, "draft", "task-0001 status must remain draft");

      log.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("[AC-S654396-2-3] pause from non-pausable state (draft) is rejected and logged", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "banto-sm-pause-reject-"));
    try {
      const log = EventLog.open(dir);
      log.append({
        type: "task_created",
        projectTag: "proj-cross",
        taskId: "task-0001",
        payload: { title: "pause reject test" },
      });

      // Attempt to pause from draft (not in PAUSABLE_STATES)
      const result = StateMachine.pause(log, "task-0001", "draft", "proj-cross");
      assert.equal(result.ok, false, "pause() from draft must be rejected");
      if (!result.ok) {
        assert.equal(result.reason, "not_pausable_from_current_state");
      }

      // Rejection recorded
      const events = log.getEventsByTask("task-0001");
      const rejections = events.filter((e) => e.type === "transition_rejected");
      assert.equal(rejections.length, 1, "rejection must be logged");

      // Status unchanged (draft)
      const store = StateStore.replay(log);
      assert.equal(store.getTask("task-0001")?.status, "draft");

      log.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("[AC-S654396-2-3] resume() from non-paused state is rejected", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "banto-sm-resume-reject-"));
    try {
      const log = EventLog.open(dir);
      log.append({
        type: "task_created",
        projectTag: "proj-cross",
        taskId: "task-0001",
        payload: { title: "resume reject test" },
      });

      // Attempt resume from draft (not paused)
      const result = StateMachine.resume(log, "task-0001", "draft", "implementing", "proj-cross");
      assert.equal(result.ok, false, "resume() from non-paused state must be rejected");
      if (!result.ok) {
        assert.equal(result.reason, "task_not_paused");
      }

      // Rejection recorded
      const events = log.getEventsByTask("task-0001");
      const rejections = events.filter((e) => e.type === "transition_rejected");
      assert.equal(rejections.length, 1, "rejection must be logged");

      const store = StateStore.replay(log);
      assert.equal(store.getTask("task-0001")?.status, "draft", "status must remain draft");

      log.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("[AC-S654396-2-3] pause from auditing and resume restores to auditing", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "banto-sm-pause-audit-"));
    try {
      const log = EventLog.open(dir);
      log.append({
        type: "task_created",
        projectTag: "proj-cross",
        taskId: "task-audit",
        payload: { title: "pause from auditing test" },
      });

      // Advance to auditing
      for (const [from, to] of [
        ["draft", "queued"], ["queued", "ready"], ["ready", "planning"],
        ["planning", "implementing"], ["implementing", "auditing"],
      ] as [string, string][]) {
        StateMachine.transition(log, "task-audit", from as never, to as never, "proj-cross");
      }

      // Pause from auditing
      const pauseResult = StateMachine.pause(log, "task-audit", "auditing", "proj-cross");
      assert.equal(pauseResult.ok, true, "pause from auditing must succeed");

      let store = StateStore.replay(log);
      let task = store.getTask("task-audit");
      assert.equal(task?.status, "paused");
      assert.equal(task?.suspendedFrom, "auditing");

      // Resume back to auditing
      const resumeResult = StateMachine.resume(log, "task-audit", "paused", "auditing", "proj-cross");
      assert.equal(resumeResult.ok, true, "resume from auditing-paused must succeed");

      store = StateStore.replay(log);
      task = store.getTask("task-audit");
      assert.equal(task?.status, "auditing", "status must be restored to auditing");
      assert.equal(task?.suspendedFrom, undefined, "suspendedFrom cleared");

      log.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

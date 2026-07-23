/**
 * AC-S654396-2-1: 正規遷移の全経路がイベントとして記録され導出状態に反映される
 *
 * Verifies the full canonical path:
 *   draft → queued → ready → planning → implementing → auditing
 *   → review-ready → in-review → approved → merging → merged
 *   → evaluating → closed
 *
 * Test discipline: consumer-style — only @banto/core public API (index.ts) is used.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { EventLog, StateStore, StateMachine } from "@banto/core";
import type { StateTransitionedEvent } from "@banto/core";

describe("[AC-S654396-2-1] Canonical state machine path — all transitions recorded and reflected", () => {
  let tmpDir: string;
  let log: EventLog;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "banto-sm-canonical-"));
    log = EventLog.open(tmpDir);

    // Create task-0001 in draft state
    log.append({
      type: "task_created",
      projectTag: "proj-sm",
      taskId: "task-0001",
      payload: { title: "canonical path test" },
    });
  });

  after(() => {
    log.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("[AC-S654396-2-1] step 1: draft → queued", () => {
    const result = StateMachine.transition(log, "task-0001", "draft", "queued", "proj-sm");
    assert.equal(result.ok, true, "draft→queued must succeed");

    const store = StateStore.replay(log);
    const task = store.getTask("task-0001");
    assert.ok(task !== undefined);
    assert.equal(task.status, "queued", "task status must be queued");
  });

  it("[AC-S654396-2-1] step 2: queued → ready", () => {
    const result = StateMachine.transition(log, "task-0001", "queued", "ready", "proj-sm");
    assert.equal(result.ok, true);
    const store = StateStore.replay(log);
    assert.equal(store.getTask("task-0001")?.status, "ready");
  });

  it("[AC-S654396-2-1] step 3: ready → planning", () => {
    const result = StateMachine.transition(log, "task-0001", "ready", "planning", "proj-sm");
    assert.equal(result.ok, true);
    const store = StateStore.replay(log);
    assert.equal(store.getTask("task-0001")?.status, "planning");
  });

  it("[AC-S654396-2-1] step 4: planning → implementing", () => {
    const result = StateMachine.transition(log, "task-0001", "planning", "implementing", "proj-sm");
    assert.equal(result.ok, true);
    const store = StateStore.replay(log);
    assert.equal(store.getTask("task-0001")?.status, "implementing");
  });

  it("[AC-S654396-2-1] step 5: implementing → auditing", () => {
    const result = StateMachine.transition(log, "task-0001", "implementing", "auditing", "proj-sm");
    assert.equal(result.ok, true);
    const store = StateStore.replay(log);
    assert.equal(store.getTask("task-0001")?.status, "auditing");
  });

  it("[AC-S654396-2-1] step 6: auditing → review-ready", () => {
    const result = StateMachine.transition(log, "task-0001", "auditing", "review-ready", "proj-sm");
    assert.equal(result.ok, true);
    const store = StateStore.replay(log);
    assert.equal(store.getTask("task-0001")?.status, "review-ready");
  });

  it("[AC-S654396-2-1] step 7: review-ready → in-review", () => {
    const result = StateMachine.transition(log, "task-0001", "review-ready", "in-review", "proj-sm");
    assert.equal(result.ok, true);
    const store = StateStore.replay(log);
    assert.equal(store.getTask("task-0001")?.status, "in-review");
  });

  it("[AC-S654396-2-1] step 8: in-review → approved", () => {
    const result = StateMachine.transition(log, "task-0001", "in-review", "approved", "proj-sm");
    assert.equal(result.ok, true);
    const store = StateStore.replay(log);
    assert.equal(store.getTask("task-0001")?.status, "approved");
  });

  it("[AC-S654396-2-1] step 9: approved → merging", () => {
    const result = StateMachine.transition(log, "task-0001", "approved", "merging", "proj-sm");
    assert.equal(result.ok, true);
    const store = StateStore.replay(log);
    assert.equal(store.getTask("task-0001")?.status, "merging");
  });

  it("[AC-S654396-2-1] step 10: merging → merged", () => {
    const result = StateMachine.transition(log, "task-0001", "merging", "merged", "proj-sm");
    assert.equal(result.ok, true);
    const store = StateStore.replay(log);
    assert.equal(store.getTask("task-0001")?.status, "merged");
  });

  it("[AC-S654396-2-1] step 11: merged → evaluating", () => {
    const result = StateMachine.transition(log, "task-0001", "merged", "evaluating", "proj-sm");
    assert.equal(result.ok, true);
    const store = StateStore.replay(log);
    assert.equal(store.getTask("task-0001")?.status, "evaluating");
  });

  it("[AC-S654396-2-1] step 12: evaluating → closed — final status check", () => {
    const result = StateMachine.transition(log, "task-0001", "evaluating", "closed", "proj-sm");
    assert.equal(result.ok, true);
    const store = StateStore.replay(log);
    assert.equal(store.getTask("task-0001")?.status, "closed", "final status must be closed");
  });

  it("[AC-S654396-2-1] step 13: verify all 13 canonical transitions are recorded in log", () => {
    // getEventsByTask returns all events including task_created; filter for state_transitioned
    const allEvents = log.getEventsByTask("task-0001");
    const transitions = allEvents.filter(
      (e): e is StateTransitionedEvent => e.type === "state_transitioned"
    );

    const expectedPairs: [string, string][] = [
      ["draft", "queued"],
      ["queued", "ready"],
      ["ready", "planning"],
      ["planning", "implementing"],
      ["implementing", "auditing"],
      ["auditing", "review-ready"],
      ["review-ready", "in-review"],
      ["in-review", "approved"],
      ["approved", "merging"],
      ["merging", "merged"],
      ["merged", "evaluating"],
      ["evaluating", "closed"],
    ];

    assert.equal(
      transitions.length,
      expectedPairs.length,
      `Expected ${expectedPairs.length} state_transitioned events, got ${transitions.length}`
    );

    for (let i = 0; i < expectedPairs.length; i++) {
      const [expectedFrom, expectedTo] = expectedPairs[i];
      const t = transitions[i];
      assert.equal(t.from, expectedFrom, `transition ${i}: from must be ${expectedFrom}`);
      assert.equal(t.to, expectedTo, `transition ${i}: to must be ${expectedTo}`);
    }
  });
});

describe("[AC-S654396-2-1] Special path: auditing → merging (auto merge policy)", () => {
  it("[AC-S654396-2-1-auto] auditing → merging is a valid transition (caller enforces auto policy)", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "banto-sm-auto-"));
    try {
      const log2 = EventLog.open(dir);
      log2.append({
        type: "task_created",
        projectTag: "proj-auto",
        taskId: "task-auto",
        payload: { title: "auto merge test" },
      });
      // Advance to auditing
      for (const [from, to] of [
        ["draft", "queued"], ["queued", "ready"], ["ready", "planning"],
        ["planning", "implementing"], ["implementing", "auditing"],
      ] as [string, string][]) {
        StateMachine.transition(log2, "task-auto", from as never, to as never, "proj-auto");
      }
      // auditing → merging (auto policy path)
      const result = StateMachine.transition(log2, "task-auto", "auditing", "merging", "proj-auto");
      assert.equal(result.ok, true, "auditing→merging must be valid");
      const store = StateStore.replay(log2);
      assert.equal(store.getTask("task-auto")?.status, "merging");
      log2.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("[AC-S654396-2-1] Special path: merged → closed (no hypothesis)", () => {
  it("[AC-S654396-2-1-nohyp] merged → closed is a valid transition", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "banto-sm-nohyp-"));
    try {
      const log2 = EventLog.open(dir);
      log2.append({
        type: "task_created",
        projectTag: "proj-nohyp",
        taskId: "task-nohyp",
        payload: { title: "no hypothesis test" },
      });
      // Advance to merged
      for (const [from, to] of [
        ["draft", "queued"], ["queued", "ready"], ["ready", "planning"],
        ["planning", "implementing"], ["implementing", "auditing"],
        ["auditing", "review-ready"], ["review-ready", "in-review"],
        ["in-review", "approved"], ["approved", "merging"], ["merging", "merged"],
      ] as [string, string][]) {
        StateMachine.transition(log2, "task-nohyp", from as never, to as never, "proj-nohyp");
      }
      // merged → closed (no hypothesis)
      const result = StateMachine.transition(log2, "task-nohyp", "merged", "closed", "proj-nohyp");
      assert.equal(result.ok, true, "merged→closed must be valid");
      const store = StateStore.replay(log2);
      assert.equal(store.getTask("task-nohyp")?.status, "closed");
      log2.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

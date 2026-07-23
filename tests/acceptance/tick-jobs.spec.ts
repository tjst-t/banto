/**
 * AC-Scc9152-3-1: Tick jobs drive gate re-evaluation autonomously.
 *
 * Verifies that:
 *   - The scheduler calls registered jobs on every tick.
 *   - The built-in gate-reeval job promotes queued tasks whose dependencies
 *     are satisfied (task in terminal state) by appending gate_evaluated events
 *     and transitioning the task to 'ready'.
 *
 * Uses a real daemon with tickIntervalMs=200 to keep test time short.
 * All state-changing calls go through the HTTP API (acceptance-level).
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { Daemon } from "@banto/daemon";

/** Transition a task through several states via HTTP to reach the target status. */
async function transitionTask(
  base: string,
  proj: string,
  taskId: string,
  ...steps: string[]
): Promise<void> {
  for (const to of steps) {
    const res = await fetch(`${base}/api/v1/projects/${proj}/tasks/${taskId}/transition`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ to }),
    });
    if (res.status !== 200) {
      const body = await res.text();
      throw new Error(`Transition to '${to}' failed (${res.status}): ${body}`);
    }
  }
}

describe("[AC-Scc9152-3-1] Tick jobs: gate re-evaluation drives queued→ready", () => {
  let tmpDir: string;
  let daemon: Daemon;
  let base: string;

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "banto-tick-jobs-"));
    // Short tick interval (200ms) to keep the test fast while still validating
    // that the scheduler fires and drives gate re-evaluation autonomously.
    daemon = Daemon.create({ port: 0, dataDir: tmpDir, tickIntervalMs: 200 });
    await daemon.start();
    base = `http://localhost:${daemon.port}`;
  });

  after(async () => {
    await daemon.stop();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("[AC-Scc9152-3-1] registered tick job (gate-reeval) fires autonomously and promotes queued task to ready", async () => {
    // Setup: register project
    const projRes = await fetch(`${base}/api/v1/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "proj-tick", repoPath: "/repos/proj-tick" }),
    });
    assert.equal(projRes.status, 201);

    // Create task-0031 (the dependency) and transition it to 'closed'
    // Path: draft → queued → ready → planning → implementing → auditing → merging → merged → closed
    const dep31Res = await fetch(`${base}/api/v1/projects/proj-tick/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "task-0031", title: "Dependency task" }),
    });
    assert.equal(dep31Res.status, 201, "task-0031 creation must succeed");

    await transitionTask(
      base, "proj-tick", "task-0031",
      "queued", "ready", "planning", "implementing", "auditing", "merging", "merged", "closed"
    );

    // Verify task-0031 is now 'closed'
    const dep31State = await fetch(`${base}/api/v1/projects/proj-tick/tasks/task-0031`);
    const dep31Body = await dep31State.json() as { task: { status: string } };
    assert.equal(dep31Body.task.status, "closed", "task-0031 must be closed before gate test");

    // Create task-0030 with depends=['task-0031'] and transition to queued
    const mainRes = await fetch(`${base}/api/v1/projects/proj-tick/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: "task-0030",
        title: "Main task with dependency",
        depends: ["task-0031"],
      }),
    });
    assert.equal(mainRes.status, 201, "task-0030 creation must succeed");

    // Transition task-0030 to queued
    await transitionTask(base, "proj-tick", "task-0030", "queued");

    // Verify task-0030 starts in queued
    const initialState = await fetch(`${base}/api/v1/projects/proj-tick/tasks/task-0030`);
    const initialBody = await initialState.json() as { task: { status: string } };
    assert.equal(initialBody.task.status, "queued", "task-0030 must start in queued");

    // Step 2: Wait for ≥2 tick cycles (200ms × 3 = 600ms) without making any
    // state-changing API calls. The tick scheduler should fire gate-reeval.
    await new Promise<void>((resolve) => setTimeout(resolve, 700));

    // Step 3: Verify gate_evaluated event appeared for task-0030 (autonomous tick drove it)
    const eventsRes = await fetch(`${base}/api/v1/projects/proj-tick/tasks/task-0030/events`);
    assert.equal(eventsRes.status, 200);
    const eventsBody = await eventsRes.json() as {
      events: Array<{ type: string; passed?: boolean; blockedBy?: string[] }>;
    };
    assert.ok(Array.isArray(eventsBody.events), "events must be an array");

    const gateEvents = eventsBody.events.filter((e) => e.type === "gate_evaluated");
    assert.ok(
      gateEvents.length >= 1,
      `Expected at least one gate_evaluated event, got ${gateEvents.length}. ` +
        `All events: ${JSON.stringify(eventsBody.events.map((e) => e.type))}`
    );

    const passedGate = gateEvents.find((e) => e.passed === true);
    assert.ok(
      passedGate !== undefined,
      `Expected at least one gate_evaluated(passed=true), got: ${JSON.stringify(gateEvents)}`
    );
    assert.deepEqual(
      passedGate.blockedBy,
      [],
      "gate_evaluated.blockedBy must be empty when passed"
    );

    // Step 4: Verify task-0030 status is now 'ready'
    const finalState = await fetch(`${base}/api/v1/projects/proj-tick/tasks/task-0030`);
    assert.equal(finalState.status, 200);
    const finalBody = await finalState.json() as { task: { id: string; status: string } };
    assert.equal(
      finalBody.task.status,
      "ready",
      `task-0030 should have been promoted to 'ready' by the gate-reeval tick job, ` +
        `but got '${finalBody.task.status}'`
    );
  });

  it("[AC-Scc9152-3-1] custom registered tick job fires via registerTickJob", async () => {
    // Verify that a job registered via daemon.registerTickJob() is also executed by the scheduler.
    let callCount = 0;
    daemon.registerTickJob("test-custom-job", () => {
      callCount++;
    });

    // Wait for ≥2 tick cycles
    await new Promise<void>((resolve) => setTimeout(resolve, 700));

    assert.ok(
      callCount >= 1,
      `Custom tick job should have been called at least once, got callCount=${callCount}`
    );
  });
});

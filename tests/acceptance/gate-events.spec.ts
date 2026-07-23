/**
 * AC-Scc9152-2-3: Gate evaluation is always recorded as gate_evaluated events,
 * with passed/blockedBy fields capturing the decision and its reasons.
 *
 * Verifies:
 *   - gate_evaluated(passed=false, blockedBy=[...]) when blocked
 *   - gate_evaluated(passed=true, blockedBy=[]) when allowed through
 *   - blockedBy entries identify both the blocking task ID and the reason
 *   - Multiple evaluations may appear; the sequence shows the progression
 *     from blocked → passed when a block is resolved
 *
 * Uses real Daemon (port=0). All observation via HTTP API.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { Daemon } from "@banto/daemon";

/** Poll until predicate passes or timeout expires. Returns last value. */
async function pollUntil<T>(
  fn: () => Promise<T>,
  pred: (v: T) => boolean,
  timeoutMs = 5000,
  intervalMs = 100
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last = await fn();
  while (!pred(last) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, intervalMs));
    last = await fn();
  }
  return last;
}

async function transitionTask(
  base: string,
  proj: string,
  taskId: string,
  ...steps: string[]
): Promise<void> {
  for (const to of steps) {
    // Skip if already at target (e.g. immediately gate-promoted from queued → ready)
    const check = await fetch(`${base}/api/v1/projects/${proj}/tasks/${taskId}`);
    if (check.ok) {
      const body = await check.json() as { task: { status: string } };
      if (body.task.status === to) continue;
    }
    const res = await fetch(`${base}/api/v1/projects/${proj}/tasks/${taskId}/transition`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ to }),
    });
    if (res.status !== 200) {
      const body = await res.text();
      throw new Error(`Transition ${taskId}→'${to}' failed (${res.status}): ${body}`);
    }
  }
}

interface GateEvent {
  type: string;
  taskId?: string;
  passed?: boolean;
  blockedBy?: string[];
}

async function getGateEvents(base: string, proj: string, taskId: string): Promise<GateEvent[]> {
  const res = await fetch(`${base}/api/v1/projects/${proj}/tasks/${taskId}/events`);
  if (!res.ok) throw new Error(`GET events failed: ${res.status}`);
  const body = await res.json() as { events: GateEvent[] };
  return body.events.filter((e) => e.type === "gate_evaluated");
}

describe("[AC-Scc9152-2-3] Gate evaluation is recorded as gate_evaluated events", () => {
  let tmpDir: string;
  let daemon: Daemon;
  let base: string;

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "banto-gate-events-"));
    daemon = Daemon.create({ port: 0, dataDir: tmpDir, tickIntervalMs: 500 });
    await daemon.start();
    base = `http://localhost:${daemon.port}`;

    const projRes = await fetch(`${base}/api/v1/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "proj-events", repoPath: "/repos/proj-events" }),
    });
    assert.equal(projRes.status, 201, "project must register");
  });

  after(async () => {
    await daemon.stop();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("[AC-Scc9152-2-3a] blocked gate records gate_evaluated(passed=false, blockedBy=[depId...])", async () => {
    // Create dep task-0050 and leave it in queued (unresolved)
    await fetch(`${base}/api/v1/projects/proj-events/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: "task-0050",
        title: "Unresolved dep",
        scope: { paths: ["x/**"] },
      }),
    });
    await transitionTask(base, "proj-events", "task-0050", "queued");

    // Wait for gate to promote task-0050 (it has no deps/ancestors)
    await pollUntil(
      async () => {
        const r = await fetch(`${base}/api/v1/projects/proj-events/tasks/task-0050`);
        return (await r.json() as { task: { status: string } }).task.status;
      },
      (s) => s === "ready",
      3000
    );
    await transitionTask(
      base, "proj-events", "task-0050",
      "planning", "implementing"
    );

    // Create task-0051 with depends=['task-0050']
    await fetch(`${base}/api/v1/projects/proj-events/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: "task-0051",
        title: "Depends on task-0050",
        depends: ["task-0050"],
        scope: { paths: ["y/**"] },
      }),
    });
    await transitionTask(base, "proj-events", "task-0051", "queued");

    // Give gate time to record the evaluation
    await new Promise((r) => setTimeout(r, 600));

    // Check that gate_evaluated event was recorded with passed=false
    const gateEvents = await getGateEvents(base, "proj-events", "task-0051");
    assert.ok(
      gateEvents.length >= 1,
      `Expected at least one gate_evaluated event, got ${gateEvents.length}`
    );

    const blockedEvent = gateEvents.find((e) => e.passed === false);
    assert.ok(
      blockedEvent !== undefined,
      `Expected at least one gate_evaluated(passed=false), got: ${JSON.stringify(gateEvents)}`
    );

    // blockedBy must reference task-0050
    assert.ok(
      Array.isArray(blockedEvent.blockedBy),
      "blockedBy must be an array"
    );
    const mentionsTask50 = blockedEvent.blockedBy!.some((b) => b.startsWith("task-0050"));
    assert.ok(
      mentionsTask50,
      `blockedBy must mention task-0050, got: ${JSON.stringify(blockedEvent.blockedBy)}`
    );
  });

  it("[AC-Scc9152-2-3b] passed gate records gate_evaluated(passed=true, blockedBy=[])", async () => {
    // Create standalone task with no deps, no scope overlap
    await fetch(`${base}/api/v1/projects/proj-events/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: "task-0060",
        title: "Standalone task",
        scope: { paths: ["standalone/**"] },
      }),
    });
    await transitionTask(base, "proj-events", "task-0060", "queued");

    // Gate should fire and pass
    const gateEvents = await pollUntil(
      () => getGateEvents(base, "proj-events", "task-0060"),
      (evts) => evts.some((e) => e.passed === true),
      3000
    );

    const passedEvent = gateEvents.find((e) => e.passed === true);
    assert.ok(
      passedEvent !== undefined,
      `Expected gate_evaluated(passed=true), got: ${JSON.stringify(gateEvents)}`
    );
    assert.deepEqual(
      passedEvent.blockedBy,
      [],
      "gate_evaluated.blockedBy must be [] when passed"
    );
  });

  it("[AC-Scc9152-2-3c] sequence shows blocked→passed when dependency resolves", async () => {
    // Create dep task-0070 in queued/implementing (blocked for task-0071)
    await fetch(`${base}/api/v1/projects/proj-events/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: "task-0070",
        title: "Dep that resolves later",
        scope: { paths: ["z/**"] },
      }),
    });
    // Let it get promoted to ready first (no deps, no overlap)
    await transitionTask(base, "proj-events", "task-0070", "queued");
    await pollUntil(
      async () => {
        const r = await fetch(`${base}/api/v1/projects/proj-events/tasks/task-0070`);
        return (await r.json() as { task: { status: string } }).task.status;
      },
      (s) => s === "ready",
      3000
    );
    // Advance to implementing (still unresolved for dep purposes)
    await transitionTask(
      base, "proj-events", "task-0070",
      "planning", "implementing"
    );

    // Create dependent task-0071
    await fetch(`${base}/api/v1/projects/proj-events/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: "task-0071",
        title: "Depends on task-0070",
        depends: ["task-0070"],
        scope: { paths: ["zz/**"] },
      }),
    });
    await transitionTask(base, "proj-events", "task-0071", "queued");

    // Wait for the initial blocked gate_evaluated to appear
    await pollUntil(
      () => getGateEvents(base, "proj-events", "task-0071"),
      (evts) => evts.some((e) => e.passed === false),
      3000
    );

    // Resolve the dependency: advance task-0070 to 'closed'
    await transitionTask(
      base, "proj-events", "task-0070",
      "auditing", "merging", "merged", "closed"
    );

    // Wait for the passed gate_evaluated to appear
    const allGateEvents = await pollUntil(
      () => getGateEvents(base, "proj-events", "task-0071"),
      (evts) => evts.some((e) => e.passed === true),
      5000
    );

    const hasBlocked = allGateEvents.some((e) => e.passed === false);
    const hasPassed = allGateEvents.some((e) => e.passed === true);

    assert.ok(
      hasBlocked,
      "event history must include at least one gate_evaluated(passed=false)"
    );
    assert.ok(
      hasPassed,
      "event history must include at least one gate_evaluated(passed=true) after resolution"
    );

    // Verify final task status is 'ready'
    const finalRes = await fetch(`${base}/api/v1/projects/proj-events/tasks/task-0071`);
    const finalBody = await finalRes.json() as { task: { status: string } };
    assert.equal(
      finalBody.task.status,
      "ready",
      "task-0071 must be in 'ready' after dependency resolved"
    );
  });

  it("[AC-Scc9152-2-3d] scope-overlap block records gate_evaluated with scope ancestor reference", async () => {
    // Create ancestor task-0080 with scope src/shared/**
    await fetch(`${base}/api/v1/projects/proj-events/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: "task-0080",
        title: "Scope ancestor",
        scope: { paths: ["src/shared/**"] },
      }),
    });
    // Advance to implementing (unreviewed)
    await transitionTask(base, "proj-events", "task-0080", "queued");
    await pollUntil(
      async () => {
        const r = await fetch(`${base}/api/v1/projects/proj-events/tasks/task-0080`);
        return (await r.json() as { task: { status: string } }).task.status;
      },
      (s) => s === "ready",
      3000
    );
    await transitionTask(base, "proj-events", "task-0080", "planning", "implementing");

    // Create task-0081 with overlapping scope
    await fetch(`${base}/api/v1/projects/proj-events/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: "task-0081",
        title: "Overlapping scope",
        scope: { paths: ["src/shared/utils.ts"] },
      }),
    });
    await transitionTask(base, "proj-events", "task-0081", "queued");

    // Wait for gate_evaluated(passed=false) event
    const gateEvents = await pollUntil(
      () => getGateEvents(base, "proj-events", "task-0081"),
      (evts) => evts.some((e) => e.passed === false),
      3000
    );

    const blockedEvent = gateEvents.find((e) => e.passed === false);
    assert.ok(blockedEvent !== undefined, "must have a blocked gate event");
    assert.ok(
      Array.isArray(blockedEvent.blockedBy) && blockedEvent.blockedBy.length > 0,
      "blockedBy must be non-empty"
    );
    // blockedBy must mention task-0080 (the scope ancestor)
    const mentionsAncestor = blockedEvent.blockedBy!.some((b) => b.startsWith("task-0080"));
    assert.ok(
      mentionsAncestor,
      `blockedBy must mention task-0080 (scope ancestor), got: ${JSON.stringify(blockedEvent.blockedBy)}`
    );
    // Reason must mention scope_overlap
    const mentionsScope = blockedEvent.blockedBy!.some((b) => b.includes("scope_overlap"));
    assert.ok(
      mentionsScope,
      `blockedBy must mention scope_overlap reason, got: ${JSON.stringify(blockedEvent.blockedBy)}`
    );
  });
});

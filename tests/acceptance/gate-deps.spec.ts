/**
 * AC-Scc9152-2-1: Dependency gate — queued task stays blocked until dependency
 * resolves, then gets promoted to ready.
 *
 * Resolved states (unblock): merged | evaluating | closed — the output is on main.
 * Unresolved states (keep blocked): queued | ready | planning | implementing |
 *   auditing | review-ready | in-review | approved | merging
 *
 * imp-0041: `approved` and `merging` do NOT unblock. `merging` is not terminal
 * (rebase conflict sends the task back to `implementing`), and `approved` has not
 * started merging at all — in neither case is the dependency's output on main.
 *
 * Uses a real Daemon (port=0, tickIntervalMs=500) and HTTP API only.
 * Gate re-evaluation fires both on tick AND immediately after state transitions,
 * so promotion happens without waiting a full tick interval.
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
    // Check current state first: if the task is already at this target status
    // (e.g. promoted by immediate gate eval), skip this step.
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
      // The gate promotes queued→ready on its own, and it can win the race against
      // the check above. Landing on the requested state by that route is a success,
      // not an invalid_transition. Anything else is a real failure (I2).
      const after = await fetch(`${base}/api/v1/projects/${proj}/tasks/${taskId}`);
      if (after.ok) {
        const body = await after.json() as { task: { status: string } };
        if (body.task.status === to) continue;
      }
      const body = await res.text();
      throw new Error(`Transition ${taskId}→'${to}' failed (${res.status}): ${body}`);
    }
  }
}

async function getStatus(base: string, proj: string, taskId: string): Promise<string> {
  const r = await fetch(`${base}/api/v1/projects/${proj}/tasks/${taskId}`);
  return (await r.json() as { task: { status: string } }).task.status;
}

/** gate_evaluated events for a task, oldest first. */
async function getGateEvents(
  base: string,
  proj: string,
  taskId: string
): Promise<Array<{ passed?: boolean; blockedBy?: string[] }>> {
  const r = await fetch(`${base}/api/v1/projects/${proj}/tasks/${taskId}/events`);
  if (!r.ok) throw new Error(`GET events failed: ${r.status}`);
  const body = await r.json() as {
    events: Array<{ type: string; passed?: boolean; blockedBy?: string[] }>;
  };
  return body.events.filter((e) => e.type === "gate_evaluated");
}

describe("[AC-Scc9152-2-1] Gate condition 1: dependency-driven queued→ready", () => {
  let tmpDir: string;
  let daemon: Daemon;
  let base: string;

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "banto-gate-deps-"));
    // disableAuditSpawn: this suite tests gate logic and transitions tasks through
    // implementing→auditing→merging etc. as state placeholders, not to trigger audit sessions.
    // disableMergeQueue (imp-0041): `approved` / `merging` are used here as state
    // placeholders to assert the gate keeps blocking. A live merge queue picks tasks up
    // out of exactly those two states and would drive them out from under the assertion
    // (and the outcome would depend on whether /repos/proj-gate happens to exist).
    daemon = Daemon.create({ port: 0, dataDir: tmpDir, tickIntervalMs: 500, disableAuditSpawn: true, disableAutoSpawn: true, disableMergeQueue: true });
    await daemon.start();
    base = `http://localhost:${daemon.port}`;

    const projRes = await fetch(`${base}/api/v1/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "proj-gate", repoPath: "/repos/proj-gate" }),
    });
    assert.equal(projRes.status, 201, "project must register successfully");
  });

  after(async () => {
    await daemon.stop();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("[AC-Scc9152-2-1a] task with unresolved dependency stays queued", async () => {
    // Create task-A: no deps, unique scope. It will be promoted to ready immediately.
    await fetch(`${base}/api/v1/projects/proj-gate/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: "task-0100",
        title: "Dependency A",
        scope: { paths: ["docs/**"] },
      }),
    });
    await transitionTask(base, "proj-gate", "task-0100", "queued");

    // Wait for gate to evaluate and promote task-0100 to ready.
    // (No deps, no unreviewed scope ancestors => should pass immediately.)
    const aReady = await pollUntil(
      () => getStatus(base, "proj-gate", "task-0100"),
      (s) => s === "ready",
      3000
    );
    assert.equal(aReady, "ready", "task-0100 (no deps) must become ready");

    // Advance task-0100 to 'implementing' (past queued, but still unresolved for deps)
    await transitionTask(base, "proj-gate", "task-0100", "planning", "implementing");

    // Create task-B with depends=['task-0100']; scope doesn't overlap with task-0100.
    await fetch(`${base}/api/v1/projects/proj-gate/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: "task-0101",
        title: "Dependent on A",
        depends: ["task-0100"],
        scope: { paths: ["tests/**"] },
      }),
    });
    await transitionTask(base, "proj-gate", "task-0101", "queued");

    // Give gate a moment to evaluate. task-0100 is 'implementing' (NOT resolved).
    await new Promise((r) => setTimeout(r, 600));

    const statusB = await getStatus(base, "proj-gate", "task-0101");
    assert.equal(
      statusB,
      "queued",
      "task-0101 must remain queued: dependency task-0100 is implementing (not resolved)"
    );
  });

  it("[AC-Scc9152-2-1b] task promotes to ready when dependency reaches 'closed'", async () => {
    // task-0100 is currently 'implementing'. Advance it to 'closed'.
    await transitionTask(
      base, "proj-gate", "task-0100",
      "auditing", "merging", "merged", "closed"
    );

    // task-0101 must be promoted to 'ready' after gate re-evaluates.
    // Gate fires immediately on each transition call, so shouldn't need >1 tick.
    const finalStatus = await pollUntil(
      () => getStatus(base, "proj-gate", "task-0101"),
      (s) => s === "ready",
      5000
    );
    assert.equal(
      finalStatus,
      "ready",
      "task-0101 must be promoted to ready once task-0100 is closed (resolved)"
    );
  });

  it("[AC-Scc9152-2-1c] 'merged' state counts as resolved (promotes dependent)", async () => {
    // Create fresh dep task-0110 → advance to 'merged' (without going to closed).
    await fetch(`${base}/api/v1/projects/proj-gate/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: "task-0110",
        title: "Dep ending at merged",
        scope: { paths: ["lib/**"] },
      }),
    });
    await transitionTask(
      base, "proj-gate", "task-0110",
      "queued", "ready", "planning", "implementing", "auditing", "merging", "merged"
    );

    // Create dependent task-0111
    await fetch(`${base}/api/v1/projects/proj-gate/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: "task-0111",
        title: "Depends on task-0110",
        depends: ["task-0110"],
        scope: { paths: ["lib/tests/**"] },
      }),
    });
    await transitionTask(base, "proj-gate", "task-0111", "queued");

    // task-0110 is merged → resolved → task-0111 should go ready
    const finalStatus = await pollUntil(
      () => getStatus(base, "proj-gate", "task-0111"),
      (s) => s === "ready",
      3000
    );
    assert.equal(
      finalStatus,
      "ready",
      "task-0111 must promote to ready when dep is 'merged' (resolved)"
    );
  });

  it("[AC-Scc9152-2-1d] 'approved' state does NOT count as resolved (imp-0041)", async () => {
    // Advance dep to 'approved'
    await fetch(`${base}/api/v1/projects/proj-gate/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: "task-0120",
        title: "Dep at approved",
        scope: { paths: ["scripts/**"] },
      }),
    });
    await transitionTask(
      base, "proj-gate", "task-0120",
      "queued", "ready", "planning", "implementing",
      "auditing", "review-ready", "in-review", "approved"
    );

    await fetch(`${base}/api/v1/projects/proj-gate/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: "task-0121",
        title: "Depends on approved dep",
        depends: ["task-0120"],
        scope: { paths: ["scripts/tests/**"] },
      }),
    });
    await transitionTask(base, "proj-gate", "task-0121", "queued");

    // Give the gate more than one tick (tickIntervalMs=500) to evaluate.
    await new Promise((r) => setTimeout(r, 1200));

    const finalStatus = await getStatus(base, "proj-gate", "task-0121");
    assert.equal(
      finalStatus,
      "queued",
      "task-0121 must stay queued: dep is 'approved' — the merge has not even started"
    );
  });

  it("[AC-Scc9152-2-1e] task with no deps and no scope overlap promotes immediately to ready", async () => {
    // Standalone task: no deps, unique scope. Gate should pass on first evaluation.
    await fetch(`${base}/api/v1/projects/proj-gate/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: "task-0199",
        title: "Standalone no-dep task",
        scope: { paths: ["standalone/**"] },
      }),
    });
    await transitionTask(base, "proj-gate", "task-0199", "queued");

    const finalStatus = await pollUntil(
      () => getStatus(base, "proj-gate", "task-0199"),
      (s) => s === "ready",
      3000
    );
    assert.equal(
      finalStatus,
      "ready",
      "standalone task with no deps must be promoted to ready by gate"
    );
  });

  // ── imp-0041: `merging` は終端ではない ──────────────────────────────────────
  //
  // dentaku で実測した筋（2026-08-15）：依存が merging に入った瞬間に後続が ready へ
  // 上がり、その後 rebase 衝突で依存が implementing に差し戻された。main に成果が
  // 無いまま後続の職人が走り出す。

  it("[AC-Scc9152-2-1f] dependency in 'merging' keeps the dependent blocked", async () => {
    await fetch(`${base}/api/v1/projects/proj-gate/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: "task-0130",
        title: "Dep parked at merging",
        scope: { paths: ["mmm/**"] },
      }),
    });
    await transitionTask(
      base, "proj-gate", "task-0130",
      "queued", "ready", "planning", "implementing", "auditing", "merging"
    );

    await fetch(`${base}/api/v1/projects/proj-gate/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: "task-0131",
        title: "Depends on a merging task",
        depends: ["task-0130"],
        scope: { paths: ["nnn/**"] },
      }),
    });
    await transitionTask(base, "proj-gate", "task-0131", "queued");

    // Wait past a full tick (tickIntervalMs=500) so the gate has certainly evaluated.
    await new Promise((r) => setTimeout(r, 1200));

    assert.equal(
      await getStatus(base, "proj-gate", "task-0131"),
      "queued",
      "task-0131 must stay queued: 'merging' is not terminal — the merge can still fail"
    );

    const gateEvents = await getGateEvents(base, "proj-gate", "task-0131");
    const lastBlocked = gateEvents.filter((e) => e.passed === false).at(-1);
    assert.ok(lastBlocked, "a gate_evaluated(passed=false) must have been recorded");
    assert.ok(
      lastBlocked.blockedBy?.includes("task-0130(unresolved:merging)"),
      `blockedBy must name the merging dependency, got ${JSON.stringify(lastBlocked.blockedBy)}`
    );
  });

  it("[AC-Scc9152-2-1g] dependent promotes to ready once the dependency reaches 'merged'", async () => {
    // task-0130 is still 'merging' from the previous test. Land it.
    await transitionTask(base, "proj-gate", "task-0130", "merged");

    const finalStatus = await pollUntil(
      () => getStatus(base, "proj-gate", "task-0131"),
      (s) => s === "ready",
      5000
    );
    assert.equal(
      finalStatus,
      "ready",
      "task-0131 must promote to ready as soon as task-0130 is 'merged' (output is on main)"
    );
  });

  it("[AC-Scc9152-2-1h] dependency rolled back merging→implementing never releases the dependent", async () => {
    await fetch(`${base}/api/v1/projects/proj-gate/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: "task-0140",
        title: "Dep that loses the rebase",
        scope: { paths: ["ppp/**"] },
      }),
    });
    await transitionTask(
      base, "proj-gate", "task-0140",
      "queued", "ready", "planning", "implementing", "auditing", "merging"
    );

    await fetch(`${base}/api/v1/projects/proj-gate/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: "task-0141",
        title: "Depends on the rolled-back task",
        depends: ["task-0140"],
        scope: { paths: ["qqq/**"] },
      }),
    });
    await transitionTask(base, "proj-gate", "task-0141", "queued");
    await new Promise((r) => setTimeout(r, 1200));

    // rebase_conflict: the merge queue sends task-0140 back to implementing.
    await transitionTask(base, "proj-gate", "task-0140", "implementing");
    await new Promise((r) => setTimeout(r, 1200));

    assert.equal(
      await getStatus(base, "proj-gate", "task-0141"),
      "queued",
      "task-0141 must never have left queued: task-0140's output never reached main"
    );

    // And it must never have been promoted at any point in between, either.
    const gateEvents = await getGateEvents(base, "proj-gate", "task-0141");
    assert.ok(
      gateEvents.every((e) => e.passed !== true),
      `no gate_evaluated(passed=true) may exist for task-0141, got ${JSON.stringify(gateEvents)}`
    );
  });
});

/**
 * AC-Scc9152-2-1: Dependency gate — queued task stays blocked until dependency
 * resolves, then gets promoted to ready.
 *
 * Resolved states (unblock): approved | merging | merged | evaluating | closed
 * Unresolved states (keep blocked): queued | ready | planning | implementing |
 *   auditing | review-ready | in-review
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
      const body = await res.text();
      throw new Error(`Transition ${taskId}→'${to}' failed (${res.status}): ${body}`);
    }
  }
}

async function getStatus(base: string, proj: string, taskId: string): Promise<string> {
  const r = await fetch(`${base}/api/v1/projects/${proj}/tasks/${taskId}`);
  return (await r.json() as { task: { status: string } }).task.status;
}

describe("[AC-Scc9152-2-1] Gate condition 1: dependency-driven queued→ready", () => {
  let tmpDir: string;
  let daemon: Daemon;
  let base: string;

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "banto-gate-deps-"));
    daemon = Daemon.create({ port: 0, dataDir: tmpDir, tickIntervalMs: 500 });
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

  it("[AC-Scc9152-2-1d] 'approved' state counts as resolved (promotes dependent)", async () => {
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

    const finalStatus = await pollUntil(
      () => getStatus(base, "proj-gate", "task-0121"),
      (s) => s === "ready",
      3000
    );
    assert.equal(
      finalStatus,
      "ready",
      "task-0121 must promote to ready when dep is 'approved' (resolved)"
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
});

/**
 * AC-Scc9152-2-2: Gate condition 2 — scope.paths overlap with unreviewed ancestor
 * causes spawn deferral; non-overlapping scope allows parallel execution.
 *
 * Spec-multi-project §3 condition 2:
 *   - If there exists an unreviewed ancestor (queued/ready/.../in-review) in the
 *     same project whose scope.paths overlaps with the candidate's scope.paths,
 *     the candidate stays in queued.
 *   - If no such overlap, the candidate is promoted to ready (parallel OK).
 *   - When the ancestor passes review (reaches approved/merging/merged/etc.),
 *     the blocked task is re-evaluated and promoted.
 *
 * Uses real Daemon (port=0) with HTTP API. No watcher (tasks created via API).
 * Tick interval is set large (60s) to confirm promotion is driven by state
 * transitions, not just periodic ticks.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { Daemon } from "@banto/daemon";

/** Poll until predicate passes or timeout. Returns last value. */
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
    // If task is already at the target status (e.g. promoted by immediate gate
    // evaluation), skip this step to avoid an invalid self-transition error.
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
  if (!r.ok) throw new Error(`GET task failed: ${r.status}`);
  return (await r.json() as { task: { status: string } }).task.status;
}

describe("[AC-Scc9152-2-2] Gate condition 2: scope.paths overlap with unreviewed ancestor", () => {
  let tmpDir: string;
  let daemon: Daemon;
  let base: string;

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "banto-gate-scope-"));
    // Large tick interval to confirm promotion is transition-driven, not tick-driven.
    // disableAuditSpawn: tests scope-overlap gate logic; transitions through auditing
    // are state placeholders and must not trigger audit session spawn.
    daemon = Daemon.create({ port: 0, dataDir: tmpDir, tickIntervalMs: 60000, disableAuditSpawn: true, disableAutoSpawn: true });
    await daemon.start();
    base = `http://localhost:${daemon.port}`;

    const projRes = await fetch(`${base}/api/v1/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "proj-scope", repoPath: "/repos/proj-scope" }),
    });
    assert.equal(projRes.status, 201, "project must register");
  });

  after(async () => {
    await daemon.stop();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("[AC-Scc9152-2-2a] overlapping scope with unreviewed ancestor → spawn deferred (queued)", async () => {
    // Create and advance ancestor task-0020 to 'implementing' (unreviewed)
    // scope: src/shared/**
    await fetch(`${base}/api/v1/projects/proj-scope/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: "task-0020",
        title: "Ancestor with shared scope",
        scope: { paths: ["src/shared/**"] },
      }),
    });
    // Advance to 'implementing' (unreviewed)
    await transitionTask(
      base, "proj-scope", "task-0020",
      "queued", "ready", "planning", "implementing"
    );

    const ancestorStatus = await getStatus(base, "proj-scope", "task-0020");
    assert.equal(ancestorStatus, "implementing", "ancestor must be implementing");

    // Create task-0021 with scope that overlaps with task-0020's src/shared/**
    // src/shared/utils.ts is within src/shared/**  → overlap
    await fetch(`${base}/api/v1/projects/proj-scope/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: "task-0021",
        title: "Overlapping scope task",
        scope: { paths: ["src/shared/utils.ts"] },
      }),
    });
    await transitionTask(base, "proj-scope", "task-0021", "queued");

    // Wait a moment for gate to evaluate (transition-driven, fires immediately)
    await new Promise((r) => setTimeout(r, 400));

    const status21 = await getStatus(base, "proj-scope", "task-0021");
    assert.equal(
      status21,
      "queued",
      "task-0021 must stay queued: scope overlaps with unreviewed ancestor task-0020"
    );
  });

  it("[AC-Scc9152-2-2b] non-overlapping scope → parallel execution allowed (ready)", async () => {
    // task-0020 is still 'implementing'. Place a task with non-overlapping scope.
    // src/other/** does NOT overlap with src/shared/**
    await fetch(`${base}/api/v1/projects/proj-scope/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: "task-0022",
        title: "Non-overlapping scope task",
        scope: { paths: ["src/other/**"] },
      }),
    });
    await transitionTask(base, "proj-scope", "task-0022", "queued");

    // gate should promote immediately — no scope overlap with unreviewed ancestor
    const finalStatus = await pollUntil(
      () => getStatus(base, "proj-scope", "task-0022"),
      (s) => s === "ready",
      3000
    );
    assert.equal(
      finalStatus,
      "ready",
      "task-0022 must be promoted to ready: src/other/** does not overlap with src/shared/**"
    );
  });

  it("[AC-Scc9152-2-2c] task promotes to ready after ancestor passes review (approved)", async () => {
    // Advance task-0020 to 'approved' (passes review)
    await transitionTask(
      base, "proj-scope", "task-0020",
      "auditing", "review-ready", "in-review", "approved"
    );

    // task-0021 was blocked by scope overlap. Now the ancestor is approved → resolved.
    // Gate re-evaluation fires on the transition call above → task-0021 should promote.
    const finalStatus = await pollUntil(
      () => getStatus(base, "proj-scope", "task-0021"),
      (s) => s === "ready",
      5000
    );
    assert.equal(
      finalStatus,
      "ready",
      "task-0021 must be promoted to ready once ancestor task-0020 passes review (approved)"
    );
  });

  it("[AC-Scc9152-2-2d] glob intersection: 'src/**' overlaps with 'src/a/b.ts'", async () => {
    // Task with broad scope src/**
    await fetch(`${base}/api/v1/projects/proj-scope/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: "task-0030",
        title: "Broad scope src/**",
        scope: { paths: ["src/**"] },
      }),
    });
    await transitionTask(
      base, "proj-scope", "task-0030",
      "queued", "ready", "planning", "implementing"
    );

    // Task with narrow scope inside src/ — should be blocked by overlap
    await fetch(`${base}/api/v1/projects/proj-scope/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: "task-0031",
        title: "Narrow scope inside src/",
        scope: { paths: ["src/a/b.ts"] },
      }),
    });
    await transitionTask(base, "proj-scope", "task-0031", "queued");

    await new Promise((r) => setTimeout(r, 400));

    const status31 = await getStatus(base, "proj-scope", "task-0031");
    assert.equal(
      status31,
      "queued",
      "task-0031 (src/a/b.ts) must be blocked by task-0030 (src/**) — overlap detected"
    );
  });

  it("[AC-Scc9152-2-2e] 'src/**' and 'src/**' overlap (same prefix)", async () => {
    // Create another task with scope src/** while task-0030 is still implementing
    await fetch(`${base}/api/v1/projects/proj-scope/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: "task-0032",
        title: "Another src/** task",
        scope: { paths: ["src/**"] },
      }),
    });
    await transitionTask(base, "proj-scope", "task-0032", "queued");

    await new Promise((r) => setTimeout(r, 400));

    const status32 = await getStatus(base, "proj-scope", "task-0032");
    assert.equal(
      status32,
      "queued",
      "task-0032 (src/**) must be blocked by task-0030 (src/**) — identical prefix overlap"
    );
  });

  it("[AC-Scc9152-2-2f] 'docs/**' does not overlap with 'src/**' (disjoint trees)", async () => {
    // A task with completely disjoint scope should not be blocked by task-0030 (src/**)
    await fetch(`${base}/api/v1/projects/proj-scope/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: "task-0033",
        title: "Docs-only scope",
        scope: { paths: ["docs/**"] },
      }),
    });
    await transitionTask(base, "proj-scope", "task-0033", "queued");

    const finalStatus = await pollUntil(
      () => getStatus(base, "proj-scope", "task-0033"),
      (s) => s === "ready",
      3000
    );
    assert.equal(
      finalStatus,
      "ready",
      "task-0033 (docs/**) must be promoted to ready — no overlap with src/** ancestor"
    );
  });
});

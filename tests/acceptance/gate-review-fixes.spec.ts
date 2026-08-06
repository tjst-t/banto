// Regression tests for Scc9152-2 review fixes:
//
// Fix 1 (temporal ancestor ordering / deadlock):
//   Two tasks with overlapping scope enter queued at the same time.
//   The earlier-created task (T1) must be promoted to ready immediately.
//   The later-created task (T2) must stay queued until T1 passes review.
//   After T1 is approved, T2 must be promoted. No deadlock must occur.
//
// Fix 2 (gate_evaluated dedup):
//   A blocked task that remains blocked across multiple ticks must NOT
//   accumulate extra gate_evaluated(passed=false) events.
//   Only one event per distinct (passed, blockedBy) result is recorded.
//   When blockedBy changes (partial resolution), a new event IS recorded.
//
// Fix 3 (mid-path glob intersection):
//   globsOverlap("src/a/**", "src/<star><star>/b.ts") must return true.
//   globsOverlap("src/a/**", "docs/<star><star>/b.ts") must return false.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { Daemon } from "@banto/daemon";
import { globsOverlap } from "../../packages/banto-daemon/src/gate-evaluator.js";

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
      throw new Error(`Transition ${taskId}->'${to}' failed (${res.status}): ${body}`);
    }
  }
}

async function getStatus(base: string, proj: string, taskId: string): Promise<string> {
  const r = await fetch(`${base}/api/v1/projects/${proj}/tasks/${taskId}`);
  if (!r.ok) throw new Error(`GET task failed: ${r.status}`);
  return (await r.json() as { task: { status: string } }).task.status;
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

// ────────────────────────────────────────────────────────────────────────────
// Fix 1: Temporal ancestor ordering / deadlock prevention
// ────────────────────────────────────────────────────────────────────────────

describe("[Scc9152-2-fix1] Temporal ancestor ordering prevents deadlock", () => {
  let tmpDir: string;
  let daemon: Daemon;
  let base: string;

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "banto-fix1-"));
    // Long tick interval: we want to confirm gate fires on transition, not periodic tick.
    // disableAuditSpawn: tests gate deferred-review logic; transitions pass through auditing
    // as state placeholders without needing actual audit session spawning.
    daemon = Daemon.create({ port: 0, dataDir: tmpDir, tickIntervalMs: 60000, disableAuditSpawn: true, disableAutoSpawn: true });
    await daemon.start();
    base = `http://localhost:${daemon.port}`;

    const projRes = await fetch(`${base}/api/v1/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "proj-fix1", repoPath: "/repos/proj-fix1" }),
    });
    assert.equal(projRes.status, 201);
  });

  after(async () => {
    await daemon.stop();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("[fix1-a] earlier-created task (T1) promotes to ready; later-created (T2) stays queued", async () => {
    // Create T1 first, then T2. Both have overlapping scope (src/shared/**).
    // T1 was created before T2, so T1 has no temporal ancestors → promoted.
    // T2 sees T1 as a temporal ancestor → deferred.
    await fetch(`${base}/api/v1/projects/proj-fix1/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: "t1-fix1",
        title: "T1 - first created",
        scope: { paths: ["src/shared/**"] },
      }),
    });
    // Small delay to ensure sequential creation (distinct eventIds)
    await new Promise((r) => setTimeout(r, 10));

    await fetch(`${base}/api/v1/projects/proj-fix1/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: "t2-fix1",
        title: "T2 - second created",
        scope: { paths: ["src/shared/**"] },
      }),
    });

    // Queue both simultaneously
    await transitionTask(base, "proj-fix1", "t1-fix1", "queued");
    await transitionTask(base, "proj-fix1", "t2-fix1", "queued");

    // T1 should be promoted to ready (no temporal ancestors with overlapping scope)
    const t1Status = await pollUntil(
      () => getStatus(base, "proj-fix1", "t1-fix1"),
      (s) => s === "ready",
      5000
    );
    assert.equal(t1Status, "ready", "T1 (earlier-created) must be promoted to ready");

    // T2 should remain queued (T1 is a temporal ancestor with overlapping scope)
    // Give the gate enough time to evaluate T2 too
    await new Promise((r) => setTimeout(r, 500));
    const t2Status = await getStatus(base, "proj-fix1", "t2-fix1");
    assert.equal(
      t2Status,
      "queued",
      "T2 (later-created) must stay queued: T1 is an overlapping temporal ancestor"
    );
  });

  it("[fix1-b] after T1 passes review, T2 is promoted (no deadlock)", async () => {
    // Advance T1 through to approved (passes review)
    await transitionTask(
      base, "proj-fix1", "t1-fix1",
      "planning", "implementing", "auditing", "review-ready", "in-review", "approved"
    );

    // T2 must now be promoted to ready
    const t2Status = await pollUntil(
      () => getStatus(base, "proj-fix1", "t2-fix1"),
      (s) => s === "ready",
      5000
    );
    assert.equal(
      t2Status,
      "ready",
      "T2 must be promoted to ready after T1 is approved (temporal ancestor resolved)"
    );
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Fix 2: gate_evaluated dedup
// ────────────────────────────────────────────────────────────────────────────

describe("[Scc9152-2-fix2] gate_evaluated events are deduplicated", () => {
  let tmpDir: string;
  let daemon: Daemon;
  let base: string;

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "banto-fix2-"));
    // Short tick interval to drive multiple gate evaluations
    // disableAuditSpawn: tests gate deduplication logic; same reasoning as above.
    daemon = Daemon.create({ port: 0, dataDir: tmpDir, tickIntervalMs: 200, disableAuditSpawn: true, disableAutoSpawn: true });
    await daemon.start();
    base = `http://localhost:${daemon.port}`;

    const projRes = await fetch(`${base}/api/v1/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "proj-fix2", repoPath: "/repos/proj-fix2" }),
    });
    assert.equal(projRes.status, 201);
  });

  after(async () => {
    await daemon.stop();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("[fix2-a] blocked task does NOT accumulate gate_evaluated(passed=false) across ticks", async () => {
    // Create a dep that stays unresolved (implementing)
    await fetch(`${base}/api/v1/projects/proj-fix2/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: "dep-fix2",
        title: "Unresolved dep",
        scope: { paths: ["aaa/**"] },
      }),
    });
    await transitionTask(base, "proj-fix2", "dep-fix2", "queued");
    await pollUntil(
      () => getStatus(base, "proj-fix2", "dep-fix2"),
      (s) => s === "ready",
      3000
    );
    await transitionTask(base, "proj-fix2", "dep-fix2", "planning", "implementing");

    // Create dependent task that stays blocked
    await fetch(`${base}/api/v1/projects/proj-fix2/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: "blocked-fix2",
        title: "Blocked task",
        depends: ["dep-fix2"],
        scope: { paths: ["bbb/**"] },
      }),
    });
    await transitionTask(base, "proj-fix2", "blocked-fix2", "queued");

    // Wait for multiple ticks (tickIntervalMs=200, wait ~800ms = at least 3 extra ticks)
    await new Promise((r) => setTimeout(r, 800));

    // Count gate_evaluated(passed=false) events — must be exactly 1
    const gateEvents = await getGateEvents(base, "proj-fix2", "blocked-fix2");
    const blockedEvents = gateEvents.filter((e) => e.passed === false);
    assert.ok(
      blockedEvents.length >= 1,
      `Expected at least one gate_evaluated(passed=false), got ${blockedEvents.length}`
    );
    assert.equal(
      blockedEvents.length,
      1,
      `gate_evaluated(passed=false) must NOT proliferate across ticks. ` +
        `Expected exactly 1, got ${blockedEvents.length}. ` +
        `(dedup fix: same result should not be re-recorded)`
    );
  });

  it("[fix2-b] new gate_evaluated IS recorded when blockedBy set changes (partial resolution)", async () => {
    // Create two deps: dep-a and dep-b. Task depends on both.
    await fetch(`${base}/api/v1/projects/proj-fix2/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: "dep-a-fix2",
        title: "Dep A",
        scope: { paths: ["ccc/**"] },
      }),
    });
    await fetch(`${base}/api/v1/projects/proj-fix2/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: "dep-b-fix2",
        title: "Dep B",
        scope: { paths: ["ddd/**"] },
      }),
    });

    // Advance both deps to implementing (unresolved)
    await transitionTask(base, "proj-fix2", "dep-a-fix2", "queued");
    await pollUntil(
      () => getStatus(base, "proj-fix2", "dep-a-fix2"),
      (s) => s === "ready",
      3000
    );
    await transitionTask(base, "proj-fix2", "dep-a-fix2", "planning", "implementing");

    await transitionTask(base, "proj-fix2", "dep-b-fix2", "queued");
    await pollUntil(
      () => getStatus(base, "proj-fix2", "dep-b-fix2"),
      (s) => s === "ready",
      3000
    );
    await transitionTask(base, "proj-fix2", "dep-b-fix2", "planning", "implementing");

    // Create task depending on both
    await fetch(`${base}/api/v1/projects/proj-fix2/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: "two-deps-fix2",
        title: "Depends on A and B",
        depends: ["dep-a-fix2", "dep-b-fix2"],
        scope: { paths: ["eee/**"] },
      }),
    });
    await transitionTask(base, "proj-fix2", "two-deps-fix2", "queued");

    // Wait for initial blocked evaluation (blocked by both dep-a and dep-b)
    await pollUntil(
      () => getGateEvents(base, "proj-fix2", "two-deps-fix2"),
      (evts) => evts.some((e) => e.passed === false),
      3000
    );

    const eventsBeforeResolve = await getGateEvents(base, "proj-fix2", "two-deps-fix2");
    const blockedBeforeCount = eventsBeforeResolve.filter((e) => e.passed === false).length;
    assert.equal(blockedBeforeCount, 1, "should have exactly 1 blocked event before any change");

    // Partially resolve: advance dep-a to approved (resolved), dep-b stays implementing
    await transitionTask(
      base, "proj-fix2", "dep-a-fix2",
      "auditing", "review-ready", "in-review", "approved"
    );

    // Wait a moment for gate re-evaluation
    await new Promise((r) => setTimeout(r, 400));

    // A NEW gate_evaluated(passed=false) must have been recorded
    // because blockedBy changed (dep-a removed from the set, dep-b still in it)
    const eventsAfterPartialResolve = await getGateEvents(base, "proj-fix2", "two-deps-fix2");
    const blockedAfterCount = eventsAfterPartialResolve.filter((e) => e.passed === false).length;
    assert.equal(
      blockedAfterCount,
      2,
      `After partial resolution of dep-a, a NEW gate_evaluated(passed=false) must appear ` +
        `(blockedBy set changed from [dep-a,dep-b] to [dep-b]). Got ${blockedAfterCount} blocked events.`
    );

    // Verify the new event's blockedBy only contains dep-b
    const lastBlockedEvent = eventsAfterPartialResolve
      .filter((e) => e.passed === false)
      .at(-1);
    assert.ok(lastBlockedEvent !== undefined);
    const mentionsDep_b = lastBlockedEvent.blockedBy!.some((b) => b.startsWith("dep-b-fix2"));
    const mentionsDep_a = lastBlockedEvent.blockedBy!.some((b) => b.startsWith("dep-a-fix2"));
    assert.ok(mentionsDep_b, "latest blocked event must still reference dep-b");
    assert.ok(!mentionsDep_a, "latest blocked event must NOT reference dep-a (already resolved)");
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Fix 3: mid-path glob intersection
// ────────────────────────────────────────────────────────────────────────────

describe("[Scc9152-2-fix3] globsOverlap handles mid-path ** correctly", () => {
  it("[fix3-a] src/a/** overlaps with src/**/b.ts", () => {
    // Both share the src/ prefix → must be considered overlapping (conservative)
    assert.equal(
      globsOverlap("src/a/**", "src/**/b.ts"),
      true,
      "src/a/** and src/**/b.ts must be considered overlapping (both under src/)"
    );
  });

  it("[fix3-b] src/a/** does NOT overlap with docs/**/b.ts (disjoint trees)", () => {
    assert.equal(
      globsOverlap("src/a/**", "docs/**/b.ts"),
      false,
      "src/a/** and docs/**/b.ts are disjoint (different top-level directories)"
    );
  });

  it("[fix3-c] src/** overlaps with src/**/util.ts", () => {
    assert.equal(
      globsOverlap("src/**", "src/**/util.ts"),
      true,
      "src/** and src/**/util.ts overlap — src/ prefix matches"
    );
  });

  it("[fix3-d] pkg/a/**  overlaps with pkg/**/index.ts", () => {
    assert.equal(
      globsOverlap("pkg/a/**", "pkg/**/index.ts"),
      true,
      "pkg/a/** and pkg/**/index.ts overlap — share pkg/ prefix"
    );
  });

  it("[fix3-e] src/x/** does NOT overlap with lib/**/y.ts (different trees)", () => {
    assert.equal(
      globsOverlap("src/x/**", "lib/**/y.ts"),
      false,
      "src/x/** and lib/**/y.ts are disjoint"
    );
  });

  it("[fix3-f] ** (catch-all) always overlaps with anything", () => {
    assert.equal(globsOverlap("**", "src/**/b.ts"), true, "** overlaps with any pattern");
    assert.equal(globsOverlap("src/**/b.ts", "**"), true, "any pattern overlaps with **");
  });

  it("[fix3-g] exact path src/a/b.ts overlaps with src/**/b.ts", () => {
    // src/a/b.ts has prefix "src/a/b.ts"; src/**/b.ts has prefix "src/"
    // src/a/b.ts starts with "src/" → overlap
    assert.equal(
      globsOverlap("src/a/b.ts", "src/**/b.ts"),
      true,
      "exact path src/a/b.ts overlaps with src/**/b.ts"
    );
  });
});

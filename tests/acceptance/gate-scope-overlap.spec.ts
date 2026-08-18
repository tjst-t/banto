/**
 * AC-Scc9152-2-2: Gate condition 2 — scope.paths overlap with unreviewed ancestor
 * is now a WARNING, not a block (PO 裁定 2026-08-17): the task proceeds to ready.
 * Non-overlapping scope runs in parallel without any warning.
 *
 * PO 裁定 2026-08-17: 並行度を上げるため待ち→警告に緩和。衝突はマージ時の rebase と
 * 差戻（rebase_conflict → rework）で処理する。ゲート自体は残す——重複で止めず、
 * gate_evaluated(passed=true, warnings=[...scope_overlap...]) に載せて進める。
 *
 * Spec-multi-project §3 condition 2:
 *   - If there exists an unreviewed ancestor (queued/ready/.../in-review) in the
 *     same project whose scope.paths overlaps with the candidate's scope.paths,
 *     the overlap is recorded as a warning and the candidate is promoted to ready.
 *   - If no such overlap, the candidate is promoted to ready with no warning.
 *   - Overlap detection itself (globsOverlap / scopePathsOverlap) is unchanged —
 *     only the consequence changed from "stay queued" to "warn and proceed".
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
import {
  globsOverlap,
  scopePathsOverlap,
} from "../../packages/banto-daemon/src/gate-evaluator.js";

/**
 * [AC-Scc9152-2-3] Pure-function tests for the overlap decision itself.
 *
 * These call globsOverlap / scopePathsOverlap directly: no daemon is started,
 * no sleep or polling is used, so the decision is testable in isolation from
 * the queue machinery that consumes it.
 *
 * Background: the gate blocked 17 tasks into a 2-hour serial queue because the
 * prefix was cut at the first *segment* containing a wildcard. That made
 * `tests/acceptance/backlog-*.spec.ts` claim the whole of `tests/acceptance/`,
 * so every task holding any file under that directory collided with every
 * other one, and max_concurrent_sessions was effectively 1.
 */
describe("[AC-Scc9152-2-3] scope overlap decision (pure function)", () => {
  // a1 — provably disjoint: the gate must NOT block these.
  const DISJOINT: Array<[string, string]> = [
    ["tests/acceptance/child-stdin-epipe.spec.ts", "tests/acceptance/backlog-*.spec.ts"],
    [
      "tests/acceptance/gate-scope-overlap.spec.ts",
      "tests/acceptance/pi-rpc-system-prompt-tools.spec.ts",
    ],
    ["packages/banto-daemon/src/gate-evaluator.ts", "packages/banto-host/src/bin.ts"],
  ];

  // a2 — genuinely intersecting: the detector must keep flagging these.
  //      (PO 裁定 2026-08-17: 待ち→警告に緩和。検出自体は変えない)
  const OVERLAPPING: Array<[string, string]> = [
    ["packages/**", "packages/banto-host/src/x.ts"],
    ["tests/acceptance/**", "tests/acceptance/foo.spec.ts"],
    ["docs/adr/**", "docs/**"],
    ["packages/banto-daemon/src/gate-evaluator.ts", "packages/banto-daemon/src/gate-evaluator.ts"],
    ["src/*/a.ts", "src/b/a.ts"],
  ];

  for (const [a, b] of DISJOINT) {
    it(`[AC-Scc9152-2-3a] '${a}' does not overlap '${b}'`, () => {
      assert.equal(globsOverlap(a, b), false, `${a} vs ${b} must be provably disjoint`);
      assert.equal(globsOverlap(b, a), false, "overlap must be symmetric");
    });
  }

  for (const [a, b] of OVERLAPPING) {
    it(`[AC-Scc9152-2-3b] '${a}' overlaps '${b}'`, () => {
      assert.equal(globsOverlap(a, b), true, `${a} vs ${b} must still overlap (warn, not wait)`);
      assert.equal(globsOverlap(b, a), true, "overlap must be symmetric");
    });
  }

  it("[AC-Scc9152-2-3c] a catch-all pattern still collides with everything", () => {
    // Undecidable at prefix granularity → always flag. Never loosen this:
    // the warning must remain honest, or parallel tasks will silently collide.
    assert.equal(globsOverlap("**", "packages/banto-daemon/src/gate-evaluator.ts"), true);
    assert.equal(globsOverlap("*", "docs/adr/adr-0009.md"), true);
  });

  it("[AC-Scc9152-2-3d] scopePathsOverlap: disjoint file lists run in parallel", () => {
    const a = [
      "tests/acceptance/child-stdin-epipe.spec.ts",
      "packages/banto-daemon/src/gate-evaluator.ts",
    ];
    const b = [
      "tests/acceptance/backlog-order.spec.ts",
      "packages/banto-host/src/bin.ts",
    ];
    assert.equal(scopePathsOverlap(a, b), false);
  });

  it("[AC-Scc9152-2-3e] scopePathsOverlap: a single shared entry blocks the whole set", () => {
    const a = [
      "tests/acceptance/child-stdin-epipe.spec.ts",
      "packages/banto-daemon/src/gate-evaluator.ts",
    ];
    const b = ["packages/banto-host/src/bin.ts", "tests/acceptance/**"];
    assert.equal(scopePathsOverlap(a, b), true, "tests/acceptance/** covers the first entry");
  });

  it("[AC-Scc9152-2-3f] an empty scope never claims anything", () => {
    assert.equal(scopePathsOverlap([], ["packages/**"]), false);
  });
});

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

  it("[AC-Scc9152-2-2a] overlapping scope with unreviewed ancestor → 警告のみで ready（PO 裁定 2026-08-17）", async () => {
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

    // PO 裁定 2026-08-17: スコープ重複は待ちではなく警告。即座に ready へ進む
    const status21 = await pollUntil(
      () => getStatus(base, "proj-scope", "task-0021"),
      (s) => s === "ready",
      3000
    );
    assert.equal(
      status21,
      "ready",
      "task-0021 must proceed to ready despite scope overlap with unreviewed ancestor task-0020 (PO 裁定 2026-08-17: 待ち→警告)"
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

  it("[AC-Scc9152-2-2c] scope_overlap は gate_evaluated(passed=true, warnings) に載る（待ちではない）", async () => {
    // task-0021 は 2-2a で重複のまま ready へ昇格済み。PO 裁定 2026-08-17:
    // 重複は待ち（blockedBy / passed=false）でなく警告（warnings / passed=true）として
    // ログに残して進める。その証跡をイベントログで検証する。
    const statusRes = await fetch(`${base}/api/v1/projects/proj-scope/tasks/task-0021`);
    const statusBody = await statusRes.json() as { task: { status: string } };
    assert.equal(statusBody.task.status, "ready", "task-0021 must be ready");

    const evtRes = await fetch(`${base}/api/v1/projects/proj-scope/tasks/task-0021/events`);
    const evtBody = await evtRes.json() as {
      events: Array<{ type: string; passed?: boolean; blockedBy?: string[]; warnings?: string[] }>;
    };
    const gateEvents = evtBody.events.filter((e) => e.type === "gate_evaluated");
    const passedEvent = gateEvents.find((e) => e.passed === true);
    assert.ok(passedEvent !== undefined, "a gate_evaluated(passed=true) must be recorded");

    // 警告に祖先（task-0020）と理由（scope_overlap）が載っている
    assert.ok(
      Array.isArray(passedEvent.warnings) && passedEvent.warnings.length > 0,
      `warnings must be non-empty, got: ${JSON.stringify(passedEvent.warnings)}`
    );
    assert.ok(
      passedEvent.warnings!.some(
        (w) => w.startsWith("task-0020") && w.includes("scope_overlap")
      ),
      `warnings must mention task-0020(scope_overlap:...), got: ${JSON.stringify(passedEvent.warnings)}`
    );
    // 待ち（blockedBy / passed=false）には scope_overlap が載らない
    const blockedWithScope = gateEvents.some(
      (e) => e.passed === false && (e.blockedBy ?? []).some((b) => b.includes("scope_overlap"))
    );
    assert.equal(blockedWithScope, false, "scope_overlap must never appear in blockedBy");
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

    // Task with narrow scope inside src/ — overlaps src/**, but that is now only
    // a warning (PO 裁定 2026-08-17): the task proceeds to ready
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

    const finalStatus31 = await pollUntil(
      () => getStatus(base, "proj-scope", "task-0031"),
      (s) => s === "ready",
      3000
    );
    assert.equal(
      finalStatus31,
      "ready",
      "task-0031 (src/a/b.ts) must proceed to ready despite overlapping task-0030 (src/**) — 警告のみ（PO 裁定 2026-08-17）"
    );
  });

  it("[AC-Scc9152-2-2e] 'src/**' and 'src/**' overlap (same prefix) → 警告のみで ready", async () => {
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

    const finalStatus32 = await pollUntil(
      () => getStatus(base, "proj-scope", "task-0032"),
      (s) => s === "ready",
      3000
    );
    assert.equal(
      finalStatus32,
      "ready",
      "task-0032 (src/**) must proceed to ready despite identical-prefix overlap with task-0030 (src/**) — 警告のみ（PO 裁定 2026-08-17）"
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

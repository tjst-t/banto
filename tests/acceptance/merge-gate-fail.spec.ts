/**
 * [AC-S75f66b-4-3] Gate failure fails the task; mainline HEAD is untouched.
 *
 * story_type=library: exercises the module's public API against a REAL git repo
 * created as a test fixture. No mocked git.
 *
 * Scenario 3 (from scenario-S75f66b-4.json):
 *   - A real git repo; record `git rev-parse main` before the gate run
 *   - A task in 'merging' whose branch violates scope or fails verify
 *
 *   Step 1: Consumer runs the gate-fail handling path (gate → StateMachine.fail).
 *     Expected: Task status derived from the log is 'failed'
 *               (state_transitioned→failed + task_failed with gate reason, I2);
 *               `git rev-parse main` after the run equals the recorded value —
 *               nothing was merged; no merge commit exists on main.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { execFileSync } from "node:child_process";
import { runMergeGate } from "@banto/daemon";
import { EventLog, StateStore } from "@banto/core";

// ── Git fixture helpers ────────────────────────────────────────────────────────

/**
 * Create a git repo with mainline 'main' and a task branch that violates scope.
 * The task branch edits src/allowed/a.ts (in scope) AND docs/forbidden.md (out of scope).
 * Returns the repo dir and the HEAD SHA of main before any gate action.
 */
function setupViolatingScopeRepo(repoDir: string): {
  base: string;
  branch: string;
  mainHeadBefore: string;
} {
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: repoDir, stdio: "pipe" });

  git("init", "-b", "main");
  git("config", "user.email", "test@banto-test.local");
  git("config", "user.name", "banto-test");

  // Initial commit on main
  fs.mkdirSync(path.join(repoDir, "src", "allowed"), { recursive: true });
  fs.mkdirSync(path.join(repoDir, "docs"), { recursive: true });
  fs.writeFileSync(path.join(repoDir, "src", "allowed", "a.ts"), "// initial\n");
  fs.writeFileSync(path.join(repoDir, "docs", "README.md"), "# docs\n");
  git("add", "-A");
  git("commit", "-m", "initial");

  // Record mainline HEAD before any gate run
  const mainHeadBefore = execFileSync("git", ["rev-parse", "main"], {
    cwd: repoDir,
    stdio: "pipe",
  })
    .toString("utf-8")
    .trim();

  // Create task branch that violates scope
  git("checkout", "-b", "task-fail-branch");
  fs.writeFileSync(path.join(repoDir, "src", "allowed", "a.ts"), "// changed\n");
  fs.writeFileSync(path.join(repoDir, "docs", "forbidden.md"), "# out of scope\n");
  git("add", "-A");
  git("commit", "-m", "task: scope violation");

  return { base: "main", branch: "task-fail-branch", mainHeadBefore };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("[AC-S75f66b-4-3] Gate failure: task→failed; mainline HEAD untouched (library)", () => {
  let repoDir: string;
  let dataDir: string;
  let mainHeadBefore: string;
  let base: string;
  let branch: string;

  before(() => {
    repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "banto-mgate-fail-repo-"));
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "banto-mgate-fail-data-"));
    const refs = setupViolatingScopeRepo(repoDir);
    base = refs.base;
    branch = refs.branch;
    mainHeadBefore = refs.mainHeadBefore;
  });

  after(() => {
    fs.rmSync(repoDir, { recursive: true, force: true });
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it("[AC-S75f66b-4-3] step 1: gate fail → task status=failed in event log; main HEAD unchanged", async () => {
    const log = EventLog.open(dataDir);

    // Seed the task: draft → ... → merging (matching scenario precondition)
    log.append({
      type: "task_created",
      projectTag: "proj-fail-test",
      taskId: "task-fail-01",
      payload: {
        title: "Scope violating task",
        scope: { paths: ["src/allowed/**"] },
        acceptance: [{ id: "a1", text: "allowed file changed" }],
      },
    });
    log.append({
      type: "state_transitioned",
      projectTag: "proj-fail-test",
      taskId: "task-fail-01",
      from: "draft",
      to: "merging",
    });

    const task = {
      id: "task-fail-01",
      projectTag: "proj-fail-test",
      status: "merging",
      title: "Scope violating task",
      scope: { paths: ["src/allowed/**"] },
      acceptance: [{ id: "a1", text: "allowed file changed" }],
    };

    // Run the gate (expected to fail due to scope violation)
    const gateResult = await runMergeGate(log, task, {
      dataDir,
      repoPath: repoDir,
      base,
      branch,
      worktreePath: repoDir,
    });

    // Gate must fail
    assert.equal(gateResult.passed, false, "gate must fail due to scope violation");

    // ── Verify task status is 'failed' via event log replay ─────────────────
    // D3: task status is derived exclusively from state_transitioned events.
    // We replay the event log to confirm the state_transitioned(→failed) was appended.
    const events = log.readAllEvents();

    // There must be a state_transitioned event with to="failed"
    const failedTransition = events.find(
      (e) =>
        e.type === "state_transitioned" &&
        (e as { to: string }).to === "failed" &&
        (e as { taskId: string }).taskId === "task-fail-01"
    );
    assert.ok(
      failedTransition !== undefined,
      "state_transitioned(→failed) event must be appended (I2: stop, record, don't swallow)"
    );

    // There must also be a task_failed event with the gate reason
    const taskFailedEvent = events.find(
      (e) =>
        e.type === "task_failed" &&
        (e as { taskId: string }).taskId === "task-fail-01"
    );
    assert.ok(taskFailedEvent !== undefined, "task_failed event must be appended");

    const failedReason = (taskFailedEvent as { reason: string }).reason;
    assert.ok(
      failedReason.includes("merge_gate_failed"),
      `task_failed reason must mention merge_gate_failed; got: "${failedReason}"`
    );

    // Replay via StateStore to confirm derived status = "failed"
    const store = StateStore.replay(log);
    const taskRecord = store.getTask("task-fail-01", "proj-fail-test");
    assert.ok(taskRecord !== undefined, "task record must exist in store");
    assert.equal(
      taskRecord!.status,
      "failed",
      "task derived status must be 'failed' after gate failure (StateMachine.fail called, I2)"
    );

    // ── Verify mainline HEAD is unchanged ────────────────────────────────────
    // The gate module does NOT perform any git merge — it only evaluates.
    // Wiring to actual merge happens in S75f66b-5.
    // Here we confirm that runMergeGate did not modify main.
    const mainHeadAfter = execFileSync("git", ["rev-parse", base], {
      cwd: repoDir,
      stdio: "pipe",
    })
      .toString("utf-8")
      .trim();

    assert.equal(
      mainHeadAfter,
      mainHeadBefore,
      `main HEAD must be unchanged after gate failure; was ${mainHeadBefore}, now ${mainHeadAfter}`
    );

    // Double-check: confirm no merge commit on main by checking the commit count
    // If a merge had happened, main would have advanced.
    const mainLog = execFileSync("git", ["log", "--oneline", base], {
      cwd: repoDir,
      stdio: "pipe",
    }).toString("utf-8");
    const mainCommitCount = mainLog.trim().split("\n").length;
    assert.equal(mainCommitCount, 1, "main must still have exactly 1 commit (no merge happened)");
  });
});

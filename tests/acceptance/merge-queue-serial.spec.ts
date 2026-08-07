/**
 * [AC-S75f66b-5-1] Serial merge queue: two approved tasks merge strictly one at a time
 * in approval order.
 *
 * story_type=api: exercises the real daemon HTTP API + real git repos.
 * No mocked git, no mocked daemon internals.
 *
 * Scenario 1 (from scenario-S75f66b-5.json):
 *   - Real daemon + real git repo; two tasks (task-A, task-B) each with a
 *     worktree/branch containing non-conflicting committed changes and
 *     passing verify commands.
 *   - PO approves both tasks (A first, then B).
 *
 *   Step 1: PO approves task-A then task-B.
 *     Expected: Both return 200; tasks are in approved (or A already progressing).
 *
 *   Step 2: Wait for merge processor ticks to drain the queue.
 *     Expected:
 *       - Both tasks reach 'merged';
 *       - Event sequence shows STRICT serialization: task-A's merge events
 *         (through task_merged) all precede task-B's first merging event;
 *       - At no point are two tasks in 'merging' simultaneously;
 *       - Task order equals approval order;
 *       - `git log main` shows A's commit before B's.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { execFileSync, execSync } from "node:child_process";
import { Daemon } from "@banto/daemon";
import { hostVerifyRunner } from "./gate-verify-runner.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Poll until predicate passes or timeout. */
async function pollUntil<T>(
  fn: () => Promise<T>,
  pred: (v: T) => boolean,
  timeoutMs = 8000,
  intervalMs = 150
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last = await fn();
  while (!pred(last) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, intervalMs));
    last = await fn();
  }
  return last;
}

async function getTask(base: string, proj: string, taskId: string): Promise<{ status: string; [k: string]: unknown }> {
  const r = await fetch(`${base}/api/v1/projects/${proj}/tasks/${taskId}`);
  const body = await r.json() as { task: { status: string; [k: string]: unknown } };
  return body.task;
}

async function getStatus(base: string, proj: string, taskId: string): Promise<string> {
  return (await getTask(base, proj, taskId)).status;
}

async function getEvents(base: string, proj: string): Promise<Array<{ type: string; taskId?: string; [k: string]: unknown }>> {
  const r = await fetch(`${base}/api/v1/projects/${proj}/events`);
  const body = await r.json() as { events: Array<{ type: string; taskId?: string }> };
  return body.events;
}

async function transitionTo(base: string, proj: string, taskId: string, to: string): Promise<void> {
  const r = await fetch(`${base}/api/v1/projects/${proj}/tasks/${taskId}/transition`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ to }),
  });
  if (r.status !== 200) {
    const body = await r.text();
    throw new Error(`Transition ${taskId}→'${to}' failed (${r.status}): ${body}`);
  }
}

/** Advance a task through multiple states. */
async function advanceTo(base: string, proj: string, taskId: string, ...steps: string[]): Promise<void> {
  for (const to of steps) {
    const current = await getStatus(base, proj, taskId);
    if (current === to) continue;
    await transitionTo(base, proj, taskId, to);
  }
}

/**
 * Set up a minimal git repo with:
 *   - a task branch 'task/<taskId>' branched from 'main', with one committed file in scope
 *   - a worktree at <worktreeBase>/<proj>/<taskId> on the task branch
 *
 * Uses a separate worktree for branch creation (not the main repo checkout) to avoid
 * the "branch already in use" error from git worktree.
 */
function setupTaskBranch(opts: {
  repoDir: string;
  worktreeBaseDir: string;
  proj: string;
  taskId: string;
  fileName: string;
  content: string;
}): { taskBranch: string; worktreePath: string } {
  const { repoDir, worktreeBaseDir, proj, taskId, fileName, content } = opts;

  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: repoDir, stdio: "pipe" });

  const taskBranch = `task/${taskId}`;
  const worktreePath = path.join(worktreeBaseDir, proj, taskId);
  fs.mkdirSync(path.dirname(worktreePath), { recursive: true });

  // Create a detached worktree at HEAD (main), then create the task branch in it.
  // This avoids the "branch already in use" error.
  execFileSync("git", ["worktree", "add", "--detach", worktreePath], {
    cwd: repoDir,
    stdio: "pipe",
  });

  // Create the task branch in the worktree
  const wgit = (...args: string[]) =>
    execFileSync("git", args, { cwd: worktreePath, stdio: "pipe" });

  wgit("checkout", "-b", taskBranch);
  fs.writeFileSync(path.join(worktreePath, fileName), content);
  wgit("add", "-A");
  wgit("commit", "-m", `feat: ${taskId} — add ${fileName}`);

  // Ensure main is checked out in the repo (not the task branch)
  // The repo HEAD stays on main (we only created the branch in the worktree).
  void git; // keep ref to avoid TS unused var

  return { taskBranch, worktreePath };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("[AC-S75f66b-5-1] Serial merge queue: two tasks merged in approval order", () => {
  let tmpDir: string;
  let repoDir: string;
  let worktreeBaseDir: string;
  let daemon: Daemon;
  let base: string;
  const PROJ = "proj-serial";

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "banto-mq-serial-"));
    repoDir = path.join(tmpDir, "repo");
    worktreeBaseDir = path.join(tmpDir, "worktrees");

    // Initialize bare repo with an initial commit on 'main'
    fs.mkdirSync(repoDir, { recursive: true });
    execFileSync("git", ["init", "-b", "main"], { cwd: repoDir, stdio: "pipe" });
    execFileSync("git", ["config", "user.email", "test@banto-test.local"], { cwd: repoDir, stdio: "pipe" });
    execFileSync("git", ["config", "user.name", "banto-test"], { cwd: repoDir, stdio: "pipe" });
    fs.writeFileSync(path.join(repoDir, "README.md"), "# test\n");
    execFileSync("git", ["add", "-A"], { cwd: repoDir, stdio: "pipe" });
    execFileSync("git", ["commit", "-m", "initial"], { cwd: repoDir, stdio: "pipe" });

    // Start daemon with small tick interval for fast test execution
    // disableAuditSpawn: this suite tests serial merge-queue logic and drives tasks
    // through implementing→auditing via HTTP transitions (not real pi LLM sessions).
    // Disabling audit spawn avoids pi CLI resolution errors in CI environments.
    // The audit_spawn_disabled event is emitted for each implementing→auditing transition
    // (F2 governance: suppression is visible in the event log).
    const dataDir = path.join(tmpDir, "data");
    daemon = Daemon.create({
      // task-0075: 検証環境は必須。マージキューの筋道を見るのが本題なので偽物を差す
      verifyRunner: hostVerifyRunner(),
      port: 0,
      dataDir,
      worktreeBaseDir,
      tickIntervalMs: 200,
      watchIntervalMs: 999999, // disable watcher
      disableAuditSpawn: true,
      // task-0060: 職人を要らないので Worker Pool に頼まない
      disableAutoSpawn: true,
    });
    await daemon.start();
    base = `http://localhost:${daemon.port}`;

    // Register project
    const projRes = await fetch(`${base}/api/v1/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: PROJ, repoPath: repoDir }),
    });
    assert.equal(projRes.status, 201, "project registration must succeed");
  });

  after(async () => {
    await daemon.stop();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("[AC-S75f66b-5-1] serial ordering: task-A merged before task-B starts merging", async () => {
    // Create task branches BEFORE creating tasks in the daemon (worktrees must exist)
    setupTaskBranch({
      repoDir,
      worktreeBaseDir,
      proj: PROJ,
      taskId: "task-A",
      fileName: "a.ts",
      content: "// task A\n",
    });
    setupTaskBranch({
      repoDir,
      worktreeBaseDir,
      proj: PROJ,
      taskId: "task-B",
      fileName: "b.ts",
      content: "// task B\n",
    });

    // Create tasks in daemon with scope covering their files
    for (const { id, file } of [{ id: "task-A", file: "a.ts" }, { id: "task-B", file: "b.ts" }]) {
      const r = await fetch(`${base}/api/v1/projects/${PROJ}/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id,
          title: `Task ${id}`,
          scope: { paths: [`${file}`] },
          acceptance: [{ id: "a1", text: "file exists", verify: `test -f ${file}` }],
        }),
      });
      assert.equal(r.status, 201, `task ${id} creation must succeed`);
    }

    // Advance both tasks to 'in-review' → then approve A first, B second
    for (const taskId of ["task-A", "task-B"]) {
      await advanceTo(base, PROJ, taskId, "queued", "ready", "planning", "implementing", "auditing", "review-ready", "in-review");
    }

    // Step 1: Approve A then B (approval order establishes queue position)
    await transitionTo(base, PROJ, "task-A", "approved");
    await transitionTo(base, PROJ, "task-B", "approved");

    // Step 2: Wait for both tasks to reach 'merged' or 'closed'
    const terminalStates = new Set(["merged", "closed", "failed"]);

    const finalA = await pollUntil(
      () => getStatus(base, PROJ, "task-A"),
      (s) => terminalStates.has(s),
      12000
    );
    const finalB = await pollUntil(
      () => getStatus(base, PROJ, "task-B"),
      (s) => terminalStates.has(s),
      12000
    );

    assert.ok(
      finalA === "merged" || finalA === "closed",
      `task-A must reach merged/closed (got ${finalA})`
    );
    assert.ok(
      finalB === "merged" || finalB === "closed",
      `task-B must reach merged/closed (got ${finalB})`
    );

    // Verify serialization: in the event log, task-A's task_merged must come
    // before task-B's first state_transitioned→merging event
    const events = await getEvents(base, PROJ);
    const aMergedIdx = events.findIndex(
      (e) => e.type === "task_merged" && e["taskId"] === "task-A"
    );
    const bMergingIdx = events.findIndex(
      (e) =>
        e.type === "state_transitioned" &&
        e["taskId"] === "task-B" &&
        (e as { to?: string }).to === "merging"
    );
    assert.ok(aMergedIdx >= 0, "task-A must have a task_merged event");
    assert.ok(bMergingIdx >= 0, "task-B must have a state_transitioned→merging event");
    assert.ok(
      aMergedIdx < bMergingIdx,
      `task-A must be fully merged (idx=${aMergedIdx}) before task-B enters merging (idx=${bMergingIdx}) — serial discipline`
    );

    // Verify git history: A's commit appears before B's commit on main
    const log = execSync("git log main --oneline", { cwd: repoDir }).toString().trim();
    const lines = log.split("\n");
    // Most-recent first in git log, so B comes before A in the array
    const aLineIdx = lines.findIndex((l) => l.includes("task-A"));
    const bLineIdx = lines.findIndex((l) => l.includes("task-B"));
    assert.ok(aLineIdx >= 0, "task-A commit must appear in git log main");
    assert.ok(bLineIdx >= 0, "task-B commit must appear in git log main");
    // In git log (newest first), B should appear BEFORE A (B was merged after A)
    assert.ok(
      bLineIdx < aLineIdx,
      `task-B (merged second) should appear earlier in 'git log' (newest first); got aIdx=${aLineIdx} bIdx=${bLineIdx}`
    );
  });
});

/**
 * [AC-S75f66b-5-2] Merge success: cleanup idempotency, dependent task unblocking,
 * and merged→closed for tasks without hypothesis.
 *
 * story_type=api: exercises the real daemon HTTP API + real git repos.
 * No mocked internals.
 *
 * Scenario 2 (from scenario-S75f66b-5.json):
 *   - task-A: approved, has a mergeable branch, no hypothesis
 *   - task-C: depends on task-A (currently queued/blocked)
 *
 *   Step 1: PO approves task-A. Merge queue processes it.
 *     Expected:
 *       - GET events: task_merged event for task-A with a commitSha on main
 *       - task-A worktree directory no longer exists
 *       - task-A branch deleted from repo
 *       - Running cleanup again (idempotent) does NOT error (I3)
 *
 *   Step 2: After gate-reeval fires, task-C becomes 'ready'.
 *     Expected: task-C status == 'ready'
 *
 *   Step 3: task-A progresses to 'closed' (no hypothesis → merged→closed auto).
 *     Expected: task-A status == 'closed'
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { execFileSync, execSync } from "node:child_process";
import { Daemon, removeWorktree } from "@banto/daemon";
import { hostVerifyRunner } from "./gate-verify-runner.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

async function pollUntil<T>(
  fn: () => Promise<T>,
  pred: (v: T) => boolean,
  timeoutMs = 10000,
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

async function getStatus(base: string, proj: string, taskId: string): Promise<string> {
  const r = await fetch(`${base}/api/v1/projects/${proj}/tasks/${taskId}`);
  const body = await r.json() as { task: { status: string } };
  return body.task.status;
}

async function getEvents(base: string, proj: string): Promise<Array<{ type: string; [k: string]: unknown }>> {
  const r = await fetch(`${base}/api/v1/projects/${proj}/events`);
  const body = await r.json() as { events: Array<{ type: string }> };
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

async function advanceTo(base: string, proj: string, taskId: string, ...steps: string[]): Promise<void> {
  for (const to of steps) {
    const current = await getStatus(base, proj, taskId);
    if (current === to) continue;
    await transitionTo(base, proj, taskId, to);
  }
}

function setupTaskBranch(opts: {
  repoDir: string;
  worktreeBaseDir: string;
  proj: string;
  taskId: string;
  fileName: string;
  content: string;
}): { taskBranch: string; worktreePath: string } {
  const { repoDir, worktreeBaseDir, proj, taskId, fileName, content } = opts;

  const taskBranch = `task/${taskId}`;
  const worktreePath = path.join(worktreeBaseDir, proj, taskId);
  fs.mkdirSync(path.dirname(worktreePath), { recursive: true });

  // Create a detached worktree at HEAD (main) to avoid "branch already in use" error
  execFileSync("git", ["worktree", "add", "--detach", worktreePath], {
    cwd: repoDir,
    stdio: "pipe",
  });

  const wgit = (...args: string[]) =>
    execFileSync("git", args, { cwd: worktreePath, stdio: "pipe" });

  wgit("checkout", "-b", taskBranch);
  fs.writeFileSync(path.join(worktreePath, fileName), content);
  wgit("add", "-A");
  wgit("commit", "-m", `feat: ${taskId} — ${fileName}`);

  return { taskBranch, worktreePath };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("[AC-S75f66b-5-2] Merge cleanup, dependent unblocking, merged→closed", () => {
  let tmpDir: string;
  let repoDir: string;
  let worktreeBaseDir: string;
  let daemon: Daemon;
  let base: string;
  const PROJ = "proj-cleanup";
  let worktreePath: string;

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "banto-mq-cleanup-"));
    repoDir = path.join(tmpDir, "repo");
    worktreeBaseDir = path.join(tmpDir, "worktrees");

    fs.mkdirSync(repoDir, { recursive: true });
    execFileSync("git", ["init", "-b", "main"], { cwd: repoDir, stdio: "pipe" });
    execFileSync("git", ["config", "user.email", "test@banto-test.local"], { cwd: repoDir, stdio: "pipe" });
    execFileSync("git", ["config", "user.name", "banto-test"], { cwd: repoDir, stdio: "pipe" });
    fs.writeFileSync(path.join(repoDir, "README.md"), "# test\n");
    execFileSync("git", ["add", "-A"], { cwd: repoDir, stdio: "pipe" });
    execFileSync("git", ["commit", "-m", "initial"], { cwd: repoDir, stdio: "pipe" });

    // disableAuditSpawn: this suite tests merge cleanup, dependent unblocking, and
    // merged→closed logic — not the audit session mechanism. Tasks are driven through
    // implementing→auditing via HTTP transitions (not real pi LLM sessions).
    // audit_spawn_disabled event is emitted for each implementing→auditing transition
    // (F2 governance: suppression is visible in the event log).
    const dataDir = path.join(tmpDir, "data");
    daemon = Daemon.create({
      // task-0075: 検証環境は必須。マージキューの筋道を見るのが本題なので偽物を差す
      verifyRunner: hostVerifyRunner(),
      port: 0,
      dataDir,
      worktreeBaseDir,
      tickIntervalMs: 200,
      watchIntervalMs: 999999,
      disableAuditSpawn: true,
      // task-0060: 職人を要らないので Worker Pool に頼まない
      disableAutoSpawn: true,
    });
    await daemon.start();
    base = `http://localhost:${daemon.port}`;

    const projRes = await fetch(`${base}/api/v1/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: PROJ, repoPath: repoDir }),
    });
    assert.equal(projRes.status, 201, "project must register");

    // Set up task-A branch and worktree (no hypothesis in payload)
    const result = setupTaskBranch({
      repoDir,
      worktreeBaseDir,
      proj: PROJ,
      taskId: "task-A2",
      fileName: "a2.ts",
      content: "// task A2\n",
    });
    worktreePath = result.worktreePath;

    // Create task-A2 in daemon (no hypothesis field → will auto-close after merge)
    const aRes = await fetch(`${base}/api/v1/projects/${PROJ}/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: "task-A2",
        title: "Task A2",
        scope: { paths: ["a2.ts"] },
        acceptance: [{ id: "a1", text: "a2.ts exists", verify: "test -f a2.ts" }],
        // NO hypothesis field
      }),
    });
    assert.equal(aRes.status, 201, "task-A2 creation must succeed");

    // Create task-C: depends on task-A2
    const cRes = await fetch(`${base}/api/v1/projects/${PROJ}/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: "task-C2",
        title: "Task C2",
        depends: ["task-A2"],
        scope: { paths: ["c2.ts"] },
      }),
    });
    assert.equal(cRes.status, 201, "task-C2 creation must succeed");
  });

  after(async () => {
    await daemon.stop();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("[AC-S75f66b-5-2a] task_merged event emitted with commitSha on main", async () => {
    // Advance task-A2 to in-review and approve it
    await advanceTo(base, PROJ, "task-A2", "queued", "ready", "planning", "implementing", "auditing", "review-ready", "in-review");
    // Also queue task-C2 so it's blocked waiting for task-A2
    await advanceTo(base, PROJ, "task-C2", "queued");
    await transitionTo(base, PROJ, "task-A2", "approved");

    // Wait for task-A2 to reach closed (merged→closed because no hypothesis)
    const finalStatus = await pollUntil(
      () => getStatus(base, PROJ, "task-A2"),
      (s) => s === "closed" || s === "merged" || s === "failed",
      12000
    );
    assert.ok(
      finalStatus === "closed" || finalStatus === "merged",
      `task-A2 must reach merged or closed (got ${finalStatus})`
    );

    // Verify task_merged event exists with a valid commitSha
    const events = await getEvents(base, PROJ);
    const mergedEvent = events.find(
      (e) => e.type === "task_merged" && e["taskId"] === "task-A2"
    );
    assert.ok(mergedEvent, "task_merged event must exist for task-A2");
    const commitSha = mergedEvent!["commitSha"] as string;
    assert.ok(commitSha && commitSha.length >= 7, `commitSha must be a git hash (got: ${commitSha})`);

    // Verify the commit exists on main
    const logOutput = execSync("git log main --oneline", { cwd: repoDir }).toString();
    assert.ok(logOutput.includes(commitSha.slice(0, 7)), `commitSha ${commitSha} must appear on main`);
  });

  it("[AC-S75f66b-5-2b] worktree and branch cleaned up idempotently (I3)", async () => {
    // After task-A2 merged, the worktree should be gone
    const worktreeGone = !fs.existsSync(worktreePath);
    assert.ok(worktreeGone, `worktree must be removed after merge: ${worktreePath}`);

    // Branch should be deleted from the repo
    let branchExists = false;
    try {
      execFileSync("git", ["rev-parse", "--verify", "task/task-A2"], {
        cwd: repoDir,
        stdio: "pipe",
      });
      branchExists = true;
    } catch {
      branchExists = false;
    }
    assert.ok(!branchExists, "task branch task/task-A2 must be deleted after merge");

    // I3 idempotency (review fix S75f66b-5): invoke cleanup a SECOND TIME on the
    // already-removed worktree and assert:
    //   (a) no error is thrown, and
    //   (b) state is unchanged (worktree still absent, task still merged/closed).
    // This exercises the "already gone" path of removeWorktree explicitly.
    let secondCleanupError: unknown = null;
    try {
      await removeWorktree(repoDir, worktreePath);
    } catch (err) {
      secondCleanupError = err;
    }
    assert.equal(
      secondCleanupError,
      null,
      `removeWorktree called a second time on an already-removed worktree must NOT throw (I3). Got: ${secondCleanupError}`
    );

    // State must be unchanged: worktree still absent, task still in merged/closed
    const worktreeStillGone = !fs.existsSync(worktreePath);
    assert.ok(worktreeStillGone, "worktree must still be absent after second cleanup call (I3 idempotency)");

    // Task state must not have been affected by the second cleanup call
    const finalStatus = await getStatus(base, PROJ, "task-A2");
    assert.ok(
      finalStatus === "merged" || finalStatus === "closed",
      `task-A2 must remain in merged/closed state after second cleanup call (got: ${finalStatus})`
    );
  });

  it("[AC-S75f66b-5-2c] dependent task-C2 becomes ready after task-A2 merged", async () => {
    // task-A2 is already merged (from previous test). Gate re-eval should have
    // run and promoted task-C2 to 'ready'.
    const status = await pollUntil(
      () => getStatus(base, PROJ, "task-C2"),
      (s) => s === "ready",
      8000
    );
    assert.equal(status, "ready", "task-C2 must become ready after dependency task-A2 merged");
  });

  it("[AC-S75f66b-5-2d] task-A2 (no hypothesis) progressed to closed", async () => {
    // task-A2 has no hypothesis → should auto-transition from merged → closed
    const finalStatus = await pollUntil(
      () => getStatus(base, PROJ, "task-A2"),
      (s) => s === "closed",
      6000
    );
    assert.equal(finalStatus, "closed", "task-A2 (no hypothesis) must auto-close after merge");
  });
});

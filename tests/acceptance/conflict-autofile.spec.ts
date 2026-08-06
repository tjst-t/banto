/**
 * [AC-S75f66b-6-1] Conflict auto-filing: rebase failure auto-files a kind:conflict task,
 * pauses the original, and the merge queue continues with the next task.
 *
 * story_type=api: exercises the real daemon HTTP API + real git repos.
 * No mocked daemon internals (I1).
 *
 * Scenario (from scenario-S75f66b-6.json scenario-1-api):
 *   - Real daemon + real git repo.
 *   - task-A and task-B both edit the same line of the same file on their branches.
 *   - task-C touches an unrelated file.
 *   - All three approved in order A→B→C.
 *
 *   Step 1: PO approves A, B, C; waits.
 *     Expected:
 *       - task-A merges.
 *       - task-B's rebase fails (conflicts with A's merge on main); NO merge of task-B.
 *       - A new conflict task file appears in work/tasks/ with:
 *           kind: conflict, status: queued, refs[0]=task-B, scope.paths=the conflicted file.
 *       - task-B is 'paused' (suspended_from=merging).
 *       - task-C reaches merged/closed (queue was NOT blocked by task-B's conflict).
 *
 * Tags: [AC-S75f66b-6-1]
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { execFileSync } from "node:child_process";
import { Daemon } from "@banto/daemon";
import { validateTaskFrontmatter } from "@banto/core";

// ── Helpers ───────────────────────────────────────────────────────────────────

async function pollUntil<T>(
  fn: () => Promise<T>,
  pred: (v: T) => boolean,
  timeoutMs = 15000,
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

async function getTask(
  base: string,
  proj: string,
  taskId: string
): Promise<{ status: string; suspendedFrom?: string; [k: string]: unknown }> {
  const r = await fetch(`${base}/api/v1/projects/${proj}/tasks/${taskId}`);
  const body = (await r.json()) as {
    task: { status: string; [k: string]: unknown };
  };
  return body.task as { status: string; suspendedFrom?: string; [k: string]: unknown };
}

async function getStatus(
  base: string,
  proj: string,
  taskId: string
): Promise<string> {
  return (await getTask(base, proj, taskId)).status;
}

async function transitionTo(
  base: string,
  proj: string,
  taskId: string,
  to: string
): Promise<void> {
  const r = await fetch(
    `${base}/api/v1/projects/${proj}/tasks/${taskId}/transition`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ to }),
    }
  );
  if (r.status !== 200) {
    const body = await r.text();
    throw new Error(
      `Transition ${taskId}→'${to}' failed (${r.status}): ${body}`
    );
  }
}

async function advanceTo(
  base: string,
  proj: string,
  taskId: string,
  ...steps: string[]
): Promise<void> {
  for (const to of steps) {
    const current = await getStatus(base, proj, taskId);
    if (current === to) continue;
    await transitionTo(base, proj, taskId, to);
  }
}

/**
 * Set up a git worktree for a task, committing a file with specific content.
 */
function setupTaskBranch(opts: {
  repoDir: string;
  worktreeBaseDir: string;
  proj: string;
  taskId: string;
  fileName: string;
  content: string;
}): void {
  const { repoDir, worktreeBaseDir, proj, taskId, fileName, content } = opts;
  const taskBranch = `task/${taskId}`;
  const worktreePath = path.join(worktreeBaseDir, proj, taskId);
  fs.mkdirSync(path.dirname(worktreePath), { recursive: true });

  execFileSync("git", ["worktree", "add", "--detach", worktreePath], {
    cwd: repoDir,
    stdio: "pipe",
  });

  const wgit = (...args: string[]) =>
    execFileSync("git", args, { cwd: worktreePath, stdio: "pipe" });

  wgit("checkout", "-b", taskBranch);
  fs.writeFileSync(path.join(worktreePath, fileName), content);
  wgit("add", "-A");
  wgit("commit", "-m", `feat: ${taskId} — update ${fileName}`);
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("[AC-S75f66b-6-1] Conflict auto-filing", () => {
  let tmpDir: string;
  let repoDir: string;
  let worktreeBaseDir: string;
  let daemon: Daemon;
  let base: string;
  const PROJ = "proj-conflict-autofile";

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "banto-conflict-af-"));
    repoDir = path.join(tmpDir, "repo");
    worktreeBaseDir = path.join(tmpDir, "worktrees");

    // Initialize repo with initial commit on 'main'.
    fs.mkdirSync(repoDir, { recursive: true });
    execFileSync("git", ["init", "-b", "main"], {
      cwd: repoDir,
      stdio: "pipe",
    });
    execFileSync(
      "git",
      ["config", "user.email", "test@banto-conflict-test.local"],
      { cwd: repoDir, stdio: "pipe" }
    );
    execFileSync("git", ["config", "user.name", "banto-conflict-test"], {
      cwd: repoDir,
      stdio: "pipe",
    });

    // Initial file: shared.ts with a specific line that both A and B will edit
    fs.writeFileSync(
      path.join(repoDir, "shared.ts"),
      "// shared.ts\nexport const VERSION = 0;\n"
    );
    execFileSync("git", ["add", "-A"], { cwd: repoDir, stdio: "pipe" });
    execFileSync("git", ["commit", "-m", "initial"], {
      cwd: repoDir,
      stdio: "pipe",
    });

    // Start daemon with small tick interval
    const dataDir = path.join(tmpDir, "data");
    daemon = Daemon.create({
      port: 0,
      dataDir,
      worktreeBaseDir,
      tickIntervalMs: 200,
      watchIntervalMs: 200, // fast watcher to pick up conflict task file quickly
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

  it("[AC-S75f66b-6-1] rebase conflict auto-files kind:conflict task, pauses origin, queue continues", async () => {
    // ── Setup: three tasks ──────────────────────────────────────────────────

    // task-A: edits shared.ts line 2 to VERSION = 1
    setupTaskBranch({
      repoDir,
      worktreeBaseDir,
      proj: PROJ,
      taskId: "task-A",
      fileName: "shared.ts",
      content: "// shared.ts\nexport const VERSION = 1; // task-A\n",
    });

    // task-B: edits shared.ts line 2 to VERSION = 2 (conflicts with A after A merges to main)
    setupTaskBranch({
      repoDir,
      worktreeBaseDir,
      proj: PROJ,
      taskId: "task-B",
      fileName: "shared.ts",
      content: "// shared.ts\nexport const VERSION = 2; // task-B\n",
    });

    // task-C: adds unrelated.ts (no conflict)
    setupTaskBranch({
      repoDir,
      worktreeBaseDir,
      proj: PROJ,
      taskId: "task-C",
      fileName: "unrelated.ts",
      content: "// unrelated\n",
    });

    // Create tasks in daemon
    for (const { id, file } of [
      { id: "task-A", file: "shared.ts" },
      { id: "task-B", file: "shared.ts" },
      { id: "task-C", file: "unrelated.ts" },
    ]) {
      const r = await fetch(`${base}/api/v1/projects/${PROJ}/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id,
          title: `Task ${id}`,
          scope: { paths: [file] },
          acceptance: [{ id: "a1", text: "file exists" }],
        }),
      });
      assert.equal(r.status, 201, `task ${id} creation must succeed`);
    }

    // Advance all three tasks to 'in-review'
    for (const taskId of ["task-A", "task-B", "task-C"]) {
      await advanceTo(
        base,
        PROJ,
        taskId,
        "queued",
        "ready",
        "planning",
        "implementing",
        "auditing",
        "review-ready",
        "in-review"
      );
    }

    // Step 1: Approve A, B, C in order
    await transitionTo(base, PROJ, "task-A", "approved");
    await transitionTo(base, PROJ, "task-B", "approved");
    await transitionTo(base, PROJ, "task-C", "approved");

    // ── Wait: task-A must merge ─────────────────────────────────────────────
    const finalA = await pollUntil(
      () => getStatus(base, PROJ, "task-A"),
      (s) => s === "merged" || s === "closed" || s === "failed",
      15000
    );
    assert.ok(
      finalA === "merged" || finalA === "closed",
      `task-A must merge (got ${finalA})`
    );

    // ── Wait: task-B must be paused (conflict) ──────────────────────────────
    const finalB = await pollUntil(
      () => getStatus(base, PROJ, "task-B"),
      (s) => s === "paused" || s === "failed",
      15000
    );
    assert.equal(finalB, "paused", `task-B must be paused after conflict`);

    // ── Verify task-B is paused with suspended_from=merging ────────────────
    const taskB = await getTask(base, PROJ, "task-B");
    assert.equal(taskB.status, "paused", "task-B status must be paused");
    // suspendedFrom is on the task record (from task_paused event handler in StateStore)
    // The HTTP API returns all task fields
    assert.equal(
      taskB["suspendedFrom"],
      "merging",
      "task-B must have suspendedFrom=merging"
    );

    // ── Wait: task-C must merge (queue was not wedged by task-B) ───────────
    const finalC = await pollUntil(
      () => getStatus(base, PROJ, "task-C"),
      (s) => s === "merged" || s === "closed" || s === "failed",
      15000
    );
    assert.ok(
      finalC === "merged" || finalC === "closed",
      `task-C must merge/close (queue must continue despite task-B conflict; got ${finalC})`
    );

    // ── Verify: NO merge of task-B on main ─────────────────────────────────
    const gitLog = execFileSync("git", ["log", "main", "--oneline"], {
      cwd: repoDir,
    })
      .toString()
      .trim();
    assert.ok(
      !gitLog.includes("task-B"),
      `task-B must NOT be in git log main (got: ${gitLog})`
    );

    // ── Step 2: Verify the conflict task file was created ──────────────────
    // Wait for watcher to detect the file (watchIntervalMs=200, may need a few polls)
    const tasksDir = path.join(repoDir, "work", "tasks");
    let conflictFiles: string[] = [];
    const fileFound = await pollUntil(
      async () => {
        if (!fs.existsSync(tasksDir)) return false;
        const files = fs.readdirSync(tasksDir);
        conflictFiles = files.filter((f) => f.endsWith(".md") && f !== "");
        return conflictFiles.some((f) => f.includes("conflict"));
      },
      (found) => found === true,
      10000,
      150
    );
    assert.ok(fileFound, "A conflict task file must be created in work/tasks/");

    // Read and validate the conflict task file
    const conflictFileName = conflictFiles.find((f) => f.includes("conflict"))!;
    assert.ok(conflictFileName, "conflict task file must have 'conflict' in name");

    const conflictFilePath = path.join(tasksDir, conflictFileName);
    const conflictFileContent = fs.readFileSync(conflictFilePath, "utf-8");

    // Validate frontmatter
    const validation = validateTaskFrontmatter(conflictFileContent);
    assert.ok(validation.ok, `conflict task frontmatter must be valid (got: ${!validation.ok ? (validation as { reason: string }).reason : "ok"})`);

    if (validation.ok) {
      const fm = validation.frontmatter;

      // kind: conflict
      assert.equal(fm.kind, "conflict", "conflict task must have kind:conflict");

      // status: queued (watcher will ingest it)
      assert.equal(fm.status, "queued", "conflict task must have status:queued");

      // refs[0] = task-B (discovered-from convention)
      assert.ok(
        Array.isArray(fm.refs) && fm.refs[0] === "task-B",
        `conflict task refs[0] must be 'task-B' (got: ${JSON.stringify(fm.refs)})`
      );

      // scope.paths must contain the conflicted file
      assert.ok(
        fm.scope.paths.some((p) => p.includes("shared.ts") || p === "**"),
        `scope.paths must include the conflicted file 'shared.ts' (got: ${JSON.stringify(fm.scope.paths)})`
      );

      // id must be task-NNNN format
      assert.ok(
        /^task-\d{4,}$/.test(fm.id),
        `conflict task id must be task-NNNN format (got: ${fm.id})`
      );
    }

    // Body must mention task-B and mainline (both branches' provenance)
    assert.ok(
      conflictFileContent.includes("task-B"),
      "conflict task body must reference the origin task (task-B)"
    );
    assert.ok(
      conflictFileContent.includes("main"),
      "conflict task body must reference the mainline branch"
    );
  });
});

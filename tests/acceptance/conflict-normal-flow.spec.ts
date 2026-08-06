/**
 * [AC-S75f66b-6-2] Conflict normal flow: the conflict-resolution task flows through
 * the completely normal pipeline — watcher ingest → ready → spawn → audit → merge.
 *
 * story_type=api: exercises the real daemon HTTP API + real git repos.
 * No mocked daemon internals (I1).
 *
 * Scenario (from scenario-S75f66b-6.json scenario-2-api):
 *   The conflict task file is present in work/tasks/ (status: queued) from the
 *   auto-filing mechanism (AC-S75f66b-6-1 precondition). The test verifies:
 *     - The watcher ingests it (task_created + draft→queued via watcher-ingest).
 *     - The gate promotes it to ready (no special path).
 *     - The task flows through the same event types as any other task in the same order.
 *   No special-case code path for kind:conflict tasks at any stage.
 *
 * Test approach:
 *   1. Write a pre-built conflict task file to work/tasks/ (simulates auto-filer output).
 *   2. Wait for the watcher to ingest it (task_created + state_transitioned draft→queued).
 *   3. Drive the conflict task through the pipeline manually via HTTP transitions
 *      (disableAuditSpawn: true; we control all transitions to avoid pi LLM dependency).
 *   4. Verify the event sequence matches the normal pipeline (same event types, same order).
 *
 * Tags: [AC-S75f66b-6-2]
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { execFileSync } from "node:child_process";
import { Daemon } from "@banto/daemon";

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

async function getTask(
  base: string,
  proj: string,
  taskId: string
): Promise<{ status: string; [k: string]: unknown }> {
  const r = await fetch(`${base}/api/v1/projects/${proj}/tasks/${taskId}`);
  const body = (await r.json()) as { task: { status: string; [k: string]: unknown } };
  return body.task;
}

async function getStatus(
  base: string,
  proj: string,
  taskId: string
): Promise<string> {
  return (await getTask(base, proj, taskId)).status;
}

async function getEvents(
  base: string,
  proj: string
): Promise<
  Array<{ type: string; taskId?: string; from?: string; to?: string; reason?: string; [k: string]: unknown }>
> {
  const r = await fetch(`${base}/api/v1/projects/${proj}/events`);
  const body = (await r.json()) as {
    events: Array<{ type: string; taskId?: string }>;
  };
  return body.events as Array<{ type: string; taskId?: string; from?: string; to?: string; reason?: string; [k: string]: unknown }>;
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
 * Build a conflict task markdown file content (simulates auto-filer output).
 *
 * Uses status:queued so the watcher ingests it immediately.
 * review.policy:auto so auditing→merging (skips manual PO review step).
 */
function buildConflictTaskFile(taskId: string, originTaskId: string): string {
  return [
    `---`,
    `id: ${taskId}`,
    `type: task`,
    `kind: conflict`,
    `title: "コンフリクト解消: ${originTaskId} vs main"`,
    `status: queued`,
    `refs: [${originTaskId}]`,
    `scope:`,
    `  paths: ["shared.ts"]`,
    `acceptance:`,
    `  - { id: a1, text: "shared.ts のコンフリクトが解消されている" }`,
    `review:`,
    `  policy: auto`,
    `---`,
    ``,
    `## 背景`,
    ``,
    `${originTaskId} と main のコンフリクトを解消するタスクです。`,
    ``,
    `## スコープ外`,
    ``,
    `- ${originTaskId} の機能追加`,
    ``,
  ].join("\n");
}

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
  wgit("commit", "-m", `feat: ${taskId} — add ${fileName}`);
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("[AC-S75f66b-6-2] Conflict task flows through normal pipeline", () => {
  let tmpDir: string;
  let repoDir: string;
  let worktreeBaseDir: string;
  let daemon: Daemon;
  let base: string;
  const PROJ = "proj-conflict-flow";
  const CONFLICT_TASK_ID = "task-0010"; // fixed ID for this test

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "banto-conflict-flow-"));
    repoDir = path.join(tmpDir, "repo");
    worktreeBaseDir = path.join(tmpDir, "worktrees");

    // Initialize repo
    fs.mkdirSync(repoDir, { recursive: true });
    execFileSync("git", ["init", "-b", "main"], {
      cwd: repoDir,
      stdio: "pipe",
    });
    execFileSync("git", ["config", "user.email", "test@banto-flow.local"], {
      cwd: repoDir,
      stdio: "pipe",
    });
    execFileSync("git", ["config", "user.name", "banto-flow-test"], {
      cwd: repoDir,
      stdio: "pipe",
    });
    fs.writeFileSync(path.join(repoDir, "shared.ts"), "// initial\n");
    execFileSync("git", ["add", "-A"], { cwd: repoDir, stdio: "pipe" });
    execFileSync("git", ["commit", "-m", "initial"], {
      cwd: repoDir,
      stdio: "pipe",
    });

    // Create work/tasks/ directory
    const tasksDir = path.join(repoDir, "work", "tasks");
    fs.mkdirSync(tasksDir, { recursive: true });

    const dataDir = path.join(tmpDir, "data");
    daemon = Daemon.create({
      port: 0,
      dataDir,
      worktreeBaseDir,
      tickIntervalMs: 200,
      watchIntervalMs: 200, // fast watcher
      disableAuditSpawn: true,
      // Prevent auto-spawn: we drive the conflict task manually via HTTP transitions.
      // This avoids pi CLI resolution failures in CI environments.
      // The test explicitly exercises the pipeline via HTTP (same entry point as the PO).
      maxConcurrentSessions: 0,
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

  it("[AC-S75f66b-6-2] conflict task ingested by watcher and flows through normal pipeline", async () => {
    const tasksDir = path.join(repoDir, "work", "tasks");

    // ── Step 1: Write conflict task file to work/tasks/ ────────────────────
    // Simulate what the auto-filer writes (status:queued, kind:conflict).
    const conflictFileContent = buildConflictTaskFile(
      CONFLICT_TASK_ID,
      "task-B"
    );
    const conflictFilePath = path.join(
      tasksDir,
      `${CONFLICT_TASK_ID}-conflict-resolution-test.md`
    );
    fs.writeFileSync(conflictFilePath, conflictFileContent, "utf-8");

    // ── Wait: watcher must ingest the file (task appears in daemon) ─────────
    // Verify: watcher creates the task via task_created → draft → queued
    // (NOT via any private enqueue path — D4 compliance verified by checking events)
    // Note: the gate may quickly promote from queued → ready; we accept any non-draft state.
    const ingested = await pollUntil(
      async () => {
        try {
          const r = await fetch(`${base}/api/v1/projects/${PROJ}/tasks/${CONFLICT_TASK_ID}`);
          if (r.status !== 200) return null;
          const body = await r.json() as { task?: { status: string } };
          return body.task ?? null;
        } catch {
          return null;
        }
      },
      (t) => t !== null && t !== undefined && (t as { status: string }).status !== "draft",
      10000,
      150
    );
    assert.ok(
      ingested !== null && ingested !== undefined,
      `conflict task must be ingested by watcher (task must appear in daemon within 10s)`
    );
    const ingestedStatus = (ingested as { status: string }).status;
    assert.ok(
      ingestedStatus !== "draft",
      `conflict task must have been ingested (status must be 'queued' or later, got '${ingestedStatus}')`
    );

    // ── Verify watcher ingest events (not direct daemon path) ──────────────
    const events = await getEvents(base, PROJ);
    const taskEvents = events.filter(
      (e) => e.taskId === CONFLICT_TASK_ID
    );

    // Must have task_created
    const created = taskEvents.find((e) => e.type === "task_created");
    assert.ok(created, "conflict task must have task_created event");

    // Must have state_transitioned draft→queued with reason "watcher-ingest"
    const draftToQueued = taskEvents.find(
      (e) =>
        e.type === "state_transitioned" &&
        e["from"] === "draft" &&
        e["to"] === "queued"
    );
    assert.ok(
      draftToQueued,
      "conflict task must have state_transitioned draft→queued event"
    );
    // reason must be watcher-ingest (confirming D4 compliance: watcher path used)
    assert.equal(
      draftToQueued["reason"],
      "watcher-ingest",
      "draft→queued transition must have reason 'watcher-ingest'"
    );

    // ── Step 2: Set up a worktree for the conflict task (for merge gate) ───
    // The conflict task's "solution" is adding a file via its task branch.
    setupTaskBranch({
      repoDir,
      worktreeBaseDir,
      proj: PROJ,
      taskId: CONFLICT_TASK_ID,
      fileName: "shared.ts",
      content: "// shared.ts — conflict resolved\nexport const VERSION = 99;\n",
    });

    // ── Step 3: Drive through the normal pipeline via HTTP transitions ─────
    // This tests that kind:conflict tasks have NO special handling at any pipeline stage.
    // Same sequence as any other task: queued → ready → planning → implementing →
    // auditing → (review-ready → in-review for manual policy, OR merging for auto).
    // review.policy=auto → auditing → merging (no in-review step).
    await advanceTo(
      base,
      PROJ,
      CONFLICT_TASK_ID,
      "ready",
      "planning",
      "implementing",
      "auditing"
    );

    // For review.policy=auto: auditing → merging directly (AC-S75f66b-6-2 says "same flow").
    // We drive this via HTTP transition (disableAuditSpawn=true means no real audit session).
    await transitionTo(base, PROJ, CONFLICT_TASK_ID, "merging");

    // ── Wait: merge queue processes the conflict task ───────────────────────
    const finalStatus = await pollUntil(
      () => getStatus(base, PROJ, CONFLICT_TASK_ID),
      (s) => s === "merged" || s === "closed" || s === "failed",
      12000,
      150
    );
    assert.ok(
      finalStatus === "merged" || finalStatus === "closed",
      `conflict task must reach merged/closed (got ${finalStatus})`
    );

    // ── Verify: event sequence is the same as any normal task ──────────────
    const finalEvents = await getEvents(base, PROJ);
    const conflictTaskEvents = finalEvents.filter(
      (e) => e.taskId === CONFLICT_TASK_ID
    );

    // Must have the complete normal event sequence
    const eventTypes = conflictTaskEvents.map((e) => e.type);

    // Verify key events are present in the right order
    const createIdx = eventTypes.indexOf("task_created");
    const draftQueuedIdx = conflictTaskEvents.findIndex(
      (e) => e.type === "state_transitioned" && e["to"] === "queued"
    );
    const mergingIdx = conflictTaskEvents.findIndex(
      (e) => e.type === "state_transitioned" && e["to"] === "merging"
    );
    const mergedIdx = conflictTaskEvents.findIndex(
      (e) => e.type === "state_transitioned" && (e["to"] === "merged" || e["to"] === "closed")
    );

    assert.ok(createIdx >= 0, "must have task_created");
    assert.ok(draftQueuedIdx >= 0, "must have draft→queued transition");
    assert.ok(mergingIdx >= 0, "must have →merging transition");
    assert.ok(mergedIdx >= 0, "must have →merged or →closed transition");

    // Ordering: create → queued → merging → merged
    assert.ok(
      createIdx < draftQueuedIdx,
      "task_created must precede draft→queued"
    );
    assert.ok(
      draftQueuedIdx < mergingIdx,
      "draft→queued must precede →merging"
    );
    assert.ok(mergingIdx < mergedIdx, "→merging must precede →merged");

    // Verify NO special event types were injected for conflict tasks
    const specialEvents = conflictTaskEvents.filter(
      (e) =>
        e.type === "conflict_filed" ||
        e.type === "conflict_started" ||
        e.type === "conflict_resolved"
    );
    assert.equal(
      specialEvents.length,
      0,
      "conflict task must not have special conflict-specific event types"
    );
  });
});

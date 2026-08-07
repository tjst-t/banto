/**
 * MergeQueue: serial merge processor for the banto daemon.
 *
 * ### Queue derivation (D3)
 * The queue is NOT persisted as a separate file. It is derived purely from event
 * log replay by `deriveQueue()`. Restart-resumable by design: replaying the log
 * after a daemon restart produces the same queue as before (D3 §4.1).
 *
 * Queue ordering: tasks are ordered by the eventId of the FIRST state_transitioned
 * event that moved them into `merging` status. Earlier entry into merging = earlier
 * in queue. This covers both paths to merging:
 *   - manual policy:  approved → merging (merge-queue-serial-processor)
 *   - auto-audit policy: auditing → merging (audit_passed, S75f66b-3)
 * Using the merging-entry event (not the approved event) ensures the ordering
 * guarantee holds under both flows without special-casing per spec §4 (D3).
 * Tasks that are currently `merging` (in-flight when the daemon was stopped) are
 * placed at the HEAD in their original order so they are re-processed on restart.
 *
 * ### Serial processor (`processMergeQueue`)
 * On each tick, the serial processor:
 *   1. Derives the queue from the event log (D3).
 *   2. Takes the HEAD task only (strictly serial — no batching, spec §4.1).
 *   3. If head is `approved`: transitions to `merging`, then processes.
 *   4. If head is already `merging` (in-flight after restart): re-processes directly.
 *   5. Processing: rebase task branch onto mainline → run merge gate (S75f66b-4)
 *      → fast-forward merge → append task_merged + state_transitioned(merged).
 *   6. Post-merge cleanup: remove worktree + branch (idempotent, I3).
 *   7. merged → closed for tasks without hypothesis (per spec state table).
 *
 * ### Rebase failure (story 5 scope limit)
 * Per planning notes: rebase failure records a tick_job_failed event and the
 * task remains in `merging`. Story 6 will hook in here to auto-file a
 * conflict-resolution task. The `onRebaseConflict` handler below is
 * the clean seam for that hook.
 *
 * D3: queue state is derived from events; no file is written.
 * D6: git operations use child_process (stdlib git CLI); no new npm deps.
 * I1: gate verify commands are run by daemon directly (via S75f66b-4 runMergeGate).
 * I2: errors recorded as tick_job_failed events; task stays in merging on rebase
 *     conflict (story 6 seam).
 * P1: only new file + daemon.ts additions.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { EventLog, TaskRecord } from "@banto/core";
import { StateMachine } from "@banto/core";
import type { OrchestrationEvent, StateTransitionedEvent } from "@banto/core";
import { runMergeGate } from "./merge-gate.js";
import { removeWorktree } from "@banto/repo-manager";

const execFileAsync = promisify(execFile);

// ── Queue entry ───────────────────────────────────────────────────────────────

export interface MergeQueueEntry {
  taskId: string;
  projectTag: string;
  /** "approved" for tasks waiting, "merging" for tasks that were in-flight at restart */
  status: "approved" | "merging";
  /**
   * eventId of the FIRST state_transitioned event that put the task into `merging` status.
   * Used for ordering: earlier entry into merging = earlier in queue.
   *
   * S75f66b-5 (reconcile with S75f66b-3): ordering by merging-entry covers both paths:
   *   - manual policy:  approved → merging (merge-queue-serial-processor)
   *   - auto-audit:     auditing → merging (audit_passed, S75f66b-3)
   * Previously named `approvedEventId` and tracked the `approved` transition; changed
   * to `mergingEntryEventId` so the serial guarantee holds under both flows (spec §4).
   *
   * For `approved` tasks (not yet in merging), this field holds the eventId of the
   * FIRST transition TO `merging` if it has been seen before (re-queue after failure),
   * or falls back to the first transition TO `approved` to preserve relative ordering
   * for tasks waiting to enter merging for the first time.
   */
  mergingEntryEventId: number;
}

// ── Queue derivation (D3) ─────────────────────────────────────────────────────

/**
 * Derive the merge queue from event log replay.
 *
 * Algorithm:
 *   1. Walk all events in chronological order (by eventId).
 *   2. Track each task's FIRST state_transitioned → merging event (for ordering).
 *      For tasks not yet in merging, fall back to the first → approved event
 *      so their relative ordering is preserved while they wait to be processed.
 *   3. Tasks that are currently in status `approved` or `merging` are queue members.
 *   4. Ordering: tasks in `merging` first (they were already being processed),
 *      then `approved` tasks in ascending order of their mergingEntryEventId.
 *   5. Tasks in terminal states (merged, failed, closed, etc.) are excluded.
 *
 * S75f66b-5 (reconcile): ordering by FIRST entry into `merging` covers both paths:
 *   - manual policy:  approved → merging (merge-queue-serial-processor)
 *   - auto-audit:     auditing → merging (audit_passed verdict, S75f66b-3)
 * This preserves the serial approval-order guarantee under both paths (spec §4).
 *
 * Pure function of the event log — no side effects.
 */
export function deriveQueue(events: OrchestrationEvent[]): MergeQueueEntry[] {
  // Track per-task: current status, first merging-entry eventId, and fallback approved eventId
  const taskStatus = new Map<string, string>(); // "projectTag/taskId" → status
  /** First time the task entered `merging` — used for ordering (covers both policy paths). */
  const taskMergingEntryEventId = new Map<string, number>(); // "projectTag/taskId" → first merging eventId
  /**
   * Fallback: first time the task entered `approved` (manual policy path).
   * Used as a proxy ordering key for `approved` tasks that have not yet entered
   * `merging` — ensures relative ordering is preserved while they wait.
   */
  const taskApprovedEventId = new Map<string, number>(); // "projectTag/taskId" → first approved eventId
  const taskProjectTag = new Map<string, string>(); // "projectTag/taskId" → projectTag

  for (const event of events) {
    if (event.type === "state_transitioned") {
      const stEvent = event as StateTransitionedEvent;
      const key = `${stEvent.projectTag}/${stEvent.taskId}`;
      taskStatus.set(key, stEvent.to);
      taskProjectTag.set(key, stEvent.projectTag);

      // Record the FIRST time the task enters `merging` status (ordering key).
      // This covers both auto-audit (auditing→merging) and manual (approved→merging) paths.
      // We use the FIRST occurrence so that re-queued tasks (rare) keep their original order.
      if (stEvent.to === "merging" && !taskMergingEntryEventId.has(key)) {
        taskMergingEntryEventId.set(key, stEvent.eventId);
      }

      // Fallback ordering key: first time the task enters `approved` status.
      // Used only for tasks that are still `approved` (not yet transitioned to `merging`).
      if (stEvent.to === "approved" && !taskApprovedEventId.has(key)) {
        taskApprovedEventId.set(key, stEvent.eventId);
      }
    }
  }

  // Collect queue members
  const merging: MergeQueueEntry[] = [];
  const approved: MergeQueueEntry[] = [];

  for (const [key, status] of taskStatus) {
    if (status !== "approved" && status !== "merging") continue;
    const projectTag = taskProjectTag.get(key) ?? key.split("/")[0]!;
    const taskId = key.slice(projectTag.length + 1);

    // Ordering key: prefer the merging-entry eventId (covers both paths).
    // Fall back to approved eventId for tasks not yet in merging (consistent ordering).
    const mergingEntryEventId =
      taskMergingEntryEventId.get(key) ??
      taskApprovedEventId.get(key) ??
      0;

    const entry: MergeQueueEntry = {
      taskId,
      projectTag,
      status: status as "approved" | "merging",
      mergingEntryEventId,
    };

    if (status === "merging") {
      merging.push(entry);
    } else {
      approved.push(entry);
    }
  }

  // merging tasks sort by mergingEntryEventId (preserve original merge-entry order)
  merging.sort((a, b) => a.mergingEntryEventId - b.mergingEntryEventId);
  // approved tasks sort by mergingEntryEventId (or approved fallback for not-yet-merging tasks)
  approved.sort((a, b) => a.mergingEntryEventId - b.mergingEntryEventId);

  return [...merging, ...approved];
}

// ── Options for the serial merge processor ────────────────────────────────────

export interface MergeProcessorOptions {
  /** Absolute path to the daemon's data directory (gate logs, worktrees). */
  dataDir: string;
  /**
   * Base directory for git worktrees.
   * Default: <dataDir>/worktrees
   *
   * `getWorktreePath` を渡した場合は使われない。
   */
  worktreeBaseDir?: string;
  /**
   * タスクのワークツリーを引く（ADR-0013 決定60・a6）。
   *
   * 置き場所を決めるのは `gwq` になったので、**呼び出し側が知っている場所を渡す**
   * ——`<base>/<projectTag>/<taskId>` を組み立てると、gwq の命名では見つからない。
   * 省略時は従来どおり `worktreeBaseDir` から組み立てる。
   */
  getWorktreePath?: (projectTag: string, taskId: string) => string;
  /**
   * Mainline branch name (fast-forward merge target).
   * Default: "main"
   */
  mainline?: string;
  /**
   * 検証コマンドの制限時間（ms）を、プロジェクトごとに解く（task-0071）。
   *
   * **タスクごとに違いうる**（層B設定はリポジトリの `meta/config.yaml`）ので、
   * 固定値ではなく引く形にしてある。省略時はゲート側の既定。
   */
  getVerifyTimeoutMs?: (projectTag: string) => number | undefined;
  /**
   * Hook called when rebase fails (conflict). Story 6 hooks in here to
   * auto-file a conflict-resolution task and pause the origin task.
   *
   * @param log             EventLog for appending events
   * @param taskId          Task ID that had the rebase conflict
   * @param projectTag      Project tag
   * @param error           Error thrown by the rebase operation
   * @param conflictedFiles Files that had conflicts (derived from git status)
   */
  onRebaseConflict?: (
    log: EventLog,
    taskId: string,
    projectTag: string,
    error: Error,
    conflictedFiles: string[]
  ) => void | Promise<void>;

  /**
   * Function to look up a task's project repo path.
   * Used to find the git repository for the task's worktree.
   */
  getProjectRepoPath: (projectTag: string) => string | undefined;

  /**
   * Function to get all current task records (for post-merge gate re-eval trigger).
   * The caller (daemon) passes its store.getAllTasks() here.
   */
  getAllTasks: () => TaskRecord[];

  /**
   * Callback after a successful merge or gate failure. Called so the daemon can
   * trigger gate re-evaluation for dependent tasks.
   */
  onMergeComplete?: (taskId: string, projectTag: string) => void;
}

// ── Serial merge processor ────────────────────────────────────────────────────

/**
 * Process the merge queue tick: handle at most one task (serial discipline, spec §4.1).
 *
 * Returns true if a task was processed (attempted), false if queue was empty.
 *
 * IMPORTANT: This function is tick-driven. When a `merging` task is at the head,
 * it means the daemon was restarted mid-merge. We re-process it from the beginning
 * (rebase again) since the previous rebase state is lost.
 *
 * I2: errors from gate/rebase are NOT swallowed. Rebase conflict → onRebaseConflict hook.
 * Gate failure → already handled by runMergeGate (StateMachine.fail).
 * Other errors → rethrown to the caller (scheduler records as tick_job_failed).
 *
 * D3: queue is derived from event log on each call; no extra state maintained.
 */
export async function processMergeQueue(
  log: EventLog,
  opts: MergeProcessorOptions
): Promise<boolean> {
  const allEvents = log.readAllEvents();
  const queue = deriveQueue(allEvents);

  if (queue.length === 0) {
    return false; // Nothing to process
  }

  const head = queue[0]!;
  const { taskId, projectTag, status } = head;

  // Gather task record
  const tasks = opts.getAllTasks();
  const task = tasks.find((t) => t.id === taskId && t.projectTag === projectTag);
  if (!task) {
    // Task vanished from state store (shouldn't happen, but be safe — I2)
    log.append({
      type: "tick_job_failed",
      projectTag: "daemon",
      jobName: "merge-queue",
      error: `merge-queue: head task ${projectTag}/${taskId} not found in state store`,
    });
    return false;
  }

  // If the task is in `approved` state, transition it to `merging` first.
  // This marks it as "in-flight" so a restart knows to re-process it.
  if (status === "approved") {
    const result = StateMachine.transition(
      log,
      taskId,
      "approved",
      "merging",
      projectTag,
      "merge-queue-serial-processor"
    );
    if (!result.ok) {
      // Transition failed — log and skip (task state inconsistency)
      log.append({
        type: "tick_job_failed",
        projectTag: "daemon",
        jobName: "merge-queue",
        error: `merge-queue: failed to transition ${projectTag}/${taskId} to merging: ${result.reason}`,
      });
      return false;
    }
  }

  // At this point the task is `merging` (either was already, or just transitioned).
  // Resolve paths
  const worktreeBase = opts.worktreeBaseDir ?? path.join(opts.dataDir, "worktrees");
  const worktreePath =
    opts.getWorktreePath?.(projectTag, taskId) ?? path.join(worktreeBase, projectTag, taskId);
  const repoPath = opts.getProjectRepoPath(projectTag);
  const mainline = opts.mainline ?? "main";

  if (!repoPath) {
    log.append({
      type: "tick_job_failed",
      projectTag: "daemon",
      jobName: "merge-queue",
      error: `merge-queue: no repo path for project '${projectTag}' (task ${taskId})`,
    });
    return false;
  }

  // Task branch name: same convention used in spawnTask
  // The agent commits to a branch named "task/<taskId>" in the worktree.
  const taskBranch = `task/${taskId}`;

  // ── 1. Rebase task branch onto mainline ──────────────────────────────────

  let conflictedFiles: string[] = [];
  try {
    await rebaseTaskBranch({
      repoPath,
      worktreePath,
      taskBranch,
      mainline,
    });
  } catch (err) {
    // Rebase conflict: collect conflicted files from git status, then call the hook.
    // I2: not swallowed — hook handles the error (story 6 seam).
    const error = err instanceof Error ? err : new Error(String(err));

    // Derive conflicted files from the git rebase error message.
    // git rebase output contains "CONFLICT (content): Merge conflict in <file>" lines.
    // After rebase --abort the working tree is clean, so parse-from-error is the
    // only reliable source. Falls back to [] (conflict task filed with scope ["**"]).
    conflictedFiles = parseConflictedFilesFromError(error.message);

    if (opts.onRebaseConflict) {
      await opts.onRebaseConflict(log, taskId, projectTag, error, conflictedFiles);
    } else {
      // Default: record as tick_job_failed, leave task in `merging`.
      log.append({
        type: "tick_job_failed",
        projectTag: "daemon",
        jobName: "merge-queue",
        error: `merge-queue: rebase failed for ${projectTag}/${taskId} (${error.message}); task stays in merging`,
      });
    }
    return false;
  }

  // ── 2. Run merge gate (scope check + verify commands) ───────────────────

  // Re-read task record after the approved→merging state change
  const updatedTasks = opts.getAllTasks();
  const updatedTask = updatedTasks.find((t) => t.id === taskId && t.projectTag === projectTag);
  if (!updatedTask) {
    log.append({
      type: "tick_job_failed",
      projectTag: "daemon",
      jobName: "merge-queue",
      error: `merge-queue: task ${projectTag}/${taskId} not found after rebase`,
    });
    return false;
  }

  const verifyTimeoutMs = opts.getVerifyTimeoutMs?.(projectTag);
  const gateResult = await runMergeGate(log, updatedTask, {
    dataDir: opts.dataDir,
    repoPath,
    base: mainline,
    branch: taskBranch,
    worktreePath,
    ...(verifyTimeoutMs !== undefined ? { verifyTimeoutMs } : {}),
  });

  if (!gateResult.passed) {
    // Gate failure: runMergeGate already called StateMachine.fail() and appended
    // merge_gate_evaluated(passed=false) + state_transitioned(→failed) + task_failed.
    // Trigger gate re-eval for dependents and return.
    if (opts.onMergeComplete) {
      opts.onMergeComplete(taskId, projectTag);
    }
    return true;
  }

  // ── 3. Fast-forward merge into mainline ──────────────────────────────────

  let commitSha: string;
  try {
    commitSha = await fastForwardMerge({
      repoPath,
      taskBranch,
      mainline,
    });
  } catch (err) {
    // Fast-forward merge failure is unexpected after a successful rebase+gate.
    // I2: record and fail the task.
    const errMsg = err instanceof Error ? err.message : String(err);
    StateMachine.fail(log, taskId, {
      currentStatus: "merging",
      reason: `fast_forward_merge_failed: ${errMsg}`,
    }, projectTag);
    log.append({
      type: "tick_job_failed",
      projectTag: "daemon",
      jobName: "merge-queue",
      error: `merge-queue: fast-forward merge failed for ${projectTag}/${taskId}: ${errMsg}`,
    });
    if (opts.onMergeComplete) {
      opts.onMergeComplete(taskId, projectTag);
    }
    return true;
  }

  // ── 4. Append task_merged + transition merging → merged ──────────────────

  log.append({
    type: "task_merged",
    projectTag,
    taskId,
    commitSha,
  });

  StateMachine.transition(
    log,
    taskId,
    "merging",
    "merged",
    projectTag,
    "merge-queue-serial-processor"
  );

  // ── 5. Post-merge cleanup ─────────────────────────────────────────────────

  // Remove worktree + branch (idempotent, I3).
  // Best-effort: failures are logged but do not fail the merge.
  await cleanupWorktreeAndBranch({
    repoPath,
    worktreePath,
    taskBranch,
  });

  // ── 6. merged → closed for tasks without hypothesis ───────────────────────

  // Re-read task after the merge events
  const postMergeTasks = opts.getAllTasks();
  const postMergeTask = postMergeTasks.find(
    (t) => t.id === taskId && t.projectTag === projectTag
  );

  if (postMergeTask) {
    const hypothesis = postMergeTask["hypothesis"];
    const hasHypothesis = hypothesis !== undefined && hypothesis !== null;

    if (!hasHypothesis) {
      // No hypothesis → skip evaluating, go straight to closed.
      StateMachine.transition(
        log,
        taskId,
        "merged",
        "closed",
        projectTag,
        "no-hypothesis-auto-close"
      );
    }
    // If hypothesis exists → stay in `merged`; evaluating/closed handled by
    // separate evaluation sprint (spec §4, merged → evaluating is a future sprint).
  }

  // ── 7. Trigger gate re-evaluation for dependent tasks ────────────────────

  if (opts.onMergeComplete) {
    opts.onMergeComplete(taskId, projectTag);
  }

  return true;
}

// ── Git helpers ───────────────────────────────────────────────────────────────

/**
 * Rebase the task branch onto the mainline in the task's worktree.
 *
 * The task's worktree has HEAD pointing to the task branch (set by the agent
 * when it committed its changes). We checkout the task branch and run
 * `git rebase <mainline>`.
 *
 * If the worktree does not exist, we operate in the bare repo directly.
 *
 * I2: throws on rebase failure (caller routes to onRebaseConflict hook).
 *     The thrown error message includes the conflicted file list (captured before abort).
 * D6: uses git CLI via child_process (stdlib).
 */
async function rebaseTaskBranch(opts: {
  repoPath: string;
  worktreePath: string;
  taskBranch: string;
  mainline: string;
}): Promise<void> {
  const { repoPath, worktreePath, taskBranch, mainline } = opts;

  const worktreeExists = fs.existsSync(worktreePath);
  const cwd = worktreeExists ? worktreePath : repoPath;

  if (worktreeExists) {
    // Ensure we're on the task branch (may be detached HEAD from initial worktree creation)
    try {
      await execFileAsync("git", ["checkout", "-B", taskBranch], { cwd });
    } catch {
      // May already be on the branch (checkout -B creates or resets)
      // Ignore errors — the rebase below will fail clearly if HEAD is wrong
    }

    // Run rebase inside the worktree
    try {
      await execFileAsync("git", ["rebase", mainline], { cwd });
    } catch (err) {
      // Abort rebase on failure to leave the worktree in a clean state
      try {
        await execFileAsync("git", ["rebase", "--abort"], { cwd });
      } catch {
        // Ignore abort errors
      }
      throw new Error(
        `rebase failed in worktree ${worktreePath}: ${String(err)}`
      );
    }
  } else {
    // Worktree doesn't exist — work in the repo
    // Checkout the task branch and rebase it
    try {
      await execFileAsync("git", ["checkout", taskBranch], { cwd: repoPath });
    } catch (err) {
      throw new Error(
        `rebaseTaskBranch: cannot checkout branch ${taskBranch} in repo ${repoPath}: ${String(err)}`
      );
    }
    try {
      await execFileAsync("git", ["rebase", mainline], { cwd: repoPath });
    } catch (err) {
      try {
        await execFileAsync("git", ["rebase", "--abort"], { cwd: repoPath });
      } catch {
        // Ignore abort errors
      }
      throw new Error(
        `rebase failed in repo ${repoPath} for branch ${taskBranch}: ${String(err)}`
      );
    }
  }
}

/**
 * Parse conflicted file paths from a git rebase error message.
 *
 * git rebase writes lines like:
 *   "CONFLICT (content): Merge conflict in src/foo.ts"
 * to stderr, which ends up in the caught Error message.
 *
 * Returns unique file paths extracted from those lines.
 * Returns [] if no CONFLICT lines are found.
 *
 * D6: regex only (stdlib).
 */
function parseConflictedFilesFromError(errorMessage: string): string[] {
  const files = new Set<string>();
  // git outputs: "CONFLICT (...): Merge conflict in <path>"
  const pattern = /CONFLICT\b.*?:\s*Merge conflict in (.+)/g;
  let m: RegExpExecArray | null;
  while ((m = pattern.exec(errorMessage)) !== null) {
    const file = m[1]?.trim();
    if (file) files.add(file);
  }
  return Array.from(files);
}

/**
 * Fast-forward merge the task branch into mainline.
 *
 * Runs `git checkout <mainline> && git merge --ff-only <taskBranch>`.
 * Returns the resulting HEAD commit SHA.
 *
 * I2: throws on failure (caller records as tick_job_failed).
 * D6: git CLI (stdlib).
 */
async function fastForwardMerge(opts: {
  repoPath: string;
  taskBranch: string;
  mainline: string;
}): Promise<string> {
  const { repoPath, taskBranch, mainline } = opts;

  // Ensure we're on the mainline
  await execFileAsync("git", ["checkout", mainline], { cwd: repoPath });

  // Fast-forward merge
  await execFileAsync("git", ["merge", "--ff-only", taskBranch], {
    cwd: repoPath,
  });

  // Return the resulting HEAD commit SHA
  const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], {
    cwd: repoPath,
  });
  return stdout.trim();
}

/**
 * Remove the task's git worktree and branch after a successful merge.
 * Idempotent: safe to call multiple times (I3).
 * Best-effort: errors are logged to stderr but do not fail the merge.
 *
 * D6: git CLI (stdlib).
 */
async function cleanupWorktreeAndBranch(opts: {
  repoPath: string;
  worktreePath: string;
  taskBranch: string;
}): Promise<void> {
  const { repoPath, worktreePath, taskBranch } = opts;

  // Remove the worktree (idempotent via removeWorktree's existsSync guard)
  try {
    await removeWorktree(repoPath, worktreePath);
  } catch (err) {
    process.stderr.write(
      `[merge-queue] WARNING: worktree removal failed for ${worktreePath}: ${String(err)}\n`
    );
  }

  // Prune worktree list (cleanup stale .git/worktrees entries)
  try {
    await execFileAsync("git", ["worktree", "prune"], { cwd: repoPath });
  } catch {
    // Best-effort
  }

  // Delete the task branch (best-effort: branch may already be gone)
  try {
    await execFileAsync("git", ["branch", "-D", taskBranch], { cwd: repoPath });
  } catch {
    // Branch may already be deleted or may not exist — idempotent (I3)
  }
}

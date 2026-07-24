/**
 * MergeGate: pre-merge checks for tasks entering the 'merging' state.
 *
 * Two checks are performed in order:
 *   1. Scope violation check: `git diff --name-only base...branch` against task's scope.paths.
 *      Any file outside scope.paths is a violation → gate fails (P1 enforcement).
 *   2. Verify command execution: acceptance[].verify commands run via child_process
 *      in the rebased worktree (I1: daemon executes them directly, no agent self-report).
 *      Execution logs are written to <dataDir>/gate-logs/<taskId>/<acId>/.
 *      A non-zero exit code fails the gate (I2: stop, record, don't skip).
 *
 * On gate failure: StateMachine.fail() is called (I2: unrecoverable, transition to failed).
 * A merge_gate_evaluated event is appended with passed=false and the reason(s).
 *
 * On gate pass: merge_gate_evaluated with passed=true is appended.
 * The caller (S75f66b-5: serial merge processor) then proceeds to git merge.
 *
 * D3: gate judgment is recorded as events only; no derived state is persisted.
 * D5: all logic here; no Surface-layer code.
 * D6: child_process from stdlib; no additional dependencies.
 * P1: touch only this module (new) + gate-evaluator.ts exports + events.ts append.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { EventLog, TaskRecord } from "@banto/core";
import { StateMachine } from "@banto/core";
import { fileMatchesScopePaths } from "./gate-evaluator.js";

const execFileAsync = promisify(execFile);

// ── Public types ──────────────────────────────────────────────────────────────

/** Input for the scope violation check. */
export interface ScopeCheckInput {
  /** Git repository root (used as cwd for git diff). */
  repoPath: string;
  /** Base ref (mainline, e.g. "main"). */
  base: string;
  /** Branch ref to check (the task's implementation branch). */
  branch: string;
  /** scope.paths globs from the task definition (must be non-empty). */
  scopePaths: string[];
}

/** Result of the scope violation check. */
export interface ScopeCheckResult {
  passed: boolean;
  /** Files that are outside scope.paths (empty when passed=true). */
  violations: string[];
}

/** A single acceptance criterion's verify command and its result. */
export interface VerifyResult {
  /** Acceptance criterion ID (e.g. "a1"). */
  acId: string;
  /** The verify command string, or undefined if there was none. */
  command: string | undefined;
  /** Exit code of the command (0 = pass). null when command is absent. */
  exitCode: number | null;
  /** Path to the directory containing stdout/stderr logs. Path reference only (spec §2.1). */
  logDirPath: string | undefined;
}

/** Full result of a merge gate evaluation. */
export interface MergeGateResult {
  passed: boolean;
  scopeResult: ScopeCheckResult;
  verifyResults: VerifyResult[];
  /** Human-readable reasons for gate failure. */
  reasons: string[];
  /** Log directory paths for verify commands (path references only, per spec §2.1). */
  logPaths: string[];
}

/** Options for runMergeGate. */
export interface MergeGateOptions {
  /** Absolute path to the daemon's data directory (gate logs go under <dataDir>/gate-logs/). */
  dataDir: string;
  /** Git repository root. */
  repoPath: string;
  /** Base branch (mainline). */
  base: string;
  /** Task implementation branch. */
  branch: string;
  /** Absolute path to the worktree where verify commands are executed. */
  worktreePath: string;
  /**
   * Timeout in milliseconds for each verify command.
   * Default: 60_000 (1 minute). Callers may configure per environment profile.
   */
  verifyTimeoutMs?: number;
}

// ── Scope violation check ─────────────────────────────────────────────────────

/**
 * Check whether the diff between base and branch contains any files outside
 * the task's scope.paths.
 *
 * Runs `git diff --name-only <base>...<branch>` in the repository root.
 * Each changed file is matched against the scope.paths globs using
 * fileMatchesScopePaths (exported from gate-evaluator, D6: reuse).
 * Files not matched by any pattern are recorded as violations.
 *
 * Pure judgment: does NOT modify any git state.
 * I2: git exec failures (non-zero exit from git) are thrown, not swallowed.
 */
export async function checkScopeViolations(input: ScopeCheckInput): Promise<ScopeCheckResult> {
  const { repoPath, base, branch, scopePaths } = input;

  // `git diff --name-only A...B` lists files changed between the common ancestor and B.
  // Using three-dot diff is the canonical way to check what a branch introduces
  // (independent of what has landed on base since the branch point).
  let stdout: string;
  try {
    const result = await execFileAsync(
      "git",
      ["diff", "--name-only", `${base}...${branch}`],
      { cwd: repoPath }
    );
    stdout = result.stdout;
  } catch (err) {
    // I2: git errors are not swallowed; rethrow so the caller can fail the gate.
    throw new Error(
      `checkScopeViolations: git diff failed in ${repoPath}: ${String(err)}`
    );
  }

  const changedFiles = stdout
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  const violations: string[] = [];
  for (const file of changedFiles) {
    if (!fileMatchesScopePaths(file, scopePaths)) {
      violations.push(file);
    }
  }

  return {
    passed: violations.length === 0,
    violations,
  };
}

// ── Verify command execution ──────────────────────────────────────────────────

/**
 * Run a single acceptance verify command in the rebased worktree.
 *
 * Executes via child_process (I1: daemon runs it directly, no agent self-report).
 * stdout and stderr are captured and written to <logDir>/stdout.txt and stderr.txt.
 * The log directory path is returned as a path reference (never the content, spec §2.1).
 *
 * A non-zero exit code is a gate failure — NOT a skip (I2).
 * A command that fails to EXECUTE (spawn error) is also a gate failure (I2).
 *
 * Returns the exitCode (0 = pass, non-zero = fail) and the log directory path.
 */
async function runSingleVerifyCommand(opts: {
  acId: string;
  command: string;
  worktreePath: string;
  logBaseDir: string;
  timeoutMs: number;
}): Promise<{ exitCode: number; logDirPath: string }> {
  const { acId, command, worktreePath, logBaseDir, timeoutMs } = opts;

  // Sanitize acId for use as a directory name (replace slashes and other special chars)
  const safeDirName = acId.replace(/[^a-zA-Z0-9_-]/g, "_");
  const logDirPath = path.join(logBaseDir, safeDirName);
  fs.mkdirSync(logDirPath, { recursive: true });

  const stdoutPath = path.join(logDirPath, "stdout.txt");
  const stderrPath = path.join(logDirPath, "stderr.txt");

  let exitCode: number;
  let stdoutContent = "";
  let stderrContent = "";

  try {
    // Run the command via sh -c so the verify string can be a shell expression.
    // (D6: sh is already required by spec; no additional dependency.)
    const result = await execFileAsync("sh", ["-c", command], {
      cwd: worktreePath,
      timeout: timeoutMs,
      maxBuffer: 10 * 1024 * 1024, // 10 MB max for captured output
    });
    stdoutContent = result.stdout;
    stderrContent = result.stderr;
    exitCode = 0;
  } catch (err) {
    // I2: execution failure or non-zero exit are both gate failures.
    // Extract stdout/stderr from the error object if available.
    const execErr = err as NodeJS.ErrnoException & {
      stdout?: string;
      stderr?: string;
      code?: number | string;
      killed?: boolean;
    };
    stdoutContent = execErr.stdout ?? "";
    stderrContent = execErr.stderr ?? "";

    if (execErr.killed) {
      // Timed out
      stderrContent +=
        `\n[banto-gate] verify command timed out after ${timeoutMs}ms: ${command}`;
      exitCode = 124; // Standard timeout exit code (same as `timeout(1)`)
    } else if (typeof execErr.code === "number") {
      exitCode = execErr.code;
    } else if (typeof execErr.code === "string" && /^\d+$/.test(execErr.code)) {
      exitCode = parseInt(execErr.code, 10);
    } else {
      // Spawn error (command not found, permission denied, etc.)
      stderrContent +=
        `\n[banto-gate] failed to execute verify command: ${String(err)}`;
      exitCode = 1; // Non-zero: gate fail (I2)
    }
  }

  // Write log files (path references only in events — spec §2.1)
  fs.writeFileSync(stdoutPath, stdoutContent, "utf-8");
  fs.writeFileSync(stderrPath, stderrContent, "utf-8");

  return { exitCode, logDirPath };
}

// ── Main gate function ────────────────────────────────────────────────────────

/**
 * Run the full merge gate for a task.
 *
 * Steps:
 *   1. Scope violation check (git diff vs scope.paths).
 *   2. Verify command execution for each acceptance entry that has a `verify` field.
 *      Runs in the rebased worktree (opts.worktreePath).
 *   3. Append a merge_gate_evaluated event to the EventLog.
 *   4. If gate failed: call StateMachine.fail() to transition the task to 'failed' (I2).
 *
 * The task must be in status 'merging' at the call site. StateMachine.fail() will
 * emit state_transitioned(→failed) + task_failed. The merge_gate_evaluated event
 * is appended BEFORE the fail transition so the audit trail is ordered correctly.
 *
 * Returns the MergeGateResult for the caller's inspection.
 */
export async function runMergeGate(
  log: EventLog,
  task: TaskRecord,
  opts: MergeGateOptions
): Promise<MergeGateResult> {
  const {
    dataDir,
    repoPath,
    base,
    branch,
    worktreePath,
    verifyTimeoutMs = 60_000,
  } = opts;

  const taskId = task.id;
  const projectTag = task.projectTag;

  // ── 1. Scope violation check ──────────────────────────────────────────────
  const scopePaths = getScopePaths(task);
  let scopeResult: ScopeCheckResult;

  try {
    scopeResult = await checkScopeViolations({
      repoPath,
      base,
      branch,
      scopePaths,
    });
  } catch (err) {
    // I2: git exec failure → gate fail; record and stop
    scopeResult = {
      passed: false,
      violations: [`git_exec_error: ${String(err)}`],
    };
  }

  // ── 2. Verify command execution ───────────────────────────────────────────
  const acceptance = getAcceptance(task);
  const logBaseDir = path.join(dataDir, "gate-logs", taskId);
  const verifyResults: VerifyResult[] = [];

  for (const ac of acceptance) {
    if (!ac.verify) {
      // No verify command for this AC — skip (not a gate failure)
      verifyResults.push({
        acId: ac.id,
        command: undefined,
        exitCode: null,
        logDirPath: undefined,
      });
      continue;
    }

    try {
      const { exitCode, logDirPath } = await runSingleVerifyCommand({
        acId: ac.id,
        command: ac.verify,
        worktreePath,
        logBaseDir,
        timeoutMs: verifyTimeoutMs,
      });
      verifyResults.push({
        acId: ac.id,
        command: ac.verify,
        exitCode,
        logDirPath,
      });
    } catch (err) {
      // I2: unexpected execution error (e.g. logDir creation failure) → gate fail
      verifyResults.push({
        acId: ac.id,
        command: ac.verify,
        exitCode: 1,
        logDirPath: undefined,
      });
      // Append to stderrPath if logBaseDir was partially created
      try {
        const safeDirName = ac.id.replace(/[^a-zA-Z0-9_-]/g, "_");
        const logDirPath = path.join(logBaseDir, safeDirName);
        fs.mkdirSync(logDirPath, { recursive: true });
        fs.appendFileSync(
          path.join(logDirPath, "stderr.txt"),
          `[banto-gate] unexpected error running verify: ${String(err)}\n`,
          "utf-8"
        );
        verifyResults[verifyResults.length - 1]!.logDirPath = logDirPath;
      } catch {
        // Secondary log write failure — I2 warning to stderr only
        process.stderr.write(
          `[banto-gate] WARNING: could not write error log for ${taskId}/${ac.id}: ${String(err)}\n`
        );
      }
    }
  }

  // ── 3. Aggregate result ───────────────────────────────────────────────────
  const reasons: string[] = [];
  const logPaths: string[] = [];

  // Scope violations
  if (!scopeResult.passed) {
    for (const v of scopeResult.violations) {
      reasons.push(`scope_violation:${v}`);
    }
  }

  // Verify command failures
  for (const vr of verifyResults) {
    if (vr.exitCode !== null && vr.exitCode !== 0) {
      reasons.push(`verify_failed:${vr.acId}(exit=${vr.exitCode})`);
    }
    if (vr.logDirPath !== undefined) {
      logPaths.push(vr.logDirPath);
    }
  }

  const passed = reasons.length === 0;

  const result: MergeGateResult = {
    passed,
    scopeResult,
    verifyResults,
    reasons,
    logPaths,
  };

  // ── 4. Append merge_gate_evaluated event ──────────────────────────────────
  log.append({
    type: "merge_gate_evaluated",
    projectTag,
    taskId,
    passed,
    reasons,
    logPaths,
  });

  // ── 5. Fail the task if gate did not pass ─────────────────────────────────
  if (!passed) {
    // I2: gate failure is unrecoverable for this merge attempt — transition to failed.
    // The task status at this point should be 'merging'.
    const currentStatus = task.status as import("@banto/core").TaskStatus;
    StateMachine.fail(log, taskId, {
      currentStatus,
      reason: `merge_gate_failed: ${reasons.join("; ")}`,
    }, projectTag);
  }

  return result;
}

// ── Internal helpers ──────────────────────────────────────────────────────────

/** Extract scope.paths from a TaskRecord (D3: derived from record). */
function getScopePaths(task: TaskRecord): string[] {
  const scope = task["scope"] as Record<string, unknown> | undefined;
  if (!scope || typeof scope !== "object") return [];
  const paths = scope["paths"];
  if (!Array.isArray(paths)) return [];
  return paths.filter((p): p is string => typeof p === "string");
}

/** Extract acceptance criteria (with optional verify) from a TaskRecord. */
function getAcceptance(task: TaskRecord): Array<{ id: string; text: string; verify?: string }> {
  const acceptance = task["acceptance"];
  if (!Array.isArray(acceptance)) return [];
  return acceptance
    .filter((a): a is Record<string, unknown> => !!a && typeof a === "object")
    .map((a) => ({
      id: String(a["id"] ?? ""),
      text: String(a["text"] ?? ""),
      ...(typeof a["verify"] === "string" ? { verify: a["verify"] } : {}),
    }))
    .filter((a) => a.id.length > 0);
}

/**
 * GateEvaluator: dependency-driven gate for queued→ready promotion.
 *
 * Implements spec-multi-project §3: three conditions only.
 *   1. Dependency graph: all depends[] tasks must be "resolved"
 *      - Resolved: approved | merging | merged | evaluating | closed
 *      - Permanent block: failed | superseded (unrecoverable, never resolves)
 *   2. Scope overlap × unreviewed ancestor (実質依存):
 *      - An unreviewed ancestor is a task in the same project whose status is
 *        queued | ready | planning | implementing | auditing | review-ready | in-review
 *        (i.e. NOT in approved | merging | merged | evaluating | closed)
 *      - If any unreviewed ancestor's scope.paths overlaps with the candidate's
 *        scope.paths, spawn is deferred.
 *      - Overlap detection is conservative: only when paths are provably disjoint
 *        is parallel execution allowed.
 *   3. Physical quota: QuotaCheck hook. Current implementation always passes
 *      (real environment quota is Sprint S9d7fdb). The interface is defined here.
 *
 * D2: gate conditions are data-driven (sets of states, not inline conditionals).
 * D3: every gate judgment is recorded as a gate_evaluated event.
 * D6: no third-party libs; glob intersection uses conservative string logic only.
 * I2: blocked reasons are explicit and recorded in blockedBy[].
 */

import type { EventLog } from "@banto/core";
import type { TaskRecord } from "@banto/core";
import { StateMachine } from "@banto/core";
import type { WsEventServer } from "./ws-server.js";

// ── State sets (D2: rules as data) ────────────────────────────────────────────

/**
 * States that count as "dependency resolved" for gate condition 1.
 * A task in one of these states has passed PO review and its output is stable.
 */
const RESOLVED_STATES: ReadonlySet<string> = new Set([
  "approved",
  "merging",
  "merged",
  "evaluating",
  "closed",
]);

/**
 * States that are permanently blocking for condition 1.
 * A dependency in one of these states will never resolve → permanent block.
 */
const PERMANENT_BLOCK_STATES: ReadonlySet<string> = new Set([
  "failed",
  "superseded",
]);

/**
 * States counted as "unreviewed" for condition 2 (scope overlap deferral).
 * These are tasks that have not yet passed PO review.
 * Note: "queued" is included — a task that hasn't even started can still
 * carry uncommitted scope that will conflict.
 */
const UNREVIEWED_STATES: ReadonlySet<string> = new Set([
  "queued",
  "ready",
  "planning",
  "implementing",
  "auditing",
  "review-ready",
  "in-review",
]);

// ── QuotaCheck interface (condition 3 hook) ────────────────────────────────────

/**
 * Physical resource quota checker.
 * Sprint S9d7fdb will provide real implementations.
 * Current default: always pass (D6: no environment dependency yet).
 */
export interface QuotaCheck {
  /** Return true if the task may proceed given current physical resource availability. */
  check(task: TaskRecord): boolean;
}

/**
 * Default no-op QuotaCheck: always passes.
 * The frame exists for S9d7fdb to inject real quota logic.
 */
export class AlwaysPassQuota implements QuotaCheck {
  check(_task: TaskRecord): boolean {
    return true;
  }
}

// ── Glob intersection (conservative, no external lib) ─────────────────────────

/**
 * Normalise a glob pattern to a comparable prefix form.
 * Strips trailing `**` and `*` wildcards to get the deepest known path component.
 * Returns the normalised segment prefix (empty string = matches everything).
 *
 * Examples:
 *   "src/**"          → "src/"
 *   "src/shared/**"   → "src/shared/"
 *   "src/a/b.ts"      → "src/a/b.ts"
 *   "**"              → ""          (matches everything)
 *   "*"               → ""          (matches anything at this level)
 */
function globPrefix(pattern: string): string {
  // Remove trailing slash first
  let p = pattern.replace(/\/+$/, "");

  // Strip trailing `/**` or `/*` or `**` or `*`
  p = p
    .replace(/\/\*\*$/, "/")
    .replace(/\/\*$/, "/")
    .replace(/\*\*$/, "")
    .replace(/\*$/, "");

  return p;
}

/**
 * Conservative glob intersection test.
 *
 * Returns true iff the two glob patterns MIGHT match an overlapping set of paths.
 * Returns false ONLY when we can prove they are disjoint.
 *
 * Strategy (no minimatch, D6):
 *   - Compute prefix(a) and prefix(b).
 *   - If either prefix is "" (wildcard-everything), they definitely overlap.
 *   - If prefix(a) starts-with prefix(b) OR prefix(b) starts-with prefix(a),
 *     they overlap (one is an ancestor of the other).
 *   - Otherwise they are on different trees → disjoint.
 *
 * This is intentionally over-conservative (may say "overlap" when none exists)
 * which is the safe direction: false parallel is better than false independence.
 */
export function globsOverlap(a: string, b: string): boolean {
  const pa = globPrefix(a);
  const pb = globPrefix(b);

  // One or both are catch-all wildcards → always overlap
  if (pa === "" || pb === "") return true;

  // Overlap if one prefix is a prefix of the other
  if (pa.startsWith(pb) || pb.startsWith(pa)) return true;

  // Disjoint
  return false;
}

/**
 * Check whether two scope.paths arrays overlap.
 * Returns true if any pattern in setA overlaps with any pattern in setB.
 */
export function scopePathsOverlap(setA: string[], setB: string[]): boolean {
  for (const a of setA) {
    for (const b of setB) {
      if (globsOverlap(a, b)) return true;
    }
  }
  return false;
}

// ── Gate evaluation result ─────────────────────────────────────────────────────

export interface GateResult {
  passed: boolean;
  /** Reasons for blocking. Human-readable IDs + descriptions. */
  blockedBy: string[];
}

// ── GateEvaluator ─────────────────────────────────────────────────────────────

export class GateEvaluator {
  constructor(private readonly quotaCheck: QuotaCheck = new AlwaysPassQuota()) {}

  /**
   * Evaluate the gate for a single queued task.
   *
   * Checks all three conditions in order:
   *   1. Dependency graph
   *   2. Scope overlap × unreviewed ancestor
   *   3. Physical quota
   *
   * Returns a GateResult with passed=true and empty blockedBy when all clear.
   * blockedBy entries carry the reason in parentheses for audit clarity.
   */
  evaluate(task: TaskRecord, allTasks: TaskRecord[]): GateResult {
    const blockedBy: string[] = [];

    // ── Condition 1: dependency graph ─────────────────────────────────────────
    const depends = task["depends"];
    if (Array.isArray(depends)) {
      for (const depId of depends) {
        if (typeof depId !== "string") continue;

        // Find the dependency in the same project first, then globally
        const dep =
          allTasks.find((t) => t.id === depId && t.projectTag === task.projectTag) ??
          allTasks.find((t) => t.id === depId);

        if (!dep) {
          // Dependency not found — treat as unresolved (task may not exist yet)
          blockedBy.push(`${depId}(not_found)`);
        } else if (PERMANENT_BLOCK_STATES.has(dep.status)) {
          // Permanent block: failed/superseded dependency can never resolve
          blockedBy.push(`${depId}(permanent:${dep.status})`);
        } else if (!RESOLVED_STATES.has(dep.status)) {
          // Not yet resolved
          blockedBy.push(`${depId}(unresolved:${dep.status})`);
        }
        // else: resolved — no block
      }
    }

    // ── Condition 2: scope overlap × unreviewed ancestor ─────────────────────
    const taskPaths = this.getScopePaths(task);
    if (taskPaths.length > 0) {
      // Ancestors: tasks in the same project that are unreviewed
      const ancestors = allTasks.filter(
        (t) =>
          t.projectTag === task.projectTag &&
          t.id !== task.id &&
          UNREVIEWED_STATES.has(t.status)
      );

      for (const ancestor of ancestors) {
        const ancestorPaths = this.getScopePaths(ancestor);
        if (ancestorPaths.length > 0 && scopePathsOverlap(taskPaths, ancestorPaths)) {
          blockedBy.push(`${ancestor.id}(scope_overlap:${ancestor.status})`);
        }
      }
    }

    // ── Condition 3: physical quota ───────────────────────────────────────────
    if (!this.quotaCheck.check(task)) {
      blockedBy.push("quota(physical_resource_limit)");
    }

    return {
      passed: blockedBy.length === 0,
      blockedBy,
    };
  }

  /** Extract scope.paths from a task record. Returns [] if not present. */
  private getScopePaths(task: TaskRecord): string[] {
    const scope = task["scope"] as Record<string, unknown> | undefined;
    if (!scope || typeof scope !== "object") return [];
    const paths = scope["paths"];
    if (!Array.isArray(paths)) return [];
    return paths.filter((p): p is string => typeof p === "string");
  }
}

// ── evaluatePendingGates: the main loop ───────────────────────────────────────

/**
 * Evaluate dependency gates for all queued tasks and promote those that pass.
 *
 * Called:
 *   (a) On scheduler tick (gate-reeval job)
 *   (b) After any state_transitioned event that might resolve a block
 *       (specifically transitions to terminal/resolved states)
 *
 * D3: every gate judgment is recorded as gate_evaluated event.
 * I2: gate results (pass or block reason) are always recorded.
 *
 * Returns the number of tasks promoted to ready.
 */
export function evaluatePendingGates(
  log: EventLog,
  allTasks: TaskRecord[],
  wsServer: WsEventServer,
  evaluator: GateEvaluator
): number {
  const queuedTasks = allTasks.filter((t) => t.status === "queued");
  let promoted = 0;

  for (const task of queuedTasks) {
    const result = evaluator.evaluate(task, allTasks);

    // I2: always record the gate judgment
    const gateEvent = log.append({
      type: "gate_evaluated",
      projectTag: task.projectTag,
      taskId: task.id,
      passed: result.passed,
      blockedBy: result.blockedBy,
    });
    wsServer.broadcast(gateEvent);

    if (result.passed) {
      StateMachine.transition(
        log,
        task.id,
        "queued",
        "ready",
        task.projectTag,
        "gate_passed"
      );
      promoted++;
    }
  }

  return promoted;
}

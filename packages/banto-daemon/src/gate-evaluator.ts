/**
 * GateEvaluator: dependency-driven gate for queued→ready promotion.
 *
 * Implements spec-multi-project §3: three conditions only.
 *   1. Dependency graph: all depends[] tasks must be "resolved"
 *      - Resolved: merged | evaluating | closed (output is on main)
 *      - Permanent block: failed | superseded (unrecoverable, never resolves)
 *   2. Scope overlap × unreviewed temporal ancestor (実質依存):
 *      - A temporal ancestor is a task in the same project that was created BEFORE
 *        the candidate (createdEventId < candidate.createdEventId) and whose status
 *        is queued | ready | planning | implementing | auditing | review-ready | in-review
 *        (i.e. NOT in approved | merging | merged | evaluating | closed).
 *      - "Before" is defined by task_created eventId order (monotonically increasing).
 *        This breaks the deadlock that would arise if two tasks with overlapping scope
 *        were created simultaneously and each blocked the other: the later-created task
 *        defers to the earlier-created task, never vice versa.
 *      - If any unreviewed temporal ancestor's scope.paths overlaps with the candidate's
 *        scope.paths, spawn is deferred.
 *      - Overlap detection is conservative: only when paths are provably disjoint
 *        is parallel execution allowed.
 *   3. Physical quota: QuotaCheck hook. Current implementation always passes
 *      (real environment quota is Sprint S9d7fdb). The interface is defined here.
 *
 * D2: gate conditions are data-driven (sets of states, not inline conditionals).
 * D3: gate judgments are recorded as gate_evaluated events only when the result
 *     changes (passed value or blockedBy set). Initial evaluation is always recorded.
 *     Re-recording identical results is suppressed to avoid log bloat.
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
 * A task in one of these states has landed on main — its output is something a
 * dependent task may build on.
 *
 * `approved` and `merging` are deliberately NOT here (imp-0041): neither means
 * the output is on main. `merging` is not terminal — the merge queue sends a
 * task back to `implementing` on rebase conflict, and a pre-merge gate failure
 * makes it `failed`; `approved` has not even started merging.
 */
const RESOLVED_STATES: ReadonlySet<string> = new Set([
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
 *
 * WHEN IN DOUBT, BLOCK. This returns the longest prefix every path matched by
 * `pattern` is guaranteed to start with. Returning a SHORTER prefix than
 * necessary is always safe (it can only make `globsOverlap` say "overlap");
 * returning a longer one is not, because it would let two tasks edit the same
 * file at once. Never lengthen a prefix past a construct this cannot prove.
 *
 * Strategy: cut at the first `*`, by CHARACTER, not by path segment. Every
 * literal character before the first wildcard is common to all matches, so
 * keeping them is provably sound. Anything from the wildcard on is unknown.
 *
 * This used to cut at the first path SEGMENT containing a wildcard, which
 * threw away the literal head of that segment: `tests/acceptance/backlog-*`
 * collapsed to `tests/acceptance/`, i.e. a claim on the whole directory. Every
 * task naming any file under a shared directory then collided with every
 * other one, so the gate serialised 17 tasks for 2 hours and
 * `max_concurrent_sessions: 5` had an effective value of 1. Note the change is
 * only about how much *literal* text is kept — the comparison below stays
 * intentionally over-conservative, and a pattern whose first character is a
 * wildcard still collapses to "" (collides with everything).
 *
 * Examples:
 *   "src/**"                      → "src/"
 *   "src/shared/**"               → "src/shared/"
 *   "src/[**]/b.ts"               → "src/"      (mid-path ** cut here; bracket notation avoids comment close)
 *   "src/a/**"                    → "src/a/"
 *   "src/a/b.ts"                  → "src/a/b.ts"
 *   "**"                          → ""          (matches everything)
 *   "*"                           → ""          (matches anything at this level)
 *   "src/[*]/b.ts"                → "src/"      (mid-path * cut here)
 *   "tests/acc/backlog-[*].ts"    → "tests/acc/backlog-"  (literal head kept)
 */
function globPrefix(pattern: string): string {
  // Remove trailing slash first
  const p = pattern.replace(/\/+$/, "");

  // Cut at the first wildcard character. Everything before it is literal and
  // therefore shared by every path the pattern can match.
  const wildcardAt = p.indexOf("*");

  if (wildcardAt === -1) {
    // No wildcard — exact path
    return p;
  }

  // Wildcard at position 0 → matches from root → catch-all (returns "").
  // Otherwise: the literal head. Note this may end mid-segment
  // ("tests/acceptance/backlog-") rather than at a "/" — that is the point,
  // and startsWith comparisons remain correct either way.
  return p.slice(0, wildcardAt);
}

/**
 * Conservative glob intersection test.
 *
 * WHEN IN DOUBT, BLOCK. The goal here is not an accurate intersection test —
 * it is to unblock only the pairs we can PROVE never touch the same file.
 * Every undecidable case must fall on the blocking side. The asymmetry is
 * deliberate: a false "disjoint" puts two tasks on the same file at the same
 * time, while a false "overlap" only costs wall-clock in the queue.
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

/**
 * Test whether a concrete file path is covered by a glob pattern.
 *
 * Used by the merge-gate scope checker to determine whether each file in
 * `git diff --name-only base...branch` falls within the task's scope.paths.
 *
 * Strategy (no minimatch, D6):
 *   - No wildcard:  exact string equality.
 *   - First segment is "**" or "*": catch-all → always matches.
 *   - Wildcard "**" in a non-first segment: the file must start with the literal
 *     prefix before the wildcard segment — it may cross directory separators.
 *   - Wildcard "*" (single star) in a non-first segment: the file must start
 *     with the literal prefix AND the remainder after the prefix must NOT contain
 *     a "/" (single star must not cross a directory separator). If the pattern
 *     segment following "*" includes a file extension (e.g. "*.ts"), the matched
 *     portion must also end with that extension.
 *   Conservative direction: when unsure → not-in-scope → violation (fail-closed).
 *
 * Examples:
 *   fileMatchesGlob("src/a.ts",       "src/**")   → true  (** crosses dirs)
 *   fileMatchesGlob("src/a/b.ts",     "src/**")   → true  (** crosses dirs)
 *   fileMatchesGlob("src/a.ts",       "src/*.ts") → true  (single *, same dir, .ts ext)
 *   fileMatchesGlob("src/a/b.ts",     "src/*.ts") → false (* must not cross /)
 *   fileMatchesGlob("src/a.js",       "src/*.ts") → false (wrong extension)
 *   fileMatchesGlob("src/a.ts",       "src/a.ts") → true  (exact)
 *   fileMatchesGlob("docs/x.md",      "src/**")   → false (different tree)
 *   fileMatchesGlob("any/path",       "**")        → true  (catch-all)
 */
export function fileMatchesGlob(filePath: string, pattern: string): boolean {
  const p = pattern.replace(/\/+$/, "");
  const segments = p.split("/");
  if (!p.includes("*")) {
    // No wildcard — exact match only
    return filePath === p;
  }

  // Compile the glob segment-by-segment into an anchored RegExp:
  //   "**" as a whole segment → zero or more path segments (".+" when last)
  //   "*"  within a segment   → any run of non-"/" characters
  // Every literal character is escaped, so matching is strict (fail-closed):
  // a stricter matcher yields MORE not-in-scope verdicts, never fewer.
  const esc = (s: string): string => s.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  let re = "^";
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i]!;
    const isLast = i === segments.length - 1;
    if (seg === "**") {
      // Zero or more whole segments; as the final segment it must cover at
      // least one character (a bare directory prefix is not a file match).
      re += isLast ? ".+" : "(?:[^/]+/)*";
    } else {
      re += seg.split("*").map(esc).join("[^/]*");
      if (!isLast) re += "/";
    }
  }
  re += "$";
  return new RegExp(re).test(filePath);
}

/**
 * Check whether a concrete file path is covered by ANY pattern in a scope.paths array.
 * Returns true if the file is within scope (permitted); false means it is a violation.
 */
export function fileMatchesScopePaths(filePath: string, scopePaths: string[]): boolean {
  return scopePaths.some((pattern) => fileMatchesGlob(filePath, pattern));
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

    // ── Condition 2: scope overlap × unreviewed temporal ancestor ────────────
    const taskPaths = this.getScopePaths(task);
    if (taskPaths.length > 0) {
      // Temporal ancestors: tasks in the same project that were created BEFORE
      // this task (createdEventId < task.createdEventId) and are still unreviewed.
      // Using creation order (task_created eventId) breaks the symmetry that would
      // cause a deadlock when two tasks with overlapping scope enter queued at the
      // same time: only the later-created one defers, never the earlier one.
      const taskCreatedEventId = (task as Record<string, unknown>)["createdEventId"];
      const taskOrder =
        typeof taskCreatedEventId === "number" ? taskCreatedEventId : Infinity;

      const ancestors = allTasks.filter((t) => {
        if (t.projectTag !== task.projectTag) return false;
        if (t.id === task.id) return false;
        if (!UNREVIEWED_STATES.has(t.status)) return false;
        // Only tasks created strictly before this task are temporal ancestors.
        const tCreatedEventId = (t as Record<string, unknown>)["createdEventId"];
        const tOrder =
          typeof tCreatedEventId === "number" ? tCreatedEventId : Infinity;
        return tOrder < taskOrder;
      });

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

// ── Gate result dedup (in-memory, resets on daemon restart) ──────────────────

/**
 * Serialise a GateResult to a stable dedup key.
 *
 * Dedup semantics (per spec "passed値とblockedBy集合"):
 *   - passed: boolean (true = all clear, false = blocked)
 *   - blockedBy SET: the set of blocking entity IDs (the part before the first `(`
 *     in each entry, e.g. "task-0050" from "task-0050(unresolved:implementing)").
 *     Parenthetical state names are EXCLUDED — the dedup check cares about WHICH
 *     entities are blocking, not their current sub-state. This prevents spurious
 *     re-recording when a blocking dep transitions between unresolved states
 *     (e.g. implementing → auditing → in-review) without leaving the blocking set.
 *   - Sorted for order-independent comparison.
 */
function gateResultKey(result: GateResult): string {
  // Extract the entity ID (strip everything from the first '(' onward)
  const ids = result.blockedBy
    .map((entry) => {
      const parenIdx = entry.indexOf("(");
      return parenIdx === -1 ? entry : entry.slice(0, parenIdx);
    })
    .sort();
  return `${result.passed}:${ids.join(",")}`;
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
 * D3: gate judgments are recorded as gate_evaluated events ONLY when the result
 *     changes (passed value or blockedBy set differs from the previous evaluation).
 *     The initial evaluation for a task is always recorded. This prevents log bloat
 *     when a blocked task stays blocked across multiple ticks with the same blockedBy
 *     set (e.g. the task is still blocked by the same dependency with no change).
 *
 * Dedup tracking: in-memory map (lastGateKey) keyed by "projectTag/taskId".
 *   - Resets on daemon restart → the first evaluation after restart is always recorded.
 *     This is acceptable: a restart produces at most one duplicate per queued task, and
 *     ensures the log always has at least one gate_evaluated record per evaluation epoch.
 *   - When blockedBy changes (a dep resolves while another remains), the result key
 *     changes and a new event is emitted. This makes partial-resolution visible in the log.
 *
 * I2: gate results (pass or block reason) are always recorded on first evaluation
 *     or when the result changes. Permanent blocks are still visible.
 *
 * Returns the number of tasks promoted to ready.
 */
export function evaluatePendingGates(
  log: EventLog,
  allTasks: TaskRecord[],
  wsServer: WsEventServer,
  evaluator: GateEvaluator,
  lastGateKey: Map<string, string> = new Map()
): number {
  const queuedTasks = allTasks.filter((t) => t.status === "queued");
  let promoted = 0;

  for (const task of queuedTasks) {
    const result = evaluator.evaluate(task, allTasks);
    const dedupKey = `${task.projectTag}/${task.id}`;
    const newKey = gateResultKey(result);
    const prevKey = lastGateKey.get(dedupKey);

    // Record gate_evaluated only when:
    //   - This is the first evaluation for this task (no prevKey), OR
    //   - The result changed (passed value or blockedBy set is different)
    if (prevKey !== newKey) {
      lastGateKey.set(dedupKey, newKey);
      const gateEvent = log.append({
        type: "gate_evaluated",
        projectTag: task.projectTag,
        taskId: task.id,
        passed: result.passed,
        blockedBy: result.blockedBy,
      });
      wsServer.broadcast(gateEvent);
    }

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
      // Clear dedup state for this task — it's no longer queued; if it somehow
      // returns to queued later, the next evaluation will be fresh.
      lastGateKey.delete(dedupKey);
    }
  }

  return promoted;
}

/**
 * StateMachine: task state machine for banto daemon.
 *
 * D2: Transition rules are expressed as data (tables), not embedded conditionals.
 * D3: Task status is derived exclusively from state_transitioned events.
 *     pause/resume/fail/supersede each emit state_transitioned (which owns the
 *     status change) PLUS their own metadata event (task_paused / task_resumed /
 *     task_failed / task_superseded). StateStore must update status ONLY from
 *     state_transitioned; the metadata events update only their own fields.
 * I2: Invalid transitions are NOT silently discarded. They are recorded as
 *     transition_rejected events so the audit trail is complete.
 *
 * spec §1 state machine:
 *   draft → queued → ready → planning → implementing → auditing
 *   → review-ready → in-review → approved → merging → merged
 *   → evaluating → closed
 *
 * Special rules (also encoded as data):
 *   - auditing → merging: only when mergePolicy === 'auto' (caller responsibility;
 *     the table records this as a valid transition, enforcement is at call site)
 *   - merged → evaluating: only for tasks with hypothesis
 *   - merged → closed: for tasks without hypothesis
 *
 * Cross-cutting transitions (separate API):
 *   - pause(): any "active" state → paused (suspends from current, for resume)
 *   - resume(): paused → restored to suspended_from state
 *   - fail(): any non-terminal state → failed (I2: unrecoverable error)
 *   - supersede(): any non-terminal state → superseded (escalation replacement)
 *
 * All cross-cutting methods emit state_transitioned first (D3: single status
 * source), then the metadata event.
 */

import type { EventLog } from "./event-log.js";
import type { TaskStatus } from "./events.js";

// ── Transition table (D2: rules as data) ────────────────────────────────────

/**
 * Regular transition table.
 * Key: "from:to" — present means the transition is permitted.
 * Value: optional notes (not enforced by StateMachine; callers handle conditions).
 */
const REGULAR_TRANSITIONS: ReadonlySet<string> = new Set<string>([
  "draft:queued",
  "queued:ready",
  "ready:planning",
  "planning:implementing",
  "implementing:auditing",
  // auditing → merging: auto merge-policy path (caller ensures policy condition)
  "auditing:merging",
  "auditing:review-ready",
  // auditing → implementing: rework path (first audit fail; daemon injects findings into new session)
  "auditing:implementing",
  "review-ready:in-review",
  "in-review:approved",
  "approved:merging",
  "merging:merged",
  // merged → evaluating: tasks with hypothesis (caller ensures hypothesis condition)
  "merged:evaluating",
  // merged → closed: tasks without hypothesis (caller ensures no-hypothesis condition)
  "merged:closed",
  "evaluating:closed",

  // ── failed から戻る道（task-0081・PO 要望 2026-08-08）────────────────────
  //
  // **タスクを切り直させない。** 落ちたら新しいタスクを立てる運用だと、同じ依頼が
  // task-0004 → task-0005 → … と増え、経緯が分断される（実機で実際にそうなった）。
  // 番頭が理由を見て、直して、**同じタスクのまま**最後まで通せるようにする。
  //
  // どちらへ戻すかは**落ちた理由で変わる**ので、番頭が選ぶ（`kobo.reopen` の mode）：
  //   - implementing: 中身の問題（スコープ違反・本当にテストが落ちる）。職人が直す
  //   - approved:     検証環境の問題。中身は触らず、マージ前ゲートをもう一度回す
  //
  // `failed:closed` は「どうしようもないものを、落ちたまま畳む」道（PO 要望）。
  // **記録は消えない**——経緯には failed を通ったことが残る。
  "failed:implementing",
  "failed:approved",
  "failed:closed",

  // ── 契約の改訂による差し戻し（task-0082・決定64 改訂）────────────────────
  //
  // **基準が動いたら、その基準を見ていない審査は無効**。監査を通ったあとの状態から
  // `implementing` へ戻して、監査からやり直す。前へ飛ぶ道は増やしていない
  // ——増えたのは**後ろへ戻る**道だけ（番頭は進められるが飛ばせない・決定62c）。
  "auditing:planning",
  "review-ready:implementing",
  "in-review:implementing",
  "approved:implementing",
]);

/**
 * Paused is reachable from any of these "active" execution states.
 * Other states (terminal, already-paused) are not pausable.
 * D2: expressed as data — pause() uses this set, not embedded conditionals.
 */
const PAUSABLE_STATES: ReadonlySet<TaskStatus> = new Set<TaskStatus>([
  "queued",
  "ready",
  "planning",
  "implementing",
  "auditing",
  "review-ready",
  "in-review",
  "approved",
  "merging",
]);

/**
 * Terminal states: once here a task cannot be failed or superseded again.
 * D2: expressed as data — fail()/supersede() refuse to act if already terminal.
 *
 * **「終端」＝「二度と落ちない」であって「二度と動かない」ではない**（task-0081）。
 * `failed` からは番頭の判断で戻れる（→ REGULAR_TRANSITIONS の failed: の3本）。
 * ここに残しているのは、落ちたものをもう一度 fail() させないため。
 */
const TERMINAL_STATES: ReadonlySet<TaskStatus> = new Set<TaskStatus>([
  "closed",
  "merged",
  "failed",
  "superseded",
]);

// ── Result types ─────────────────────────────────────────────────────────────

export type TransitionResult =
  | { ok: true }
  | { ok: false; reason: string };

// ── StateMachine ─────────────────────────────────────────────────────────────

export class StateMachine {
  /**
   * Attempt a regular state transition.
   *
   * On success: appends state_transitioned event; returns { ok: true }.
   * On failure: appends transition_rejected event; returns { ok: false, reason }.
   *
   * I2: Both outcomes are persisted — rejections are NOT silently swallowed.
   */
  static transition(
    log: EventLog,
    taskId: string,
    from: TaskStatus,
    to: TaskStatus,
    projectTag: string = "default",
    reason?: string
  ): TransitionResult {
    const key = `${from}:${to}`;

    if (!REGULAR_TRANSITIONS.has(key)) {
      // Record the rejection (I2)
      log.append({
        type: "transition_rejected",
        projectTag,
        taskId,
        attempted_from: from,
        attempted_to: to,
        reason: "invalid_transition",
      });
      return { ok: false, reason: "invalid_transition" };
    }

    // Valid transition — record it
    log.append({
      type: "state_transitioned",
      projectTag,
      taskId,
      from,
      to,
      ...(reason !== undefined ? { reason } : {}),
    });
    return { ok: true };
  }

  /**
   * Pause a task from an active execution state.
   *
   * Emits (in order):
   *   1. state_transitioned(from=currentStatus, to="paused") — D3: owns the status change
   *   2. task_paused(suspended_from=currentStatus)           — metadata: records restore point
   *
   * Returns { ok: false } if the task is not in a pausable state.
   */
  static pause(
    log: EventLog,
    taskId: string,
    currentStatus: TaskStatus,
    projectTag: string = "default"
  ): TransitionResult {
    if (!PAUSABLE_STATES.has(currentStatus)) {
      log.append({
        type: "transition_rejected",
        projectTag,
        taskId,
        attempted_from: currentStatus,
        attempted_to: "paused",
        reason: "not_pausable_from_current_state",
      });
      return { ok: false, reason: "not_pausable_from_current_state" };
    }

    // D3: state_transitioned is the single canonical source of status changes
    log.append({
      type: "state_transitioned",
      projectTag,
      taskId,
      from: currentStatus,
      to: "paused",
    });
    // Metadata event: records suspended_from so resume() can restore it
    log.append({
      type: "task_paused",
      projectTag,
      taskId,
      suspended_from: currentStatus,
    });
    return { ok: true };
  }

  /**
   * Resume a paused task, restoring it to the suspended_from state.
   *
   * Caller must provide the suspended_from state (read from TaskRecord.suspendedFrom).
   * Returns { ok: false } if the task is not currently paused.
   *
   * Emits (in order):
   *   1. state_transitioned(from="paused", to=suspendedFrom) — D3: owns the status change
   *   2. task_resumed(restored_to=suspendedFrom)             — metadata: clears suspendedFrom
   */
  static resume(
    log: EventLog,
    taskId: string,
    currentStatus: TaskStatus,
    suspendedFrom: TaskStatus,
    projectTag: string = "default"
  ): TransitionResult {
    if (currentStatus !== "paused") {
      log.append({
        type: "transition_rejected",
        projectTag,
        taskId,
        attempted_from: currentStatus,
        attempted_to: suspendedFrom,
        reason: "task_not_paused",
      });
      return { ok: false, reason: "task_not_paused" };
    }

    // D3: state_transitioned is the single canonical source of status changes
    log.append({
      type: "state_transitioned",
      projectTag,
      taskId,
      from: "paused",
      to: suspendedFrom,
    });
    // Metadata event: signals that suspendedFrom should be cleared
    log.append({
      type: "task_resumed",
      projectTag,
      taskId,
      restored_to: suspendedFrom,
    });
    return { ok: true };
  }

  /**
   * Fail a task with an unrecoverable error (I2: stop, record, don't swallow).
   * Any non-terminal state may be failed.
   *
   * Emits (in order):
   *   1. state_transitioned(from=currentStatus, to="failed") — D3: owns the status change
   *   2. task_failed(reason)                                 — metadata: records failure reason
   *
   * Returns { ok: false } if the task is already in a terminal state.
   */
  static fail(
    log: EventLog,
    taskId: string,
    opts: { currentStatus: TaskStatus; reason: string },
    projectTag: string = "default"
  ): TransitionResult {
    if (TERMINAL_STATES.has(opts.currentStatus)) {
      log.append({
        type: "transition_rejected",
        projectTag,
        taskId,
        attempted_from: opts.currentStatus,
        attempted_to: "failed",
        reason: "already_terminal",
      });
      return { ok: false, reason: "already_terminal" };
    }

    // D3: state_transitioned is the single canonical source of status changes
    log.append({
      type: "state_transitioned",
      projectTag,
      taskId,
      from: opts.currentStatus,
      to: "failed",
    });
    // Metadata event: records failure reason
    log.append({
      type: "task_failed",
      projectTag,
      taskId,
      reason: opts.reason,
    });
    return { ok: true };
  }

  /**
   * Supersede a task (escalation-driven replacement).
   * Records the superseding task ID for audit trail.
   *
   * Emits (in order):
   *   1. state_transitioned(from=currentStatus, to="superseded") — D3: owns the status change
   *   2. task_superseded(supersededBy)                           — metadata: records who superseded
   *
   * Returns { ok: false } if the task is already in a terminal state.
   */
  static supersede(
    log: EventLog,
    taskId: string,
    opts: { currentStatus: TaskStatus; by: string },
    projectTag: string = "default"
  ): TransitionResult {
    if (TERMINAL_STATES.has(opts.currentStatus)) {
      log.append({
        type: "transition_rejected",
        projectTag,
        taskId,
        attempted_from: opts.currentStatus,
        attempted_to: "superseded",
        reason: "already_terminal",
      });
      return { ok: false, reason: "already_terminal" };
    }

    // D3: state_transitioned is the single canonical source of status changes
    log.append({
      type: "state_transitioned",
      projectTag,
      taskId,
      from: opts.currentStatus,
      to: "superseded",
    });
    // Metadata event: records which task superseded this one
    log.append({
      type: "task_superseded",
      projectTag,
      taskId,
      supersededBy: opts.by,
    });
    return { ok: true };
  }
}

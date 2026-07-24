/**
 * Orchestration event types for the banto event sourcing system.
 * All events are append-only and cover: state transitions, spawn/exit,
 * gate decisions, approvals/rejections, PO operations, card generation.
 *
 * Session transcripts are NOT stored here — only path references (per spec §2.1).
 */

/** Task lifecycle states from daemon-core spec §1 */
export type TaskStatus =
  | "draft"
  | "queued"
  | "ready"
  | "planning"
  | "implementing"
  | "auditing"
  | "review-ready"
  | "in-review"
  | "approved"
  | "merging"
  | "merged"
  | "evaluating"
  | "closed"
  | "paused"
  | "failed"
  | "superseded";

/** Base fields present on every event (monotonically increasing eventId + projectTag) */
export interface EventBase {
  /** Monotonically increasing integer ID scoped to this log */
  eventId: number;
  /** ISO-8601 timestamp */
  timestamp: string;
  /** Project tag for multi-project support (spec-multi-project §1) */
  projectTag: string;
  /**
   * 起点参照 (D8 / spec-ui §3): ID of the PO input or event that triggered this
   * event, e.g. "event:123" or "po:<eventId of po_operation>". Optional —
   * writers populate it when the trigger is known; existing events are not
   * backfilled. Added by v1a data-shape audit (docs/research/v1a-data-shape-audit.md).
   */
  originRef?: string;
}

/** Task created by PO or daemon */
export interface TaskCreatedEvent extends EventBase {
  type: "task_created";
  taskId: string;
  payload: {
    title: string;
    /** Optional transcript path reference (not content) */
    transcriptPath?: string;
    [key: string]: unknown;
  };
}

/** Task state machine transition */
export interface StateTransitionedEvent extends EventBase {
  type: "state_transitioned";
  taskId: string;
  from: TaskStatus;
  to: TaskStatus;
  reason?: string;
}

/** Agent session spawned for a task */
export interface AgentSpawnedEvent extends EventBase {
  type: "agent_spawned";
  taskId: string;
  pid: number;
  sessionPath: string;
  worktree: string;
  modelTier: "reasoning" | "standard" | "fast";
}

/** Agent session exited */
export interface AgentExitedEvent extends EventBase {
  type: "agent_exited";
  taskId: string;
  pid: number;
  exitCode: number | null;
  signal: string | null;
}

/** Dependency gate evaluated (queued → ready gate) */
export interface GateEvaluatedEvent extends EventBase {
  type: "gate_evaluated";
  taskId: string;
  passed: boolean;
  blockedBy: string[];
}

/**
 * PO approved a task for merge.
 * D3: This event is a PO judgment record ONLY — it does NOT change task status.
 * Status canonical source is state_transitioned exclusively.
 */
export interface TaskApprovedEvent extends EventBase {
  type: "task_approved";
  taskId: string;
  approvedBy: string;
}

/**
 * PO rejected a task.
 * D3: This event is a PO judgment record ONLY — it does NOT change task status.
 * Status canonical source is state_transitioned exclusively.
 */
export interface TaskRejectedEvent extends EventBase {
  type: "task_rejected";
  taskId: string;
  rejectedBy: string;
  reason: string;
}

/** PO operation (enqueue, prioritize, pause, etc.) */
export interface PoOperationEvent extends EventBase {
  type: "po_operation";
  operation: string;
  taskId?: string;
  payload?: Record<string, unknown>;
}

/** Evaluation/retrospective card generated */
export interface CardGeneratedEvent extends EventBase {
  type: "card_generated";
  cardId: string;
  taskId?: string;
  cardType: "evaluation" | "cadence" | "meta_cadence";
  /** Path reference to card file, not content */
  cardPath: string;
}

/** Environment provisioned for a task */
export interface EnvProvisionedEvent extends EventBase {
  type: "env_provisioned";
  taskId: string;
  envId: string;
  /** Profile name used to provision (e.g. "dev", "test") — spec-environment §2 */
  profileName: string;
  /** Driver name or path used (e.g. "process") */
  driver: string;
  /**
   * Result of the healthcheck after provision.
   * D3: path reference only — never log bodies (spec-environment §6).
   */
  healthcheck: { ok: boolean; detail?: string };
}

/** Environment torn down */
export interface EnvTornDownEvent extends EventBase {
  type: "env_torn_down";
  taskId: string;
  envId: string;
  /**
   * Reason for teardown. Optional — omitted for user-initiated teardown.
   * "ttl_expired": TTL enforcement tick forced teardown (Story-5).
   * "vanished": reconcile detected that the resource is gone from the driver list (Story-5).
   */
  reason?: "ttl_expired" | "vanished";
}

/** Merge completed */
export interface TaskMergedEvent extends EventBase {
  type: "task_merged";
  taskId: string;
  commitSha: string;
}

/**
 * Invalid transition attempt recorded for auditability (I2: errors not swallowed).
 * D3: This event records the rejection fact; it does NOT change task status.
 */
export interface TransitionRejectedEvent extends EventBase {
  type: "transition_rejected";
  taskId: string;
  attempted_from: TaskStatus;
  attempted_to: TaskStatus;
  reason: string;
}

/**
 * Task paused from an active execution state.
 * suspended_from records the pre-pause status so resume() can restore it (D3).
 */
export interface TaskPausedEvent extends EventBase {
  type: "task_paused";
  taskId: string;
  suspended_from: TaskStatus;
}

/**
 * Task resumed from paused state, restoring to the suspended_from status.
 */
export interface TaskResumedEvent extends EventBase {
  type: "task_resumed";
  taskId: string;
  restored_to: TaskStatus;
}

/**
 * Task entered unrecoverable failure state (I2: stop, don't swallow).
 */
export interface TaskFailedEvent extends EventBase {
  type: "task_failed";
  taskId: string;
  reason: string;
}

/**
 * Task superseded (replaced) by another task via escalation.
 */
export interface TaskSupersededEvent extends EventBase {
  type: "task_superseded";
  taskId: string;
  supersededBy: string;
}

/**
 * Task definition file was rejected during watcher ingest (I2: rejection recorded, not swallowed).
 * The file is NOT added to the task registry. reason describes the validation failure.
 */
export interface TaskIngestRejectedEvent extends EventBase {
  type: "task_ingest_rejected";
  /** Absolute path of the rejected task definition file */
  filePath: string;
  /** Human-readable reason for rejection (e.g. "missing required field: scope.paths") */
  reason: string;
}

/**
 * A scheduler tick job failed.
 * I2: errors are NOT swallowed — recorded here so the audit trail is complete.
 * The daemon continues running after a tick job failure (scheduler catches and records).
 * projectTag is set to the sentinel value "daemon" (daemon-internal, not a user project).
 */
export interface TickJobFailedEvent extends EventBase {
  type: "tick_job_failed";
  jobName: string;
  error: string;
}

/**
 * Merge-gate verdict for a task in the 'merging' state.
 *
 * Records whether the pre-merge checks (scope diff + verify commands) passed.
 * On failure, `reasons` lists the violation file paths or verify command failures.
 * Log paths for verify-command output are carried as path references only (spec §2.1).
 *
 * S75f66b-4: appended here to keep the union complete; wiring into the merge
 * processor happens in S75f66b-5. (D3: gate judgments recorded as events only.)
 */
export interface MergeGateEvaluatedEvent extends EventBase {
  type: "merge_gate_evaluated";
  taskId: string;
  passed: boolean;
  /** Human-readable reasons for gate failure (violation files or failed command ids). */
  reasons: string[];
  /**
   * Path references to execution log directories for verify commands.
   * Contains log directory paths only — never log content (spec §2.1).
   * Empty when no verify commands were run or when scope check failed first.
   */
  logPaths: string[];
}

/**
 * Audit session started for a task in 'auditing' state.
 *
 * S75f66b-3: emitted when daemon auto-spawns an audit session.
 * sessionPath is a path reference only — no content stored (spec §2.1).
 * role: "audit" distinguishes this from executor agent_spawned events.
 */
export interface AuditStartedEvent extends EventBase {
  type: "audit_started";
  taskId: string;
  /** Session JSONL path reference (not transcript content — spec §2.1). */
  sessionPath: string;
  /** Absolute path to the task's worktree (read context for the audit agent). */
  worktree: string;
}

/**
 * Audit session reported a verdict via the audit_report tool.
 *
 * S75f66b-3: emitted by daemon when it receives the audit verdict.
 * D3: status change is carried exclusively by state_transitioned events;
 * this event records only the audit metadata (verdict + findings).
 * findings: path references or short descriptions — no large content inline (spec §2.1).
 */
export interface AuditVerdictEvent extends EventBase {
  type: "audit_verdict";
  taskId: string;
  verdict: "pass" | "fail";
  /**
   * Human-readable findings from the audit session (fail case).
   * Empty array on pass. Short strings only — full transcript is in sessionPath.
   */
  findings: string[];
}

/**
 * Audit session spawn was suppressed by the disableAuditSpawn config flag.
 *
 * F2 (governance): emitted so the bypass is visible in the event log — "黙って迂回できる経路を
 * 作らない" (priority rule 2). This event is recorded instead of spawning the audit session,
 * making the suppression auditable without spawning a real session (test-only flag).
 */
export interface AuditSpawnDisabledEvent extends EventBase {
  type: "audit_spawn_disabled";
  taskId: string;
}

/**
 * Daemon started with one or more spawn-suppressing config flags set.
 *
 * F2 (governance): emitted once at daemon start when disableAutoSpawn (or similar
 * spawn-suppressing flags) are set, so the bypass is visible in the event log —
 * "黙って迂回できる経路を作らない" (priority rule 2). Without this event, a production
 * daemon started with disableAutoSpawn:true would silently not auto-spawn, invisible
 * to the PO via GET /events.
 *
 * Pattern mirrors audit_spawn_disabled: the suppression fact is the observable artifact.
 */
export interface DaemonConfigEvent extends EventBase {
  type: "daemon_config";
  /** True when the auto-spawn scheduler job is suppressed by config */
  autoSpawnDisabled: boolean;
  /** True when the audit-spawn side-effect is suppressed by config */
  auditSpawnDisabled: boolean;
}

/**
 * An environment profile definition in meta/environments.yaml was rejected
 * because it failed schema validation (driver missing / ttl format / quota type).
 *
 * S9d7fdb-1 (AC-S9d7fdb-1-2): emitted at most once per (project, profile name, mtime)
 * to avoid event flooding (watcher-reject no-flood pattern).
 * D3: file is intent; this event records the rejection fact only.
 * I2: errors not swallowed — recorded here so the audit trail is complete.
 */
export interface EnvProfileRejectedEvent extends EventBase {
  type: "env_profile_rejected";
  /** Profile name that failed validation */
  profileName: string;
  /** Human-readable reason naming the offending field */
  reason: string;
}

/**
 * A provision attempt for a task's environment failed.
 *
 * S9d7fdb-1 (AC-S9d7fdb-1-3): emitted when a task references an unknown profile name
 * (or when provision fails for any other reason at the profile-resolution layer).
 * D3: no env_provisioned event is emitted on failure.
 * I2: failure is recorded, not swallowed.
 */
export interface EnvProvisionFailedEvent extends EventBase {
  type: "env_provision_failed";
  taskId: string;
  /** The profile name that was requested but not found (or failed) */
  profileName: string;
  /** Human-readable failure reason */
  reason: string;
}

/**
 * A tmux pane was successfully added to the task's tmux window for environment output.
 *
 * S9d7fdb-7 (AC-S9d7fdb-7-2): emitted after the env pane is attached in the task's
 * existing tmux window so the PO can observe the provisioned environment on SSH+attach.
 * D3: pane address is recorded here; no duplicate pane tracking state elsewhere.
 * I2: not emitted on failure — env_review_tmux_pane_skipped covers failure/no-tmux paths.
 */
export interface EnvReviewTmuxPaneAttachedEvent extends EventBase {
  type: "env_review_tmux_pane_attached";
  taskId: string;
  /** Provisioned environment ID */
  envId: string;
  /** Tmux window address (e.g. "banto:T-001") from the spawn ledger */
  windowAddr: string;
  /** Pane index that was added (2 = the env pane alongside the agent session pane) */
  paneIndex: number;
}

/**
 * Tmux pane attachment was skipped because no tmux session is configured,
 * no spawn-ledger entry has a tmux window for this task, or tmux returned an error.
 *
 * S9d7fdb-7 (AC-S9d7fdb-7-2): I2 — skip must not be silent. This event makes the
 * skip observable via GET /events so the PO knows no pane is waiting.
 * "tmux-less config" (daemon.tmuxSession unset or "") → reason "no_tmux_session".
 * "No window recorded in spawn ledger for this task" → reason "no_tmux_window".
 * "tmux split-window command failed" → reason "tmux_error".
 */
export interface EnvReviewTmuxPaneSkippedEvent extends EventBase {
  type: "env_review_tmux_pane_skipped";
  taskId: string;
  /** Provisioned environment ID (present when provision succeeded before the pane skip) */
  envId: string;
  /** Reason code for the skip */
  reason: "no_tmux_session" | "no_tmux_window" | "tmux_error";
  /** Optional detail message (e.g. tmux stderr) */
  detail?: string;
}

/** Union of all orchestration event types */
export type OrchestrationEvent =
  | TaskCreatedEvent
  | StateTransitionedEvent
  | AgentSpawnedEvent
  | AgentExitedEvent
  | GateEvaluatedEvent
  | TaskApprovedEvent
  | TaskRejectedEvent
  | PoOperationEvent
  | CardGeneratedEvent
  | EnvProvisionedEvent
  | EnvTornDownEvent
  | TaskMergedEvent
  | TransitionRejectedEvent
  | TaskPausedEvent
  | TaskResumedEvent
  | TaskFailedEvent
  | TaskSupersededEvent
  | TaskIngestRejectedEvent
  | TickJobFailedEvent
  | MergeGateEvaluatedEvent
  | AuditStartedEvent
  | AuditVerdictEvent
  | AuditSpawnDisabledEvent
  | DaemonConfigEvent
  | EnvProfileRejectedEvent
  | EnvProvisionFailedEvent
  | EnvReviewTmuxPaneAttachedEvent
  | EnvReviewTmuxPaneSkippedEvent;

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
  worktree: string;
}

/** Environment torn down */
export interface EnvTornDownEvent extends EventBase {
  type: "env_torn_down";
  taskId: string;
  envId: string;
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
  | TickJobFailedEvent;

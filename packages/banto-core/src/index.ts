/**
 * banto-core public API
 *
 * Consumer-style tests and daemon code import ONLY from this file.
 * Internal module paths must NOT be imported directly from outside this package.
 */

// Event types
export type {
  OrchestrationEvent,
  EventBase,
  TaskStatus,
  TaskCreatedEvent,
  StateTransitionedEvent,
  AgentSpawnedEvent,
  AgentExitedEvent,
  GateEvaluatedEvent,
  TaskApprovedEvent,
  TaskRejectedEvent,
  PoOperationEvent,
  CardGeneratedEvent,
  EnvProvisionedEvent,
  EnvTornDownEvent,
  TaskMergedEvent,
  TransitionRejectedEvent,
  TaskPausedEvent,
  TaskResumedEvent,
  TaskFailedEvent,
  TaskSupersededEvent,
  TaskIngestRejectedEvent,
  TickJobFailedEvent,
} from "./events.js";

// Task frontmatter parser + validator
export { validateTaskFrontmatter, extractFrontmatter, parseYamlFrontmatter } from "./task-frontmatter.js";
export type { TaskFrontmatter, FrontmatterValidation } from "./task-frontmatter.js";

// EventLog
export { EventLog } from "./event-log.js";
export type {
  EventPayload,
  ReplayStats,
  Snapshot,
  SnapshotState,
  TaskRecord,
} from "./event-log.js";

// StateStore (replay engine + in-memory derived state)
export { StateStore } from "./state-store.js";

// EventIndex (in-memory task/project history views)
export { EventIndex } from "./event-index.js";

// StateMachine (task state machine: transition table + cross-cutting transitions)
export { StateMachine } from "./state-machine.js";
export type { TransitionResult } from "./state-machine.js";

// DaemonClient (fetch-based HTTP client for banto-daemon REST API)
export { DaemonClient, DaemonConnectionError, DaemonApiError } from "./daemon-client.js";
export type { ProjectEntry, HealthResponse } from "./daemon-client.js";

// Executor tool definitions (runtime-neutral; no pi/agent-sdk imports)
export { reportPhaseTool, reportDoneTool, bantoExecutorTools } from "./tools.js";
export type { BantoTool, ToolResult, ToolTextContent, ToolParameterSchema } from "./tools.js";

// Prompt asset loader (reads from skills/ directory at repo root)
export { loadPromptAsset } from "./prompt-assets.js";

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
} from "./events.js";

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

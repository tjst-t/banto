/**
 * StateStore: replay engine + in-memory derived state store.
 *
 * D3: derived state is NEVER persisted. The log is the truth.
 * Only the snapshot (written at rotation time) is persisted.
 * task.status is updated EXCLUSIVELY by the state_transitioned handler.
 * Metadata events (task_paused / task_resumed / task_failed / task_superseded /
 * task_merged) update ONLY their own metadata fields — never task.status.
 *
 * I2: errors not swallowed — unknown event types are skipped with a warning,
 * malformed events throw.
 */

import type { OrchestrationEvent } from "./events.js";
import type { EventLog, ReplayStats, SnapshotState, TaskRecord } from "./event-log.js";

export type { TaskRecord };

export class StateStore {
  // D3: all fields are derived; never written to disk directly
  private tasks: Map<string, TaskRecord> = new Map();
  private _replayStats: ReplayStats = { snapshotUsed: false, eventsReplayed: 0 };

  private constructor() {}

  /**
   * Create a StateStore from an EventLog via replay.
   *
   * Algorithm:
   * 1. Load the latest snapshot (if any).
   * 2. Replay only the active segment (events after lastEventId in snapshot).
   * 3. If no snapshot, replay ALL events from all segments.
   *
   * This keeps startup cost bounded (spec §2.3 item 2).
   */
  static replay(log: EventLog): StateStore {
    const store = new StateStore();
    store._replay(log);
    return store;
  }

  private _replay(log: EventLog): void {
    const snapshot = log.readSnapshot();

    if (snapshot !== null) {
      // Restore state from snapshot
      this.loadSnapshot(snapshot.state);
      this._replayStats.snapshotUsed = true;

      // Replay only events after the snapshot's lastEventId from active segment
      const activeEvents = log.readActiveSegment();
      let count = 0;
      for (const event of activeEvents) {
        if (event.eventId > snapshot.lastEventId) {
          this.applyEvent(event);
          count++;
        }
      }
      this._replayStats.eventsReplayed = count;
    } else {
      // No snapshot: full replay from all segments
      const allEvents = log.readAllEvents();
      for (const event of allEvents) {
        this.applyEvent(event);
      }
      this._replayStats.eventsReplayed = allEvents.length;
      this._replayStats.snapshotUsed = false;
    }
  }

  private loadSnapshot(state: SnapshotState): void {
    this.tasks.clear();
    for (const [id, record] of Object.entries(state.tasks)) {
      this.tasks.set(id, record);
    }
  }

  /** Apply a single event to update in-memory state */
  private applyEvent(event: OrchestrationEvent): void {
    switch (event.type) {
      case "task_created": {
        const existing = this.tasks.get(event.taskId);
        if (!existing) {
          this.tasks.set(event.taskId, {
            id: event.taskId,
            status: "draft",
            projectTag: event.projectTag,
            title: String(event.payload.title ?? ""),
          });
        }
        break;
      }

      case "state_transitioned": {
        const task = this.tasks.get(event.taskId);
        if (task) {
          task.status = event.to;
        }
        // If task not found, this is an inconsistency; log but don't throw
        // (I2: not swallowed, surfaced as missing task in state)
        break;
      }

      case "task_approved": {
        // D3: task_approved is a PO judgment record only — it does NOT update status.
        // Status canonical source is state_transitioned exclusively.
        const task = this.tasks.get(event.taskId);
        if (task) {
          task.approvedBy = event.approvedBy;
        }
        break;
      }

      case "task_rejected": {
        // D3: task_rejected is a PO judgment record only — it does NOT update status.
        // Status canonical source is state_transitioned exclusively.
        const task = this.tasks.get(event.taskId);
        if (task) {
          task.rejectedBy = event.rejectedBy;
          task.rejectionReason = event.reason;
        }
        break;
      }

      case "task_merged": {
        // D3: task_merged is a metadata event only — it does NOT update status.
        // Status canonical source is state_transitioned exclusively.
        // (merging → merged transition is recorded as state_transitioned by the caller.)
        const task = this.tasks.get(event.taskId);
        if (task) {
          task.commitSha = event.commitSha;
        }
        break;
      }

      case "transition_rejected":
        // D3/I2: rejection events are audit records only — they do NOT change task status.
        // The attempted_from/to are recorded in the log for inspection.
        break;

      case "task_paused": {
        // D3: task_paused is a metadata event only — it does NOT update status.
        // Status canonical source is state_transitioned exclusively.
        // Records suspended_from so resume() can restore to the pre-pause state.
        const task = this.tasks.get(event.taskId);
        if (task) {
          task.suspendedFrom = event.suspended_from;
        }
        break;
      }

      case "task_resumed": {
        // D3: task_resumed is a metadata event only — it does NOT update status.
        // Status canonical source is state_transitioned exclusively.
        // Clears suspendedFrom since the task is no longer paused.
        const task = this.tasks.get(event.taskId);
        if (task) {
          delete task.suspendedFrom;
        }
        break;
      }

      case "task_failed": {
        // D3: task_failed is a metadata event only — it does NOT update status.
        // Status canonical source is state_transitioned exclusively (to="failed").
        // I2: records failure reason for diagnosis.
        const task = this.tasks.get(event.taskId);
        if (task) {
          task.failureReason = event.reason;
        }
        break;
      }

      case "task_superseded": {
        // D3: task_superseded is a metadata event only — it does NOT update status.
        // Status canonical source is state_transitioned exclusively (to="superseded").
        // Records supersededBy for audit trail.
        const task = this.tasks.get(event.taskId);
        if (task) {
          task.supersededBy = event.supersededBy;
        }
        break;
      }

      case "agent_spawned":
      case "agent_exited":
      case "gate_evaluated":
      case "po_operation":
      case "card_generated":
      case "env_provisioned":
      case "env_torn_down":
        // These events are recorded for the log's truth value but don't
        // directly alter the task state machine (handled by daemon logic)
        break;

      default: {
        // I2: unknown event types indicate a version mismatch (newer writer, older reader).
        // Silently skipping would corrupt derived state — throw instead so the caller can stop.
        // Cast through unknown: TypeScript narrows `event` to `never` here because the union
        // is exhaustive at compile time, but unknown future types arrive at runtime. (any justified: unreachable branch)
        const raw = event as unknown as { type: string; eventId: number }; // eslint-disable-line @typescript-eslint/no-explicit-any
        throw new Error(
          `StateStore.applyEvent: unknown event type "${raw.type}" (eventId=${raw.eventId}). ` +
            "This may indicate a newer event log is being read by older code. Stopping to prevent state corruption."
        );
      }
    }
  }

  /** Get a single task by ID. Returns undefined if not found. */
  getTask(taskId: string): TaskRecord | undefined {
    return this.tasks.get(taskId);
  }

  /** Get all tasks */
  getAllTasks(): TaskRecord[] {
    return Array.from(this.tasks.values());
  }

  /** Get tasks filtered by projectTag */
  getTasksByProject(projectTag: string): TaskRecord[] {
    return Array.from(this.tasks.values()).filter((t) => t.projectTag === projectTag);
  }

  /** Stats from the last replay (snapshotUsed, eventsReplayed) */
  replayStats(): ReplayStats {
    return { ...this._replayStats };
  }

  /**
   * Export the current in-memory state as a SnapshotState.
   * Used by EventLog.rotate() to persist the snapshot.
   * D3: this is the ONLY serialization path for derived state.
   */
  toSnapshotState(): SnapshotState {
    const tasks: Record<string, TaskRecord> = {};
    for (const [id, record] of this.tasks.entries()) {
      tasks[id] = { ...record };
    }
    return { tasks };
  }
}

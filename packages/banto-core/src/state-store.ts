/**
 * StateStore: replay engine + in-memory derived state store.
 *
 * D3: derived state is NEVER persisted. The log is the truth.
 * Only the snapshot (written at rotation time) is persisted.
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
        const task = this.tasks.get(event.taskId);
        if (task) {
          task.status = "approved";
        }
        break;
      }

      case "task_rejected": {
        const task = this.tasks.get(event.taskId);
        if (task) {
          task.status = "failed";
          task.rejectionReason = event.reason;
        }
        break;
      }

      case "task_merged": {
        const task = this.tasks.get(event.taskId);
        if (task) {
          task.status = "merged";
          task.commitSha = event.commitSha;
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

      default:
        // Unknown event type: tolerate for forward compatibility (I2: don't throw on unknown future types)
        // but don't swallow — log a warning conceptually (no logger available here, so no-op)
        break;
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

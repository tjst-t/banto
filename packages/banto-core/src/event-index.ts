/**
 * EventIndex: in-memory index derived from the event log.
 *
 * D3: The index is NEVER persisted. It is derived from the log on demand.
 * Provides task-history views and project-scoped queries without
 * duplicating the log's truth.
 *
 * Multi-project isolation (spec-multi-project §2):
 *   byTask key is "projectTag/taskId" (composite), matching StateStore's
 *   key scheme.  getTaskHistory(taskId, projectTag) is O(1) and
 *   guarantees no cross-project event leakage for same-name taskIds.
 */

import type { OrchestrationEvent } from "./events.js";
import type { EventLog } from "./event-log.js";

export class EventIndex {
  /**
   * Composite key "projectTag/taskId" → events in eventId order.
   * Isolates events by project so that two projects sharing the same
   * taskId never see each other's history (spec-multi-project §2).
   */
  private byTask: Map<string, OrchestrationEvent[]> = new Map();
  /** projectTag → events in eventId order */
  private byProject: Map<string, OrchestrationEvent[]> = new Map();

  private constructor() {}

  /** Compose the internal map key from projectTag + taskId (mirrors StateStore). */
  private static taskKey(projectTag: string, taskId: string): string {
    return `${projectTag}/${taskId}`;
  }

  /**
   * Build an in-memory index from all events in the given log.
   * D3: never persisted — rebuilt on demand.
   */
  static build(log: EventLog): EventIndex {
    const index = new EventIndex();
    const allEvents = log.readAllEvents();

    for (const event of allEvents) {
      // Index by projectTag
      if (event.projectTag) {
        const byProj = index.byProject.get(event.projectTag) ?? [];
        byProj.push(event);
        index.byProject.set(event.projectTag, byProj);
      }

      // Index by composite key projectTag/taskId (for events that carry a taskId).
      // Cast via unknown first per TS strict requirements (I4).
      const taskId = (event as unknown as Record<string, unknown>)["taskId"];
      if (typeof taskId === "string" && event.projectTag) {
        const key = EventIndex.taskKey(event.projectTag, taskId);
        const byTask = index.byTask.get(key) ?? [];
        byTask.push(event);
        index.byTask.set(key, byTask);
      }
    }

    return index;
  }

  /**
   * Get all events for a task in eventId (chronological) order.
   * projectTag is required to enforce project-namespace isolation
   * (spec-multi-project §2): two projects may share the same taskId.
   * Returns empty array if task not found.
   */
  getTaskHistory(taskId: string, projectTag: string): OrchestrationEvent[] {
    const key = EventIndex.taskKey(projectTag, taskId);
    return (this.byTask.get(key) ?? []).slice().sort((a, b) => a.eventId - b.eventId);
  }

  /**
   * Get all events for a project in eventId order.
   */
  getProjectHistory(projectTag: string): OrchestrationEvent[] {
    return (this.byProject.get(projectTag) ?? []).slice().sort((a, b) => a.eventId - b.eventId);
  }

  /** All known composite "projectTag/taskId" keys */
  get taskKeys(): string[] {
    return Array.from(this.byTask.keys());
  }

  /** All known projectTags */
  get projectTags(): string[] {
    return Array.from(this.byProject.keys());
  }
}

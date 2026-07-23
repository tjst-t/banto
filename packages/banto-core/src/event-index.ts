/**
 * EventIndex: in-memory index derived from the event log.
 *
 * D3: The index is NEVER persisted. It is derived from the log on demand.
 * Provides task-history views and project-scoped queries without
 * duplicating the log's truth.
 */

import type { OrchestrationEvent } from "./events.js";
import type { EventLog } from "./event-log.js";

export class EventIndex {
  /** taskId → events in eventId order */
  private byTask: Map<string, OrchestrationEvent[]> = new Map();
  /** projectTag → events in eventId order */
  private byProject: Map<string, OrchestrationEvent[]> = new Map();

  private constructor() {}

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

      // Index by taskId (for events that carry a taskId)
      // Cast via unknown first per TS strict requirements (I4)
      const taskId = (event as unknown as Record<string, unknown>)["taskId"];
      if (typeof taskId === "string") {
        const byTask = index.byTask.get(taskId) ?? [];
        byTask.push(event);
        index.byTask.set(taskId, byTask);
      }
    }

    return index;
  }

  /**
   * Get all events for a task in eventId (chronological) order.
   * Returns empty array if task not found.
   */
  getTaskHistory(taskId: string): OrchestrationEvent[] {
    return (this.byTask.get(taskId) ?? []).slice().sort((a, b) => a.eventId - b.eventId);
  }

  /**
   * Get all events for a project in eventId order.
   */
  getProjectHistory(projectTag: string): OrchestrationEvent[] {
    return (this.byProject.get(projectTag) ?? []).slice().sort((a, b) => a.eventId - b.eventId);
  }

  /** All known taskIds */
  get taskIds(): string[] {
    return Array.from(this.byTask.keys());
  }

  /** All known projectTags */
  get projectTags(): string[] {
    return Array.from(this.byProject.keys());
  }
}

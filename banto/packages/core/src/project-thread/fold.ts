import type { StoredEvent } from "../event-store/log.js";
import type { Fold } from "../event-store/snapshot.js";
import type { ProjectThreadReadModel, ProjectState, ThreadState } from "./types.js";

export type ProjectThreadEvent =
  | { type: "project.created"; payload: { id: string; name: string; root: string } }
  | { type: "project.closed"; payload: { id: string } }
  | { type: "project.reopened"; payload: { id: string } }
  | {
      type: "thread.created";
      payload: {
        id: string;
        projectId: string;
        kind: "base" | "fork";
        parentThreadId?: string;
        resumePoint?: string;
      };
    }
  | { type: "thread.closed"; payload: { id: string } }
  | { type: "thread.reopened"; payload: { id: string } }
  | { type: "thread.resume_point_updated"; payload: { id: string; resumePoint: string } }
  | { type: "memory.appended"; payload: { threadId: string; text: string } }
  | { type: "memory.invalidated"; payload: { threadId: string; targetSeq: number } }
  | { type: "message.appended"; payload: { threadId: string; role: "user" | "assistant"; text: string } }
  | { type: "thread.cleared"; payload: { threadId: string } }
  | { type: "usage.recorded"; payload: { threadId: string; contextUsage: unknown; compactionCount: number } };

function cloneModel(m: ProjectThreadReadModel): ProjectThreadReadModel {
  return {
    projects: new Map(m.projects),
    threads: new Map(
      Array.from(m.threads, ([k, v]) => [
        k,
        { ...v, memory: [...v.memory], messages: [...v.messages], markers: [...v.markers], usage: [...v.usage] },
      ]),
    ),
  };
}

export const projectThreadFold: Fold<ProjectThreadReadModel> = {
  initial: () => ({ projects: new Map(), threads: new Map() }),

  apply(state, raw: StoredEvent): ProjectThreadReadModel {
    const event = raw as unknown as ProjectThreadEvent & { ts: string };
    const next = cloneModel(state);

    switch (event.type) {
      case "project.created": {
        const p: ProjectState = {
          id: event.payload.id,
          name: event.payload.name,
          root: event.payload.root,
          status: "active",
          createdAt: raw.ts,
        };
        next.projects.set(p.id, p);
        return next;
      }
      case "project.closed": {
        const p = next.projects.get(event.payload.id);
        if (p) next.projects.set(p.id, { ...p, status: "closed" });
        return next;
      }
      case "project.reopened": {
        const p = next.projects.get(event.payload.id);
        if (p) next.projects.set(p.id, { ...p, status: "active" });
        return next;
      }
      case "thread.created": {
        const t: ThreadState = {
          id: event.payload.id,
          projectId: event.payload.projectId,
          kind: event.payload.kind,
          parentThreadId: event.payload.parentThreadId,
          resumePoint: event.payload.resumePoint,
          status: "active",
          memory: [],
          messages: [],
          markers: [],
          usage: [],
          createdAt: raw.ts,
        };
        // Fork Threadは分岐時点のMemoryで固定する（アーキ仕様§2.2の決定、
        // 自動では取り込まない）——親のmemoryをこの時点でコピーする。
        if (t.kind === "fork" && t.parentThreadId) {
          const parent = next.threads.get(t.parentThreadId);
          if (parent) {
            t.memory = [...parent.memory];
            t.messages = [...parent.messages];
            t.markers = [...parent.markers];
            t.usage = [...parent.usage];
          }
        }
        next.threads.set(t.id, t);
        return next;
      }
      case "thread.closed": {
        const t = next.threads.get(event.payload.id);
        if (t) next.threads.set(t.id, { ...t, status: "closed" });
        return next;
      }
      case "thread.reopened": {
        const t = next.threads.get(event.payload.id);
        if (t) next.threads.set(t.id, { ...t, status: "active" });
        return next;
      }
      case "thread.resume_point_updated": {
        const t = next.threads.get(event.payload.id);
        if (t) next.threads.set(t.id, { ...t, resumePoint: event.payload.resumePoint });
        return next;
      }
      case "memory.appended": {
        const t = next.threads.get(event.payload.threadId);
        if (t) {
          t.memory.push({ seq: raw.seq, text: event.payload.text, invalidated: false });
        }
        return next;
      }
      case "memory.invalidated": {
        const t = next.threads.get(event.payload.threadId);
        if (t) {
          const entry = t.memory.find((m) => m.seq === event.payload.targetSeq);
          if (entry) entry.invalidated = true;
        }
        return next;
      }
      case "message.appended": {
        const t = next.threads.get(event.payload.threadId);
        if (t) {
          t.messages.push({ seq: raw.seq, role: event.payload.role, text: event.payload.text });
        }
        return next;
      }
      case "usage.recorded": {
        const t = next.threads.get(event.payload.threadId);
        if (t) {
          t.usage.push({
            seq: raw.seq,
            contextUsage: event.payload.contextUsage,
            compactionCount: event.payload.compactionCount,
          });
        }
        return next;
      }
      case "thread.cleared": {
        const t = next.threads.get(event.payload.threadId);
        if (t) {
          t.markers.push({ seq: raw.seq, kind: "clear" });
          // 「畳む」＝次のRunner呼び出しでresume-pointを渡さない
          // （v4-architecture.md §2.2）。新規query()として再開する。
          t.resumePoint = undefined;
        }
        return next;
      }
      default:
        return state;
    }
  },
};

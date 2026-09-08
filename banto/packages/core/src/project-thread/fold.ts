import type { StoredEvent } from "../event-store/log.js";
import type { Fold } from "../event-store/snapshot.js";
import type {
  MessageEntry,
  ProjectThreadReadModel,
  ProjectState,
  ThreadPermissionMode,
  ThreadState,
} from "./types.js";

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
  | { type: "thread.permission_mode_set"; payload: { id: string; mode: ThreadPermissionMode } }
  // Memoryの持ち主はProject（決定・2026-09-05）。この決定より前に積まれた
  // イベントは`threadId`しか持たない——書き換えず、foldでThread→Projectを
  // 解決して読む（Event Storeは追記のみ、規則3）。
  | { type: "memory.appended"; payload: { projectId?: string; threadId?: string; text: string } }
  | { type: "memory.invalidated"; payload: { projectId?: string; threadId?: string; targetSeq: number } }
  | { type: "memory.delivered"; payload: { threadId: string; upToSeq: number } }
  | {
      type: "message.appended";
      payload: {
        threadId: string;
        role: "user" | "assistant";
        text: string;
        /** 画面つき tool の呼び出し（表示の復元用、決定・2026-09-07）。 */
        uiToolCalls?: unknown;
      };
    }
  | { type: "thread.cleared"; payload: { threadId: string } }
  | {
      type: "ui-tool-call.display-mode.recorded";
      payload: { threadId: string; toolCallId: string; displayMode: "inline" | "fullscreen" };
    }
  | {
      type: "usage.recorded";
      payload: {
        threadId: string;
        contextUsage: unknown;
        compactionCount: number;
        apiUsage?: unknown;
      };
    };

function cloneModel(m: ProjectThreadReadModel): ProjectThreadReadModel {
  return {
    displayModeByToolCall: new Map(m.displayModeByToolCall),
    projects: new Map(Array.from(m.projects, ([k, v]) => [k, { ...v, memory: [...v.memory] }])),
    threads: new Map(
      Array.from(m.threads, ([k, v]) => [
        k,
        { ...v, messages: [...v.messages], markers: [...v.markers], usage: [...v.usage] },
      ]),
    ),
  };
}

/** Memoryイベントの宛先Project。新しいイベントは`projectId`を持ち、
 *  この決定（2026-09-05）より前のものは`threadId`しか持たない——後者は
 *  Threadから解決する（既存イベントを書き換えないための読み替え）。 */
function resolveMemoryProjectId(
  model: ProjectThreadReadModel,
  payload: { projectId?: string; threadId?: string },
): string | undefined {
  if (payload.projectId) return payload.projectId;
  if (!payload.threadId) return undefined;
  return model.threads.get(payload.threadId)?.projectId;
}


export const projectThreadFold: Fold<ProjectThreadReadModel> = {
  initial: () => ({ projects: new Map(), threads: new Map(), displayModeByToolCall: new Map() }),

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
          memory: [],
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
          createdSeq: raw.seq,
          resumePoint: event.payload.resumePoint,
          // 作られた時点のresume-pointは「親から借りたもの」——自分のセッション
          // ではない（決定・2026-09-05）。最初のターンでforkSessionにより
          // 枝を分け、自分のsession idを受け取った時点でtrueになる。
          ownsSession: false,
          status: "active",
          // system promptに入るMemoryはここで確定する（決定・2026-09-05）。
          // 物差しはEvent Storeのseqそのもの——Project MemoryもGlobal Memoryも
          // 同じ1本の時間軸に並ぶので、種類ごとに別の境界を持たなくてよい。
          // Fork Threadが「分岐時点のMemoryを固定的に持つ」（§2.2 item6）のも
          // 同じ1つの値で表せる——親のmemoryをコピーする必要は無い（規則3）。
          memoryBaselineSeq: raw.seq,
          memoryDeliveredSeq: 0,
          abandonedSessions: [],
          messages: [],
          markers: [],
          usage: [],
          createdAt: raw.ts,
        };
        // 会話の表示（messages/markers/usage）は分岐時点の親の内容を引き継ぐ
        // ——Fork Threadは親の会話の続きとして画面に出る（決定・2026-09-04）。
        if (t.kind === "fork" && t.parentThreadId) {
          const parent = next.threads.get(t.parentThreadId);
          if (parent) {
            t.messages = [...parent.messages];
            t.markers = [...parent.markers];
            t.usage = [...parent.usage];
            // 人が選んだ permissionMode も引き継ぐ（決定・2026-09-06）——
            // 引き継がないと、承認ゲートを効かせていたつもりの人が
            // fork した瞬間に既定（auto）へ戻る（規則2）
            if (parent.permissionMode) t.permissionMode = parent.permissionMode;
          }
        }
        next.threads.set(t.id, t);
        return next;
      }
      case "thread.permission_mode_set": {
        const t = next.threads.get(event.payload.id);
        if (t) next.threads.set(t.id, { ...t, permissionMode: event.payload.mode });
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
        if (!t) return next;
        // **Clear で切り離したセッションは、後から来ても入れない**（決定・2026-09-06）。
        // 走行中に Clear すると、そのターンは終了時に開始時のsession idで
        // ここへ来て、Clear を取り消してしまっていた（見直し・2026-09-06）。
        if (t.abandonedSessions.includes(event.payload.resumePoint)) return next;
        // Runnerが返したsession idを受け取った＝この Thread 自身のセッション。
        next.threads.set(t.id, { ...t, resumePoint: event.payload.resumePoint, ownsSession: true });
        return next;
      }
      case "memory.appended": {
        const projectId = resolveMemoryProjectId(next, event.payload);
        const p = projectId ? next.projects.get(projectId) : undefined;
        if (p) {
          p.memory.push({
            seq: raw.seq,
            text: event.payload.text,
            originThreadId: event.payload.threadId,
          });
        }
        return next;
      }
      case "memory.invalidated": {
        const projectId = resolveMemoryProjectId(next, event.payload);
        const p = projectId ? next.projects.get(projectId) : undefined;
        if (p) {
          // エントリ自体は前のスナップショットと共有されている——書き換えず
          // 差し替える（foldの結果は不変であるべき、規則3）。
          // 無効化の「時点」を残す——確定時点との前後で扱いが変わる（types.ts）。
          p.memory = p.memory.map((m) =>
            m.seq === event.payload.targetSeq && m.invalidatedAtSeq === undefined
              ? { ...m, invalidatedAtSeq: raw.seq }
              : m,
          );
        }
        return next;
      }
      case "memory.delivered": {
        const t = next.threads.get(event.payload.threadId);
        // 巻き戻さない——届けた事実は消えない（Event Storeは追記のみ）。
        if (t) t.memoryDeliveredSeq = Math.max(t.memoryDeliveredSeq, event.payload.upToSeq);
        return next;
      }
      case "message.appended": {
        const t = next.threads.get(event.payload.threadId);
        if (t) {
          t.messages.push({
            seq: raw.seq,
            role: event.payload.role,
            text: event.payload.text,
            // 先に届いていた「どの面に出したか」をここで貼る（上の説明）
            uiToolCalls: Array.isArray(event.payload.uiToolCalls)
              ? (event.payload.uiToolCalls as NonNullable<MessageEntry["uiToolCalls"]>).map((c) => {
                  const known = next.displayModeByToolCall.get(c.toolCallId);
                  return known ? { ...c, displayMode: c.displayMode ?? known } : c;
                })
              : undefined,
          });
        }
        return next;
      }
      // **どの面に出したか**を、その tool 呼び出しの記録に書き足す
      // （決定・2026-09-07）。決めるのは画面側なので、決まってから届く
      case "ui-tool-call.display-mode.recorded": {
        // 会話がまだ書かれていないこともあるので、まず預かる
        next.displayModeByToolCall.set(event.payload.toolCallId, event.payload.displayMode);
        const t = next.threads.get(event.payload.threadId);
        if (t) {
          t.messages = t.messages.map((m) => {
            if (!m.uiToolCalls?.some((c) => c.toolCallId === event.payload.toolCallId)) return m;
            return {
              ...m,
              uiToolCalls: m.uiToolCalls.map((c) =>
                c.toolCallId === event.payload.toolCallId
                  ? { ...c, displayMode: event.payload.displayMode }
                  : c,
              ),
            };
          });
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
            apiUsage: event.payload.apiUsage,
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
          // 走行中のターンが終了時に同じsession idで戻ってきても復活させない
          if (t.resumePoint) t.abandonedSessions = [...t.abandonedSessions, t.resumePoint];
          t.resumePoint = undefined;
          t.ownsSession = false;
          // 畳んだ時点で、system promptに入るMemoryを確定し直す
          // （決定・2026-09-05）——次のターンは新しいキャッシュ境界から始まる。
          t.memoryBaselineSeq = raw.seq;
        }
        return next;
      }
      default:
        return state;
    }
  },
};

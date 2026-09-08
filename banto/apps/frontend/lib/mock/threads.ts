import type { MockThread } from "./types";
import { notifyMockStoreChange } from "./store-events";
import { closeRealThread, reopenRealThread } from "../backend/client";

// デモ用の台本つきThreadは持たない（決定・2026-09-03、実機投入に伴いデモデータを撤去）。
// 実Threadはregisterrealthread/hydrateRealProjects経由でここへ登録される
let mockThreads: MockThread[] = [];

export function getThread(id: string): MockThread | undefined {
  return mockThreads.find((t) => t.id === id);
}

export interface ThreadOverview {
  messageCount: number;
  firstMessage: string | null;
  lastMessage: string | null;
}

/**
 * 閉じた Thread 一覧の概要（レビュー指摘、2026-09-01）——**AI要約はしない**。
 * Memory の自動要約を採らなかったのと同じ理由（§2.2「決まったことの意味を
 * 静かに歪めるリスク」）がここにも当てはまる。安い・決定的に出せるもの
 * （件数・最初と最後の発言）だけを見せる。全文を読みたければ「再度開く」
 */
export function getThreadOverview(thread: MockThread): ThreadOverview {
  if (thread.real) {
    const messages = thread.realMessages ?? [];
    const texts = messages.map((m) => m.text);
    return {
      messageCount: messages.length,
      firstMessage: texts[0] ?? null,
      lastMessage: texts.length > 1 ? texts[texts.length - 1] : null,
    };
  }
  const texts = thread.script.seed.filter((s) => s.t === "text").map((s) => s.text);
  return {
    messageCount: thread.script.seed.length,
    firstMessage: texts[0] ?? null,
    lastMessage: texts.length > 1 ? texts[texts.length - 1] : null,
  };
}

/** 既定は "open" だけ——閉じた Fork Thread は畳んで整理済みのもの、別の一覧で見る */
export function getThreadsForProject(projectId: string): readonly MockThread[] {
  return mockThreads.filter((t) => t.projectId === projectId && t.status === "open");
}

export function getClosedForksForProject(projectId: string): readonly MockThread[] {
  return mockThreads.filter((t) => t.projectId === projectId && t.kind === "fork" && t.status === "closed");
}

export function getAllThreadsForProject(projectId: string): readonly MockThread[] {
  return mockThreads.filter((t) => t.projectId === projectId);
}

/**
 * createRealProject（projects.ts）専用。実bantoホストで既に作られたThreadを
 * ここへ登録するだけ——scriptは空のプレースホルダ（real:trueのThreadは
 * lib/backend/adapter.tsが実データで動かすため、参照されない）。
 */
export function registerRealThread(
  threadId: string,
  projectId: string,
  projectName: string,
  realMessages?: MockThread["realMessages"],
  realMarkers?: MockThread["realMarkers"],
  realUsage?: MockThread["realUsage"],
): void {
  if (mockThreads.some((t) => t.id === threadId)) return;
  const thread: MockThread = {
    id: threadId,
    projectId,
    kind: "base",
    title: projectName,
    parentThreadId: null,
    script: { seed: [], replies: [{ match: "*", steps: [{ t: "text", text: "" }] }] },
    status: "open",
    real: true,
    realMessages,
    realMarkers,
    realUsage,
  };
  mockThreads = [...mockThreads, thread];
  notifyMockStoreChange();
}

/**
 * Fork Thread を実banto hostに作った直後、ここへ登録する（決定・2026-09-04、
 * registerRealThreadのFork版）。titleはAI要約しない方針（§2.2）に合わせ、
 * 決定的に出せるもの（この Project 内の連番）だけにする。
 */
export function registerRealFork(
  threadId: string,
  projectId: string,
  parentThreadId: string,
  realMessages?: MockThread["realMessages"],
  realMarkers?: MockThread["realMarkers"],
  status: MockThread["status"] = "open",
  realUsage?: MockThread["realUsage"],
  /** 親の会話のどこで分岐したか（決定・2026-09-07） */
  realCreatedSeq?: number,
): MockThread {
  const existing = mockThreads.find((t) => t.id === threadId);
  if (existing) return existing;
  const forkCount = mockThreads.filter((t) => t.projectId === projectId && t.kind === "fork").length;
  const thread: MockThread = {
    id: threadId,
    projectId,
    kind: "fork",
    title: `Fork ${forkCount + 1}`,
    parentThreadId,
    realCreatedSeq,
    script: { seed: [], replies: [{ match: "*", steps: [{ t: "text", text: "" }] }] },
    status,
    real: true,
    realMessages,
    realMarkers,
    realUsage,
  };
  mockThreads = [...mockThreads, thread];
  notifyMockStoreChange();
  return thread;
}

/** Clear等でbanto host側の状態が変わった後、そのThreadの表示データだけを
 *  再取得して差し替える（決定・2026-09-04）——ローカルに楽観的なコピーは
 *  持たない（真実は一箇所、規則3）。 */
export function updateRealThreadData(
  threadId: string,
  realMessages: MockThread["realMessages"],
  realMarkers: MockThread["realMarkers"],
  realUsage?: MockThread["realUsage"],
): void {
  mockThreads = mockThreads.map((t) => (t.id === threadId ? { ...t, realMessages, realMarkers, realUsage } : t));
  notifyMockStoreChange();
}

/** ターン完了直後（adapter.tsの"done"イベント）に、そのターンでhost側が
 *  実際に記録したusageをそのまま追記する（決定・2026-09-04）——リロード無しで
 *  メーターに反映する。都度取り直さないのは、host側が返した値と全く同じもの
 *  をこのターンの範囲でだけ複製するだけだから（規則3の逸脱ではない）。 */
export function appendRealUsage(threadId: string, contextUsage: unknown, compactionCount: number): void {
  const thread = getThread(threadId);
  if (!thread?.real) return;
  const seq = (thread.realUsage?.at(-1)?.seq ?? 0) + 1;
  mockThreads = mockThreads.map((t) =>
    t.id === threadId ? { ...t, realUsage: [...(t.realUsage ?? []), { seq, contextUsage, compactionCount }] } : t,
  );
  notifyMockStoreChange();
}

/** Fork Thread を畳む（§2.2「会話を畳む」と同じ性質——削除ではない）。実Threadは
 *  hostへも反映する——ローカルに楽観的なコピーは持たない（真実は一箇所、規則3、
 *  Clearのhandle Clearと同じ形）。 */
export async function closeThread(id: string): Promise<void> {
  const thread = getThread(id);
  if (thread?.real) await closeRealThread(id);
  mockThreads = mockThreads.map((t) => (t.id === id ? { ...t, status: "closed", closedAt: "たった今" } : t));
  notifyMockStoreChange();
}

export async function reopenThread(id: string): Promise<void> {
  const thread = getThread(id);
  if (thread?.real) await reopenRealThread(id);
  mockThreads = mockThreads.map((t) => (t.id === id ? { ...t, status: "open", closedAt: undefined } : t));
  notifyMockStoreChange();
}

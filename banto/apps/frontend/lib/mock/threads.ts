import type { MockThread } from "./types";
import { notifyMockStoreChange } from "./store-events";
import {
  closeRealThread,
  getRealThread,
  listRealThreads,
  renameRealThread,
  reopenRealThread,
  setRealForkOrder,
} from "../backend/client";

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
    // **中身を取っていれば中身から、まだなら一覧の要約から**（改訂・2026-09-07）。
    // 一覧は要約だけを返すようにしたので、開いていない Thread はこちらを通る
    const messages = thread.realMessages;
    if (!messages) {
      return (
        thread.realOverview ?? { messageCount: 0, firstMessage: null, lastMessage: null }
      );
    }
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
  /** 中身をまだ取っていないときの概要（改訂・2026-09-07） */
  realOverview?: MockThread["realOverview"],
): void {
  if (mockThreads.some((t) => t.id === threadId)) return;
  const thread: MockThread = {
    id: threadId,
    projectId,
    kind: "base",
    title: projectName,
    parentThreadId: null,
    realOverview,
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
  /** 中身をまだ取っていないときの概要（改訂・2026-09-07） */
  realOverview?: MockThread["realOverview"],
  /** 人が付けた名前（決定・2026-09-11）。無ければこの Project の中の連番 */
  title?: string,
): MockThread {
  const existing = mockThreads.find((t) => t.id === threadId);
  if (existing) return existing;
  const thread: MockThread = {
    id: threadId,
    projectId,
    kind: "fork",
    // 既定の呼び名は下の renumberDefaultForkTitles が入れ直す
    title: title ?? "Fork",
    explicitTitle: title,
    parentThreadId,
    realCreatedSeq,
    realOverview,
    script: { seed: [], replies: [{ match: "*", steps: [{ t: "text", text: "" }] }] },
    status,
    real: true,
    realMessages,
    realMarkers,
    realUsage,
  };
  mockThreads = [...mockThreads, thread];
  renumberDefaultForkTitles(projectId);
  notifyMockStoreChange();
  return mockThreads.find((t) => t.id === threadId) ?? thread;
}

/**
 * **既定の呼び名は「作られた順」から出す**（改訂・2026-09-11）。
 *
 * 以前は登録した順に `Fork 1`, `Fork 2`, … と振っていたので、**並べ替えたあとに
 * 読み込み直すと番号が入れ替わっていた**（実測：`Fork 2` を上に動かしてリロード
 * すると `Fork 1` になる）。名前は人が覚えているものなので、並び順で変わっては
 * いけない。人が付けた名前（`explicitTitle`）はそのまま。
 */
function renumberDefaultForkTitles(projectId: string): void {
  const forks = mockThreads
    .filter((t) => t.projectId === projectId && t.kind === "fork")
    .slice()
    .sort((a, b) => (a.realCreatedSeq ?? 0) - (b.realCreatedSeq ?? 0));
  const titleById = new Map<string, string>();
  forks.forEach((fork, index) => {
    titleById.set(fork.id, fork.explicitTitle ?? `Fork ${index + 1}`);
  });
  mockThreads = mockThreads.map((t) => {
    const title = titleById.get(t.id);
    return title !== undefined && title !== t.title ? { ...t, title } : t;
  });
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

/**
 * Fork Thread を畳む（ヘッダの GitMerge と、サイドバーの目次の両方から呼ぶ）。
 * **閉じる前に host が持っている最新の中身を手元へ写す**——閉じた Fork は
 * 履歴から読み返せる必要があり、写さずに閉じると畳んだ時点までの発言が
 * 手元に無いまま一覧に並ぶ。手順を2箇所に書かないためにここへ置く（規則3）
 */
export async function foldForkThread(id: string): Promise<void> {
  const thread = getThread(id);
  if (thread?.real) await refreshRealThreadData(id);
  await closeThread(id);
}

/**
 * **その Project の、開いている会話の中身を取り直す**（追加・2026-09-26）。
 *
 * 閉じた Fork は取らない——履歴に出すのは一覧の要約で足り、全文はその会話を開いた面が
 * 取る（`latest-state.ts`——開いた会話の最新を記録から出す）。使い込んだ Project では 12 本中 9 本が
 * 閉じた Fork で、開くたびに誰も読まない会話を丸ごと受け取っていた
 * （docs/notes/2026-09-25-latency-review.md §2.2）。
 *
 * **同じ Project を同時に2回取りに行かない**——ホームは飛ぶ先の Project の会話を
 * 飛ぶ前から取り始め（URL が変わって画面が組み上がるのを待たない）、Project の画面は
 * 開いたときに同じものを欲しがる。
 */
const projectThreadFetches = new Map<string, Promise<void>>();
export function refreshRealProjectThreads(projectId: string): Promise<void> {
  let pending = projectThreadFetches.get(projectId);
  if (!pending) {
    pending = listRealThreads(projectId)
      .then(async (summaries) => {
        await Promise.all(
          summaries.filter((t) => t.status === "active").map((t) => refreshRealThreadData(t.id)),
        );
      })
      .finally(() => projectThreadFetches.delete(projectId));
    projectThreadFetches.set(projectId, pending);
  }
  return pending;
}

/**
 * 実 Thread の中身を host から取り直して手元へ写す。**同じ Thread を同時に
 * 2本取りに行かない**（追加・2026-09-26）——ホームが飛ぶ前に始めた取得と、
 * 開いた Project の画面が同じ Thread を同時に欲しがる。
 */
const realThreadFetches = new Map<string, Promise<void>>();
export function refreshRealThreadData(id: string): Promise<void> {
  let pending = realThreadFetches.get(id);
  if (!pending) {
    pending = getRealThread(id)
      .then((updated) => updateRealThreadData(id, updated.messages, updated.markers, updated.usage))
      .finally(() => realThreadFetches.delete(id));
    realThreadFetches.set(id, pending);
  }
  return pending;
}

export async function reopenThread(id: string): Promise<void> {
  const thread = getThread(id);
  // 中身はここでは取らない——閉じた Fork は中身を持っていないことがある（Project を開いたときに
  // 取るのは開いている Thread だけ）が、開いた面が最新を取りに行く（`latest-state.ts`）
  if (thread?.real) await reopenRealThread(id);
  mockThreads = mockThreads.map((t) => (t.id === id ? { ...t, status: "open", closedAt: undefined } : t));
  notifyMockStoreChange();
}


/**
 * **Fork の名前を変える**（決定・2026-09-11、ユーザー要望）。付けた名前は host が
 * 持つ——ブラウザの覚えにすると、別の端末で開いたときに「Fork 1」へ戻る（規則3）。
 * 先に host へ書いてから手元を直す（書けなかったときに画面だけ変わらないように）。
 */
export async function renameForkThread(threadId: string, title: string): Promise<void> {
  const trimmed = title.trim();
  if (!trimmed) throw new Error("名前を空にはできません");
  await renameRealThread(threadId, trimmed);
  mockThreads = mockThreads.map((t) =>
    t.id === threadId ? { ...t, title: trimmed, explicitTitle: trimmed } : t,
  );
  notifyMockStoreChange();
}

/** その Project の Fork の並び。渡すのは**並び全体**（projects.ts と同じ形）。 */
export async function reorderForks(projectId: string, orderedIds: string[]): Promise<void> {
  const before = mockThreads;
  const rank = new Map(orderedIds.map((id, i) => [id, i]));
  // **その Project の Fork が居た場所に、並べ替えたものを置き直す**
  // ——配列全体を比較関数で並べ替えると、他の Project の Thread まで動く
  const slots: number[] = [];
  const forks: MockThread[] = [];
  mockThreads.forEach((t, i) => {
    if (t.projectId === projectId && t.kind === "fork") {
      slots.push(i);
      forks.push(t);
    }
  });
  forks.sort(
    (a, b) => (rank.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b.id) ?? Number.MAX_SAFE_INTEGER),
  );
  const next = [...mockThreads];
  slots.forEach((slot, i) => {
    next[slot] = forks[i]!;
  });
  mockThreads = next;
  notifyMockStoreChange();
  try {
    await setRealForkOrder(projectId, orderedIds);
  } catch (err) {
    mockThreads = before;
    notifyMockStoreChange();
    throw err;
  }
}

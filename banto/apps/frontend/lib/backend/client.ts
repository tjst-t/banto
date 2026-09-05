// banto host（packages/core、実HTTP+SSE API）への薄いクライアント。
// mock/のスクリプト付きデモデータ（lib/mock/*）はそのまま残す——ここは
// 「実Projectを作ったときだけ」通る経路（決定・2026-09-03、モックは
// 動画撮影用の既存資産としてそのまま動かし続ける、壊さない）。
//
// 接続先はブラウザのlocalStorageに保存したhost URL・tokenを使う
// （NEXT_PUBLIC_*はビルド時固定になり、hostを後から変えられないため）。

const STORAGE_KEY = "banto.backend";

export interface BackendConfig {
  baseUrl: string;
  token: string;
}

/**
 * `?bantoToken=<token>&bantoHost=<url>`で一度開けば覚える（apps/frontend
 * （旧・最小フロントエンド）と同じ方式）。bantoHostを省略した場合は今開いている
 * ページと同じホスト名・ポート4737を仮定する（開発時の既定）。
 */
export function getBackendConfig(): BackendConfig | null {
  if (typeof window === "undefined") return null;

  const params = new URLSearchParams(window.location.search);
  const tokenFromUrl = params.get("bantoToken");
  if (tokenFromUrl) {
    const hostFromUrl = params.get("bantoHost");
    const baseUrl = hostFromUrl ?? `${window.location.protocol}//${window.location.hostname}:4737`;
    const config: BackendConfig = { baseUrl, token: tokenFromUrl };
    setBackendConfig(config);
    return config;
  }

  const raw = window.localStorage.getItem(STORAGE_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as BackendConfig;
  } catch {
    return null;
  }
}

export function setBackendConfig(config: BackendConfig): void {
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
}

export function clearBackendConfig(): void {
  window.localStorage.removeItem(STORAGE_KEY);
}

function requireConfig(): BackendConfig {
  const config = getBackendConfig();
  if (!config) {
    throw new Error("banto host の接続先が設定されていません（設定画面から接続してください）");
  }
  return config;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const config = requireConfig();
  const res = await fetch(`${config.baseUrl}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${config.token}`,
      "content-type": "application/json",
      ...init?.headers,
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`banto host ${path} が ${res.status} を返しました: ${text}`);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export interface RealProject {
  id: string;
  name: string;
  root: string;
  status: "active" | "closed";
  createdAt: string;
}

export interface RealThreadMessage {
  seq: number;
  role: "user" | "assistant";
  text: string;
}

export interface RealThreadMarker {
  seq: number;
  kind: "clear";
}

/** G1〜G3・G5——決定事項の記録。invalidated:trueは無効化（物理削除ではない、規則3）。 */
export interface RealThreadMemory {
  seq: number;
  text: string;
  invalidated: boolean;
}

/** F2/F3——ターンごとの文脈使用量。contextUsageはRunnerが返す形をそのまま
 *  受け取る（規則12「そのまま使う」）——ここで構造を解釈・加工しない。 */
export interface RealThreadUsage {
  seq: number;
  contextUsage: unknown;
  compactionCount: number;
}

export interface RealThread {
  id: string;
  projectId: string;
  kind: "base" | "fork";
  parentThreadId?: string;
  status: "active" | "closed";
  resumePoint?: string;
  messages: RealThreadMessage[];
  markers: RealThreadMarker[];
  usage: RealThreadUsage[];
  memory: RealThreadMemory[];
  createdAt: string;
}

export interface RealInboxItem {
  kind: "judgment" | "review";
  id: string;
  threadId: string;
  message?: string;
  summary?: string;
  liveness?: string;
  createdAt: string;
}

export async function createRealProject(name: string, root: string): Promise<RealProject> {
  return request<RealProject>("/api/projects", { method: "POST", body: JSON.stringify({ name, root }) });
}

export async function listRealProjects(): Promise<RealProject[]> {
  return request<RealProject[]>("/api/projects");
}

export async function listRealThreads(projectId: string): Promise<RealThread[]> {
  return request<RealThread[]>(`/api/projects/${projectId}/threads`);
}

export async function createRealBaseThread(projectId: string): Promise<RealThread> {
  return request<RealThread>(`/api/projects/${projectId}/threads`, { method: "POST" });
}

export async function getRealThread(threadId: string): Promise<RealThread> {
  return request<RealThread>(`/api/threads/${threadId}`);
}

/** Fork Threadを立てる——新しい枝として親の現在のresume-pointを引き継ぐ
 *  （v4-architecture.md §2.2、host側`forkThread`の既定）。 */
export async function createRealFork(parentThreadId: string): Promise<RealThread> {
  return request<RealThread>(`/api/threads/${parentThreadId}/fork`, { method: "POST" });
}

/** UIの「Clear」——会話を畳む。次のターンはresume-pointなし（新規query()）で始まる。 */
export async function clearRealThread(threadId: string): Promise<void> {
  await request(`/api/threads/${threadId}/clear`, { method: "POST" });
}

/** Fork Threadを畳む（削除ではない——履歴から読み返し、再度開ける）。 */
export async function closeRealThread(threadId: string): Promise<void> {
  await request(`/api/threads/${threadId}/close`, { method: "POST" });
}

export async function reopenRealThread(threadId: string): Promise<void> {
  await request(`/api/threads/${threadId}/reopen`, { method: "POST" });
}

/** G3「人が消せる」——物理削除ではなく無効化イベントの追記（規則3）。 */
export async function appendRealMemory(threadId: string, text: string): Promise<void> {
  await request(`/api/threads/${threadId}/memory`, { method: "POST", body: JSON.stringify({ text }) });
}

export async function invalidateRealMemory(threadId: string, seq: number): Promise<void> {
  await request(`/api/threads/${threadId}/memory/${seq}/invalidate`, { method: "POST" });
}

/** Projectを終了する（削除ではない——履歴から読み返し、再度開ける）。 */
export async function closeRealProject(projectId: string): Promise<void> {
  await request(`/api/projects/${projectId}/close`, { method: "POST" });
}

export async function reopenRealProject(projectId: string): Promise<void> {
  await request(`/api/projects/${projectId}/reopen`, { method: "POST" });
}

export async function listRealInbox(): Promise<RealInboxItem[]> {
  return request<RealInboxItem[]>("/api/inbox");
}

export async function answerRealInboxItem(id: string, answer: unknown): Promise<void> {
  await request(`/api/inbox/${id}/answer`, { method: "POST", body: JSON.stringify({ answer }) });
}

export type RealTurnEvent =
  | { type: "message"; message: unknown }
  | { type: "judgment"; judgmentId: string; kind: "approval" | "elicitation"; toolName?: string; message: string }
  | { type: "done"; sessionId?: string; contextUsage?: unknown; compactionCount: number }
  | { type: "error"; message: string };

/**
 * ターンをSSEで受け取る。fetch()のReadableStreamを手で読む——ブラウザ標準の
 * EventSourceはPOST+bodyを送れないため使わない（apps/frontend/app.js、
 * Phase 0実測時に決めた方式をそのまま踏襲）。
 */
export async function* streamRealTurn(
  threadId: string,
  prompt: string,
  permissionMode?: string,
): AsyncGenerator<RealTurnEvent> {
  const config = requireConfig();
  const res = await fetch(`${config.baseUrl}/api/threads/${threadId}/messages`, {
    method: "POST",
    headers: { authorization: `Bearer ${config.token}`, "content-type": "application/json" },
    body: JSON.stringify({ prompt, permissionMode }),
  });
  if (!res.ok || !res.body) {
    yield { type: "error", message: `ターンの開始に失敗しました（${res.status}）` };
    return;
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const parts = buf.split("\n\n");
    buf = parts.pop() ?? "";
    for (const part of parts) {
      if (!part.startsWith("data: ")) continue;
      yield JSON.parse(part.slice(6)) as RealTurnEvent;
    }
  }
}

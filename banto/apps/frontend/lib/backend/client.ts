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
  /** 画面つき tool の呼び出し（§6.2、決定・2026-09-07）。リロードや別タブで
   *  Module の画面を出し直すのに使う。 */
  uiToolCalls?: RealUiToolCall[];
}

/** 画面つき tool の呼び出し1件（表示の復元に要る分だけ）。 */
export interface RealUiToolCall {
  toolCallId: string;
  toolName: string;
  server: string;
  resourceUri: string;
  args?: unknown;
  result?: unknown;
  /** どの面に出したか（決定・2026-09-07）。無い＝inline（記録が付く前のもの）。 */
  displayMode?: "inline" | "fullscreen";
}

export interface RealThreadMarker {
  seq: number;
  kind: "clear";
}

/** G1〜G3・G5——決定事項の記録。**持ち主はProject**（決定・2026-09-05）。
 *  invalidated:trueは無効化（物理削除ではない、規則3）。originThreadIdは
 *  どのThreadで決まったかの出所（人が直接足したときは無し）。 */
export interface RealProjectMemory {
  seq: number;
  text: string;
  invalidated: boolean;
  originThreadId?: string;
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
  /** 親の会話の**どこで分岐したか**（決定・2026-09-07）。Fork の入口を
   *  その場所に置くのに使う——Clear の横線と同じ物差し（seq）。 */
  createdSeq?: number;
  status: "active" | "closed";
  resumePoint?: string;
  messages: RealThreadMessage[];
  markers: RealThreadMarker[];
  usage: RealThreadUsage[];
  /** system promptに入れるMemoryの上限seq（§2.3）。これより後にProjectへ
   *  増えた分はターンに添えて届く——Threadは写しを持たない（規則3）。 */
  memoryBaselineSeq: number;
  /** 人がこのThreadで明示的に選んだpermissionMode。選んでいなければ無い
   *  ——その場合はConfigurationのカスケードから導く（規則3）。 */
  permissionMode?: MockPermissionModeValue;
  createdAt: string;
}

/** v4-frontend.md §6.4 の6値。hostの`ThreadPermissionMode`と同じ集合。 */
export type MockPermissionModeValue =
  | "default"
  | "acceptEdits"
  | "bypassPermissions"
  | "plan"
  | "dontAsk"
  | "auto";

/** 判断待ち（§2.4）。hostの`JudgmentItem`をそのまま受け取る——ここで形を
 *  作り替えない（規則3・規則12）。 */
export interface RealInboxJudgment {
  kind: "judgment";
  id: string;
  threadId: string;
  source: "elicitation" | "text" | "factory" | "alarm";
  message: string;
  /** Elicitationのform/urlモード（§2.4「自前で作らない」）。 */
  mode?: "form" | "url";
  requestedSchema?: unknown;
  url?: string;
  toolCallId?: string;
  /** 承認する tool の引数（approvalのみ）。何を承認するのかを画面に出すため
   *  （決定・2026-09-06、§6.0「サーバを呼ぶ前に人に見せる」）。 */
  toolInput?: unknown;
  /** どのサーバが聞いているか（§2.4.1 の MUST）。 */
  serverName?: string;
  liveness: "live" | "answered" | "timed_out";
  createdAt: string;
}

/** レビュー待ち。**生成元がまだ無い**——受信箱の画面では出さない（規則13）。 */
export interface RealInboxReview {
  kind: "review";
  id: string;
  threadId: string;
  summary: string;
  acknowledged: boolean;
  createdAt: string;
}

/** お知らせ（決定・2026-09-07）——許可/拒否を求めないが、人に伝えたいこと。
 *  最初の用途は「Module を繋げなかった」。 */
export interface RealInboxNotice {
  kind: "notice";
  id: string;
  /** 無い＝banto 全体（instance に1本の Module） */
  projectId?: string;
  dedupeKey: string;
  title: string;
  detail: string;
  acknowledged: boolean;
  createdAt: string;
}

export type RealInboxItem = RealInboxJudgment | RealInboxReview | RealInboxNotice;

export async function createRealProject(name: string, root: string): Promise<RealProject> {
  return request<RealProject>("/api/projects", { method: "POST", body: JSON.stringify({ name, root }) });
}

export async function listRealProjects(): Promise<RealProject[]> {
  return request<RealProject[]>("/api/projects");
}

/**
 * **Project を開いたら、その Project の Module を先に用意する**
 * （決定・2026-09-07、ユーザー）。返事は待たない——用意できたかは
 * 受信箱のお知らせに出る（繋がらなかったとき）。
 */
export async function prepareRealProjectModules(projectId: string): Promise<string[]> {
  const res = await request<{ connected: string[] }>(`/api/projects/${projectId}/modules/prepare`, {
    method: "POST",
  });
  return res.connected;
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
/** 人が選んだpermissionModeをhostに残す（決定・2026-09-06）——UI側だけに
 *  持つとリロードで消える。 */
export async function setRealThreadPermissionMode(
  threadId: string,
  mode: MockPermissionModeValue,
): Promise<void> {
  await request(`/api/threads/${threadId}/permission-mode`, {
    method: "POST",
    body: JSON.stringify({ mode }),
  });
}

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

export async function listRealMemory(projectId: string): Promise<RealProjectMemory[]> {
  return request<RealProjectMemory[]>(`/api/projects/${projectId}/memory`);
}

export async function appendRealMemory(projectId: string, text: string): Promise<void> {
  await request(`/api/projects/${projectId}/memory`, { method: "POST", body: JSON.stringify({ text }) });
}

/** G3「人が消せる」——物理削除ではなく無効化イベントの追記（規則3）。 */
export async function invalidateRealMemory(projectId: string, seq: number): Promise<void> {
  await request(`/api/projects/${projectId}/memory/${seq}/invalidate`, { method: "POST" });
}

/** Global Memory（§2.2、決定・2026-09-05）——banto全体で覚えていること。
 *  形はProject Memoryと同じ（同じ規律を別の置き場に適用しただけ）。 */
export async function listRealGlobalMemory(): Promise<RealProjectMemory[]> {
  return request<RealProjectMemory[]>("/api/global/memory");
}

export async function appendRealGlobalMemory(text: string): Promise<void> {
  await request("/api/global/memory", { method: "POST", body: JSON.stringify({ text }) });
}

export async function invalidateRealGlobalMemory(seq: number): Promise<void> {
  await request(`/api/global/memory/${seq}/invalidate`, { method: "POST" });
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

/** お知らせを「見た」ことにする（決定・2026-09-07）。 */
export async function acknowledgeRealNotice(id: string): Promise<void> {
  await request(`/api/inbox/${id}/acknowledge`, { method: "POST" });
}

export async function answerRealInboxItem(id: string, answer: unknown): Promise<void> {
  await request(`/api/inbox/${id}/answer`, { method: "POST", body: JSON.stringify({ answer }) });
}

export type RealTurnEvent =
  | { type: "message"; message: unknown }
  | {
      type: "judgment";
      judgmentId: string;
      kind: "approval" | "elicitation";
      toolName?: string;
      toolInput?: unknown;
      serverName?: string;
      message: string;
    }
  | { type: "done"; sessionId?: string; contextUsage?: unknown; compactionCount: number }
  | { type: "error"; message: string };

/**
 * ターンをSSEで受け取る。fetch()のReadableStreamを手で読む——ブラウザ標準の
 * EventSourceはPOST+bodyを送れないため使わない（apps/frontend/app.js、
 * Phase 0実測時に決めた方式をそのまま踏襲）。
 */
/**
 * ターンのSSEを読む。
 *
 * **読むのと、描くために渡すのを分ける**（改訂・2026-09-07、ユーザー報告が起点）。
 * 以前は「ジェネレータが `read()` する→yield する」を1本でやっていたため、
 * **描く側が最後まで引き取らないと、その先が読まれない**。実測すると
 * ランタイムは最後の yield のあと次を要求しないことがあり、その結果
 * **ターンの終了イベント（`done`）が一度も処理されなかった**
 * ——ターンが「走行中」のまま残り、文脈使用量も記録されない。
 *
 * いまは受信を**独立した繰り返し**で回し、届いた端から `onEvent` に渡しつつ、
 * 描画用には順番に取り出せるようにしてある。**描く側の都合で受信が止まらない。**
 */
export function streamRealTurn(
  threadId: string,
  prompt: string,
  permissionMode?: string,
  onEvent?: (event: RealTurnEvent) => void,
): AsyncGenerator<RealTurnEvent> {
  const queue: RealTurnEvent[] = [];
  let wake: (() => void) | null = null;
  let finished = false;

  const push = (event: RealTurnEvent): void => {
    onEvent?.(event);
    queue.push(event);
    wake?.();
    wake = null;
  };

  const pump = async (): Promise<void> => {
    const config = requireConfig();
    const res = await fetch(`${config.baseUrl}/api/threads/${threadId}/messages`, {
      method: "POST",
      headers: { authorization: `Bearer ${config.token}`, "content-type": "application/json" },
      body: JSON.stringify({ prompt, permissionMode }),
    });
    if (!res.ok || !res.body) {
      push({ type: "error", message: `ターンの開始に失敗しました（${res.status}）` });
      return;
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const parts = buf.split("\n\n");
      buf = parts.pop() ?? "";
      for (const part of parts) {
        if (!part.startsWith("data: ")) continue;
        push(JSON.parse(part.slice(6)) as RealTurnEvent);
      }
    }
  };

  void pump()
    .catch((err: unknown) => {
      // **黙って終わらせない**（規則2）——読めなくなったことを描く側に伝える
      push({ type: "error", message: err instanceof Error ? err.message : String(err) });
    })
    .finally(() => {
      finished = true;
      wake?.();
      wake = null;
    });

  async function* drain(): AsyncGenerator<RealTurnEvent> {
    for (;;) {
      const next = queue.shift();
      if (next !== undefined) {
        yield next;
        continue;
      }
      if (finished) return;
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
    }
  }

  return drain();
}

// ---- Module の画面（MCP Apps、決定・2026-09-06、§6.2）----------------------
//
// banto は「どこに出すか」だけを決め、**中身は Module 発**。ここは
// その中身を host 越しに取ってくるだけの薄い経路。

/** どの tool が画面を持つか（`_meta.ui.resourceUri`）。 */
export interface RealUiTool {
  server: string;
  tool: string;
  resourceUri: string;
}

/** Module が申告した画面。CSP はサンドボックスの口へそのまま渡す。 */
export interface RealUiResource {
  html: string;
  csp?: unknown;
  permissions?: unknown;
  prefersBorder?: boolean;
}

export async function fetchRealUiConfig(): Promise<{ sandboxUrl: string | null }> {
  return request<{ sandboxUrl: string | null }>("/api/ui-config");
}

export async function listRealUiTools(threadId: string): Promise<RealUiTool[]> {
  return request<RealUiTool[]>(`/api/threads/${threadId}/ui-tools`);
}

/** その画面が誰のものか。会話の中なら Thread、設定画面なら Project
 *  （設定は Thread のものではない、決定・2026-09-07）。 */
export type RealCanvasOwner =
  | { kind: "thread"; id: string }
  | { kind: "project"; id: string }
  /** banto 全体（instance に1本の Module の設定、決定・2026-09-07）。 */
  | { kind: "instance" };

function ownerPath(owner: RealCanvasOwner): string {
  if (owner.kind === "thread") return `/api/threads/${owner.id}`;
  if (owner.kind === "project") return `/api/projects/${owner.id}`;
  return "/api";
}

export async function fetchRealUiResource(
  owner: RealCanvasOwner,
  server: string,
  uri: string,
): Promise<RealUiResource> {
  return request<RealUiResource>(
    `${ownerPath(owner)}/ui-resource?server=${encodeURIComponent(server)}&uri=${encodeURIComponent(uri)}`,
  );
}

/**
 * 記録から、その tool 呼び出し1件を引く（決定・2026-09-07、ユーザー報告）。
 *
 * **別タブは手元の記憶を持たない**——同じ画面を別タブで開くには、どの Module の
 * どの画面を、どんな引数で呼んで何が返ったかを**host の記録から**取り直す
 * （真実は host、規則3）。
 */
export async function fetchRealUiToolCall(
  threadId: string,
  toolCallId: string,
): Promise<RealUiToolCall | undefined> {
  const thread = await getRealThread(threadId);
  for (const message of thread.messages ?? []) {
    const found = message.uiToolCalls?.find((c) => c.toolCallId === toolCallId);
    if (found) return found;
  }
  return undefined;
}

/**
 * **どの面に出したか**を host に残す（決定・2026-09-07、ユーザー指摘）。
 *
 * 決めるのは Module の画面（`ui/request-display-mode`）。残さないと、
 * リロード後に「inline は埋め直す・fullscreen は入口だけ残す」の区別ができず、
 * 復元した画面がまた「大きく出して」と言って**毎回勝手に開く**。
 */
export async function recordRealUiDisplayMode(
  threadId: string,
  toolCallId: string,
  displayMode: "inline" | "fullscreen",
): Promise<void> {
  const config = requireConfig();
  const res = await fetch(
    `${config.baseUrl}/api/threads/${threadId}/ui-tool-calls/${encodeURIComponent(toolCallId)}/display-mode`,
    {
      method: "POST",
      headers: { authorization: `Bearer ${config.token}`, "content-type": "application/json" },
      body: JSON.stringify({ displayMode }),
    },
  );
  if (!res.ok) throw new Error(`表示の記録に失敗しました（${res.status}）`);
}

/** 人が直接開ける入口（launcher、§6.2）。名前と説明は Module が名乗ったもの。 */
export interface RealUiLauncher {
  server: string;
  resourceUri: string;
  name?: string;
  description?: string;
}

/**
 * その Project に**繋がっている Module の入口**だけ。
 * 一覧は host が Module 集合から導出する——画面は別の索引を持たない（規則3）。
 */
export async function listRealLaunchers(projectId: string): Promise<RealUiLauncher[]> {
  return request<RealUiLauncher[]>(`/api/projects/${projectId}/ui-launchers`);
}

/**
 * その相手の Module が名乗っている**設定 Canvas**の一覧。
 *
 * **どちらに出るかは Module の scope が決まる**（決定・2026-09-07、ユーザー指摘）
 * ——instance に1本の Module（Vault 等）は banto 全体の設定に、Project ごとに
 * 立つもの（Shell・FileSystem）は Project の設定に出る。
 */
export async function listRealUiSettings(
  owner: RealCanvasOwner,
): Promise<Array<{ server: string; resourceUri: string; name?: string }>> {
  return request<Array<{ server: string; resourceUri: string; name?: string }>>(
    `${ownerPath(owner)}/ui-settings`,
  );
}

/** **画面からの tool 呼び出し**。host 側で必ず承認ゲートを通る——
 *  返ってくるまでの間、人は受信箱で承認を求められている（§6.2 の決定）。 */
export async function callRealUiTool(
  owner: RealCanvasOwner,
  server: string,
  tool: string,
  args: Record<string, unknown> | undefined,
): Promise<unknown> {
  return request<unknown>(`${ownerPath(owner)}/ui-tool-call`, {
    method: "POST",
    body: JSON.stringify({ server, tool, arguments: args }),
  });
}

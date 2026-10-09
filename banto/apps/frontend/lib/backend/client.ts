// banto host（packages/core、実HTTP+SSE API）への薄いクライアント。
// mock/のスクリプト付きデモデータ（lib/mock/*）はそのまま残す——ここは
// 「実Projectを作ったときだけ」通る経路（決定・2026-09-03、モックは
// 動画撮影用の既存資産としてそのまま動かし続ける、壊さない）。
//
// **人はセッションの Cookie で入る**（決定・2026-10-03、`docs/specs/v4-security.md`「人のログイン」）。
// 画面は合言葉（Bearer）を持たない——Cookie は HttpOnly で、画面の JavaScript からは読めない。
// 画面が付けるのは独自のヘッダ `X-Banto-Client: 1` だけ（兄弟のサブドメインからの要求を host が見分ける印）。
//
// API の基点：本番は**画面と同じオリジン**（Caddy が `/api/*` を host へ回す）に固定する。URL の `bantoHost` は
// **localhost・127.0.0.1 でだけ**読む（開発・E2E で画面と host のポートが違うとき）——本番で読むと、公開先の
// ページが `?bantoHost=<自分>` へ飛ばして画面の接続先をすり替えられる（Fable のレビュー高2）。

const STORAGE_KEY = "banto.backend";
import type { RealTurnSummary } from "@/lib/turn-summary";

export const CLIENT_HEADER = "x-banto-client";
/** 画面からの要求に必ず付けるもの */
export const CLIENT_HEADERS: Record<string, string> = { [CLIENT_HEADER]: "1" };

export interface BackendConfig {
  baseUrl: string;
}

function isLoopback(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]" || hostname.endsWith(".localhost");
}

/** API の基点。http（安全でない文脈）では null——画面は ConnectGate が「HTTPS で開いてください」に止める */
export function getBackendConfig(): BackendConfig | null {
  if (typeof window === "undefined") return null;
  if (!window.isSecureContext) return null;
  const { hostname, protocol, origin } = window.location;
  if (!isLoopback(hostname)) {
    // 前の版が覚えた合言葉（`{ baseUrl, token }`）が残っていれば消す——もう使わない
    if (window.localStorage.getItem(STORAGE_KEY) !== null) window.localStorage.removeItem(STORAGE_KEY);
    return { baseUrl: origin };
  }
  const hostFromUrl = new URLSearchParams(window.location.search).get("bantoHost");
  if (hostFromUrl) {
    const config: BackendConfig = { baseUrl: hostFromUrl.replace(/\/$/, "") };
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
    return config;
  }
  const raw = window.localStorage.getItem(STORAGE_KEY);
  if (raw) {
    try {
      const stored = JSON.parse(raw) as { baseUrl?: unknown };
      if (typeof stored.baseUrl === "string") return { baseUrl: stored.baseUrl };
    } catch {
      // 読めなければ既定へ
    }
  }
  return { baseUrl: `${protocol}//${hostname}:4737` };
}

function requireConfig(): BackendConfig {
  const config = getBackendConfig();
  if (!config) throw new Error("banto の画面は HTTPS で開いてください");
  return config;
}

/**
 * **画面から host への fetch はすべてここを通す**——独自のヘッダと Cookie を付け、401（ログインが切れた・
 * 締め出された）なら門に知らせる。
 */
export async function hostFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const config = requireConfig();
  const res = await fetch(`${config.baseUrl}${path}`, {
    ...init,
    credentials: "include",
    headers: { ...CLIENT_HEADERS, ...(init.headers as Record<string, string> | undefined) },
  });
  if (res.status === 401 && !path.startsWith("/api/auth/")) notifyUnauthorized();
  return res;
}

const UNAUTHORIZED_EVENT = "banto:unauthorized";
function notifyUnauthorized(): void {
  window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
}
/** ログインが切れたとき（401）に呼ばれる。門が自分を出し直すのに使う */
export function onUnauthorized(listener: () => void): () => void {
  window.addEventListener(UNAUTHORIZED_EVENT, listener);
  return () => window.removeEventListener(UNAUTHORIZED_EVENT, listener);
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await hostFetch(path, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(init?.headers as Record<string, string> | undefined),
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    // **host が理由を書いていたら、それをそのまま人に出す**（改訂・2026-09-22、
    // 実機で発覚）。以前は `banto host /api/… が 400 を返しました: {"error":"…"}`
    // と**内部の経路と JSON がそのまま画面に出ていた**——人が読むのは
    // 「繋ぎ方が書かれていません」のほうで、口の名前と状態番号ではない（規則2）。
    // 理由が無いときだけ、何が起きたかを言うために口と番号を出す
    let reason = "";
    try {
      const body = JSON.parse(text) as { error?: unknown };
      if (typeof body.error === "string" && body.error.trim() !== "") reason = body.error;
    } catch {
      // JSON でないなら、本文をそのまま手がかりにする
      reason = text.trim();
    }
    throw new Error(reason || `banto host ${path} が ${res.status} を返しました`);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export interface RealProject {
  id: string;
  name: string;
  root: string;
  status: "active" | "closed";
  /** 承認なしでメッセージを受け取ってよい Project の id（追加・2026-10-01、アーキ仕様 §4.2）。無ければ空 */
  acceptMessagesFrom?: string[];
  createdAt: string;
}

export interface RealThreadMessage {
  seq: number;
  role: "user" | "assistant";
  text: string;
  /** 画面つき tool の呼び出し（§6.2、決定・2026-09-07）。リロードや別タブで
   *  Module の画面を出し直すのに使う。 */
  uiToolCalls?: RealUiToolCall[];
  /** **機械から届いたもの**の印（決定・2026-09-25、アーキ仕様 §4.2）。**無ければ人の発言** */
  origin?: RealMessageOrigin;
  /** 人が添えた画像（決定・2026-09-26）。中身は `GET /api/images/:id` で取る */
  images?: RealMessageImage[];
  /**
   * そのターンで出た中継の承認のカード（追加・2026-10-05）。host が記録の id に受信箱の中身を添えて返す——会話を記録から
   * 組み直しても（止めた・開き直した）カードが残る
   */
  judgments?: RealJudgmentCard[];
  /** ターンの終わりのまとめ（追加・2026-10-06、v4-frontend.md §6.35）。そのターンの最後の `report_turn` */
  turnSummary?: RealTurnSummary;
}

/** 会話に残す中継の承認のカード1枚（宛名と答えだけ。値は載らない、アーキ仕様 §2.5） */
export interface RealJudgmentCard {
  id: string;
  message: string;
  serverName?: string;
  toolInput?: unknown;
  liveness: "live" | "answered" | "timed_out";
  /** 答え（会話のカードに「回答：…」と出す一言）。答えが付いていなければ無い */
  answer?: string;
}

/** 発言に添えた画像1枚——名前は中身の SHA-256 */
export interface RealMessageImage {
  id: string;
  name?: string;
}

/** 送る発言に添える画像1枚（base64）。形式は host が中身から決める */
export interface OutgoingImage {
  data: string;
  name?: string;
}

/** 届いたものの印——送り手・題・何回中継されたか */
export interface RealMessageOrigin {
  from: string;
  title: string;
  hop: number;
  deliveryId: string;
  /** 別の Thread の AI が送ったものの送り元（追加・2026-10-01、アーキ仕様 §4.2）。Module が届けたものには無い */
  sender?: { projectId: string; projectName: string; threadId: string; threadLabel: string };
}

/** 画面つき tool の呼び出し1件（表示の復元に要る分だけ）。 */
export interface RealUiToolCall {
  toolCallId: string;
  toolName: string;
  server: string;
  resourceUri: string;
  /** 会話にはカードだけを置く（決定・2026-10-01） */
  card?: RealToolCard;
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
 *  受け取る（規則12「そのまま使う」）——ここで構造を解釈・加工しない。
 *  **`GET /api/threads/:id` が返すのは最新の1件だけ**（改訂・2026-09-26）——
 *  画面が読むのはメーターの最新値だけで、履歴が応答の 90% を占めていた。 */
export interface RealThreadUsage {
  seq: number;
  contextUsage: unknown;
  compactionCount: number;
}

export interface RealThread {
  id: string;
  projectId: string;
  kind: "base" | "fork";
  /** 人が付けた名前（決定・2026-09-11）。付けていなければ無い——連番は画面が出す */
  title?: string;
  parentThreadId?: string;
  /** 親の会話の**どこで分岐したか**（決定・2026-09-07）。Fork の入口を
   *  その場所に置くのに使う——Clear の横線と同じ物差し（seq）。 */
  createdSeq?: number;
  /** 過去のメッセージから分けたなら、その seq（決定・2026-09-11）。 */
  forkedFromSeq?: number;
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
  /** 人がこの Thread で選んだモデルと effort（決定・2026-09-23）。選んでいなければ無い
   *  ——CLI の既定で走る */
  model?: string;
  effort?: RealEffort;
  /** セッションごとに効かせた Skill（決定・2026-09-23、アーキ仕様 §5.7）。
   *  最後の1件がいまのセッションのもの。この仕組みより前の会話には無い。 */
  skillSets?: { seq: number; set: RealSessionSkillSet }[];
  /** 最後のターンの始まり（追加・2026-10-05、host の `lastTurn` の一部）。流し直すターンとの境界を引くのに使う */
  lastTurn?: { startedSeq: number };
  createdAt: string;
}

/** 会話の始まりで固定した Skill の集合（host の `SessionSkillSet` と同じ形）。 */
export interface RealSessionSkillSet {
  active: { module: string; name: string; description: string; uri: string }[];
  /** 効かせていない Skill **も**配っている Module */
  othersIn: string[];
  problems: { module: string; message: string }[];
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
  /** `relay`＝Module 間中継の初回承認（host 自身が発生源、§「Module 間中継の承認」）。 */
  source: "elicitation" | "text" | "factory" | "alarm" | "relay" | "message";
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
  /** 答えの選択肢（host は 2026-10-01 から持っている）。無ければ「許可する／拒否する」 */
  choices?: string[];
  liveness: "live" | "answered" | "timed_out";
  createdAt: string;
}

/** レビュー待ち——**ターンが終わった**（決定・2026-09-27）。見れば消える */
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
  /**
   * **「続ける」を押せる**（追加・2026-10-05、アーキ仕様 §2.5「上限」）。起こし直しのたびに切れるので host が自動で
   * 続けるのをやめたターン。押すと `resumeRealNoticeTurn`
   */
  resume?: { threadId: string; turnId: string };
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

/**
 * **一覧は要約だけ**（改訂・2026-09-07、実測）。会話の中身は入っていない
 * ——起動時に開いてもいない Project の全会話まで受け取っていた
 * （API 転送 2.88MB のうち 2.875MB がこれ）。中身は開いたときに
 * `getRealThread` で取る。
 */
/** Thread を閉じたのは AI（`close_fork`）か人（画面）か（host の `ThreadClosedBy`、追加・2026-10-08） */
export type RealThreadClosedBy = "ai" | "human";

export interface RealThreadSummary {
  id: string;
  projectId: string;
  kind: "base" | "fork";
  /** 人が付けた名前（決定・2026-09-11）。付けていなければ無い——既定の呼び名は
   *  その Project の中の連番から出す（規則3）。 */
  title?: string;
  parentThreadId?: string;
  createdSeq?: number;
  /** 親の会話の**どのメッセージから**分けたか（決定・2026-09-11）。
   *  「この Fork を開く」をその場所に置くのに使う。 */
  forkedFromSeq?: number;
  status: "active" | "closed";
  /** 誰が閉じたか・理由（追加・2026-10-08）。閉じている間だけ。これより前に閉じた記録には無い */
  closedBy?: RealThreadClosedBy;
  closedReason?: string;
  permissionMode?: MockPermissionModeValue;
  model?: string;
  effort?: RealEffort;
  createdAt: string;
  /** 閉じた Thread の概要に使う（AI 要約はしない——数えられるものだけ）。 */
  messageCount: number;
  firstMessage: string | null;
  lastMessage: string | null;
}

export async function listRealThreads(projectId: string): Promise<RealThreadSummary[]> {
  return request<RealThreadSummary[]>(`/api/projects/${projectId}/threads`);
}

export async function createRealBaseThread(projectId: string): Promise<RealThread> {
  return request<RealThread>(`/api/projects/${projectId}/threads`, { method: "POST" });
}

export async function getRealThread(threadId: string): Promise<RealThread> {
  return request<RealThread>(`/api/threads/${threadId}`);
}

/** Fork Threadを立てる——新しい枝として親の現在のresume-pointを引き継ぐ
 *  （v4-architecture.md §2.2、host側`forkThread`の既定）。 */
/**
 * 枝を分ける。**過去のメッセージの時点からも分けられる**（決定・2026-09-11、
 * ユーザー要望）——`fromSeq` はそのメッセージの seq。渡さなければ「いまの続き」から。
 */
export async function createRealFork(
  parentThreadId: string,
  options: {
    fromSeq?: number;
    /** 人がダイアログで付けた名前（決定・2026-10-02、v4-frontend.md §6.32）。空なら連番のまま */
    title?: string;
    /** 「まっさらで始める」——会話を引き継がない Fork（§6.32）。fromSeq とは一緒に渡せない */
    fresh?: boolean;
  } = {},
): Promise<RealThread> {
  const body: Record<string, unknown> = {};
  if (options.fromSeq !== undefined) body.fromSeq = options.fromSeq;
  if (options.title) body.title = options.title;
  if (options.fresh) body.fresh = true;
  return request<RealThread>(`/api/threads/${parentThreadId}/fork`, {
    method: "POST",
    body: JSON.stringify(body),
  });
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

/** reasoning effort の段（Claude Agent SDK の `effort`）。 */
export type RealEffort = "low" | "medium" | "high" | "xhigh" | "max";

/** 選べるモデル1件（host が CLI に聞いたもの、決定・2026-09-23）。 */
export interface RealModelChoice {
  /** SDK に渡す値。`default` は「選んでいない」＝ CLI の既定 */
  value: string;
  displayName: string;
  description: string;
  /** このモデルで選べる effort の段（空なら選べない） */
  efforts: RealEffort[];
}

export async function listRealModels(): Promise<RealModelChoice[]> {
  return (await request<{ models: RealModelChoice[] }>("/api/models")).models;
}

/** 人がこの Thread で選んだモデルと effort を host に残す。null は既定に戻す。 */
export async function setRealThreadModel(
  threadId: string,
  model: string | null,
  effort: RealEffort | null,
): Promise<void> {
  await request(`/api/threads/${threadId}/model`, {
    method: "POST",
    body: JSON.stringify({ model, effort }),
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

/**
 * **その根を選ぶと、何が見えるようになるか**（決定・2026-09-11、ユーザー）。
 * 広い根（home 等）を選ぶこと自体は止めない——**選ぶ前に見せる**。
 * 判断は host が持つ（画面は home の場所を推測しない、規則3）。
 */
export interface RealRootScope {
  wide: boolean;
  /** 広いとき、その中に入ってしまうもの（人に見せる言葉） */
  includes: string[];
}

/**
 * **フォルダを選ぶための一覧**（決定・2026-09-11、ユーザー要望）。
 * 返るのはフォルダの名前だけ——人が Root を選ぶための窓。
 */
export interface RealDirectoryListing {
  path: string;
  parent?: string;
  entries: Array<{ name: string; path: string }>;
}

export async function listRealDirectories(path?: string): Promise<RealDirectoryListing> {
  const query = path ? `?path=${encodeURIComponent(path)}` : "";
  return request<RealDirectoryListing>(`/api/fs/directories${query}`);
}

export async function fetchRealRootScope(path: string): Promise<RealRootScope> {
  return request<RealRootScope>(`/api/config/root-scope?path=${encodeURIComponent(path)}`);
}

/**
 * **この Project で使う Module**（`phase1-project-modules-ui`、2026-09-11）。
 * 宣言は banto 全体の既定なので、1本足すと全 Project に繋がる
 * ——増やす前に、Project ごとに選べるようにする（Phase 2 の入口）。
 */
export interface RealProjectModule {
  name: string;
  /** この Project で使うか */
  selected: boolean;
  /** その Module が名乗る役割（`satisfies`） */
  satisfies: string[];
  dependsOn: { role: string; required: boolean }[];
  /** banto 全体で1本か、Project ごとに1本か */
  scope: "instance" | "project";
  /** Project の根に閉じ込めて起動する */
  confinement?: { kind: string; root: string };
  /** どこで動くか（host が宣言から導いた値。`docs/specs/v4-security.md` §1） */
  placement: ModulePlacement;
}

/** Module がどこで動くか（host の `modulePlacement` と同じ語） */
export type ModulePlacement = "project-container" | "instance-container" | "host" | "remote";

export async function listRealProjectModules(projectId: string): Promise<RealProjectModule[]> {
  return request<RealProjectModule[]>(`/api/projects/${projectId}/modules`);
}

/** **まとめて保存する**——画面の下書きを確定するときに一度だけ（§6.15）。 */
export async function setRealProjectModules(projectId: string, names: string[]): Promise<void> {
  await request(`/api/projects/${projectId}/modules`, {
    method: "PUT",
    body: JSON.stringify({ names }),
  });
}

/**
 * **配られている Skill と、効かせるかどうか**（決定・2026-09-23、アーキ仕様 §5.7）。
 * `instance`・`project` はその層に書かれた値（書かれていなければ `null`）、
 * `enabled` はカスケードした結果。
 */
export interface RealSkill {
  module: string;
  name: string;
  description: string;
  uri: string;
  instance: boolean | null;
  project: boolean | null;
  enabled: boolean;
}

export interface RealSkillListing {
  skills: RealSkill[];
  problems: { module: string; message: string }[];
}

/** `projectId` を渡せばその Project の層、渡さなければ banto 全体の層。 */
export async function listRealSkills(projectId?: string): Promise<RealSkillListing> {
  return request<RealSkillListing>(`/api/skills${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ""}`);
}

/**
 * **この会話で効いている Skill**（決定・2026-09-23、§5.7）。会話の始まりで固定した集合と、
 * `instructions` の中でそれぞれが占める文字数（メーターが SDK の値を按分するのに使う）。
 */
export interface RealThreadSkills {
  set: RealSessionSkillSet | null;
  fixedAtSeq: number | null;
  footprint: { totalChars: number; skills: { module: string; name: string; chars: number }[] };
}

export async function getRealThreadSkills(threadId: string): Promise<RealThreadSkills> {
  return request<RealThreadSkills>(`/api/threads/${threadId}/skills`);
}

/**
 * **Shell 専用のホームに写すもの**（決定・2026-09-23、ユーザー）。人のホームからの相対パス。
 * `lastSync` は最後に写したときの結果（Shell がまだ1本も立っていなければ `null`）。
 */
export interface RealShellHomeSync {
  copied: string[];
  missing: string[];
  removedGitKeys: string[];
  rewrittenGitKeys: string[];
}

export interface RealShellHome {
  files: string[];
  defaults?: string[];
  lastSync: RealShellHomeSync | null;
}

export async function getRealShellHome(): Promise<RealShellHome> {
  return request<RealShellHome>("/api/shell-home");
}

export async function setRealShellHomeFiles(files: string[]): Promise<RealShellHome> {
  return request<RealShellHome>("/api/shell-home", { method: "PUT", body: JSON.stringify({ files }) });
}

/** `enabled: null` は Project の上書きを消す（全体の既定に戻す）。 */
export async function setRealSkillEnabled(input: {
  module: string;
  name: string;
  projectId?: string;
  enabled: boolean | null;
}): Promise<void> {
  await request(`/api/skills/enabled`, { method: "PUT", body: JSON.stringify(input) });
}

// **名前と並び順**（決定・2026-09-11、ユーザー要望）。どちらも人の意図なので
// host が持つ——ブラウザの覚えにすると、別の端末で開いたときに元へ戻る（規則3）。

/**
 * **承認なしでメッセージを受け取ってよい Project の一覧を置き換える**（決定・2026-10-01、アーキ仕様 §4.2）。足すのは
 * Project をまたぐ送信の承認画面の「以後聞かない」、ここは人が外すのに使う
 */
export async function setRealMessageSenders(projectId: string, senders: string[]): Promise<RealProject> {
  return request<RealProject>(`/api/projects/${projectId}/message-senders`, {
    method: "PUT",
    body: JSON.stringify({ senders }),
  });
}

export async function renameRealProject(projectId: string, name: string): Promise<void> {
  await request(`/api/projects/${projectId}`, { method: "PATCH", body: JSON.stringify({ name }) });
}

/**
 * **名前と根をまとめて直す**（決定・2026-09-11、ユーザー要望）。根は閉じ込めの
 * 範囲そのものなので、変えると host がその Project の Module を落とす
 * （次に要るときに新しい根で立ち上がる）。
 */
/**
 * **この Project のコンテナ**（決定・2026-09-25、`docs/specs/v4-security.md` §1）。この Project の Module と
 * AI のコマンドはここで動く。`nesting` は中で Docker を使うか
 */
export interface RealProjectContainer {
  nesting: boolean;
  /** まだ一度も Module を起こしていなければ null（最初に要るときに作る） */
  container: { name: string; status: string } | null;
  /** 資源の上限（2026-10-02）。host がコンテナを使っていなければ null */
  limits: RealContainerLimits | null;
}

/** 資源の上限の数（メモリ MiB・CPU コア数・プロセス数） */
export interface RealLimitNumbers {
  memoryMiB: number;
  cpus: number;
  processes: number;
}
export interface RealContainerLimitPolicy {
  hostReserveMemoryMiB: number;
  hostReserveCpus: number;
  processes: number;
}
/** host が計算した上限（`packages/core/src/container-limits.ts` の ContainerLimitsView） */
export interface RealContainerLimits {
  host: { memoryMiB: number; cpus: number };
  policy: RealContainerLimitPolicy;
  defaults: RealContainerLimitPolicy;
  ceiling: RealLimitNumbers;
  override?: Partial<RealLimitNumbers>;
  effective?: RealLimitNumbers;
}

/**
 * **資源**（決定・2026-10-09、v4-frontend.md §6.36）。host が 10 秒ごとに測った最新。まだ測っていなければ null。
 * 形は host の `resources.ts` の `ResourcesSnapshot` と同じ
 */
export interface RealResourceConsumer {
  name: string;
  detail?: string;
  bytes: number;
}
export interface RealResourceGroup {
  id: "modules" | "work" | "commands" | "services" | "nested" | "other";
  label: string;
  items: RealResourceConsumer[];
}
export interface RealResourceWaiting {
  cpu: number;
  memory: number;
  io: number;
}
export interface RealProjectResources {
  projectId: string;
  name: string;
  containerName: string;
  busy: boolean;
  busyReason?: string;
  usedBytes: number;
  cacheBytes: number;
  limitBytes?: number;
  cpuLimit?: number;
  cpuUsed?: number;
  waiting: RealResourceWaiting;
  processes: number;
  processLimit?: number;
  groups: RealResourceGroup[];
  hits: Array<{ at: string; what: string }>;
}
export interface RealResourcesSnapshot {
  measuredAt: string;
  host: {
    busy: boolean;
    busyReason?: string;
    totalBytes?: number;
    availableBytes?: number;
    cores: number;
    waiting: RealResourceWaiting;
    memory: Array<{ id: string; label: string; bytes: number; projectId?: string }>;
    stalls: Array<{ at: string; seconds: number }>;
  };
  projects: RealProjectResources[];
}

export async function fetchRealResources(): Promise<RealResourcesSnapshot | null> {
  return request<RealResourcesSnapshot | null>("/api/admin/resources");
}

export async function fetchRealContainerLimits(): Promise<RealContainerLimits> {
  return request<RealContainerLimits>("/api/container-limits");
}

/** banto 全体：host に何を残すか。動いているコンテナにも、起こし直さずに効く */
export async function setRealContainerLimitPolicy(policy: RealContainerLimitPolicy): Promise<RealContainerLimits> {
  return request<RealContainerLimits>("/api/container-limits", { method: "PUT", body: JSON.stringify(policy) });
}

/** Project ごとの上限（banto 全体の上限より下げることだけできる）。null は banto 全体のまま */
export async function setRealProjectContainerLimits(
  projectId: string,
  limits: { memoryMiB: number | null; cpus: number | null; processes: number | null },
): Promise<RealContainerLimits> {
  return request<RealContainerLimits>(`/api/projects/${projectId}/container/limits`, {
    method: "PUT",
    body: JSON.stringify(limits),
  });
}

export async function fetchRealProjectContainer(projectId: string): Promise<RealProjectContainer> {
  return request<RealProjectContainer>(`/api/projects/${projectId}/container`);
}

/** 中で Docker を使うかを変える。この Project の Module は立て直しになる（host が落とし、次に要るときに起こす） */
export async function setRealProjectContainerNesting(projectId: string, nesting: boolean): Promise<void> {
  await request(`/api/projects/${projectId}/container`, { method: "PUT", body: JSON.stringify({ nesting }) });
}

/**
 * **承認をすべて自動で許可する**（決定・2026-10-05、ユーザー。v4-frontend.md §6.4「承認をすべて自動で許可する」）。
 * Project にだけ置ける。読み書きの答えは host がいま持っている値
 */
export async function fetchRealAutoApproveAll(projectId: string): Promise<boolean> {
  return (await request<{ enabled: boolean }>(`/api/projects/${projectId}/auto-approve`)).enabled;
}

export async function setRealAutoApproveAll(projectId: string, enabled: boolean): Promise<boolean> {
  return (
    await request<{ enabled: boolean }>(`/api/projects/${projectId}/auto-approve`, {
      method: "PUT",
      body: JSON.stringify({ enabled }),
    })
  ).enabled;
}

/**
 * **ターンの終わりのまとめ**（決定・2026-10-06、ユーザー。v4-frontend.md §6.35）。Project にだけ置ける、既定はオフ
 */
export async function fetchRealTurnSummary(projectId: string): Promise<boolean> {
  return (await request<{ enabled: boolean }>(`/api/projects/${projectId}/turn-summary`)).enabled;
}

export async function setRealTurnSummary(projectId: string, enabled: boolean): Promise<boolean> {
  return (
    await request<{ enabled: boolean }>(`/api/projects/${projectId}/turn-summary`, {
      method: "PUT",
      body: JSON.stringify({ enabled }),
    })
  ).enabled;
}

/**
 * **この Project に Claude のログインを使わせる**（決定・2026-09-27、ユーザー。`docs/specs/v4-security.md` §2）。既定はオン。
 * 真実は host（`packages/core/src/claude-login/relay.ts`）。観測（回数・最終時刻・直近の 401）は banto を起こしてからの分
 */
export interface RealClaudeLogin {
  enabled: boolean;
  hostLogin: { loggedIn: true; subscriptionType?: string; rateLimitTier?: string } | { loggedIn: false; reason: string };
  stats: { requests: number; lastRequestAt?: string; lastUnauthorizedAt?: string };
}

export async function fetchRealClaudeLogin(projectId: string): Promise<RealClaudeLogin> {
  return request<RealClaudeLogin>(`/api/projects/${projectId}/claude-login`);
}

export async function setRealClaudeLogin(projectId: string, enabled: boolean): Promise<RealClaudeLogin> {
  return request<RealClaudeLogin>(`/api/projects/${projectId}/claude-login`, { method: "PUT", body: JSON.stringify({ enabled }) });
}

export async function updateRealProjectSettings(
  projectId: string,
  patch: { name?: string; root?: string },
): Promise<RealProject> {
  return request<RealProject>(`/api/projects/${projectId}`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
}

export async function renameRealThread(threadId: string, title: string): Promise<void> {
  await request(`/api/threads/${threadId}`, { method: "PATCH", body: JSON.stringify({ title }) });
}

/** Project の並び。**順番そのものを1件で送る**（要素ごとの番号は持たない）。 */
export async function setRealProjectOrder(ids: string[]): Promise<void> {
  await request("/api/projects/order", { method: "PUT", body: JSON.stringify({ ids }) });
}

/** その Project の Fork の並び。 */
export async function setRealForkOrder(projectId: string, ids: string[]): Promise<void> {
  await request(`/api/projects/${projectId}/fork-order`, {
    method: "PUT",
    body: JSON.stringify({ ids }),
  });
}

export async function listRealInbox(): Promise<RealInboxItem[]> {
  return request<RealInboxItem[]>("/api/inbox");
}

/** お知らせ・レビュー待ちを「見た」ことにする（決定・2026-09-07、レビュー待ちは 2026-09-27）。 */
export async function acknowledgeRealNotice(id: string): Promise<void> {
  await request(`/api/inbox/${id}/acknowledge`, { method: "POST" });
}

/** 自動で続けるのをやめたターンを続けてもらう（お知らせの「続ける」）。続けられなければ理由を投げる */
export async function resumeRealNoticeTurn(id: string): Promise<void> {
  await request(`/api/inbox/${id}/resume`, { method: "POST" });
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
      /** 答えの選択肢（追加・2026-10-01）。無ければ「許可する／拒否する」 */
      choices?: string[];
    }
  /** 判断待ちに答えがついた（どこで答えても流れに載る——決定・2026-09-26）。`answer` は画面に出す言葉 */
  | { type: "answered"; judgmentId: string; answer: string }
  | { type: "done"; sessionId?: string; contextUsage?: unknown; compactionCount: number }
  | { type: "error"; message: string }
  /**
   * **人が止めた**（追加・2026-10-01、v4-frontend.md §6.31）。ターンの終わり。`withdrawn` があれば、AI がまだ何も出して
   * いなかったので host が発言ごと取り消した（記録にも残らない）
   */
  | { type: "stopped"; withdrawn?: RealWithdrawnMessage }
  /**
   * **流れが切れた**（画面の側の出来事。host は送ってこない——決定・2026-09-26）。携帯で別アプリへ移った・
   * 回線が変わった等。ターンが失敗したのではないので、人にエラーとしては見せず、記録から最新を取り直す
   */
  | { type: "disconnected"; message: string };

/** host が取り消した発言。画像は置き場の名前だけ（`fetchRealImageUrl` で取れる） */
export interface RealWithdrawnMessage {
  text: string;
  images: RealMessageImage[];
}

/** 止めた結果。`stopped: false` はそのとき止めるターンが無かった（もう終わっていた） */
export interface RealStopOutcome {
  stopped: boolean;
  withdrawn?: RealWithdrawnMessage;
}

/**
 * **ターンを止める**（決定・2026-10-01、ユーザー要望。v4-frontend.md §6.31）。`turnId` はこの画面が送ったターンの名前
 * （順番待ちでもそれを止める）。無ければいま走っているターン。host は片づくまで待って答える
 */
export async function stopRealTurn(threadId: string, turnId?: string): Promise<RealStopOutcome> {
  return request<RealStopOutcome>(`/api/threads/${threadId}/stop`, {
    method: "POST",
    body: JSON.stringify(turnId ? { turnId } : {}),
  });
}

/** 繋ぎ直しの流れだけが最初に返すもの：走っていない（`idle`）／走っている（`attached`） */
export type RealFollowEvent =
  | RealTurnEvent
  | { type: "idle" }
  /**
   * `startedSeq`：そのターンの始まり（`turn.started`）の seq（追加・2026-10-05）。AI の発言は書き終えるごとに記録にも
   * 入るので、流し直す分と記録が重なる——これより後ろのそのターンの AI の発言を記録から外して組み直す
   * （`replayed-turn.ts`）。始まりを記録する前に終わったターンには無い
   */
  | { type: "attached"; startedAt: string; startedSeq?: number };

/**
 * **黙って止まった接続を見切るまでの時間**（決定・2026-09-26）。host はどの流れにも15秒ごとに空行を送る
 * （`SSE_KEEPALIVE_MS`）ので、その3倍なにも届かなければ切れている——携帯で別アプリから戻ったとき、
 * 回線が変わったとき、接続は「エラー」にならずに黙って止まることがある
 */
const SSE_STALE_MS = 45_000;

class SseStaleError extends Error {}

/**
 * SSE の本文を読み、`data:` の行ごとに渡す（ターン・繋ぎ直し・host の知らせで共通）。**黙って止まった接続は
 * 見切って投げる**——見張りは5秒ごと、画面に戻ってきた瞬間（`visibilitychange`）にも見る（隠れている間は
 * 見張りの時計が間引かれる）。本文が終われば返る
 */
export async function readSse(res: Response, onData: (data: unknown) => void): Promise<void> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let lastAt = Date.now();
  let stale = false;
  const check = (): void => {
    if (stale || Date.now() - lastAt <= SSE_STALE_MS) return;
    stale = true;
    void reader.cancel().catch(() => undefined);
  };
  const onVisible = (): void => {
    if (document.visibilityState === "visible") check();
  };
  const timer = setInterval(check, 5_000);
  document.addEventListener("visibilitychange", onVisible);
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (stale) throw new SseStaleError(`${SSE_STALE_MS / 1000} 秒間なにも届かなかったので、切れたとみなしました`);
      if (done) return;
      lastAt = Date.now();
      buf += decoder.decode(value, { stream: true });
      const parts = buf.split("\n\n");
      buf = parts.pop() ?? "";
      for (const part of parts) {
        if (!part.startsWith("data: ")) continue; // 空行（`: keep-alive`）は数えるだけ
        onData(JSON.parse(part.slice(6)));
      }
    }
  } finally {
    clearInterval(timer);
    document.removeEventListener("visibilitychange", onVisible);
  }
}

/**
 * **受信と、描くために渡すのを分ける**（改訂・2026-09-07、ユーザー報告が起点）。
 * 以前は「ジェネレータが `read()` する→yield する」を1本でやっていたため、
 * **描く側が最後まで引き取らないと、その先が読まれない**。実測すると
 * ランタイムは最後の yield のあと次を要求しないことがあり、その結果
 * **ターンの終了イベント（`done`）が一度も処理されなかった**。
 *
 * 受信は独立した繰り返しで回し、届いた端から `onEvent` に渡しつつ、描画用には順番に取り出せるようにする。
 * `close()` で受信も止める（読むのをやめた流れを開いたままにしない）
 */
function queuedStream<E>(
  pump: (push: (event: E) => void, signal: AbortSignal) => Promise<void>,
  onEvent?: (event: E) => void,
): { events: AsyncGenerator<E>; close(): void } {
  const queue: E[] = [];
  let wake: (() => void) | null = null;
  let finished = false;
  const controller = new AbortController();
  const push = (event: E): void => {
    onEvent?.(event);
    queue.push(event);
    wake?.();
    wake = null;
  };
  void pump(push, controller.signal).finally(() => {
    finished = true;
    wake?.();
    wake = null;
  });
  async function* drain(): AsyncGenerator<E> {
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
  return { events: drain(), close: () => controller.abort() };
}

/**
 * **走行中のターンに、あとから繋いで流し直してもらう**（`turn-stream-reattach`、2026-09-10）。
 * 走っていれば `attached` のあと、そのターンがこれまでに出したものを最初から、続きもそのまま。
 * 走っていなければ `idle` が1つ来て閉じる。繋げなかった・途中で切れたら `disconnected`
 */
export function followRealTurn(
  threadId: string,
  onEvent?: (event: RealFollowEvent) => void,
): { events: AsyncGenerator<RealFollowEvent>; close(): void } {
  return queuedStream<RealFollowEvent>(async (push, signal) => {
    try {
      const res = await hostFetch(`/api/threads/${threadId}/stream`, { signal });
      if (!res.ok || !res.body) {
        push({ type: "disconnected", message: `走行中のターンに繋げませんでした（${res.status}）` });
        return;
      }
      await readSse(res, (data) => push(data as RealFollowEvent));
    } catch (err) {
      if (!signal.aborted) push({ type: "disconnected", message: err instanceof Error ? err.message : String(err) });
    }
  }, onEvent);
}

/**
 * ターンを始めて、その流れを読む。`POST` の本文を送るので EventSource は使わない
 * （fetch の ReadableStream を手で読む）。
 */
export function streamRealTurn(
  threadId: string,
  prompt: string,
  permissionMode?: string,
  onEvent?: (event: RealTurnEvent) => void,
  /** 人が添えた画像（決定・2026-09-26） */
  images: readonly OutgoingImage[] = [],
  /** このターンの名前（§6.31）。止めるときに同じ名前を渡す */
  turnId?: string,
): AsyncGenerator<RealTurnEvent> {
  return queuedStream<RealTurnEvent>(async (push, signal) => {
    let res: Response;
    try {
      res = await hostFetch(`/api/threads/${threadId}/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          prompt,
          permissionMode,
          ...(images.length > 0 ? { images } : {}),
          ...(turnId ? { turnId } : {}),
        }),
        signal,
      });
    } catch (err) {
      // **届いたか分からない**——ターンが始まったとは言えないので、切れたではなく失敗として出す（規則2）
      if (!signal.aborted) push({ type: "error", message: err instanceof Error ? err.message : String(err) });
      return;
    }
    if (!res.ok || !res.body) {
      // **断られた理由を出す**（追加・2026-09-25）——409 は「この Thread はいま走っている」（届いたものに答えている等）
      const reason = ((await res.json().catch(() => null)) as { error?: string } | null)?.error;
      push({ type: "error", message: reason ?? `ターンの開始に失敗しました（${res.status}）` });
      return;
    }
    try {
      await readSse(res, (data) => push(data as RealTurnEvent));
    } catch (err) {
      // **ターンは host で続いている**（host は画面が切れても最後まで走らせる）——切れたとだけ伝える
      if (!signal.aborted) push({ type: "disconnected", message: err instanceof Error ? err.message : String(err) });
    }
  }, onEvent).events;
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
  /** 会話にはカードだけを置く、と Module が名乗った tool（`dev.banto/card`、決定・2026-10-01） */
  card?: RealToolCard;
}

/** カードの題と説明の文。`{引数名}` はその呼び出しの引数で置き換える */
export interface RealToolCard {
  title?: string;
  description?: string;
}

/** Module が申告した画面。CSP はサンドボックスの口へそのまま渡す。 */
export interface RealUiResource {
  html: string;
  csp?: unknown;
  permissions?: unknown;
  prefersBorder?: boolean;
}

/**
 * サンドボックスの配信先。**host が起動しているあいだは変わらない**ので、ページの中で1回だけ取る
 * （改訂・2026-09-26、実測）——会話の中の Canvas が1枚ごとに同じものを取っていた
 * （Project を開くたびに 6 枚なら 6 回）。失敗は覚えない（次に欲しがったときに取り直す）。
 */
let uiConfigOnce: Promise<{ sandboxUrl: string | null }> | undefined;
export function fetchRealUiConfig(): Promise<{ sandboxUrl: string | null }> {
  uiConfigOnce ??= request<{ sandboxUrl: string | null }>("/api/ui-config").catch((err: unknown) => {
    uiConfigOnce = undefined;
    throw err;
  });
  return uiConfigOnce;
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

/**
 * 画面の中身（HTML）。**同時に同じものを欲しがったら1本の要求を分け合う**（改訂・2026-09-26）
 * ——会話の中に同じ Module の画面が何枚もあると、開くたびに同じ HTML を枚数分取っていた。
 * 取り終えたものは覚えない（Module を入れ替えたら、次に開いたときには新しい画面が出る）。
 */
const uiResourceFetches = new Map<string, Promise<RealUiResource>>();
export function fetchRealUiResource(owner: RealCanvasOwner, server: string, uri: string): Promise<RealUiResource> {
  const path = `${ownerPath(owner)}/ui-resource?server=${encodeURIComponent(server)}&uri=${encodeURIComponent(uri)}`;
  let pending = uiResourceFetches.get(path);
  if (!pending) {
    pending = request<RealUiResource>(path).finally(() => uiResourceFetches.delete(path));
    uiResourceFetches.set(path, pending);
  }
  return pending;
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
  const res = await hostFetch(
    `/api/threads/${threadId}/ui-tool-calls/${encodeURIComponent(toolCallId)}/display-mode`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ displayMode }),
    },
  );
  if (!res.ok) throw new Error(`表示の記録に失敗しました（${res.status}）`);
}

/** 人が直接開ける入口（launcher、§6.2）。名前と説明は Module が名乗ったもの。 */
/** core の新しい Project の画面に差し出す始め方（Module が名乗ったもの、§2.4「core との境目」） */
export interface RealFolderProvider {
  server: string;
  resourceUri: string;
  name?: string;
  description?: string;
  /** `data:` の画像だけ（core が確かめて渡す） */
  icon?: string;
}

/** banto 全体の Module が「Project の Root にするフォルダを用意できる」と名乗った画面の一覧 */
export async function listRealFolderProviders(): Promise<RealFolderProvider[]> {
  return request<RealFolderProvider[]>(`/api/ui-folder-providers`);
}

export interface RealUiLauncher {
  server: string;
  resourceUri: string;
  name?: string;
  description?: string;
}

/**
 * その Project に**繋がっている Module の入口**と、**banto 全体に1本の Module の入口**（改訂・2026-10-01、§6.2
 * ——後者は Project の Module 集合に無くても出る。開いた画面の中身・呼び出しも同じ集合に届く）。
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

/**
 * **画面と Module の間の流れの札**（決定・2026-10-08、アーキ仕様 §5.8）。host が持ち主から見える Module か・
 * その画面がその名前を名乗っているかを確かめて、1回だけ・30 秒の札を返す。`frame` は iframe ごとの印
 */
export async function requestRealUiStream(
  owner: RealCanvasOwner,
  input: { server: string; resourceUri: string; name: string; params: Record<string, unknown>; frame: string },
): Promise<{ url: string; ticket: string; expiresAt: string }> {
  return request<{ url: string; ticket: string; expiresAt: string }>(`${ownerPath(owner)}/ui-stream`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

/**
 * **banto 全体の Module**（追加・2026-09-15、§10 item 14 (a)）。
 *
 * Project ごとの選択（`RealProjectModule`）は「この Project の AI に見せるか」。
 * こちらは **banto 全体の層**——宣言そのものを足す・止める・消す。
 */
export interface RealInstanceModule {
  name: string;
  /** banto 全体で動かすか（止めても一覧には残る——消えたのか止めたのか分かるように） */
  enabled: boolean;
  /** banto 同梱か、外から繋いだか。**許してよいことが違う** */
  origin: "bundled" | "external";
  /** 一覧から消せるか（＝設定にその宣言が書かれているか）。 */
  removable: boolean;
  satisfies: string[];
  dependsOn: { role: string; required: boolean }[];
  scope: "instance" | "project";
  confinement?: { kind: string; root: string; profile: string };
  /** どこで動くか（host が宣言から導いた値） */
  placement: ModulePlacement;
  launch:
    | { command: string; args: string[]; env?: Record<string, string> }
    | { type: "http"; url: string; headers?: Record<string, string> };
  /** 止めると断るようになる Module（`dependsOn` から導いた値） */
  /** いま立っているか */
  connected: boolean;
  /** 立たなかった理由 */
  error?: string;
}

export async function listRealInstanceModules(): Promise<RealInstanceModule[]> {
  return request<RealInstanceModule[]>("/api/modules");
}

export async function setRealInstanceModuleEnabled(name: string, enabled: boolean): Promise<void> {
  await request(`/api/modules/${encodeURIComponent(name)}`, {
    method: "PUT",
    body: JSON.stringify({ enabled }),
  });
}

export async function addRealInstanceModule(
  declaration: {
    name: string;
    launch:
      | { command: string; args: string[]; env?: Record<string, string> }
      | { type: "http"; url: string; headers?: Record<string, string> };
    meta: unknown;
  },
  /** **URL に繋ぐ形のときだけ要る**——「machine の外へ出す」と人が承知した印。 */
  acknowledgeEgress = false,
): Promise<void> {
  await request("/api/modules", {
    method: "POST",
    body: JSON.stringify(acknowledgeEgress ? { ...declaration, acknowledgeEgress: true } : declaration),
  });
}

/**
 * **ログインを始める**（URL に繋ぐ Module が OAuth を要るとき）。
 *
 * banto はサーバなので**自分でブラウザを開けない**——押し先の URL を返し、
 * 画面が新しいタブで開く（`docs/specs/v4-frontend.md` §6.23）。
 */
/**
 * **同梱の目録**（追加・2026-09-20、ユーザー決定）。既定には入れていないが
 * banto が同梱している実装——要る人が「Module を追加」から入れる。
 */
export interface RealCatalogEntry {
  id: string;
  name: string;
  description: string;
  suggestedName: string;
  satisfies: string[];
  scope: "instance" | "project";
}

export async function listRealModuleCatalog(): Promise<RealCatalogEntry[]> {
  return request<RealCatalogEntry[]>("/api/modules/catalog");
}

/**
 * 目録から1本入れる。**画面が送るのは目録の id と名前だけ**
 * ——役割も起動の指定も画面が組み立てない（組み立てさせると「役割を自由に
 * 入力できる欄」ができ、貼り付けた JSON が金庫の窓口を名乗る経路が復活する。
 * `docs/specs/v4-security.md`「役割のなりすまし」）。
 */
export async function installRealModuleFromCatalog(id: string, name: string): Promise<void> {
  await request<{ ok: true }>(`/api/modules/catalog/${encodeURIComponent(id)}`, {
    method: "POST",
    body: JSON.stringify({ name }),
  });
}

// ---- MCP Registry（追加・2026-09-21、ユーザー要望）--------------------------
//
// **並べ替えも、繋ぎ方の見立ても host がやる**（規則3）——画面は返ってきた順に
// 描いて、返ってきた札を出すだけ。ここで並べ直すと、順序の決まりが2箇所になる。

/** その1件の出所。**registry は「公式」の欄を持たない**ので、banto の見立て。 */
export type RealRegistryProvenance =
  | "vendor"
  | "third-party-domain"
  | "github-account"
  /** 人が貼った `server.json`——registry を引いていないので出所を確かめようがない。 */
  | "pasted";

export type RealRegistryConnect =
  | { kind: "remote"; host: string; transport: string }
  | {
      kind: "local";
      registryType: string;
      identifier: string;
      packageVersion?: string;
      supported: boolean;
      reason?: string;
    }
  | { kind: "none"; reason: string };

export interface RealRegistryInput {
  target: "env" | "header";
  name: string;
  description?: string;
  required: boolean;
  /** **秘密は Vault を既定にする**（直書きは記録に残り続ける）。 */
  secret: boolean;
  choices?: string[];
  default?: string;
}

export interface RealRegistryEntry {
  name: string;
  title?: string;
  /** 一覧に出す見出し（host が決める——`title` が無いときの代わりも含めて）。 */
  label: string;
  /** 付ける Module 名の候補（host が決める。見出しとは別＝こちらは識別子）。 */
  suggestedName: string;
  description: string;
  version: string;
  websiteUrl?: string;
  repositoryUrl?: string;
  status: string;
  provenance: RealRegistryProvenance;
  connect: RealRegistryConnect;
  inputs: RealRegistryInput[];
}

export interface RealRegistrySearch {
  entries: RealRegistryEntry[];
  nextCursor?: string;
  formats: Array<{ registryType: string; label: string; runtime: string; supported: boolean; reason?: string }>;
}

/** banto が選んだ目録の1件（`packages/core/src/modules/registry/curated.ts`）。 */
export interface RealCuratedEntry {
  id: string;
  registryName: string;
  label: string;
  description: string;
  /** **なぜ載っているか**——人が確かめた根拠。画面はこれをそのまま出す。 */
  why: string;
}

export async function listRealCuratedModules(): Promise<RealCuratedEntry[]> {
  return request<RealCuratedEntry[]>("/api/modules/curated");
}

export async function searchRealModuleRegistry(
  query: string,
  cursor?: string,
): Promise<RealRegistrySearch> {
  const params = new URLSearchParams();
  if (query.trim()) params.set("q", query.trim());
  if (cursor) params.set("cursor", cursor);
  const qs = params.toString();
  return request<RealRegistrySearch>(`/api/modules/registry${qs ? `?${qs}` : ""}`);
}

/** 人が入れた1件の答え。**秘密は Vault の名前**を渡す（値は宣言に残さない）。 */
export interface RealRegistryAnswer {
  name: string;
  source: "vault" | "plain";
  value: string;
}

/**
 * **registry から1本入れて、繋ぐ。**
 *
 * **画面が送るのは「目録のどれか・付ける名前・人が入れた値」だけ**
 * ——起動の指定も役割も画面は組み立てない。host が `server.json` を引き直して
 * 作る（`v4-security.md`「役割のなりすまし」）。
 */
export async function installRealModuleFromRegistry(
  serverName: string,
  name: string,
  answers: readonly RealRegistryAnswer[],
): Promise<{ summary: string }> {
  return request<{ ok: true; added: string; summary: string }>("/api/modules/registry/install", {
    method: "POST",
    body: JSON.stringify({ serverName, name, answers }),
  });
}

/**
 * **貼られた `server.json` を読む**（追加・2026-09-22）。**入れない、読むだけ**
 * ——返ってくるのは検索の1件と同じ形なので、画面は同じ部品で描ける（規則3）。
 */
export async function inspectRealServerJson(serverJson: string): Promise<RealRegistryEntry> {
  const res = await request<{ entry: RealRegistryEntry }>("/api/modules/registry/inspect", {
    method: "POST",
    body: JSON.stringify({ serverJson }),
  });
  return res.entry;
}

/** 貼られた `server.json` から入れる。**繋ぎ方を組み立てるのは host**。 */
export async function installRealModuleFromServerJson(
  serverJson: string,
  name: string,
  answers: readonly RealRegistryAnswer[],
): Promise<{ summary: string }> {
  return request<{ ok: true; added: string; summary: string }>("/api/modules/registry/install", {
    method: "POST",
    body: JSON.stringify({ serverJson, name, answers }),
  });
}

export async function startRealModuleOAuth(name: string): Promise<{ url: string }> {
  return request<{ url: string }>(`/api/modules/${encodeURIComponent(name)}/oauth/start`, {
    method: "POST",
  });
}

export async function removeRealInstanceModule(name: string): Promise<void> {
  await request(`/api/modules/${encodeURIComponent(name)}`, { method: "DELETE" });
}

/**
 * **`mcpServers` の形で足す**（2026-09-16）。人は Claude Code の設定や
 * README から**貼ってくる**——打たせない。
 */
export async function addRealInstanceModulesFromMcpServers(
  json: string,
  /** **URL に繋ぐ形が混じっているときだけ要る**（`docs/specs/v4-security.md`）。 */
  acknowledgeEgress = false,
): Promise<string[]> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (err) {
    throw new Error(`JSON として読めません：${err instanceof Error ? err.message : String(err)}`);
  }
  // `{"mcpServers": {...}}` でも、その中身だけでも受ける
  // ——README には中身だけ載っていることがある
  const body =
    typeof parsed === "object" && parsed !== null && "mcpServers" in parsed
      ? (parsed as Record<string, unknown>)
      : { mcpServers: parsed };
  const res = await request<{ added: string[] }>("/api/modules", {
    method: "POST",
    body: JSON.stringify(acknowledgeEgress ? { ...body, acknowledgeEgress: true } : body),
  });
  return res.added ?? [];
}

/** いまの設定を `mcpServers` の形で取り出す（他のクライアントへ持っていける）。 */
export async function exportRealInstanceModules(): Promise<unknown> {
  return request<unknown>("/api/modules/export");
}

/** 記録から戻した画像の印（`banto-image:<id>`）。`useAttachmentSrc` がこれを見て host から取ってくる */
export const REAL_IMAGE_SRC_PREFIX = "banto-image:";

/** 取りに行った画像（名前 → 画面で使える URL）。**名前は中身のハッシュなので、中身は変わらない**——一度取れば覚えてよい */
const imageObjectUrls = new Map<string, Promise<string>>();

/**
 * **人が会話に添えた画像を、画面で出せる URL にする**（決定・2026-09-26）。
 * `<img src>` は合言葉のヘッダを付けられないので、合言葉つきで取ってから手元の URL（blob:）にする
 * ——URL に合言葉を載せると、履歴やログに残る。
 */
export function fetchRealImageUrl(id: string): Promise<string> {
  let url = imageObjectUrls.get(id);
  if (!url) {
    url = (async () => {
      const res = await hostFetch(`/api/images/${encodeURIComponent(id)}`);
      if (!res.ok) throw new Error(`画像を取れませんでした（${res.status}）`);
      return URL.createObjectURL(await res.blob());
    })();
    // 失敗は覚えない——次に描くときにもう一度取りに行く
    url.catch(() => imageObjectUrls.delete(id));
    imageObjectUrls.set(id, url);
  }
  return url;
}

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
import type { UiByExtension } from "@/lib/ui-by-extension";

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
    let code: unknown;
    try {
      const body = JSON.parse(text) as { error?: unknown; code?: unknown };
      if (typeof body.error === "string" && body.error.trim() !== "") reason = body.error;
      code = body.code;
    } catch {
      // JSON でないなら、本文をそのまま手がかりにする
      reason = text.trim();
    }
    // 眠っている Project の設定・入口・Module の画面（v4-frontend.md §6.43）——画面は「起こす」を出す
    if (res.status === 409 && code === "asleep") throw new ProjectAsleepError(reason || "この Project は眠っています");
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
  /** 実行場所（`remote:<名前>` なら別のサーバ。無ければこの機械のコンテナ）。変わるのは別の実行場所へ移したときだけ */
  runtime?: string;
  /** 承認なしでメッセージを受け取ってよい Project の id（追加・2026-10-01、アーキ仕様 §4.2）。無ければ空 */
  acceptMessagesFrom?: string[];
  /** 入っているグループ（追加・2026-10-16、アーキ仕様 §2.2「Project のグループとスリープ」）。無ければグループなし */
  groupId?: string;
  /** 眠っている（追加・2026-10-16、アーキ仕様 §2.2「スリープ」）。いつから・誰が（人・しばらく開いていないので自動で） */
  sleep?: RealProjectSleep;
  /** 眠っているが、出来事を待たれている Module のため一部起きている（追加・2026-10-16、アーキ仕様 §2.2）。眠っていなければ無い */
  partlyAwake?: RealPartlyAwake[];
  /**
   * **しばらく開いていないので、眠らせるか聞く**（追加・2026-10-16、アーキ仕様 §2.2「しばらく開いていない Project」）。
   * `projects.autoSleep` が `ask` で、host の時計が候補に決めたものだけ。何日開いていないか
   */
  idle?: { days: number; suggestSleep: true };
  /** 新しい Project の始め方の仕事（別のサーバの clone・新しいリポジトリ、§6.49）。そう作ったものだけ */
  start?: RealProjectStart;
  /** 特権コンテナにした（v4-security.md §1「`containers` で仮想化（KVM）」の 4.。サイドバーの行に印）。そうでなければ無い */
  privileged?: true;
  createdAt: string;
}

/** 出来事を待たれているので眠らせても止めない Module と、待っている自動化（host の `AwaitedModule`） */
export interface RealPartlyAwake {
  module: string;
  automations: Array<{ id: string; name: string }>;
}

/**
 * 「自動化『〈名前〉』が〈Module〉の出来事を待っているので、〈Module〉は起きたままです」（v4-frontend.md §6.43）。
 * Module ごとに1文
 */
export function partlyAwakeReasons(awake: readonly RealPartlyAwake[]): string[] {
  return awake.map(
    (a) => `自動化${a.automations.map((x) => `『${x.name}』`).join("・")}が${a.module}の出来事を待っているので、${a.module}は起きたままです`,
  );
}

export interface RealProjectSleep {
  since: string;
  by: "human" | "auto";
}

/**
 * **眠っている Project の設定・入口・Module の画面を開いた**（host の 409 `asleep`、アーキ仕様 §2.2「それ以外の道では
 * 起こさない」）。画面は「眠っています。起こすと見られます」と「起こす」を出す（`components/banto/project/asleep-notice.tsx`）
 */
export class ProjectAsleepError extends Error {}

/**
 * 眠らせると止まるもの（Service・待たないコマンド・Terminal のセッション）と、眠らせられない理由。`keeps` は自動化のため
 * 止めない Module、`servicesKept` はその中に Service の Module がある（Service と公開中の URL は止まらない）
 */
export interface RealSleepPreview {
  stops: Array<{ kind: string; label: string }>;
  blockers: string[];
  keeps: RealPartlyAwake[];
  servicesKept: boolean;
}

export async function getRealSleepPreview(projectId: string): Promise<RealSleepPreview> {
  return request<RealSleepPreview>(`/api/projects/${projectId}/sleep-preview`);
}

/** 眠らせるのを断られた（AI が動いている・裏の仕事が残っている・移している等）。`reasons` は1つずつの理由 */
export class ProjectSleepRefusedError extends Error {
  constructor(
    message: string,
    readonly reasons: string[],
  ) {
    super(message);
  }
}

/** **眠らせる**（`POST /api/projects/:id/sleep`）。断られたら `ProjectSleepRefusedError` */
export async function sleepRealProject(projectId: string): Promise<void> {
  const res = await hostFetch(`/api/projects/${projectId}/sleep`, { method: "POST", headers: { "content-type": "application/json" } });
  if (res.ok) return;
  const body = (await res.json().catch(() => ({}))) as { error?: string; reasons?: unknown };
  const message = body.error || `banto host /api/projects/${projectId}/sleep が ${res.status} を返しました`;
  if (res.status === 409) {
    const reasons = Array.isArray(body.reasons) ? body.reasons.filter((r): r is string => typeof r === "string") : [];
    throw new ProjectSleepRefusedError(message, reasons.length > 0 ? reasons : [message]);
  }
  throw new Error(message);
}

/** 「今はしない」（`dismissedAt` を今に。さらに 14 日たったらまた聞く、アーキ仕様 §2.2） */
export async function dismissRealSleepSuggestions(ids: readonly string[]): Promise<void> {
  await request<{ ok: true }>("/api/projects/sleep-suggestions/dismiss", { method: "POST", body: JSON.stringify({ ids }) });
}

/** しばらく開いていない Project をどうするか（banto 全体の設定 `projects.autoSleep`）。聞く（既定）・自動で眠らせる・何もしない */
export type RealAutoSleepMode = "ask" | "auto" | "off";

export async function getRealAutoSleep(): Promise<RealAutoSleepMode> {
  return (await request<{ mode: RealAutoSleepMode }>("/api/settings/auto-sleep")).mode;
}

export async function setRealAutoSleep(mode: RealAutoSleepMode): Promise<RealAutoSleepMode> {
  return (await request<{ mode: RealAutoSleepMode }>("/api/settings/auto-sleep", { method: "PUT", body: JSON.stringify({ mode }) })).mode;
}

/** グループの色（host の `PROJECT_GROUP_COLORS` と同じ5つ。記録には名前で持つ） */
export const REAL_PROJECT_GROUP_COLORS = ["blue", "green", "yellow", "orange", "pink"] as const;
export type RealProjectGroupColor = (typeof REAL_PROJECT_GROUP_COLORS)[number];

/** Project のグループ（host の `ProjectGroupState` と同じ形、アーキ仕様 §2.2） */
export interface RealProjectGroup {
  id: string;
  name: string;
  color: RealProjectGroupColor;
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
  /** Module の画面から人が添えたもの（追加・2026-10-15）。人の文（`text`）とは分かれている */
  quotes?: RealMessageQuote[];
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

/**
 * **Module の画面から人が添えた塊**（追加・2026-10-15、v4-frontend.md §6.2「画面から会話の入力欄へ文を渡す」）。送るときは
 * 出所の Module と文だけ——第三者かは host が自分の宣言で決める。記録から返るときは host が決めた値が付く
 */
export interface OutgoingQuote {
  module: string;
  text: string;
}
export interface RealMessageQuote extends OutgoingQuote {
  thirdParty: boolean;
  /** 見回り〈名前〉の気づきの引用（§6.47） */
  patrol?: string;
}

/** 届いたものの印——送り手・題・何回中継されたか */
export interface RealMessageOrigin {
  from: string;
  title: string;
  hop: number;
  deliveryId: string;
  /** 別の Thread の AI が送ったものの送り元（追加・2026-10-01、アーキ仕様 §4.2）。Module が届けたものには無い */
  sender?: { projectId: string; projectName: string; threadId: string; threadLabel: string };
  /**
   * **外から来たもの**（追加・2026-10-15、アーキ仕様 §4.3「Webhook」）。自動化の指示の下に添えた、Webhook で受けた本文。
   * AI には別の囲みでデータとして渡している——画面も指示と分けて出す
   */
  external?: {
    source: "webhook" | "event";
    receivedAt: string;
    body: string;
    truncatedFrom?: number;
    /** Module が知らせた出来事の見出し（`source: "event"` だけ）。名前・題・属性は Module の申告 */
    event?: { name: string; title: string; eventId: string; occurredAt: string; fields: Record<string, string | number | boolean> };
    /** まとめた1本が大きすぎて本文を省いた */
    bodyOmitted?: true;
  }[];
  /**
   * **任務の予約で起こした回**（追加・2026-10-20、v4-frontend.md §6.47）。会話には届いたもののカードではなく薄い1行で出す。
   * `maxWakes`・`note` は起こした時点の上限と前の予約のメモ（この仕組みより前の記録には無い）
   */
  mission?: { id: string; wake: number; maxWakes?: number; note?: string };
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
  /**
   * 最後のターンの始まり（追加・2026-10-05、host の `lastTurn` の一部）。流し直すターンとの境界を引くのに使う。
   * 上限で止まったかは `rateLimitStop` で読む（ここの `rateLimit` は畳んだターンにも残る）
   */
  lastTurn?: { startedSeq: number };
  /**
   * **この Thread の要求で Claude のアカウントを切り替えた**（追加・2026-10-18、v4-frontend.md §6.46）。会話に薄い1行で出す
   * （AI の文脈には入っていない）。この仕組みより前の会話には無い
   */
  accountSwitches?: RealAccountSwitch[];
  /**
   * **会話の一番下に「上限で止まった」帯を出すか**（追加・2026-10-18、§6.46。host が記録から導く——`lastTurn.rateLimit` の有無で
   * 決めない）。`stopped`＝止まった（待っている・人がやめた）、`gave_up`＝続けて上限に当たったのでやめた、`unknown_reset`＝
   * リセットの時刻が分からない。上限で終わっていない・Clear や閉じた Fork で畳んだターンなら無い
   */
  rateLimitStop?: "stopped" | "gave_up" | "unknown_reset";
  /**
   * **読むだけの回**（追加・2026-10-20、アーキ仕様 §4.4）。この会話の AI は読むだけの tool しか使えず、書いた URL は banto が
   * 知っている場所だけリンクにする。印の無い会話には無い
   */
  restriction?: "read-only";
  createdAt: string;
}

/** Claude のアカウントの切り替え1件（host の `ClaudeAccountSwitchRecord` に名前を添えたもの） */
export interface RealAccountSwitch {
  /** 会話の中の置き場（発言と同じ物差し） */
  seq: number;
  at: string;
  from: string;
  to: string;
  /** アカウントの名前（読むときに台帳から引く。外したアカウントには無い） */
  fromLabel?: string;
  toLabel?: string;
  reason: {
    kind: "threshold" | "rejected" | "recovered" | "order" | "unavailable";
    window?: "5h" | "7d";
    /** 0〜1 */
    utilization?: number;
    resetsAt?: string;
    claim?: string;
  };
  /** 並びの全部が閾値を越えていて、一番早くリセットされる `to` で続けた */
  allOver?: true;
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

/** 全部越えのカードの中身（`RealInboxNotice.claudeAccounts`） */
export interface RealNoticeClaudeAccounts {
  projectId: string;
  projectName?: string;
  order: string[];
  /** 続けているアカウント（一番早くリセットされるもの） */
  using: string;
  /** 並びの順。リセットを過ぎた窓は無い（分からない） */
  accounts: Array<{
    id: string;
    label: string;
    fiveHour?: RealUsageWindow;
    sevenDay?: RealUsageWindow;
    status?: string;
    statusResetsAt?: string;
  }>;
  /** 0〜1 */
  thresholds: { fiveHour: number; sevenDay: number };
}

/** 窓1つの使用率（host の `UsageWindow`） */
export interface RealUsageWindow {
  /** 0〜1 */
  utilization: number;
  resetsAt?: string;
}

/** 受信箱のカードに添える任務の結末（host の `ReviewMission`） */
export interface RealReviewMission {
  id: string;
  goal: string;
  status: "active" | "done" | "gave-up" | "exhausted" | "stalled" | "stopped";
  wakes: number;
  maxWakes: number;
  until: string;
  result?: string;
}

/** 判断待ち（§2.4）。hostの`JudgmentItem`をそのまま受け取る——ここで形を
 *  作り替えない（規則3・規則12）。 */
export interface RealInboxJudgment {
  kind: "judgment";
  id: string;
  threadId: string;
  /** `relay`＝Module 間中継の初回承認（host 自身が発生源、§「Module 間中継の承認」）。
   *  `automation`＝自動化の確認（届ける前に人に聞く）。 */
  source: "elicitation" | "text" | "factory" | "alarm" | "relay" | "message" | "automation" | "memory" | "mission";
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
  /**
   * **行き先**（追加・2026-10-15、アーキ仕様 §2.4）。host がその Thread を知っていれば添える——画面が Thread を手元に
   * 持っていなくても（読み込み前・閉じた Fork）カードから会話へ移れるように
   */
  projectId?: string;
  threadKind?: "base" | "fork";
}

/** レビュー待ち——**ターンが終わった**（決定・2026-09-27）。見れば消える */
export interface RealInboxReview {
  kind: "review";
  id: string;
  threadId: string;
  summary: string;
  acknowledged: boolean;
  createdAt: string;
  /**
   * **行き先**（追加・2026-10-15、アーキ仕様 §2.4）。host がその Thread を知っていれば添える——画面が Thread を手元に
   * 持っていなくても（読み込み前・閉じた Fork）カードから会話へ移れるように
   */
  projectId?: string;
  threadKind?: "base" | "fork";
  /** そのターンの中身（追加・2026-10-15、アーキ仕様 §2.4「受信箱の中で読んで答える」）。Thread が無ければ無い */
  turn?: RealReviewTurn;
  /**
   * 自動化の回のカードだけ（追加・2026-10-15、アーキ仕様 §4.3「受信箱」）。この会話で、このカード以降に終わってまだ
   * 見ていない回の数（このカードの回を含む）
   */
  unseenRuns?: number;
  /**
   * **判断役がこのターンの決めることをどうしたか**（追加・2026-10-16、アーキ仕様 §4.3「banto.turn-decisions と判断役」）。
   * 無ければ判断役は答えていない
   */
  judge?: RealReviewJudge;
  /** 前のカードから引き継いだ判断役の決め（「判断役が〈選択肢〉を選んで進めました」） */
  carriedJudge?: RealReviewJudge;
  /**
   * **任務が人に返ってきた**（追加・2026-10-20、アーキ仕様 §4.4「受信箱」）。終わった・枠を使い切った・止まっている任務の結末。
   * 画面に出すのは v4-frontend.md §6.47 の任務の画面（Backlog #422）
   */
  mission?: RealReviewMission;
  /** 判断役の回が動いている間（まだ答えていない）。host が走っている回から添える（記録には無い） */
  judgeWatching?: { id: string; name: string };
}

/**
 * 判断役の答え（host の `ReviewJudge` のまま）。`decided-by-automation`＝全部の問いに選択肢で答えて元の会話に届けた・
 * `deferred`＝人に任せた・`incomplete`＝揃わないまま判断役のターンが終わった（どちらも何も届けていない）
 */
export interface RealReviewJudge {
  kind: "decided-by-automation" | "deferred" | "incomplete";
  automation: { id: string; name: string };
  /** 問い・選択肢の番号は 1 から */
  answers?: Array<{ question: number; choice: number; label: string; reason: string }>;
  reason?: string;
  answered?: number;
  total?: number;
  at: string;
}

/**
 * **レビュー待ちのターンの中身**（追加・2026-10-15）。host が読むたびに Thread の記録から組む
 * （`packages/core/src/inbox/review-turn.ts`）
 */
export interface RealReviewTurn {
  /** まとめの `request`。無ければ人の最後の発言の頭 */
  request?: string;
  /** AI の最後の発言の本文（そのターンのもの、8000字まで） */
  reply?: string;
  replyTruncated?: true;
  /** そのターンのまとめ（`report_turn` の中身そのまま。描く前に `asTurnSummary` で確かめる） */
  summary?: unknown;
  /** ターンの結末。`interrupted`＝終わりを書く前に切れた（起こし直し等）。走っている間は無い */
  outcome?: "completed" | "stopped" | "failed" | "interrupted";
  /** そのターンで AI が呼んだ tool の数 */
  toolCalls?: number;
}

/** お知らせ（決定・2026-09-07）——許可/拒否を求めないが、人に伝えたいこと。
 *  最初の用途は「Module を繋げなかった」。 */
export interface RealInboxNotice {
  kind: "notice";
  id: string;
  /** 無い＝banto 全体（instance に1本の Module） */
  projectId?: string;
  /**
   * **どの会話で起きたか**（追加・2026-10-15、アーキ仕様 §2.4）。分かるときだけ。「続ける」のお知らせは host が
   * `resume` の Thread を入れて返す。`threadKind` はその Thread の種類（host が知っていれば）
   */
  threadId?: string;
  threadKind?: "base" | "fork";
  dedupeKey: string;
  title: string;
  detail: string;
  /**
   * **「続ける」を押せる**（追加・2026-10-05、アーキ仕様 §2.5「上限」）。起こし直しのたびに切れるので host が自動で
   * 続けるのをやめたターン。押すと `resumeRealNoticeTurn`
   */
  resume?: { threadId: string; turnId: string };
  /**
   * **実行場所の SSH 鍵が置き場の外にある**（追加・2026-10-17、Backlog 375 番）。`from` があれば「移す」を押せる
   * （`moveRealRuntimeKey`）。無ければ理由と入口だけ
   */
  /**
   * **並びの Claude のアカウントが全部閾値を越えた**（追加・2026-10-18、v4-frontend.md §6.46）。名前・メーター・閾値は host が
   * 読むたびに台帳から添える。どれかが閾値の下に戻ると host がカードを閉じる
   */
  claudeAccounts?: RealNoticeClaudeAccounts;
  runtimeKey?: {
    runtime: string;
    alias: string;
    from?: { implementation: string; group: string };
    projectIds: string[];
  };
  acknowledged: boolean;
  createdAt: string;
}

/**
 * **見回りの気づき**（追加・2026-10-20、アーキ仕様 §4.4「気づき（受信箱）」・v4-frontend.md §6.47）。外から来た文を読んだ見回りが
 * `notify` で書いたもの——中身の URL は banto が知っている場所だけリンクにする（`knownPlaceUrl`）
 */
export interface RealInboxFinding {
  kind: "finding";
  id: string;
  projectId: string;
  /** 見回りの Fork */
  threadId: string;
  patrol: { id: string; name: string };
  key: string;
  title: string;
  finding: string;
  evidence?: string;
  suggestion?: string;
  urgent: boolean;
  /** 「やって」の宛先にする Base（host が添える） */
  baseThreadId?: string;
  /** 見回りの Fork の種類（host が知っていれば添える。行き先は他のカードと同じ、§2.4） */
  threadKind?: "base" | "fork";
  closed?: { how: "acted" | "mission" | "muted" | "dismissed"; threadId?: string; at: string };
  createdAt: string;
}

export type RealInboxItem = RealInboxJudgment | RealInboxReview | RealInboxNotice | RealInboxFinding;

export async function createRealProject(
  name: string,
  root: string,
  runtime?: string,
  /** **始め方**（別のサーバだけ、v4-frontend.md §6.49）。`root` は置く場所、`folder` はその中に作るフォルダの名前 */
  start?: { start: RealProjectStartRequest; folder: string },
  /** **作るときに一緒に書くスイッチ**（v4-frontend.md §6.51）。host が作るのと同じ処理の中で書く */
  settings?: RealNewProjectSettings,
): Promise<RealProject> {
  return request<RealProject>("/api/projects", {
    method: "POST",
    body: JSON.stringify({
      ...(start
        ? { name, runtime, start: start.start, parent: root, folder: start.folder }
        : { name, root, ...(runtime ? { runtime } : {}) }),
      ...(settings ? { settings } : {}),
    }),
  });
}

/** 新しい Project の画面の「この Project の AI」の3つ（host の `NewProjectSettings` と同じ形） */
export interface RealNewProjectSettings {
  turnSummary?: boolean;
  autoApproveAll?: boolean;
  idleCompaction?: boolean;
}

/** 新しい Project の始め方（別のサーバの clone・新しいリポジトリ、§6.49） */
export type RealProjectStartRequest = { kind: "init" } | { kind: "clone"; url: string; account?: string };

/** 始め方の仕事の記録（host の `ProjectStart` と同じ形） */
export interface RealProjectStart {
  kind: "init" | "clone";
  url?: string;
  account?: string;
  startedAt: string;
  status: "waking" | "running" | "done" | "failed" | "interrupted";
  error?: string;
}

/** 始め方の仕事を、もう一度（失敗した・途中で止まったもの） */
export async function retryRealProjectStart(projectId: string): Promise<void> {
  await request(`/api/projects/${projectId}/start/retry`, { method: "POST" });
}

/**
 * clone のタブで選べる GitHub のアカウント（Repositories のブラウザログイン。login だけ）。Repositories が入っていなければ空
 */
export async function listRealStartGithubAccounts(): Promise<string[]> {
  return (await request<{ accounts: string[] }>("/api/project-start/github-accounts")).accounts;
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
/** 閉じたのは AI か人か、自動化が専用の Fork を乗り換えたか（追加・2026-10-15、Backlog #318） */
export type RealThreadClosedBy = "ai" | "human" | "automation";

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
  /** 読むだけの回（追加・2026-10-20、アーキ仕様 §4.4）。印の無い会話には無い */
  restriction?: "read-only";
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

/** **上限の待ちを今すぐ続ける**（追加・2026-10-18、v4-frontend.md §6.46）。待っていなければ host が断る（409） */
export async function continueRealRateLimitWait(threadId: string): Promise<void> {
  await request(`/api/threads/${threadId}/rate-limit-wait/continue`, { method: "POST" });
}

/**
 * **会話の任務**（追加・2026-10-20、アーキ仕様 §4.4「任務」・v4-frontend.md §6.47）。host の `MissionState` をそのまま受け取る
 * ——ここで形を作り替えない（規則3）
 */
export interface RealMission {
  id: string;
  goal: string;
  doneWhen: string;
  frame: { maxWakes: number; until: string; minIntervalMinutes: number };
  startedBy: "ai" | "human";
  startedAt: string;
  /** `active` 以外は人に返っている。`exhausted`＝枠を使い切った・`stalled`＝止まっている・`stopped`＝人が止めた／閉じた */
  status: "active" | "done" | "gave-up" | "exhausted" | "stalled" | "stopped";
  wakes: number;
  lastWakeAt?: string;
  /** 次の予約（時刻か待っている出来事。出来事が来たら時刻と `received` が付く） */
  followup?: {
    note: string;
    setAt: string;
    at?: string;
    event?: { name: string; title?: string; until: string };
    received?: { at: string; title: string };
  };
  /** 起きた記録（新しい順） */
  history: Array<{
    wake: number;
    at: string;
    cause: "time" | "event" | "event-timeout" | "human";
    scheduledFor?: string;
    result?: "done" | "decisions" | "waiting" | "failed";
  }>;
  result?: string;
  finishedAt?: string;
}

/** 任務の枠の欄（人が変える分だけ。省けば今のまま） */
export interface RealMissionFramePatch {
  maxWakes?: number;
  /** ISO */
  until?: string;
  minInterval?: number;
}

/** 今の任務と、この会話で任務を始められない理由（始められれば無い） */
export async function getRealMission(threadId: string): Promise<{ mission: RealMission | null; startRefused?: string }> {
  return request(`/api/threads/${threadId}/mission`);
}

/** **人が任務を始める**（会話の「…」と受信箱の気づきの「任務にする」）。人が押しているので host は聞かない */
export async function startRealMission(
  threadId: string,
  input: { goal: string; doneWhen: string } & RealMissionFramePatch,
): Promise<RealMission> {
  return (await request<{ mission: RealMission }>(`/api/threads/${threadId}/mission`, { method: "POST", body: JSON.stringify(input) })).mission;
}

/** **枠を延ばす**（枠を使い切った・止まっている任務は動いている任務に戻る）か、**止める**（`stop`） */
export async function patchRealMission(threadId: string, patch: RealMissionFramePatch | { stop: true }): Promise<RealMission> {
  return (await request<{ mission: RealMission }>(`/api/threads/${threadId}/mission`, { method: "PATCH", body: JSON.stringify(patch) })).mission;
}

/** **今すぐ起こす**（最短の間隔に縛られない。回数には数える）。会話が空いていなければ host が断る（409） */
export async function wakeRealMission(threadId: string): Promise<RealMission> {
  return (await request<{ mission: RealMission }>(`/api/threads/${threadId}/mission/wake`, { method: "POST" })).mission;
}

/** **上限の待ちをやめる**（追加・2026-10-18、§6.46）。自動では続けない——人が送れば、その発言で始まる */
export async function cancelRealRateLimitWait(threadId: string): Promise<void> {
  await request(`/api/threads/${threadId}/rate-limit-wait/cancel`, { method: "POST" });
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

/**
 * **閉じている間に、その実行場所を別の Project が使い始めていた**（決定・2026-10-13、`docs/specs/v4-security.md` §1
 * 「閉じた Project は数えない」）。再開は断られる——画面は「別の実行場所へ移す」を開いて選び直してもらう
 */
export class RuntimeTakenError extends Error {}

export async function reopenRealProject(projectId: string): Promise<void> {
  const res = await hostFetch(`/api/projects/${projectId}/reopen`, { method: "POST", headers: { "content-type": "application/json" } });
  if (res.ok) return;
  const body = (await res.json().catch(() => ({}))) as { error?: string; code?: string };
  if (res.status === 409 && body.code === "runtime-taken") throw new RuntimeTakenError(body.error ?? "実行場所を別の Project が使っています");
  throw new Error(body.error || `banto host /api/projects/${projectId}/reopen が ${res.status} を返しました`);
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

/** フォルダを1つ作る（新しい Project の「選ぶ」の画面の「新しいフォルダ」）。作ったフォルダの絶対パス */
export async function createRealDirectory(parent: string, name: string): Promise<string> {
  return (await request<{ path: string }>(`/api/fs/directories`, { method: "POST", body: JSON.stringify({ parent, name }) })).path;
}

export async function fetchRealRootScope(path: string): Promise<RealRootScope> {
  return request<RealRootScope>(`/api/config/root-scope?path=${encodeURIComponent(path)}`);
}

/**
 * **実行場所——別のサーバ**（決定・2026-10-08、`docs/specs/v4-security.md` §1「登録と選び方」、Backlog
 * `remote-runtime-registry`）。判断（選べない理由・前提の ✓✕）は host が持ち、画面はそのまま出す
 */
export const HOST_CONTAINER_RUNTIME = "host-container";

export interface RealHostKey {
  /** `ssh-ed25519` 等 */
  type: string;
  key: string;
  /** `SHA256:…` */
  fingerprint: string;
}

export interface RealRuntimeCheck {
  id: string;
  label: string;
  status: "ok" | "warn" | "fail";
  detail?: string;
  fix?: string;
  /** banto が登録・確かめ直しのときに sudo -n で整える項目（v4-security.md §1「足りないものは banto が入れる」） */
  autoFix?: boolean;
}

export interface RealRuntimeInput {
  name: string;
  host: string;
  user: string;
  port: number;
  /** Vault の ssh-identity の alias */
  identity: string;
  dataRoot: string;
  /** 動かし方：サーバ丸ごと1つの Project の箱（machine）／Project ごとに Incus のコンテナを立てる（containers） */
  mode: RealRuntimeMode;
}

export type RealRuntimeMode = "machine" | "containers";

export interface RealRemoteRuntime extends RealRuntimeInput {
  /** Project の記録に書く印（`remote:<名前>`） */
  runtime: string;
  hostKey: RealHostKey & { confirmedAt: string };
  hostKeyMismatch?: RealHostKey & { seenAt: string };
  checks: RealRuntimeCheck[];
  checkedAt: string;
  usedBy: Array<{ id: string; name: string }>;
  /** 新しい Project で選べない理由（選べるなら無し） */
  unavailableReason?: string;
  /** 仮想化（KVM）を許している（containers だけ。v4-security.md §1「`containers` で仮想化（KVM）」の 1.）。許していなければ無い */
  virtualization?: boolean;
}

/**
 * **実行場所の「仮想化（KVM）を許す」**（決定・2026-10-20、v4-security.md §1「`containers` で仮想化（KVM）」の 1.、Backlog 458 番）。
 * 止めるときに、まだ使っている Project（閉じたもの・眠っているものも）があれば host が名指しして断る
 */
export async function setRealRuntimeVirtualization(name: string, allowed: boolean): Promise<{ warnings: string[]; runtime: RealRemoteRuntime }> {
  return request<{ warnings: string[]; runtime: RealRemoteRuntime }>(`/api/runtimes/${encodeURIComponent(name)}/virtualization`, {
    method: "PUT",
    body: JSON.stringify({ allowed }),
  });
}

export async function listRealRuntimes(): Promise<RealRemoteRuntime[]> {
  return (await request<{ runtimes: RealRemoteRuntime[] }>("/api/runtimes")).runtimes;
}

/** 実行場所に使える SSH 鍵と、それを置く Vault のグループ（core だけが使える置き場。Project から使える鍵は出ない） */
/** `failures` は読めなかった Vault（`<実装>（<理由>）`）——そこにある鍵は一覧に出ていない */
export async function listRealSshIdentities(): Promise<{ identities: string[]; group: string; failures: string[] }> {
  return request<{ identities: string[]; group: string; failures: string[] }>("/api/runtimes/identities");
}

/**
 * **実行場所の鍵の置き場に新しい SSH 鍵を作る**（追加・2026-10-17、Backlog 375 番）。Vault の中で作り、返るのは公開鍵だけ
 * （向こうの `~/.ssh/authorized_keys` に足すのは人）
 */
export async function createRealRuntimeIdentity(name: string): Promise<{ name: string; group: string; publicKey: string }> {
  return request<{ name: string; group: string; publicKey: string }>("/api/runtimes/identities", {
    method: "POST",
    body: JSON.stringify({ name }),
  });
}

/**
 * **受信箱のカードの「移す」**（追加・2026-10-17、Backlog 375 番）。その実行場所の鍵を Vault の中で実行場所の鍵の置き場へ移し、
 * すぐ繋ぎ直す。移せたのに繋げなかったら `reconnectError` に理由
 */
export async function moveRealRuntimeKey(name: string): Promise<{ moved: true; reconnectError?: string }> {
  return request<{ moved: true; reconnectError?: string }>(`/api/runtimes/${encodeURIComponent(name)}/move-key`, { method: "POST" });
}

export async function scanRealRuntimeHostKey(input: RealRuntimeInput): Promise<RealHostKey> {
  return (await request<{ hostKey: RealHostKey }>("/api/runtimes/scan", { method: "POST", body: JSON.stringify(input) })).hostKey;
}

export async function checkRealRuntime(input: RealRuntimeInput, hostKey: RealHostKey): Promise<RealRuntimeCheck[]> {
  return (
    await request<{ checks: RealRuntimeCheck[] }>("/api/runtimes/check", {
      method: "POST",
      body: JSON.stringify({ runtime: input, hostKey }),
    })
  ).checks;
}

export async function registerRealRuntime(input: RealRuntimeInput, hostKey: RealHostKey): Promise<RealRemoteRuntime> {
  return request<RealRemoteRuntime>("/api/runtimes", { method: "POST", body: JSON.stringify({ runtime: input, hostKey }) });
}

export async function recheckRealRuntime(name: string): Promise<RealRemoteRuntime> {
  return request<RealRemoteRuntime>(`/api/runtimes/${encodeURIComponent(name)}/recheck`, { method: "POST" });
}

export async function acceptRealRuntimeHostKey(name: string, fingerprint: string): Promise<RealRemoteRuntime> {
  return request<RealRemoteRuntime>(`/api/runtimes/${encodeURIComponent(name)}/accept-host-key`, {
    method: "POST",
    body: JSON.stringify({ fingerprint }),
  });
}

export async function removeRealRuntime(name: string): Promise<void> {
  await request<{ ok: true }>(`/api/runtimes/${encodeURIComponent(name)}`, { method: "DELETE" });
}

export async function listRealRuntimeDirectories(name: string, path?: string): Promise<RealDirectoryListing> {
  const query = path ? `?path=${encodeURIComponent(path)}` : "";
  return request<RealDirectoryListing>(`/api/runtimes/${encodeURIComponent(name)}/directories${query}`);
}

/** 別のサーバにフォルダを1つ作る */
export async function createRealRuntimeDirectory(name: string, parent: string, folder: string): Promise<string> {
  return (
    await request<{ path: string }>(`/api/runtimes/${encodeURIComponent(name)}/directories`, {
      method: "POST",
      body: JSON.stringify({ parent, name: folder }),
    })
  ).path;
}

export async function fetchRealRuntimeRootScope(name: string, path: string): Promise<RealRootScope> {
  return request<RealRootScope>(`/api/runtimes/${encodeURIComponent(name)}/root-scope?path=${encodeURIComponent(path)}`);
}

/**
 * **Project を別の実行場所へ移す**（決定・2026-10-11、`docs/specs/v4-security.md` §1「Project を別の実行場所へ移す」、
 * Backlog `runtime-move-ui`）。押す前の見積もり・移す・進み具合。押せるかどうかの判断は host が持つ（`blockers`）
 */
export interface RealMoveEstimate {
  from: { runtime: string; root: string; label: string };
  to: { runtime: string; label: string; root: string };
  size: { bytes: number; files: number };
  /** 大きさを数えなかった理由（移す元の containers のコンテナが止まっている——移すときに起こしてから数える） */
  sizeNote?: string;
  notMoved: string[];
  rebuild: string[];
  running: Array<{ kind: string; label: string }>;
  copiesClaudeRecords: boolean;
  claudeRecords: number;
  confinementNote?: string;
  /** 前に居た場所へ戻す（差分で写す）。無ければふつうに写す */
  returning?: {
    movedAt?: string;
    /** 差分（別のサーバどうし・rsync が無いときは無い） */
    diff?: { files: number; bytes: number; deleted: number };
    /** 上書きされる・消えるファイル（そこから移したあとに変わったもの）。1件でもあれば承知が要る */
    overwritten: { count: number; head: string[] };
  };
  /** 押せない理由（無ければ押せる） */
  blockers: string[];
}

export interface RealMoveProgress {
  phase: "preparing" | "stopping" | "copying" | "verifying" | "finishing" | "done" | "failed";
  copiedBytes: number;
  totalBytes: number;
  current?: string;
  startedAt: string;
  endedAt?: string;
  reason?: string;
}

export interface RealMoveStatus {
  /** 移している途中の記録（立っている間は移している） */
  move?: { to: { runtime: string; root: string } };
  /** 進み具合（host が起き直したあとは無い） */
  progress?: RealMoveProgress;
}

export async function estimateRealRuntimeMove(projectId: string, target: { runtime: string; root: string }): Promise<RealMoveEstimate> {
  const query = `runtime=${encodeURIComponent(target.runtime)}&root=${encodeURIComponent(target.root)}`;
  return request<RealMoveEstimate>(`/api/projects/${encodeURIComponent(projectId)}/runtime-move/estimate?${query}`);
}

/** 移し始める。返るのは移している途中の Project（移す先の根は正規化したもの） */
export async function startRealRuntimeMove(
  projectId: string,
  target: { runtime: string; root: string; acknowledgeOverwrite?: boolean },
): Promise<RealProject & { move?: { to: { runtime: string; root: string } } }> {
  return request(`/api/projects/${encodeURIComponent(projectId)}/runtime-move`, { method: "POST", body: JSON.stringify(target) });
}

export async function fetchRealRuntimeMoveStatus(projectId: string): Promise<RealMoveStatus> {
  return request<RealMoveStatus>(`/api/projects/${encodeURIComponent(projectId)}/runtime-move`);
}

/** `remote:<名前>` から名前を引く（この機械のコンテナなら undefined） */
export function remoteRuntimeName(runtime: string | undefined): string | undefined {
  return runtime?.startsWith("remote:") ? runtime.slice("remote:".length) : undefined;
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
export type ModulePlacement = "project-container" | "instance-container" | "tools-container" | "host" | "remote";

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
 * **土台の指示の節ごとの文字数**（追加・2026-10-20、v4-frontend.md §6.50）。右上の文脈のメーターが SDK の「System prompt」を
 * Memory とそれ以外に按分するのに使う。数えるのはその会話で確定した Memory（会話の始まりの時点の行）
 */
export interface RealPromptFootprint {
  parts: { kind: string; chars: number }[];
  totalChars: number;
  projectMemoryLines: number;
}

export async function getRealPromptFootprint(threadId: string): Promise<RealPromptFootprint> {
  return request<RealPromptFootprint>(`/api/threads/${threadId}/prompt-footprint`);
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
  /** 仮想化（KVM）（2026-10-20）。host が扱えなければ null */
  virtualization: RealProjectVirtualization | null;
}

/**
 * **Project ごとの仮想化（KVM）**（決定・2026-10-20、v4-security.md §1「`containers` で仮想化（KVM）」の 2.。host の
 * `ContainersVirtualization.describe`）。`available` はその Project で使えるか（containers の実行場所で、許しているか）
 */
export interface RealProjectVirtualization {
  /** /dev/kvm と /dev/vhost-net を見せる */
  kvm: boolean;
  /** 人が足したカーネルモジュールの名前（`vhost_net` は含まない） */
  modules: string[];
  /** 2MiB の hugepages の数 */
  hugepages: number;
  /** 特権コンテナにする */
  privileged: boolean;
  available: boolean;
  /** 使えない理由 */
  reason?: string;
  /** 同じ実行場所の、ほかの特権の Project（閉じたもの・眠っているものも）。許していなくても返る */
  privilegedOnServer: Array<{ id: string; name: string }>;
}

/** 「/dev/kvm を見せる」を変える（Backlog 459 番）。`nesting` は「中で Docker を使う」の今の値（host は変えない） */
export async function setRealProjectKvm(
  projectId: string,
  enabled: boolean,
  modules: readonly string[],
): Promise<{ warnings: string[]; kvm: boolean; modules: string[]; nesting: boolean }> {
  return request<{ warnings: string[]; kvm: boolean; modules: string[]; nesting: boolean }>(`/api/projects/${projectId}/container/kvm`, {
    method: "PUT",
    body: JSON.stringify({ enabled, modules }),
  });
}

/** hugepages の数を変える（Backlog 460 番）。`total` はその実行場所の合計、`allocated` はサーバで確保できた数 */
export async function setRealProjectHugepages(
  projectId: string,
  count: number,
): Promise<{ warnings: string[]; hugepages: number; total: number; allocated: number }> {
  return request<{ warnings: string[]; hugepages: number; total: number; allocated: number }>(`/api/projects/${projectId}/container/hugepages`, {
    method: "PUT",
    body: JSON.stringify({ count }),
  });
}

/** 「特権コンテナにする」を変える（Backlog 461 番）。`confirmName` は人が打った Project の名前（オン・オフとも） */
export async function setRealProjectPrivileged(projectId: string, enabled: boolean, confirmName: string): Promise<{ privileged: boolean }> {
  return request<{ privileged: boolean }>(`/api/projects/${projectId}/container/privileged`, {
    method: "PUT",
    body: JSON.stringify({ enabled, confirmName }),
  });
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
  /** 眠っているのにコンテナが動いている（自動化のため一部起きている、§6.43）。今どおり測る */
  asleep?: true;
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
  /** 別のサーバ（追加・2026-10-14）。古い host は付けない */
  remotes?: RealRemoteResources[];
  /** 眠っている Project（追加・2026-10-16、§6.43）。コンテナが止まっているので量は無い——「スリープ中」と1行で出す */
  sleeping?: Array<{ projectId: string; name: string }>;
}

/** 別のサーバの資源（host の `remote-resources.ts` の `RemoteResources` と同じ形） */
export interface RealRemoteResources {
  runtime: string;
  address: string;
  projects: Array<{ projectId: string; name: string }>;
  unavailable?: string;
  busy: boolean;
  busyReason?: string;
  totalBytes?: number;
  availableBytes?: number;
  cores?: number;
  cpuUsed?: number;
  waiting?: RealResourceWaiting;
  bantoBytes?: number;
  otherBytes?: number;
  groups: RealResourceGroup[];
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
 * **見回りで使ってよい tool**（決定・2026-10-20、v4-frontend.md §6.47「Project の設定」、アーキ仕様 §4.4）。真実は host の
 * Configuration（Project の `patrol.allowedTools`）。一覧は host が Module の今の tool から導いたもの
 */
export type RealPatrolToolsModule =
  | { name: string; bundled: true; verified: string[] }
  | {
      name: string;
      bundled: false;
      tools: Array<{ name: string; description?: string; readOnlyHint?: boolean; openWorldHint?: boolean; allowed: boolean }>;
      resourcesAllowed: boolean;
    }
  | { name: string; bundled: boolean; error: string };

export interface RealPatrolTools {
  /** 人が許したもの（`<Module>/<tool>` と `<Module>/resources`） */
  allowed: string[];
  modules: RealPatrolToolsModule[];
}

export async function fetchRealPatrolTools(projectId: string): Promise<RealPatrolTools> {
  return request<RealPatrolTools>(`/api/projects/${projectId}/patrol-tools`);
}

/** 許す一覧そのものを置き換える */
export async function setRealPatrolTools(projectId: string, allowed: string[]): Promise<RealPatrolTools> {
  return request<RealPatrolTools>(`/api/projects/${projectId}/patrol-tools`, {
    method: "PUT",
    body: JSON.stringify({ allowed }),
  });
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
 * **空いた会話を冷める前に要約する**（決定・2026-10-20、ユーザー。アーキ仕様 §3.1）。Project にだけ置ける、値が無ければオン
 */
export async function fetchRealIdleCompaction(projectId: string): Promise<boolean> {
  return (await request<{ enabled: boolean }>(`/api/projects/${projectId}/idle-compaction`)).enabled;
}

export async function setRealIdleCompaction(projectId: string, enabled: boolean): Promise<boolean> {
  return (
    await request<{ enabled: boolean }>(`/api/projects/${projectId}/idle-compaction`, {
      method: "PUT",
      body: JSON.stringify({ enabled }),
    })
  ).enabled;
}

/**
 * **Project ごとの「AI への指示」**（決定・2026-10-09、ユーザー。v4-frontend.md §6.17）。空なら無し。上限は host だけが持つ——超えたら host が理由つきで断る（規則3）
 */
export async function fetchRealProjectInstruction(projectId: string): Promise<string> {
  return (await request<{ text: string }>(`/api/projects/${projectId}/instruction`)).text;
}

export async function setRealProjectInstruction(projectId: string, text: string): Promise<string> {
  return (
    await request<{ text: string }>(`/api/projects/${projectId}/instruction`, {
      method: "PUT",
      body: JSON.stringify({ text }),
    })
  ).text;
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

/**
 * **Claude のアカウント**（決定・2026-10-18、v4-frontend.md §6.46・v4-security.md §2「Claude のアカウントを複数持つ」）。
 * 真実は host の台帳（`packages/core/src/claude-login/accounts.ts`）。使用率は 0〜1、リセットを過ぎたものは host が落として返す
 */
export interface ClaudeUsageWindow {
  utilization: number;
  resetsAt?: string;
  status?: string;
}

export interface ClaudeAccountView {
  id: string;
  /** `host`＝このマシンの Claude Code のログイン（`~/.claude`、人の claude コマンドと共有）。外せない・banto からログインし直さない */
  kind: "host" | "banto";
  label: string;
  email?: string;
  subscriptionType?: string;
  rateLimitTier?: string;
  addedAt: string;
  usage?: { fiveHour?: ClaudeUsageWindow; sevenDay?: ClaudeUsageWindow; status?: string; statusResetsAt?: string; readAt: string };
  /** いまこのアカウントを使っている Project（上から順には中継が起こしてから覚えたもの、均すは直近1時間の固定） */
  usedBy: Array<{ projectId: string; name: string }>;
}

/** 使い方：`balance`＝均す（新しい会話ごとに余裕のあるものを選ぶ、既定）・`ordered`＝上から順に（v4-security.md §2「均す」） */
export type ClaudeAccountMode = "balance" | "ordered";

export interface ClaudeAccountsState {
  accounts: ClaudeAccountView[];
  /** banto 全体の使い方 */
  mode: ClaudeAccountMode;
  defaultOrder: string[];
  /** 0〜1 */
  thresholds: { fiveHour: number; sevenDay: number };
  /** 並びを決めてある Project（外すとその並びから消える） */
  projectOrders: Array<{ projectId: string; name: string; order: string[] }>;
  /** 最後に全部の使用率を読み直した時刻（起こしてから） */
  usageReadAt?: string;
  hostLogin?: RealClaudeLogin["hostLogin"];
  /** 中継が取り直せない banto の理由（会話の本体は今のログインだけを使う） */
  noRefreshReason?: string;
}

export async function fetchClaudeAccounts(): Promise<ClaudeAccountsState> {
  return request<ClaudeAccountsState>("/api/claude-accounts");
}

/** 全部のアカウントの使用率を `/api/oauth/usage` で読み直す。読めなかったものは `failures` に理由 */
export async function refreshClaudeAccountUsage(): Promise<ClaudeAccountsState & { failures: Array<{ accountId: string; reason: string }> }> {
  return request("/api/claude-accounts/usage", { method: "POST" });
}

/** 既定の並び・閾値（0〜1）・使い方。渡したものだけ変える */
export async function updateClaudeAccountSettings(patch: {
  mode?: ClaudeAccountMode;
  defaultOrder?: string[];
  thresholds?: { fiveHour: number; sevenDay: number };
}): Promise<ClaudeAccountsState> {
  return request<ClaudeAccountsState>("/api/claude-accounts/settings", { method: "PUT", body: JSON.stringify(patch) });
}

export async function renameClaudeAccount(id: string, label: string): Promise<ClaudeAccountsState> {
  return request<ClaudeAccountsState>(`/api/claude-accounts/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify({ label }) });
}

export async function removeClaudeAccount(id: string): Promise<void> {
  await request<{ ok: true }>(`/api/claude-accounts/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export async function startClaudeAccountLogin(): Promise<{ loginId: string; url: string; expiresAt: string }> {
  return request("/api/claude-accounts/login", { method: "POST" });
}

/** host が分けて返す失敗（`expired`・`state-mismatch`・`malformed`・`exchange-failed`・`unknown`・`account-mismatch`） */
export class ClaudeAccountLoginFailed extends Error {
  constructor(
    readonly code: string | undefined,
    message: string,
  ) {
    super(message);
  }
}

/**
 * 向こうの画面に出た `<コード>#<state>` を渡して交換する。`accountId` を渡すと「そのアカウントにログインし直す」
 * （違うアカウントが返ったら host が断る）。失敗は `ClaudeAccountLoginFailed`（画面が理由ごとに文を変える）
 */
export async function finishClaudeAccountLogin(
  loginId: string,
  pasted: string,
  accountId?: string,
): Promise<{ account: ClaudeAccountView; replaced: boolean }> {
  const res = await hostFetch(`/api/claude-accounts/login/${encodeURIComponent(loginId)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ pasted, ...(accountId ? { accountId } : {}) }),
  });
  const text = await res.text();
  let body: { error?: unknown; code?: unknown } | undefined;
  try {
    body = JSON.parse(text) as typeof body;
  } catch {
    body = undefined;
  }
  if (!res.ok) {
    const reason = typeof body?.error === "string" && body.error ? body.error : text.trim() || `banto host が ${res.status} を返しました`;
    throw new ClaudeAccountLoginFailed(typeof body?.code === "string" ? body.code : undefined, reason);
  }
  return body as unknown as { account: ClaudeAccountView; replaced: boolean };
}

export interface ClaudeAccountSwitchView {
  at: string;
  from: string;
  to: string;
  reason: { kind: "threshold"; window: "5h" | "7d"; utilization: number } | { kind: "rejected" | "recovered" | "order" | "unavailable" };
}

/** Project の並び（`order: null`＝既定のまま）・使い方（`mode: null`＝banto 全体と同じ）と観測 */
export interface ProjectClaudeAccounts {
  order: string[] | null;
  effectiveOrder: string[];
  mode: ClaudeAccountMode | null;
  effectiveMode: ClaudeAccountMode;
  /** 上から順に：最後に返事をしたアカウント */
  currentAccount?: string;
  /** 均す：生きている固定先（並びの順） */
  pinnedAccounts?: string[];
  recentSwitches?: ClaudeAccountSwitchView[];
}

export async function fetchProjectClaudeAccounts(projectId: string): Promise<ProjectClaudeAccounts> {
  return request<ProjectClaudeAccounts>(`/api/projects/${projectId}/claude-accounts`);
}

/** 渡したものだけ変える（`null`＝既定の並び・banto 全体の使い方に戻す） */
export async function setProjectClaudeAccounts(
  projectId: string,
  patch: { order?: string[] | null; mode?: ClaudeAccountMode | null },
): Promise<ProjectClaudeAccounts> {
  return request<ProjectClaudeAccounts>(`/api/projects/${projectId}/claude-accounts`, { method: "PUT", body: JSON.stringify(patch) });
}

/** 均すときのその会話の生きている固定先（v4-security.md §2「均す」の 9.）。まだ固定が無ければ `accountId` が無い */
export async function fetchThreadClaudeAccount(threadId: string): Promise<{ accountId?: string }> {
  return request<{ accountId?: string }>(`/api/threads/${encodeURIComponent(threadId)}/claude-account`);
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

/** **Project のグループ**（追加・2026-10-16、アーキ仕様 §2.2）。並びは host が決めた順 */
export async function listRealProjectGroups(): Promise<RealProjectGroup[]> {
  return request<RealProjectGroup[]>("/api/project-groups");
}

/** 色を省けば、host がまだ使っていない色を選ぶ。同じ名前（大文字小文字を区別しない）は 409 */
export async function createRealProjectGroup(name: string, color?: RealProjectGroupColor): Promise<RealProjectGroup> {
  return request<RealProjectGroup>("/api/project-groups", {
    method: "POST",
    body: JSON.stringify({ name, ...(color ? { color } : {}) }),
  });
}

export async function updateRealProjectGroup(
  id: string,
  patch: { name?: string; color?: RealProjectGroupColor },
): Promise<RealProjectGroup> {
  return request<RealProjectGroup>(`/api/project-groups/${id}`, { method: "PATCH", body: JSON.stringify(patch) });
}

/** なくしても中の Project は消えない——グループの外へ出る（host） */
export async function removeRealProjectGroup(id: string): Promise<void> {
  await request(`/api/project-groups/${id}`, { method: "DELETE" });
}

export async function setRealProjectGroupOrder(ids: string[]): Promise<void> {
  await request("/api/project-groups/order", { method: "PUT", body: JSON.stringify({ ids }) });
}

/** Project をグループに入れる・出す（`null` でグループの外）。`order`（Project 全部の並び）を添えると位置も同じ1回で書く */
export async function assignRealProjectGroup(projectId: string, groupId: string | null, order?: string[]): Promise<RealProject> {
  return request<RealProject>(`/api/projects/${projectId}/group`, {
    method: "PUT",
    body: JSON.stringify({ groupId, ...(order ? { order } : {}) }),
  });
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

/**
 * **受信箱から返信を送る**（追加・2026-10-15、v4-frontend.md §6.41）。会話の入力欄と同じ口（`POST /api/threads/:id/messages`）で
 * その Thread にターンを始める。**流れは読まない**——host は受け付けた時点で最後まで走らせる（画面が切れても止まらない。
 * `streamRealTurn` の「ターンは host で続いている」と同じ）。開いている会話には `turn.started` で最新が出る
 * （`latest-state.ts`）。断られたら理由を投げる（別の実行場所へ移している等）
 */
export async function sendRealThreadMessage(
  threadId: string,
  prompt: string,
  /** 見回りの気づきの引用（「やって」「任務にする」、§6.47）。中身は host が受信箱から組む */
  options: { findingId?: string } = {},
): Promise<void> {
  const res = await hostFetch(`/api/threads/${threadId}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ prompt, ...(options.findingId ? { quotes: [{ finding: options.findingId }] } : {}) }),
  });
  if (!res.ok || !res.body) {
    const reason = ((await res.json().catch(() => null)) as { error?: string } | null)?.error;
    throw new Error(reason ?? `送れませんでした（${res.status}）`);
  }
  // 受け付けた（流れが始まった）ところで読むのをやめる
  await res.body.cancel().catch(() => undefined);
}

/** 見回りの気づきの「今後知らせない」（`mute`）・「片づけた」（`dismiss`）。手帳にも残る */
export async function closeRealFinding(id: string, action: "mute" | "dismiss"): Promise<void> {
  await request(`/api/inbox/${id}/finding`, { method: "POST", body: JSON.stringify({ action }) });
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
      /** 答えに添える欄（任務の枠、追加・2026-10-20、v4-frontend.md §6.47） */
      requestedSchema?: unknown;
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
  /** Module の画面から人が添えたもの（追加・2026-10-15） */
  quotes: readonly OutgoingQuote[] = [],
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
          ...(quotes.length > 0 ? { quotes } : {}),
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
  /** 引数のファイルの拡張子で画面を選び替える（`dev.banto/ui-by-extension`、追加・2026-10-15）。選ぶのは `ui-by-extension.ts` */
  byExtension?: UiByExtension;
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
  /**
   * 道具用のコンテナで動く Module だけ：名乗ったパッケージを入れているところか、入れられなかったか（追加・2026-10-15）。
   * 入れられなかったら毎回はやり直さない——人が「道具を入れ直す」を押す
   */
  toolsInstall?: { state: "installing" } | { state: "failed"; reason: string };
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
  /** 一緒に入っていないと動かない目録の Module の id（host が目録から決める） */
  requires: string[];
  /** 接続先ごとに名前を付けて1本ずつ入れるもの（まとめて入れる対象ではない） */
  perConnection: boolean;
  /** いま入れてある名前（目録と同じコードを指す宣言） */
  installed: string[];
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

/** まとめて入れた結果の1行（`installCatalogBulk`） */
export interface RealCatalogBulkResult {
  id: string;
  name?: string;
  status: "installed" | "already" | "failed";
  requiredBy?: string[];
  error?: string;
}

/**
 * **目録から何本かをまとめて入れる**（追加・2026-10-18、ユーザー決定）。画面が送るのは目録の id だけ
 * ——要るもの・名前・入れてあるかは host が決め、行ごとの結果を返す
 */
export async function installRealModulesFromCatalog(ids: readonly string[]): Promise<RealCatalogBulkResult[]> {
  const res = await request<{ results: RealCatalogBulkResult[] }>("/api/modules/catalog/bulk", {
    method: "POST",
    body: JSON.stringify({ ids }),
  });
  return res.results;
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

/** 道具用のコンテナにパッケージを入れ直す（入れられなかったとき）。入れ終わるのは待たない */
export async function retryRealModuleTools(name: string): Promise<void> {
  await request(`/api/modules/${encodeURIComponent(name)}/tools/retry`, { method: "POST" });
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

// ---- 自動化（v4-frontend.md §6.42、アーキ仕様 §4.3）。台帳は host（`automation/store.ts`）、画面は写しを持つだけ ----

/** 時刻の繰り返し。`time` は "H:MM"（24時間）、`day` は 0＝日曜 */
export type RealAutomationRepeat =
  | { kind: "daily"; time: string }
  | { kind: "weekdays"; time: string }
  | { kind: "weekly"; day: number; time: string }
  | { kind: "interval"; hours: number }
  | { kind: "cron"; expr: string };

/**
 * きっかけの出どころ。`webhook` の受け口の URL は作った応答（`webhookUrl`）でだけ返る——写しには無い（アーキ仕様 §4.3）
 */
export type RealAutomationSource =
  | { kind: "time"; repeat: RealAutomationRepeat; timeZone: string }
  | {
      kind: "webhook";
      /** 無ければ署名を確かめない */
      signature?: { header: string; alias: string };
      /** 続けて届いたものをまとめる待ち時間（秒）。0 は1件ずつ */
      batchSeconds: number;
      allowProjectContainer: boolean;
    }
  | {
      /** Module が名乗る出来事（アーキ仕様 §4.3「段2」）。`where` は属性の「等しい／どれか」 */
      kind: "event";
      event: string;
      where?: Record<string, string | number | boolean | Array<string | number | boolean>>;
      batchSeconds: number;
      /** この自動化自身の回が起こした出来事でも動く（既定 false） */
      allowSelfTriggered: boolean;
    };

/** 作るときに渡す Webhook の出どころ。署名を確かめないなら `signature: false`（既定はオンなので明示する） */
export type RealAutomationSourceInput =
  | Extract<RealAutomationSource, { kind: "time" }>
  | Extract<RealAutomationSource, { kind: "event" }>
  | (Omit<Extract<RealAutomationSource, { kind: "webhook" }>, "signature"> & { signature: { header: string; alias: string } | false });

/** 出来事の属性の名乗り（`@banto/module-contract` の `EventFieldDeclaration` のまま） */
export interface RealEventField {
  type: "string" | "number" | "boolean";
  title: string;
  enum?: Array<string | number | boolean>;
}

/** 出来事1つの名乗り（`EventDeclaration` のまま。core は中身を知らずに見せる） */
export interface RealEventDeclaration {
  name: string;
  title: string;
  description: string;
  fields: Record<string, RealEventField>;
  subject?: string;
}

/** 出どころ（Module の名前か `banto`）ごとの名乗り */
export interface RealAutomationEventSource {
  source: string;
  events: RealEventDeclaration[];
}

/** その Project で待てる出来事（banto 自身が先頭） */
export async function listRealAutomationEvents(projectId: string): Promise<RealAutomationEventSource[]> {
  const body = await request<{ sources: RealAutomationEventSource[] }>(`/api/projects/${encodeURIComponent(projectId)}/automation-events`);
  return body.sources;
}

/** 届け先。`dedicated` の `threadId` は host が専用の Fork を立てたあとに入る */
export type RealAutomationTarget =
  | { kind: "dedicated"; mode: "fresh" | "continue"; threadId?: string }
  | { kind: "thread"; threadId: string };

export type RealAutomationRunResult = "running" | "done" | "failed" | "waiting" | "skipped" | "rejected";

export interface RealAutomationRun {
  runId: string;
  /** 実際に動いた時刻（ISO） */
  at: string;
  cause: "clock" | "manual" | "webhook" | "event";
  result: RealAutomationRunResult;
  reason?: string;
  threadId?: string;
  rotatedFrom?: string;
  /** 時計で動いた回の予定の時刻 */
  scheduledFor?: string;
  delayed?: string;
  /** Webhook・出来事で受けたもののうち、この回にまとめて届けた件数 */
  received?: number;
}

/** 人が作り・直せる欄 */
export interface RealAutomationFields {
  name: string;
  instruction: string;
  source: RealAutomationSource;
  target: RealAutomationTarget;
  reviewOnDone: boolean;
  /** 見回り（§6.47）。無ければふつう。作ったあと変えない */
  mode?: "patrol";
  /** 見回りの1日の気づきの上限 */
  dailyFindingLimit?: number;
}

/** 見回りの手帳の1行（`key` ごと。新しい順） */
export interface RealPatrolNote {
  key: string;
  title: string;
  firstSeenAt: string;
  lastSeenAt: string;
  notifiedAt?: string;
  status: "notified" | "muted" | "dismissed";
}

export interface RealAutomation extends RealAutomationFields {
  id: string;
  projectId: string;
  createdBy: { kind: "human" } | { kind: "ai"; threadId: string };
  createdAt: string;
  updatedAt: string;
  paused: boolean;
  pausedReason?: string;
  /** 新しい順（最大 50 件） */
  runs: RealAutomationRun[];
  /** 次に時計で動く時刻（host が毎回計算して添える。一時停止中は無い） */
  nextFireAt?: string;
  /** Webhook で受けて、まだ届けていないもの（古い順） */
  received?: { receivedId: string; at: string }[];
  /** 見回りの手帳（見回りだけ） */
  notebook?: RealPatrolNote[];
}

/** 見回りの手帳の「知らせない」を外す */
export async function unmuteRealPatrolNote(projectId: string, id: string, key: string): Promise<RealAutomation> {
  return request<RealAutomation>(`/api/projects/${encodeURIComponent(projectId)}/automations/${encodeURIComponent(id)}/unmute`, {
    method: "POST",
    body: JSON.stringify({ key }),
  });
}

/** 作る・直すときに渡す欄（Webhook の署名を切るときは `false`） */
export type RealAutomationInput = Omit<RealAutomationFields, "source"> & { source: RealAutomationSourceInput };

export async function listRealAutomations(projectId: string): Promise<RealAutomation[]> {
  const body = await request<{ automations: RealAutomation[] }>(`/api/projects/${encodeURIComponent(projectId)}/automations`);
  return body.automations;
}

/**
 * 作る。Webhook なら受け口の URL（`webhookUrl`）が**この応答でだけ**返る——印は host に残らない（見失ったら作り直す）。
 * 判断役（`banto.turn-decisions` を待つ）なら案内（`notices`：まとめがオフ・自動許可は効かない）が添わることがある
 */
export async function createRealAutomation(
  projectId: string,
  fields: RealAutomationInput,
): Promise<RealAutomation & { webhookUrl?: string; notices?: string[] }> {
  return request<RealAutomation & { webhookUrl?: string; notices?: string[] }>(`/api/projects/${encodeURIComponent(projectId)}/automations`, {
    method: "POST",
    body: JSON.stringify(fields),
  });
}

/** 欄を直す・一時停止（`paused: true`）・再開（`paused: false`） */
export async function updateRealAutomation(
  projectId: string,
  id: string,
  changes: Partial<RealAutomationInput> & { paused?: boolean },
): Promise<RealAutomation> {
  return request<RealAutomation>(`/api/projects/${encodeURIComponent(projectId)}/automations/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify(changes),
  });
}

export async function removeRealAutomation(projectId: string, id: string): Promise<void> {
  await request<{ ok: true }>(`/api/projects/${encodeURIComponent(projectId)}/automations/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
}

/** 今すぐ動かす。届けなかった（閉じている等）ときも `skipped` と理由が返る。前の回が終わっていなければ投げる（409） */
export async function runRealAutomation(
  projectId: string,
  id: string,
): Promise<{ runId: string; result: "running" | "skipped"; reason?: string; threadId?: string }> {
  return request(`/api/projects/${encodeURIComponent(projectId)}/automations/${encodeURIComponent(id)}/run`, { method: "POST" });
}

/** その Project から使える秘密の alias の名前（Webhook の署名の鍵の選び先）。値は通らない */
export async function listRealSecretAliases(projectId: string): Promise<string[]> {
  const body = await request<{ aliases: string[] }>(`/api/projects/${encodeURIComponent(projectId)}/secret-aliases`);
  return body.aliases;
}

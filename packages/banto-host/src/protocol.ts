/**
 * 番頭ホストの WS プロトコル（task-0009）。
 *
 * Kobo が「HTTP＋WS、GUI/CLI はその同格クライアント」という形をとるのに合わせ、
 * Banto も同じ形にする。CLI も WebUI もこの1つの契約にぶら下がる。
 *
 * 番頭側は常に**論理名**（`kobo.query.ready` 等）で通知する。wire名（`kobo__query__ready`）は
 * プロバイダとの境界に閉じ、クライアントには漏らさない（ADR-0010 決定22）。
 *
 * D6: 型定義のみ。依存なし。
 */

// ── Client → Server ──────────────────────────────────────────────────────────

/** 番頭に発話する。ターンが走り、結果はイベントとして返る。 */
export interface PromptMessage {
  type: "prompt";
  text: string;
}

/** 実行中のターンを中断する。 */
export interface AbortMessage {
  type: "abort";
}

export type ClientMessage = PromptMessage | AbortMessage;

// ── Server → Client ──────────────────────────────────────────────────────────

/** キャンバスに開けるGUIのカタログエントリ（UIがコンポーネントを解決するのに使う）。 */
export interface CatalogEntryView {
  kind: string;
  title: string;
  description: string;
  /** 描画する React コンポーネントのエクスポート名（決定17・決定12）。 */
  component: string;
  category?: string;
  icon?: string;
}

/** 接続直後に1度だけ送られる。現在のセッション情報。 */
export interface WelcomeEvent {
  type: "welcome";
  sessionId: string;
  /** 番頭が使えるToolの論理名一覧。 */
  tools: string[];
  /** キャンバスに開けるGUIの一覧。 */
  catalog: CatalogEntryView[];
}

/** アシスタント応答のテキスト差分。 */
export interface TextDeltaEvent {
  type: "text_delta";
  delta: string;
}

/** Tool実行の開始。name は論理名（決定22）。 */
export interface ToolStartEvent {
  type: "tool_start";
  toolCallId: string;
  name: string;
}

/** Tool実行の終了。name は論理名（決定22）。 */
export interface ToolEndEvent {
  type: "tool_end";
  toolCallId: string;
  name: string;
  isError: boolean;
}

/** ターンの終わり。クライアントは入力可能状態に戻ってよい。 */
export interface TurnEndEvent {
  type: "turn_end";
  /** プロバイダ側でエラーが起きた場合の説明。正常時は undefined。 */
  errorMessage?: string;
}

/** キャンバスに開かれているタブ（表示状態の配信用）。 */
export interface CanvasTabView {
  id: string;
  kind: string;
  title: string;
  params: Record<string, unknown>;
}

/**
 * キャンバスの表示状態。接続直後と、状態が変わるたびに送られる。
 * D3: 真実はホスト側の Canvas が持ち、UIはこれを描くだけで独自状態を持たない。
 */
export interface CanvasStateEvent {
  type: "canvas_state";
  tabs: CanvasTabView[];
  activeTabId: string | undefined;
}

/** プロトコル違反・処理不能。I2: 黙って捨てずクライアントへ返す。 */
export interface ErrorEvent {
  type: "error";
  message: string;
}

export type ServerEvent =
  | WelcomeEvent
  | TextDeltaEvent
  | ToolStartEvent
  | ToolEndEvent
  | TurnEndEvent
  | CanvasStateEvent
  | ErrorEvent;

/** WSのパス。Kobo（/ws）と同じ流儀。 */
export const BANTO_WS_PATH = "/ws";

/** 既定ポート。Kobo の 3000 と衝突しない値。 */
export const BANTO_DEFAULT_PORT = 4100;

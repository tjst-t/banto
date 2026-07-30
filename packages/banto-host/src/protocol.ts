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

/** POが直接タブを切り替える。番頭の canvas.switch と同じ結果になる。 */
export interface CanvasSwitchMessage {
  type: "canvas_switch";
  tabId: string;
}

/** POが直接タブを閉じる。 */
export interface CanvasCloseMessage {
  type: "canvas_close";
  tabId: string;
}

/**
 * 会話を捨てて新しくやり直す。記憶（好み・習慣）は残る——番頭に記憶があるからこそ
 * 会話は使い捨てにできる（D11）。キャンバスの表示はそのまま維持する。
 */
export interface NewSessionMessage {
  type: "new_session";
}

export type ClientMessage =
  | PromptMessage
  | AbortMessage
  | CanvasSwitchMessage
  | CanvasCloseMessage
  | NewSessionMessage;

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
  /** このGUIを提供しているモジュール名（決定25・27）。 */
  module: string;
  /**
   * そのモジュールへの到達先（決定25）。UI はここからデータを取りに行く——
   * コンポーネント側にエンドポイントを直書きしない。組み込みモジュールは
   * `/api/...` のような相対パスで、UI が自分のオリジンに解決する。
   */
  endpoint: string;
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

/**
 * 会話の1行。ホスト側が真実を持ち、接続時に history として丸ごと配る。
 * これによりリロードしても会話が消えず、途中から繋いだクライアントも履歴を見られる（D3）。
 */
export type TranscriptEntry =
  | { role: "po"; text: string }
  | { role: "banto"; text: string }
  | { role: "tool"; name: string; state: "running" | "ok" | "failed" }
  | { role: "error"; text: string };

/** 接続直後に送られる会話履歴。 */
export interface HistoryEvent {
  type: "history";
  entries: TranscriptEntry[];
}

/** POの発話。送った本人以外のクライアントにも届く。 */
export interface PoMessageEvent {
  type: "po_message";
  text: string;
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
  | HistoryEvent
  | PoMessageEvent
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

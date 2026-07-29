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

/** 接続直後に1度だけ送られる。現在のセッション情報。 */
export interface WelcomeEvent {
  type: "welcome";
  sessionId: string;
  /** 番頭が使えるToolの論理名一覧。 */
  tools: string[];
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
  | ErrorEvent;

/** WSのパス。Kobo（/ws）と同じ流儀。 */
export const BANTO_WS_PATH = "/ws";

/** 既定ポート。Kobo の 3000 と衝突しない値。 */
export const BANTO_DEFAULT_PORT = 4100;

/**
 * モジュール間呼び出しの wire 契約（ADR-0010 決定27b）。
 *
 * **定数と型だけ**を置く——ブラウザ（UI）からも import されるため、node への依存を持たない。
 * レジストリの読み込みとクライアント実装は module-invocation.ts（node 側）にある。
 *
 * 呼び手は2種類あるが契約は1つ（決定25・27b）：
 *   - UI（人の経路）：`details` の構造化データを読む
 *   - 他のモジュール：ModuleClient から呼ぶ
 */

/**
 * Tool 呼び出しのパス接頭辞。`{baseUrl}/tools/{論理Tool名}` に POST する。
 * 論理名（ドット区切り）をそのままパスに置く——URL パスはドットを許容するため、
 * 決定22 の wire 名変換（LLM プロバイダ向け）は不要。
 */
export const MODULE_TOOL_PATH = "/tools/";

/** 呼び出しのリクエストボディ。 */
export interface ModuleToolRequest {
  args: Record<string, unknown>;
}

/**
 * 呼び出しの結果。Tool の戻り値をそのまま運ぶ。
 * `content` は人・LLM 向けのテキスト、`details` は機械向けの構造化データ——
 * UI は `details` を、番頭は `content` を読む（同じ実装の上の2つの口。D5）。
 */
export interface ModuleToolResult {
  content: Array<{ type: string; text?: string }>;
  details?: unknown;
}

/** エラー応答のボディ。 */
export interface ModuleToolError {
  error: string;
}

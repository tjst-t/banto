/**
 * 「モデルを呼べない」系のエラーを見分ける純粋な口（task-0289）。
 *
 * ## 背景
 *
 * 2026-08-19、OpenRouter のクレジット切れ（402 Insufficient credits）でターンが
 * 落ち続け、工場が17時間止まった。`task_stalled` の知らせは正しく届いていたが、
 * 開き直すたびに同じエラーで落ち、誰も気づけなかった——journal（journalctl）にも
 * `Insufficient credits` は一件も残っていない。会話の jsonl を開かない限り分からず、
 * しかもその会話は畳んだ枝なので誰も開かない。
 *
 * ## ここでやること
 *
 * 判定・文面づくりを**純粋な関数**として切り出す（D5：server.ts のあちこちに
 * 判定を散らさない）。誤検知は「幹を余計に起こす」実害が大きいので、
 * **迷ったら呼べない系として扱わない**（背景に貼った実物の形にだけ強く反応する）。
 */

/** 「モデルを呼べない」と判定したときの理由の一言。journal・札の両方で使う。 */
export type LlmUnavailableReason = string;

/**
 * 本文の先頭が HTTP のエラーステータス（401/402/403）で始まっているか。
 *
 * `Error` を `String()` した形（`Error: 401: ...`）も拾えるよう、先頭の
 * `Error: ` は剥がしてから見る。数字の後に別の数字が続く（`4012` のような
 * 無関係な値）ときは拾わない。
 */
const HTTP_STATUS_PATTERN = /^(?:Error:\s*)?(401|402|403)\b/;

/** 認証切れ・与信切れの実物の言い回し（OpenRouter・opencode）。 */
const KEYWORD_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /insufficient credits/i, reason: "Insufficient credits" },
  { pattern: /insufficient balance/i, reason: "Insufficient balance" },
  { pattern: /creditserror/i, reason: "CreditsError" },
  { pattern: /invalid[\s_-]?api[\s_-]?key/i, reason: "invalid api key" },
  { pattern: /\bunauthorized\b/i, reason: "Unauthorized" },
];

/**
 * エラー本文が「モデルを呼べない」系か見分け、理由の一言を返す。
 * 当てはまらなければ `undefined`（＝呼べない系として扱わない）。
 *
 * 見るのは**この本文だけ**——道具のエラー・中断（`Request was aborted`）などは
 * どれにも当たらず `undefined` になる（a4）。
 */
export function detectLlmUnavailable(errorMessage: string): LlmUnavailableReason | undefined {
  const text = errorMessage.trim();
  if (text === "") return undefined;
  for (const { pattern, reason } of KEYWORD_PATTERNS) {
    if (pattern.test(text)) return reason;
  }
  const statusMatch = text.match(HTTP_STATUS_PATTERN);
  if (statusMatch) return `HTTP ${statusMatch[1]}`;
  return undefined;
}

/** そのターンの出所のうち、**自分以外**（誰かがこの会話に何かを頼んでいた）もの。 */
const REQUESTED_BY_OTHERS = new Set(["kobo", "worker", "nudge", "thread"]);

/**
 * そのターンの出所が「自分以外」か（＝親の幹へ上げる価値があるか）。
 *
 * PO 自身の発話（`po`）や、出所を名乗らない `system`／`env` は、還す相手も
 * 頼んだ相手も PO 自身なので、幹の札にしても誰も得しない。
 */
export function shouldEscalateLlmUnavailable(source: string | undefined): boolean {
  return source !== undefined && REQUESTED_BY_OTHERS.has(source);
}

/** その会話のモデル座標を1行に整える（無ければ「未設定」）。 */
export function formatModelCoordinate(
  model: { backend?: string; provider: string; id: string } | undefined
): string {
  if (!model) return "(未設定)";
  return model.backend ? `${model.backend}:${model.provider}/${model.id}` : `${model.provider}/${model.id}`;
}

/** journal（console.error）へ出す1行（a1）。会話 id・出所・モデル座標・理由を持つ。 */
export function formatLlmUnavailableLog(params: {
  threadId: string;
  source: string;
  model: string;
  reason: string;
}): string {
  return (
    `[banto] モデルを呼べません（呼べない系のエラー）: ` +
    `会話=${params.threadId} 出所=${params.source} モデル=${params.model} 理由=${params.reason}`
  );
}

/** 知らせの本文の頭を切り詰める（幹の札に載せる分・a2）。 */
export function noticeHead(text: string, max = 200): string {
  const trimmed = text.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed;
}

/**
 * 親の幹へ立てる札の本文（a2）。**どの会話が・どの知らせを・なぜ捌けなかったか**を持つ。
 * 幹はその枝の中を見ていないので、知らせの本文の頭がないと手が打てない。
 */
export function formatLlmUnavailableCard(params: {
  threadTitle: string;
  threadId: string;
  noticeHead: string;
  model: string;
  reason: string;
}): string {
  return (
    `「${params.threadTitle}」（${params.threadId}）が、モデルを呼べないため知らせを捌けませんでした。\n` +
    `モデル: ${params.model} / 理由: ${params.reason}\n` +
    `捌けなかった知らせ（頭200字まで）:\n${params.noticeHead}`
  );
}

/** 同一会話・同一理由の札を連打しない間隔（watchdog.ts の nudge cooldown と揃える・a3）。 */
export const LLM_UNAVAILABLE_ESCALATION_COOLDOWN_MS = 10 * 60_000;

/**
 * 前回の札からこの間隔内か（連打の抑制・a3）。
 *
 * 履歴の持ち方（呼び出し側が持つ Map）は watchdog.ts の `nudgedAt` と揃える——
 * ここは純粋な判定だけを持ち、Map への読み書きは呼び出し側の責務（D5）。
 */
export function withinLlmUnavailableCooldown(
  lastEscalatedAt: number | undefined,
  now: number,
  cooldownMs: number = LLM_UNAVAILABLE_ESCALATION_COOLDOWN_MS
): boolean {
  return lastEscalatedAt !== undefined && now - lastEscalatedAt < cooldownMs;
}

/** 連打の抑制に使う履歴の鍵（会話 × 理由）。 */
export function llmUnavailableCooldownKey(threadId: string, reason: string): string {
  return `${threadId}::${reason}`;
}

/**
 * Claude Code（Agent SDK）で職人を動かすときの、名前の対応表（純関数だけ）。
 *
 * Worker Pool の公開の口（`worker.delegate` の `tools` / `modelTier` / `model`）は
 * ランタイム中立に保つ。**呼ぶ側に「Claude では Read で pi では read」と書かせない**
 * ——そこを覚えさせると、番頭の指示がランタイムに縛られる（決定3：モジュールは
 * ハーネスに依存しない）。変換はここ1箇所に集める。
 *
 * D5: 判断は無い。名前を写すだけ。
 * D6: 依存なし（driver からもホスト側の子プロセスからも読めるように、素の TS で書く）。
 */

/** ランタイムの識別子（`@banto/core` の DriverId と同じ綴り）。 */
export const CLAUDE_AGENT_DRIVER_ID = "claude-agent-sdk";

/** この拡張が職人に足す MCP サーバの名前。Tool の wire名は `mcp__<server>__<tool>`。 */
export const BANTO_MCP_SERVER = "banto";

/** 報告・質問の Tool（Claude 側の wire名）。 */
export const CLAUDE_REPORT_TOOL = `mcp__${BANTO_MCP_SERVER}__report`;
export const CLAUDE_ASK_TOOL = `mcp__${BANTO_MCP_SERVER}__ask`;

/** 報告経路の Tool 名（許可リストを絞るときに必ず残すもの）。 */
export const CLAUDE_REPORT_TOOL_NAMES: readonly string[] = [CLAUDE_REPORT_TOOL, CLAUDE_ASK_TOOL];

/**
 * 工場（Kobo）の口の名前（PO報告 2026-08-11）。
 *
 * **絞り込みで消してはいけない。** これが無いと、実装を終えても工場へ伝えられず、
 * 監査人は判定の出しようが無い——タスクが1本も完走しなくなる（実機でそうなった）。
 * 生えるのは Kobo が起こした職人だけ（`BANTO_DAEMON_URL` があるとき）。
 */
export const CLAUDE_KOBO_TOOL_NAMES: readonly string[] = [
  `mcp__${BANTO_MCP_SERVER}__report_phase`,
  `mcp__${BANTO_MCP_SERVER}__report_done`,
  `mcp__${BANTO_MCP_SERVER}__audit_report`,
];

/** 外を読む口。`network: true` のときだけ渡す（imp-0005 と同じ扱い）。 */
export const CLAUDE_WEB_TOOL_NAMES: readonly string[] = ["WebFetch", "WebSearch"];

/**
 * 中立な道具名 → Claude Code の道具名。
 *
 * 左側は pi の組み込みと Worker Pool の拡張が使っている名前（番頭が `worker.delegate` の
 * `tools` に書く名前）。`ls` と `find` はどちらも Claude では Glob が担う。
 */
const TOOL_ALIASES: Readonly<Record<string, readonly string[]>> = {
  read: ["Read"],
  write: ["Write"],
  edit: ["Edit"],
  bash: ["Bash"],
  grep: ["Grep"],
  find: ["Glob"],
  ls: ["Glob"],
  list: ["Glob"],
  glob: ["Glob"],
  todo: ["TodoWrite"],
  task: ["Task"],
  "web.fetch": ["WebFetch"],
  web__fetch: ["WebFetch"],
  "web.search": ["WebSearch"],
  web__search: ["WebSearch"],
  "worker.report": [CLAUDE_REPORT_TOOL],
  worker__report: [CLAUDE_REPORT_TOOL],
  "worker.ask": [CLAUDE_ASK_TOOL],
  worker__ask: [CLAUDE_ASK_TOOL],
};

/**
 * 中立な道具名の並びを Claude Code の道具名へ写す。
 *
 * - 対応表に無い名前は**そのまま通す**。番頭が Claude の名前（`Read` や
 *   `mcp__…`）を直に書いた場合に落とさないため——ここで黙って捨てると、
 *   絞ったつもりの許可リストが空になり、道具の無い職人が生まれる（I2）。
 * - 重複は畳む。
 */
export function toClaudeToolNames(requested: readonly string[]): string[] {
  const out: string[] = [];
  for (const name of requested) {
    const mapped = TOOL_ALIASES[name] ?? TOOL_ALIASES[name.toLowerCase()] ?? [name];
    for (const claudeName of mapped) {
      if (!out.includes(claudeName)) out.push(claudeName);
    }
  }
  return out;
}

/** モデルの等級（`@banto/core` の ModelTier と同じ並び。ここでは型依存を持たない）。 */
export type ClaudeModelTier = "reasoning" | "standard" | "fast";

/**
 * 等級 → Claude Code のモデル別名。
 *
 * **別名で持つ**（`opus` / `sonnet` / `haiku`）。世代が上がるたびに `claude-opus-5` の
 * ような具体名を書き換えて回るのは、この表が持つべき仕事ではない——解決は Claude Code に任せる。
 * 具体名を指定したいときは `model` で直に渡せる（番頭が選べる・PO要望 2026-08-10）。
 */
export const CLAUDE_TIER_MODELS: Readonly<Record<ClaudeModelTier, string>> = {
  reasoning: "opus",
  standard: "sonnet",
  fast: "haiku",
};

/** モデル指定が無いときの既定。 */
export const CLAUDE_DEFAULT_MODEL = CLAUDE_TIER_MODELS.standard;

/**
 * 設定画面に並べる Claude Code のモデル。
 *
 * **別名で持つ**（具体名を並べない）。世代が上がるたびに一覧を書き換えて回ることになるし、
 * 書き換え忘れれば画面には古い世代が並ぶ——別名なら Claude Code が最新へ解決する。
 * 具体名（`claude-opus-5` 等）を使いたいときは、`worker.delegate` の `model` や
 * 工場の役割設定に直接書けば通る（この一覧は選ばせるためのものであって、制限ではない）。
 */
export const CLAUDE_KNOWN_MODELS: ReadonlyArray<{ value: string; label: string }> = [
  { value: "opus", label: "opus（いちばん賢い・高い）" },
  { value: "sonnet", label: "sonnet（釣り合いが良い）" },
  { value: "haiku", label: "haiku（速い・安い）" },
];

/**
 * その名前は Claude Code のモデルか（純関数）。
 *
 * 名指しからランタイムを言い当てるために使う——番頭や工場に「どのランタイムか」を
 * 併記させると、モデルを変えるたびに2か所を直す羽目になる。
 */
export function isClaudeModelName(model: string): boolean {
  const name = model.trim().toLowerCase();
  if (name.length === 0) return false;
  if (CLAUDE_KNOWN_MODELS.some((m) => m.value === name)) return true;
  return name.startsWith("claude");
}

/**
 * 使うモデルを決める。**明示の指定が最優先**（番頭が選んだものを等級で上書きしない）。
 *
 * @param model 番頭が名指ししたモデル（`opus` / `claude-opus-5` など）
 * @param tier  名指しが無いときの等級
 * @param fallback どちらも無いときの既定
 */
export function resolveClaudeModel(
  model?: string,
  tier?: ClaudeModelTier,
  fallback: string = CLAUDE_DEFAULT_MODEL
): string {
  if (model && model.trim().length > 0) return model.trim();
  if (tier) return CLAUDE_TIER_MODELS[tier];
  return fallback;
}

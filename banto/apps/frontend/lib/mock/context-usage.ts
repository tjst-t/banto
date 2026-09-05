import type { ThreadId } from "./types";

// 文脈内訳（§2.10 D群、§8実測）。`getContextUsage()` が返す内訳を模す——
// system prompt・tools・messages・MCP tools・memory files 別のトークン数。
// Skill は名前と出所ごと、MCP はサーバごと、Memory はファイルごとに内訳が
// 取れる（§5.7・実測 2026-08-30）。

export interface ContextUsageItem {
  name: string;
  tokens: number;
}

export interface ContextCategory {
  id: string;
  label: string;
  tokens: number;
  /** カテゴリ色を塗るか（塗るのは中身がある実データだけ。バッファ・空きは中立色） */
  kind: "content" | "reserved";
  /** Skill・MCP・Memory は名前ごとの内訳が取れる（§5.7） */
  items?: readonly ContextUsageItem[];
}

export interface ContextUsage {
  windowTokens: number;
  /** 合計は windowTokens に一致する（reserved 含む） */
  categories: readonly ContextCategory[];
  /**
   * 窓の外にある tool 定義（`deferred`）——モデルの文脈には入らないので
   * windowTokens の合計に含めない（実測 2026-08-30）
   */
  deferred: readonly ContextUsageItem[];
}

export function getContextUsage(threadId: ThreadId): ContextUsage {
  // モック：Thread ごとに多少ぶれさせる（実データへ繋いだときの見え方に近づける）
  const jitter = (threadId.length % 5) * 400;

  return {
    windowTokens: 200_000,
    categories: [
      { id: "system-tools", label: "System tools", tokens: 24_000 + jitter, kind: "content" },
      {
        id: "skills",
        label: "Skills",
        tokens: 3_200,
        kind: "content",
        items: [
          { name: "banto/repo-workflow（banto 標準）", tokens: 1_200 },
          { name: "community/lint-helper（第三者）", tokens: 2_000 },
        ],
      },
      {
        id: "mcp-tools",
        label: "MCP tools",
        tokens: 8_400,
        kind: "content",
        items: [
          { name: "banto.repo", tokens: 3_000 },
          { name: "banto.fs", tokens: 2_600 },
          { name: "banto.vault-local", tokens: 2_800 },
        ],
      },
      {
        id: "memory",
        label: "Memory files",
        tokens: 5_600,
        kind: "content",
        items: [
          { name: "project.md", tokens: 4_000 },
          { name: "decisions.md", tokens: 1_600 },
        ],
      },
      { id: "messages", label: "Messages", tokens: 18_300 - jitter, kind: "content" },
      { id: "autocompact", label: "Autocompact buffer", tokens: 33_000, kind: "reserved" },
      { id: "free", label: "Free space", tokens: 107_500, kind: "reserved" },
    ],
    deferred: [
      { name: "MCP tools deferred", tokens: 2_940 },
      { name: "System tools deferred", tokens: 14_952 },
    ],
  };
}

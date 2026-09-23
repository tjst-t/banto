// F2/F3——banto host（Runner＝Claude Agent SDK）の`getContextUsage()`が返す
// `SDKControlGetContextUsageResponse`をlib/mock/context-usage.tsのContextUsage
// 表示形へ写す。ここでの変換は値の解釈・加工ではなく、SDKが持つ構造をそのまま
// カテゴリ/内訳として並べ替えるだけ（規則12「そのまま使う」）——数値そのものは
// 一切作らない（"free"だけはSDKがカテゴリとして持たないため、rawMaxTokensと
// totalTokensの差分から求める——これも新しい数値の創作ではなく、SDKが返した
// 2値の引き算）。
import type { ContextCategory, ContextUsage } from "../mock/context-usage";

interface SDKContextUsageResponseShape {
  totalTokens: number;
  rawMaxTokens: number;
  categories: { name: string; tokens: number; isDeferred?: boolean }[];
  mcpTools: { name: string; serverName: string; tokens: number }[];
  memoryFiles: { path: string; type: string; tokens: number }[];
  skills?: { skillFrontmatter: { name: string; source: string; tokens: number }[] };
  /** Messages の内訳。添付（system-reminder）の種類ごとの量もここにある。 */
  messageBreakdown?: { attachmentsByType?: { name: string; tokens: number }[] };
}

/**
 * **MCP サーバの `instructions` は、会話の中の添付として数えられる**（実測・2026-09-23）
 * ——system prompt ではなく Messages の一部。banto で `instructions` を載せるのは
 * **Skill だけ**（core が組み立て、実 Module の `instructions` は転送しない、
 * `relay/agent-proxy.ts`）なので、この添付の量がそのまま Skill の量になる。
 * **他のものを `instructions` に載せるようになったら、ここは嘘になる。**
 */
const MCP_INSTRUCTIONS_ATTACHMENT = "mcp_instructions_delta";
/** 残量メーターの Skill の行（Messages から切り出したもの）。 */
export const SKILL_CATEGORY_ID = "Skill";

function isSDKContextUsageResponseShape(v: unknown): v is SDKContextUsageResponseShape {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.totalTokens === "number" &&
    typeof o.rawMaxTokens === "number" &&
    Array.isArray(o.categories) &&
    Array.isArray(o.mcpTools) &&
    Array.isArray(o.memoryFiles)
  );
}

/** thread.usageの最新エントリのcontextUsage（unknown）を表示形へ写す。
 *  想定した形でなければnull——contextUsageは規則12でRunnerの形をそのまま
 *  保存しているので、SDKのバージョン差で形が変わることがありうる。 */
export function realContextUsageToDisplay(raw: unknown): ContextUsage | null {
  if (!isSDKContextUsageResponseShape(raw)) return null;

  // Skill の分は **Messages の中から切り出す**（SDK 自身の内訳を並べ替えるだけ——
  // 数字は作らない）。切り出さずに足すと二重に数えることになる
  const skillTokens =
    raw.messageBreakdown?.attachmentsByType?.find((a) => a.name === MCP_INSTRUCTIONS_ATTACHMENT)?.tokens ?? 0;
  const categories: ContextCategory[] = raw.categories
    .filter((c) => !c.isDeferred && c.tokens > 0)
    .map((c) => (skillTokens > 0 && /^messages$/i.test(c.name) ? { ...c, tokens: Math.max(0, c.tokens - skillTokens) } : c))
    .filter((c) => c.tokens > 0)
    .map((c) => {
      const items =
        /mcp/i.test(c.name) && raw.mcpTools.length > 0
          ? raw.mcpTools.map((t) => ({ name: `${t.serverName}.${t.name}`, tokens: t.tokens }))
          : /memory/i.test(c.name) && raw.memoryFiles.length > 0
            ? raw.memoryFiles.map((f) => ({ name: `${f.type}: ${f.path}`, tokens: f.tokens }))
            : /skill/i.test(c.name) && raw.skills && raw.skills.skillFrontmatter.length > 0
              ? raw.skills.skillFrontmatter.map((s) => ({ name: `${s.name}（${s.source}）`, tokens: s.tokens }))
              : undefined;
      return { id: c.name, label: c.name, tokens: c.tokens, kind: "content" as const, items };
    });

  if (skillTokens > 0) {
    // 内訳（Skill ごと）はここでは作れない——会話に刻まれた集合を画面が取りに行って埋める
    categories.push({ id: SKILL_CATEGORY_ID, label: "Skill", tokens: skillTokens, kind: "content" });
  }

  const freeTokens = Math.max(0, raw.rawMaxTokens - raw.totalTokens);
  if (freeTokens > 0) {
    categories.push({ id: "free", label: "Free space", tokens: freeTokens, kind: "reserved" });
  }

  const deferred = raw.categories.filter((c) => c.isDeferred && c.tokens > 0).map((c) => ({ name: c.name, tokens: c.tokens }));

  return { windowTokens: raw.rawMaxTokens, categories, deferred };
}

// Module の自己申告を読む（決定・2026-09-06、Phase 1）。
//
// **どこで名乗るか**：`resources/list` に出す資源の `_meta["dev.banto/module"]`
// （アーキ仕様 §5.4「banto の拡張は `_meta` に載せる。別のマニフェストを作らない」）。
// URI は Module が自由に決めてよい——host は `_meta` の中身だけを見る。
// これで **同じ Module が他の MCP ホストでもそのまま動く**（知らないホストからは
// ただの `_meta` として無視される）。
//
// **`initialize` の応答には載せられない**——SDK のクライアントが serverInfo を
// スキーマで削るため、余分な `_meta` は host まで届かない（実測・2026-09-06）。
//
// 名乗りは**任意**。名乗らない Module は宣言（Config）だけで起動する。

import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { MODULE_META_KEY, parseModuleMeta, type BantoModuleMeta } from "@banto/module-contract";

export class SelfReportError extends Error {}

/**
 * その Module の自己申告。名乗っていなければ undefined。
 * **2つ以上名乗っていたら落とす**——どちらが本当か決められない（規則2）。
 */
export async function readSelfReportedMeta(client: Client): Promise<BantoModuleMeta | undefined> {
  let resources: { uri: string; _meta?: Record<string, unknown> }[];
  try {
    ({ resources } = (await client.listResources()) as {
      resources: { uri: string; _meta?: Record<string, unknown> }[];
    });
  } catch {
    // resources を持たない Module——名乗っていないだけ（エラーではない）
    return undefined;
  }

  const claims = resources.filter((r) => r._meta?.[MODULE_META_KEY] !== undefined);
  if (claims.length === 0) return undefined;
  if (claims.length > 1) {
    throw new SelfReportError(
      `Module が自分の申告を複数の資源に載せています（${claims.map((c) => c.uri).join(", ")}）`,
    );
  }
  return parseModuleMeta(claims[0]!._meta![MODULE_META_KEY], `selfReport(${claims[0]!.uri})`);
}

// **MCP Registry に聞く**（追加・2026-09-21、ユーザー要望）。
//
// **画面から直に叩かない。** registry は banto の外なので、
//   1. どこへ出ていくかを host の1箇所に集める（`docs/specs/v4-security.md`）
//   2. ブラウザの CORS に振り回されない
//   3. 繋がらなかった理由を、人に出せる形で1度だけ組み立てる（規則2）
// ——という理由で host が中継する。**検索は読み取りだけ**（公開しない・入れない）。

import { rankEntries } from "./rank.js";
import { parseEntry, type RegistryEntry } from "./server-json.js";

/** 公式 registry。**別の registry を指せるようにしておく**（自前を立てる人が居る）。 */
export const DEFAULT_REGISTRY_BASE_URL = "https://registry.modelcontextprotocol.io";

export interface RegistrySearchResult {
  entries: RegistryEntry[];
  /** 次のページ。**無ければ終わり**——「0件」と「まだ在る」を混同しない。 */
  nextCursor?: string;
}

export interface RegistrySearchOptions {
  query?: string;
  cursor?: string;
  limit?: number;
  baseUrl?: string;
  /** 試験が差し替える。既定は global の `fetch`。 */
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}

export class RegistryUnavailableError extends Error {}

/**
 * 検索する。**`version=latest` で引く**——同じサーバの古い版が一覧に並ぶと、
 * 人はどれを選べばよいか決められない（実測：`ac.inference.sh/mcp` が
 * 1.0.0 と 1.0.1 で2行出ていた）。
 *
 * **並べ替えはここでやる**（規則3）——画面と host で別々に並べると、
 * 「どちらの順が正しいのか」が2箇所に分かれる。
 */
export async function searchRegistry(opts: RegistrySearchOptions = {}): Promise<RegistrySearchResult> {
  const base = opts.baseUrl ?? DEFAULT_REGISTRY_BASE_URL;
  const url = new URL("/v0/servers", base);
  url.searchParams.set("version", "latest");
  url.searchParams.set("limit", String(opts.limit ?? 50));
  if (opts.query?.trim()) url.searchParams.set("search", opts.query.trim());
  if (opts.cursor) url.searchParams.set("cursor", opts.cursor);

  const doFetch = opts.fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await doFetch(url, { signal: opts.signal, headers: { accept: "application/json" } });
  } catch (err) {
    // **繋がらなかったことを「0件」にしない**（規則2）——人には直せる形で言う
    throw new RegistryUnavailableError(
      `MCP Registry に繋がりませんでした（${new URL(base).host}）：${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!res.ok) {
    throw new RegistryUnavailableError(
      `MCP Registry が ${res.status} を返しました（${new URL(base).host}）`,
    );
  }
  const body = (await res.json()) as { servers?: unknown; metadata?: { nextCursor?: unknown } };
  const raw = Array.isArray(body.servers) ? body.servers : [];
  // **読めなかった1件で全部を落とさない**（`parseEntry` のコメント）
  const entries = raw.map(parseEntry).filter((e): e is RegistryEntry => e !== undefined);
  const nextCursor =
    typeof body.metadata?.nextCursor === "string" ? body.metadata.nextCursor : undefined;
  return { entries: rankEntries(entries, opts.query ?? ""), nextCursor };
}

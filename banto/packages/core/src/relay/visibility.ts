// docs/specs/v4-architecture.md §2.5「resource には tool と違う非対称がある」の実装。
// tool は「代理サーバに登録しない＝存在しない」で守れるが、resourceは
// resources/read にURIを直接指定されると一覧に無くても読めてしまう
// （poc/06-resource-prompt-relayで実測）。fail closedで解決する。

import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { visibilityOf, type Visibility } from "@banto/module-contract";

export type ResourceVisibility = Visibility | "unknown";

export interface ResourceVisibilityResolver {
  (uri: string): Promise<ResourceVisibility>;
}

function templatePrefix(uriTemplate: string): string {
  const idx = uriTemplate.indexOf("{");
  return idx === -1 ? uriTemplate : uriTemplate.slice(0, idx);
}

/**
 * 解決順序：①resources/list の完全一致 → ②resources/templates/list の
 * prefixマッチ → ③不明なら拒否（fail closed）。
 *
 * ②はRFC6570のテンプレート展開のフルマッチではなく、意図的な単純化——
 * 先頭の`{`より前の文字列でprefixマッチする。banto自身のModuleは
 * 先頭に展開式を持つtemplateを使わないので実用上問題ないが、その限界を
 * ここに明記しておく。
 */
export function makeResourceVisibilityResolver(client: Client): ResourceVisibilityResolver {
  return async (uri: string): Promise<ResourceVisibility> => {
    const list = await client.listResources().catch(() => ({ resources: [] }));
    const exact = list.resources.find((r) => r.uri === uri);
    if (exact) return visibilityOf(exact as { _meta?: Record<string, unknown> });

    const templates = await client
      .listResourceTemplates()
      .catch(() => ({ resourceTemplates: [] }));
    for (const t of templates.resourceTemplates) {
      const prefix = templatePrefix(t.uriTemplate);
      if (uri.startsWith(prefix)) {
        return visibilityOf(t as { _meta?: Record<string, unknown> });
      }
    }
    return "unknown";
  };
}

/**
 * 場所の一覧（ADR-0010 決定36d/e・task-0039）。
 *
 * **これが無いと場所は使えない。** `file.*` も `worker.delegate` も場所の id を引数に取るのに、
 * 番頭がその id を知る手段はエラーメッセージだけだった（「複数あります: a, b, c」）。
 * repo-manager が `ghq` の全リポジトリを場所として足すと、なおさら成り立たない。
 *
 * GUI もこの同じ Tool を HTTP 経由で呼んで場所の選択肢を出す——人も番頭も同じ契約で、
 * 経路が違うだけ（決定25）。
 *
 * D3: ここでは何も持たない。`PlaceRegistry` が毎回すべての提供元に聞いた結果をそのまま返す。
 */

import { Type } from "typebox";
import { defineNamespacedTool, type NamespacedToolDefinition } from "./tool-registry.js";
import type { PlaceRegistry } from "./places.js";

export function createPlaceTools(places: PlaceRegistry): NamespacedToolDefinition[] {
  const list = defineNamespacedTool({
    name: "place.list",
    label: "Place: List",
    description:
      "いま作業できる場所の一覧（id・パス・書き込みが許された範囲）。既定は読み取り専用。\n例: {} → 全件／{query: \"banto\"} → 名前・パスに banto を含むものだけ",
    parameters: Type.Object({
      query: Type.Optional(Type.String())
    }),
    async execute(params) {
      const all = await places.list();
      const query = params.query?.trim().toLowerCase();
      const matched = query
        ? all.filter((p) =>
            [p.id, p.label, p.path].some((field) => field.toLowerCase().includes(query))
          )
        : all;

      const rows = matched.map((p) => ({
        id: p.id,
        label: p.label,
        path: p.path,
        // 空配列＝読み取り専用。番頭が「書けるつもり」で失敗しないよう常に出す（決定38a）
        writable: [...(p.writable ?? [])],
      }));

      const text =
        rows.length === 0
          ? query
            ? `"${params.query}" に一致する場所はありません（全 ${all.length} 件）`
            : "登録されている場所がありません"
          : rows
              .map(
                (r) =>
                  `${r.id} — ${r.label} (${r.path})` +
                  (r.writable.length > 0 ? ` [書込可: ${r.writable.join(", ")}]` : " [読み取り専用]")
              )
              .join("\n");

      return {
        content: [{ type: "text" as const, text }],
        details: { places: rows, total: all.length },
      };
    },
  });

  return [list];
}

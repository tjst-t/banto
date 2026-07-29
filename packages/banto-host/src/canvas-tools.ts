/**
 * キャンバス操作Tool（ADR-0010 決定9・決定13）。
 *
 * 決定5 §1・§5 の制約に従い、**表示状態の変更に閉じる**——ここで中身のデータは取らない。
 * 何を表示するかのデータ取得は別ドメインのTool（`file.*` / `git.*` / Kobo Extension Pack）が担う。
 *
 * 決定13：番頭は「いまキャンバスに何が開いているか」を自分で照会できる必要がある
 * （`canvas.query_state`）。POの発言が「この画面」等を指すと判断したときに参照する。
 *
 * D5: 判断は持たない。Canvas に言われた通り操作を伝えるだけ。
 * I2: 未知の kind・タブIDは Canvas が例外にする。ここで握りつぶさない。
 */

import { Type } from "typebox";
import type { Canvas, CanvasCatalog } from "./canvas.js";
import { defineNamespacedTool, type NamespacedToolDefinition } from "./tool-registry.js";

/** `canvas.*` を生成する。 */
export function createCanvasTools(canvas: Canvas, catalog: CanvasCatalog): NamespacedToolDefinition[] {
  const listCatalog = defineNamespacedTool({
    name: "canvas.list_catalog",
    label: "Canvas: List Catalog",
    description:
      "キャンバスに開けるGUIの一覧（kind・説明・必要なパラメータ）を返す。" +
      "何を見せられるか分からないときに、開く前に確認する。",
    parameters: Type.Object({}),
    async execute() {
      const specs = catalog.list();
      const text =
        specs.length === 0
          ? "開けるGUIなし"
          : specs
              .map((s) => `- ${s.kind}: ${s.title} — ${s.description}`)
              .join("\n");
      return { content: [{ type: "text" as const, text }], details: {} };
    },
  });

  const open = defineNamespacedTool({
    name: "canvas.open",
    label: "Canvas: Open",
    description:
      "キャンバスにGUIをタブとして開き、アクティブにする。POに何かを見せたいときに使う。" +
      "開けるkindは canvas.list_catalog で確認できる。表示を変えるだけで、データの取得はしない。",
    parameters: Type.Object({
      kind: Type.String({ description: "開くGUIの種別（例: demo.hello）" }),
      params: Type.Optional(
        Type.Record(Type.String(), Type.Unknown(), {
          description: "そのGUIに渡すパラメータ。必要な形は canvas.list_catalog を参照",
        })
      ),
      title: Type.Optional(Type.String({ description: "タブに表示する名前（省略時はカタログの既定）" })),
    }),
    async execute(_toolCallId, params) {
      // I2: 未知の kind は Canvas が利用可能な一覧付きで例外にする（決定20）
      const tab = canvas.open(
        params.kind,
        (params.params as Record<string, unknown> | undefined) ?? {},
        params.title
      );
      return {
        content: [{ type: "text" as const, text: `opened ${tab.kind} as "${tab.title}" (tabId: ${tab.id})` }],
        details: {},
      };
    },
  });

  const close = defineNamespacedTool({
    name: "canvas.close",
    label: "Canvas: Close",
    description: "キャンバスのタブを閉じる。tabId は canvas.query_state で確認できる。",
    parameters: Type.Object({
      tabId: Type.String({ description: "閉じるタブのID" }),
    }),
    async execute(_toolCallId, params) {
      canvas.close(params.tabId);
      return { content: [{ type: "text" as const, text: `closed ${params.tabId}` }], details: {} };
    },
  });

  const switchTool = defineNamespacedTool({
    name: "canvas.switch",
    label: "Canvas: Switch",
    description: "キャンバスで表示するタブを切り替える。",
    parameters: Type.Object({
      tabId: Type.String({ description: "表示に切り替えるタブのID" }),
    }),
    async execute(_toolCallId, params) {
      canvas.switchTo(params.tabId);
      return { content: [{ type: "text" as const, text: `switched to ${params.tabId}` }], details: {} };
    },
  });

  const queryState = defineNamespacedTool({
    name: "canvas.query_state",
    label: "Canvas: Query State",
    description:
      "いまキャンバスに何が開いているか（タブ一覧と、どれが表示中か）を返す。" +
      "POの発言が「この画面」「これ」などキャンバスの現在の表示を指していると判断したら、まずこれを見る。",
    parameters: Type.Object({}),
    async execute() {
      const { tabs, activeTabId } = canvas.snapshot();
      const text =
        tabs.length === 0
          ? "キャンバスには何も開かれていない"
          : tabs
              .map((t) => `${t.id === activeTabId ? "▶" : " "} ${t.title} [${t.kind}] (tabId: ${t.id})`)
              .join("\n");
      return { content: [{ type: "text" as const, text }], details: {} };
    },
  });

  return [listCatalog, open, close, switchTool, queryState];
}

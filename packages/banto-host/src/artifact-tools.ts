/**
 * 退避した観測を読み戻す Tool（提案§3.1）。
 *
 * 決定9の境界線では単発の照会なので Tool。**番頭に汎用のファイル読みを与えずに済む**
 * のが要点——退避したものだけが読め、退避先はこの会話のディレクトリに閉じている
 * （決定1：結合は Tool の公開I/Fのみ）。
 *
 * D5: 判断は無い。`ArtifactStore` に委ねて整形するだけ。
 * D6: 依存は typebox と ArtifactStore のみ。
 */

import { Type } from "typebox";
import type { ArtifactStore } from "./artifacts.js";
import { defineNamespacedTool, type NamespacedToolDefinition } from "./tool-registry.js";

export function createArtifactTools(store: ArtifactStore): NamespacedToolDefinition[] {
  const read = defineNamespacedTool({
    name: "artifact.read",
    label: "Artifact: Read",
    description:
      "退避されたツール出力（栞 `artifact a-0001`）の中身を読む。\n例: {id: \"a-0001\", grep: \"FAIL\"} → 一致行だけ／{offset: 200, limit: 50} → 200行目から50行\ngrep の語は英語で埋める。**要る所だけ読む。**",
    parameters: Type.Object({
      id: Type.String(),
      grep: Type.Optional(Type.String()),
      offset: Type.Optional(Type.Number()),
      limit: Type.Optional(Type.Number())
    }),
    async execute(params) {
      // I2: 無いID・壊れたIDは ArtifactStore が例外にする。黙って空を返さない
      const slice = store.read(params.id, {
        ...(params.grep !== undefined ? { grep: params.grep } : {}),
        ...(params.offset !== undefined ? { offset: params.offset } : {}),
        ...(params.limit !== undefined ? { limit: params.limit } : {}),
      });

      const where =
        slice.from !== undefined
          ? `${slice.id} の ${slice.from}〜${slice.to} 行目（全 ${slice.totalLines} 行）`
          : `${slice.id} の該当行（全 ${slice.totalLines} 行）`;
      const more = slice.truncated ? "\n\n（まだ続きがある。必要なら offset を進めて読む）" : "";
      const body = slice.text.length === 0 ? "（該当なし）" : slice.text;

      return {
        content: [{ type: "text" as const, text: `${where}\n\n${body}${more}` }],
        details: { id: slice.id, totalLines: slice.totalLines, truncated: slice.truncated },
      };
    },
  });

  const list = defineNamespacedTool({
    name: "artifact.list",
    label: "Artifact: List",
    description:
      "この会話で退避されている観測の一覧を返す（ID・大きさ・見出し）。" +
      "章を畳んだ後など、どんな観測が手元にあるかを確かめたいときに使う。" +
      "中身は artifact.read で読む。",
    parameters: Type.Object({}),
    async execute() {
      const items = store.list();
      const text =
        items.length === 0
          ? "退避された観測はありません"
          : items
              .map((a) => {
                const head = a.outline.split("\n")[0]?.trim() ?? "";
                return `- ${a.id}（${a.chars.toLocaleString("en-US")}字）${head ? ` — ${head}` : ""}`;
              })
              .join("\n");
      return {
        content: [{ type: "text" as const, text }],
        details: { artifacts: items.map((a) => ({ id: a.id, chars: a.chars, outline: a.outline })) },
      };
    },
  });

  return [read, list];
}

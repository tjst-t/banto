/**
 * 章の引き継ぎ資料を読む Tool（提案§3.2）。
 *
 * 次の章の文脈に載るのは**見出しだけ**で、詳細はここから引く。SKILL の
 * `skill.read` と同じ段階的開示——一覧は常時、本体は要るときだけ。
 *
 * D5: 判断は無い。`HandoffStore` に委ねるだけ。
 * D6: 依存は typebox と HandoffStore のみ。
 */

import { Type } from "typebox";
import type { HandoffStore } from "./handoffs.js";
import { defineNamespacedTool, type NamespacedToolDefinition } from "./tool-registry.js";

export function createHandoffTools(
  store: HandoffStore,
  threadId: string
): NamespacedToolDefinition[] {
  const read = defineNamespacedTool({
    name: "handoff.read",
    label: "Handoff: Read",
    description:
      "前の章の引き継ぎ資料を読む。" +
      "会話が長くなると章を区切って文脈を畳んでおり、いまの文脈には見出ししか載っていない。" +
      "**前提が要るときは憶測で埋めず、ここを読むこと。** 元のやり取りは失われていない。",
    parameters: Type.Object({
      id: Type.Optional(
        Type.String({
          description: '資料のID（例: "thread-1/ch-0001"）。省略するとこの会話の最新の章',
        })
      ),
    }),
    async execute(params) {
      const id: string | undefined = params.id ?? store.list(threadId).at(-1);
      // I2: 無いIDは HandoffStore が例外にする。黙って空を返さない
      const text = id === undefined ? "この会話にはまだ章の引き継ぎがありません" : store.read(id);
      return { content: [{ type: "text" as const, text }], details: { id } };
    },
  });

  const list = defineNamespacedTool({
    name: "handoff.list",
    label: "Handoff: List",
    description: "この会話の章の一覧を返す。どこまで畳んだかを確かめるときに使う。",
    parameters: Type.Object({}),
    async execute() {
      const ids = store.list(threadId);
      const text =
        ids.length === 0 ? "章の引き継ぎはまだありません" : ids.map((id) => `- ${id}`).join("\n");
      return { content: [{ type: "text" as const, text }], details: { ids: [...ids] } };
    },
  });

  return [read, list];
}

/**
 * 記憶を番頭に公開する Tool（ADR-0010 決定9・決定10、D11）。
 *
 * 決定9の境界線に従い、記憶の読み書きは「単発の照会・単発のアクション」なので Tool とする
 * （複数Tool呼び出しにまたがる手順知識は SKILL 側）。
 *
 * D5: 判断ロジックを持たない。保存・取り出しは MemoryStore に委ね、ここは受け渡しのみ。
 * D6: 依存は banto-core の MemoryStore と typebox のみ。ファイル操作はここで一切しない。
 */

import type { MemoryKind, MemoryStore } from "@banto/core";
import { Type } from "typebox";
import { defineNamespacedTool, type NamespacedToolDefinition } from "./tool-registry.js";

const MemoryKindSchema = Type.Union(
  [Type.Literal("preference"), Type.Literal("habit"), Type.Literal("fact")],
  {
    description:
      "preference（好み。文体や見せ方など、そうしてほしいこと。変わってよい）、" +
      "habit（習慣。手順やチェックのルーティン。変わってよい）、" +
      "fact（事実。名前・役割・許諾範囲など、導出できず変わらないことが期待される属性）。" +
      "**事実を好みに入れない**——名前を好みとして覚えると「変えてよいもの」として扱ってしまう",
  }
);

/**
 * `memory.save` / `memory.recall` を生成する。
 *
 * どちらも渡された MemoryStore だけを触るため、保存形式（JSONL・将来のSQLite）が
 * 変わっても Tool 側は変更しない。
 */
export function createMemoryTools(store: MemoryStore): NamespacedToolDefinition[] {
  const saveTool = defineNamespacedTool({
    name: "memory.save",
    label: "Memory: Save",
    description:
      "POの好み・習慣として長期に覚えておくべきことを1件保存する。" +
      "セッションを跨いで参照されるため、その場限りの作業メモではなく、次回以降も効く事実だけを書く。" +
      "既存の記憶を訂正する場合は supersedes に古い記憶のIDを渡す。",
    parameters: Type.Object({
      kind: MemoryKindSchema,
      text: Type.String({ description: "記憶の内容。1件1事実で簡潔に書く。" }),
      refs: Type.Optional(
        Type.Array(Type.String(), { description: "関連するタスク・ADR等のID（任意）" })
      ),
      supersedes: Type.Optional(
        Type.String({ description: "訂正する場合、置き換える古い記憶のID" })
      ),
    }),
    async execute(_toolCallId, params) {
      // I2: 存在しないIDの訂正は MemoryStore が例外にする。ここで握りつぶさない。
      const saved = params.supersedes
        ? store.supersede(params.supersedes, {
            kind: params.kind,
            text: params.text,
            ...(params.refs ? { refs: params.refs } : {}),
          })
        : store.save({
            kind: params.kind,
            text: params.text,
            ...(params.refs ? { refs: params.refs } : {}),
          });

      return {
        content: [{ type: "text" as const, text: `saved memory ${saved.id}: ${saved.text}` }],
        details: {},
      };
    },
  });

  const recallTool = defineNamespacedTool({
    name: "memory.recall",
    label: "Memory: Recall",
    description:
      "保存済みの好み・習慣を取り出す。訂正済み（superseded）の記憶は既定で除外される。" +
      "セッション開始時の記憶は既にシステムプロンプトへ注入されているため、" +
      "種別で絞りたいときや、注入後に保存した記憶を読み直したいときに使う。",
    parameters: Type.Object({
      kind: Type.Optional(MemoryKindSchema),
    }),
    async execute(_toolCallId, params) {
      const records = store.list(params.kind ? { kind: params.kind } : {});
      const text =
        records.length === 0
          ? "記憶なし"
          : records.map((r) => `- [${r.kind}] ${r.text} (id: ${r.id})`).join("\n");
      return { content: [{ type: "text" as const, text }], details: {} };
    },
  });

  return [saveTool, recallTool];
}

/**
 * セッション開始時にシステムプロンプトへ差し込む記憶のセクションを組み立てる。
 * 記憶が無ければ空文字（プロンプトに空セクションを足さない）。
 *
 * 注入するのは active な記憶のみ——訂正済みの記憶を混ぜると、番頭が古い前提で判断する。
 */
export function renderMemoryForPrompt(store: MemoryStore): string {
  const byKind = (kind: MemoryKind) =>
    store.list({ kind }).map((r) => `- ${r.text} (id: ${r.id})`);

  const facts = byKind("fact");
  const preferences = byKind("preference");
  const habits = byKind("habit");
  if (facts.length === 0 && preferences.length === 0 && habits.length === 0) return "";

  // 決定31d: 事実が最も安定しているので先に読ませる（事実 → 好み → 習慣）
  const sections = ["# 記憶（前回までに覚えたこと）"];
  if (facts.length > 0) sections.push("## 事実\n" + facts.join("\n"));
  if (preferences.length > 0) sections.push("## 好み\n" + preferences.join("\n"));
  if (habits.length > 0) sections.push("## 習慣\n" + habits.join("\n"));
  sections.push(
    "これらは過去のセッションで保存された。矛盾する指示を受けたら、" +
      "古い記憶を memory.save の supersedes で訂正する。"
  );
  return sections.join("\n\n");
}

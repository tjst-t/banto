/**
 * studio モジュール（組み込み・ADR-0010 決定25・27）。
 *
 * 番頭自身の中身——**記憶（宣言的記憶）と SKILL（手続き記憶）**——をPOに見せる。
 * 職人ビューアが「いま誰が何をしているか」を見せるのに対して、こちらは
 * 「番頭が何を覚えていて、どう動くつもりか」を見せる。
 *
 * `memory.*` / `skill.*` のドメインは Banto 中核が持つ（決定27a）。このモジュールは
 * それらを**所有しない**——番頭向けの Tool は中核が createBantoHostSession で渡しており、
 * ここが提供するのは GUI と、その GUI がデータを取るための口だけ。所有と閲覧を混ぜないため、
 * 口の名前は `studio.*` にしてある。
 *
 * **読み取り専用。** 記憶の削除は追記で表す設計（task-0023・D3）、SKILL の書き込みは
 * 決定26 の学習層（task-0017）に属する。GUI の都合でその設計を先取りしない。
 *
 * D5: 判断は無い。持っているものをそのまま返すだけ。
 */

import { Type } from "typebox";
import * as fs from "node:fs";
import type { MemoryStore } from "@banto/core";
import type { BantoModule } from "../module.js";
import type { CanvasViewSpec } from "../canvas.js";
import { defineNamespacedTool, type NamespacedToolDefinition } from "../tool-registry.js";
import type { SkillEntry } from "../module.js";

/** 組み込みモジュールの到達先は Banto ホスト自身。UIは自分のオリジンに解決する。 */
export const STUDIO_BASE_URL = "/api/studio";

const studioViews: CanvasViewSpec[] = [
  {
    kind: "memory.viewer",
    title: "記憶",
    description:
      "番頭が覚えている好み・習慣の一覧。POが「何を覚えている？」と聞いたときや、" +
      "覚え違いを疑ったときに開く。訂正済みの記憶も履歴として確認できる。**閲覧専用**。",
    parameters: Type.Object({
      kind: Type.Optional(
        Type.String({ description: "preference / habit で絞る（省略時は両方）" })
      ),
    }),
    component: "MemoryViewer",
    category: "studio",
    icon: "🧠",
  },
  {
    kind: "skill.viewer",
    title: "SKILL",
    description:
      "番頭が持っている手続き記憶（SKILL）の一覧と中身。どんな手順を知っているか、" +
      "その出所（番頭核／どのモジュール）を見せたいときに開く。**閲覧専用**。",
    parameters: Type.Object({
      name: Type.Optional(Type.String({ description: "最初に開く SKILL 名（省略時は一覧から）" })),
    }),
    component: "SkillViewer",
    category: "studio",
    icon: "📘",
  },
];

export interface StudioModuleOptions {
  memory: MemoryStore;
  /** 解決済みの SKILL（由来つき）。決定26 の層を解いた後のもの。 */
  skills: SkillEntry[];
}

/**
 * GUI がデータを取る口（決定25）。番頭には渡さない——番頭は中核の
 * `memory.recall` / `skill.read` を直接使うので、同じものを二重に持たせない。
 */
function createStudioDataTools(options: StudioModuleOptions): NamespacedToolDefinition[] {
  const memory = defineNamespacedTool({
    name: "studio.memory",
    label: "Studio: Memory",
    description: "番頭の記憶を一覧で返す（記憶ビューア用のデータ）。",
    parameters: Type.Object({
      kind: Type.Optional(
        Type.Union(
          [Type.Literal("preference"), Type.Literal("habit"), Type.Literal("fact")],
          { description: "種別で絞る（決定31）" }
        )
      ),
      includeSuperseded: Type.Optional(
        Type.Boolean({ description: "訂正済みの記憶も含める（既定 false）" })
      ),
    }),
    async execute(params) {
      const records = options.memory.list({
        ...(params.kind ? { kind: params.kind } : {}),
        ...(params.includeSuperseded !== undefined
          ? { includeSuperseded: params.includeSuperseded }
          : {}),
      });
      return {
        content: [{ type: "text" as const, text: `${records.length} 件` }],
        details: { records },
      };
    },
  });

  const skills = defineNamespacedTool({
    name: "studio.skills",
    label: "Studio: Skills",
    description: "番頭が持っている SKILL の一覧と中身を返す（SKILLビューア用のデータ）。",
    parameters: Type.Object({
      name: Type.Optional(Type.String({ description: "この SKILL の本文だけを返す" })),
    }),
    async execute(params) {
      const entries = options.skills.map((entry) => {
        const base = {
          name: entry.skill.name,
          description: entry.skill.description,
          /** どの層から来たか（決定26）。番頭核なら core、モジュール名ならそのモジュール */
          origin: entry.origin,
        };
        if (params.name !== undefined && params.name !== entry.skill.name) return base;
        // I2: 読めない SKILL を黙って空にしない。理由を本文として返す
        try {
          return { ...base, body: fs.readFileSync(entry.skill.filePath, "utf-8") };
        } catch (err) {
          return { ...base, error: `読めません: ${String(err)}` };
        }
      });
      return {
        content: [{ type: "text" as const, text: `${entries.length} 件` }],
        details: { skills: entries },
      };
    },
  });

  return [memory, skills];
}

/**
 * studio モジュールの定義を返す。
 *
 * `tools` は空。番頭に渡す口は中核が持っているので、ここで重ねない（決定27a）。
 */
export function createStudioModule(options: StudioModuleOptions): BantoModule {
  return {
    name: "studio",
    title: "番頭の中身",
    description:
      "番頭が覚えていること（記憶）と、知っている手順（SKILL）を見せる。閲覧専用。",
    endpoint: { baseUrl: STUDIO_BASE_URL },
    tools: [],
    internalTools: createStudioDataTools(options),
    views: studioViews,
    skills: [],
  };
}

/**
 * SKILL（手続き記憶）を番頭に公開する Tool — ADR-0010 決定9。
 *
 * progressive disclosure の「本体を読む」側。一覧は skills.ts の
 * renderSkillsForPrompt() がシステムプロンプトへ注入する。
 *
 * D5: 判断ロジックを持たない。読み取りは skills.ts に委ね、ここは受け渡しのみ。
 * 番頭に汎用のファイル読み取りは与えない——読めるのは登録済みSKILLだけ（skills.ts の理由参照）。
 */

import { Type } from "typebox";
import { readBantoSkill, type BantoSkill } from "./skills.js";
import { defineNamespacedTool, type NamespacedToolDefinition } from "./tool-registry.js";

/** `skill.list` / `skill.read` を生成する。 */
export function createSkillTools(skills: BantoSkill[]): NamespacedToolDefinition[] {
  const listTool = defineNamespacedTool({
    name: "skill.list",
    label: "Skill: List",
    description:
      "使えるSKILL（手順知識）の一覧と、それぞれをいつ使うかを返す。" +
      "一覧はセッション開始時にも渡されているため、確認し直したいときに使う。",
    parameters: Type.Object({}),
    async execute() {
      const text =
        skills.length === 0
          ? "SKILLなし"
          : skills.map((s) => `- ${s.name}: ${s.description}`).join("\n");
      return { content: [{ type: "text" as const, text }], details: {} };
    },
  });

  const readTool = defineNamespacedTool({
    name: "skill.read",
    label: "Skill: Read",
    description:
      "SKILLの本体（手順）を読む。該当する作業に入る前に必ず読み、その手順に従うこと。" +
      "読めるのは登録済みSKILLのみで、任意のファイルは読めない。",
    parameters: Type.Object({
      name: Type.String({ description: "SKILLの名前（例: work-handoff）" }),
    }),
    async execute(params) {
      // I2: 未知のSKILL名は握りつぶさずエラーにする（利用可能な名前を添えて返す）
      const body = readBantoSkill(params.name, skills);
      return { content: [{ type: "text" as const, text: body }], details: {} };
    },
  });

  return [listTool, readTool];
}

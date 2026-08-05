/**
 * SKILL（手続き記憶）を番頭に公開する Tool — ADR-0010 決定9。
 *
 * progressive disclosure の「本体を読む」側。一覧は skills.ts の
 * renderSkillsForPrompt() がシステムプロンプトへ注入する。
 *
 * D5: 判断ロジックを持たない。読み取りは skills.ts に委ね、ここは受け渡しのみ。
 * 番頭に汎用のファイル読み取りは与えない——読めるのは登録済みSKILLだけ（skills.ts の理由参照）。
 */

import * as fs from "node:fs";
import { Type } from "typebox";
import { readBantoSkill, type BantoSkill } from "./skills.js";
import { skillHash, type LearnedSkillStore } from "./skill-learning.js";
import { defineNamespacedTool, type NamespacedToolDefinition } from "./tool-registry.js";

/** `createSkillTools` の追加の口。 */
export interface SkillToolsOptions {
  /**
   * 学習層（決定26・task-0017）。渡すと `skill.learn` / `skill.unlearn` が登録され、
   * 番頭が実務で得た手順の改善を保存できる。
   */
  learned?: LearnedSkillStore;
  /**
   * 既定の SKILL（学習層を解決する**前**のもの）。上書きするとき、元にした版を
   * 記録するのに要る（a3）。
   */
  defaults?: readonly BantoSkill[];
  /** 学習層を書き換えたときに呼ばれる。次のセッションから効くことを知らせるのに使う。 */
  onLearned?: (name: string) => void;
}

/** `skill.list` / `skill.read`（＋学習層を渡せば `skill.learn` / `skill.unlearn`）を生成する。 */
export function createSkillTools(
  skills: BantoSkill[],
  options: SkillToolsOptions = {}
): NamespacedToolDefinition[] {
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

  const tools = [listTool, readTool];
  if (!options.learned) return tools;

  const learned = options.learned;
  const learnTool = defineNamespacedTool({
    name: "skill.learn",
    label: "Skill: Learn",
    description:
      "手順の学びを SKILL として保存する（学習層）。同名の既定があれば、次のセッションから" +
      "この内容が優先される。**その場限りの作業メモは書かない**——次回以降も同じ場面で" +
      "使える手順だけを書くこと。既定に戻したいときは skill.unlearn。",
    parameters: Type.Object({
      name: Type.String({ description: "SKILLの名前（英小文字・数字・ハイフン）" }),
      description: Type.String({ description: "いつ使うかを一行で。一覧に常時載る" }),
      body: Type.String({ description: "手順の本体（Markdown）" }),
    }),
    async execute(params) {
      // a3: 上書きなら、元にした既定の版を記録する。既定が後で変わったことに気づける
      const base = options.defaults?.find((s) => s.name === params.name);
      const basedOn = base
        ? { origin: "default", hash: skillHash(fs.readFileSync(base.filePath, "utf-8")) }
        : undefined;

      // I2: 名前の検算は LearnedSkillStore が例外にする。黙って別の名前で保存しない
      learned.save({
        name: params.name,
        description: params.description,
        body: params.body,
        ...(basedOn ? { basedOn } : {}),
      });
      options.onLearned?.(params.name);

      const what = base ? `既定を上書きしました（元の版 ${basedOn!.hash}）` : "新しく作りました";
      return {
        content: [
          {
            type: "text" as const,
            text: `SKILL "${params.name}" を${what}。**次のセッションから効きます**。`,
          },
        ],
        details: {},
      };
    },
  });

  const unlearnTool = defineNamespacedTool({
    name: "skill.unlearn",
    label: "Skill: Unlearn",
    description:
      "学習層の SKILL を捨てて既定に戻す。学んだ手順が誤っていたときに使う。" +
      "既定そのものは消えない（学習層は既定の上に載っているだけ）。",
    parameters: Type.Object({
      name: Type.String({ description: "捨てる SKILL の名前" }),
    }),
    async execute(params) {
      learned.remove(params.name);
      options.onLearned?.(params.name);
      return {
        content: [
          {
            type: "text" as const,
            text: `SKILL "${params.name}" の学習層を捨てました。**次のセッションから既定に戻ります**。`,
          },
        ],
        details: {},
      };
    },
  });

  return [...tools, learnTool, unlearnTool];
}

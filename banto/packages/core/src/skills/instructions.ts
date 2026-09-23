// docs/specs/v4-architecture.md §5.6「効かせ方——名前と説明は `instructions` に載せる」
// （決定・2026-09-23）。
//
// **組み立てるのは core である。** Module は資源を配るだけで、何を文脈に入れるかは
// 決めない——Module に文脈を勝手に占領させない。この文字列は代理サーバ
// （`relay/agent-proxy.ts`）の `initialize` 応答に載り、Runner がモデルの文脈の
// 冒頭に入れる（実測・2026-09-23）。
//
// 書き方は system prompt（`runner/system-prompt.ts`）に揃える——日本語、だ・である調。

import type { SessionSkillSet, SkillRef } from "./types.js";

/**
 * その Module の代理サーバに載せる `instructions`。**載せるものが無ければ `undefined`**
 * （空の見出しだけを文脈に入れない）。
 *
 * **同じ集合からは、1バイトも違わない文字列を返す**——効かせる集合は会話の開始時に
 * 固定され（§5.7）、後のターンでも同じものを載せる。
 */
export function renderSkillInstructions(set: SessionSkillSet | undefined, module: string): string | undefined {
  if (!set) return undefined;
  const active = set.active.filter((s) => s.module === module);
  const hasOthers = set.othersIn.includes(module);
  if (active.length === 0 && !hasOthers) return undefined;

  const blocks: string[] = ["# Skill"];
  if (active.length > 0) {
    blocks.push(
      "このサーバは Skill を配っている。Skill は、ある種類の仕事のやり方をまとめた文書である。" +
        "この会話では、次の Skill が効いている：",
      active.map(skillLine).join("\n"),
      "仕事が説明に合うときは、取りかかる前に本文を ReadMcpResourceTool で読み、そのやり方に従う。" +
        "本文が相対パス（`references/…` など）で別のファイルを指していたら、本文の URI を基準にした URI で同じように読める。" +
        "本文がスクリプトの実行やファイルの直接の読み込みを前提にしていても、その道具はここには無い" +
        "——見えている tool でできる範囲でやり、できないことはそう言う。",
    );
    if (hasOthers) {
      blocks.push("ここに挙げていない Skill も、このサーバの資源の一覧にある（この会話では効かせていない）。探せば読める。");
    }
  } else {
    blocks.push(
      "このサーバは Skill（ある種類の仕事のやり方をまとめた文書）を配っているが、この会話では1つも効かせていない。" +
        "資源の一覧から探せば読める。",
    );
  }
  return blocks.join("\n\n");
}

/**
 * 1件の行。**説明は1行に畳む**——説明は他人が書いた文章なので、改行で
 * 見出しや箇条を作って周りの構造を崩せないようにする。
 */
function skillLine(skill: SkillRef): string {
  const description = skill.description.replace(/\s+/g, " ").trim();
  return `- **${skill.name}**（本文：\`${skill.uri}\`）：${description}`;
}


/**
 * `instructions` のうち、Skill ごとに何文字を占めているか（残量メーターの内訳用、§5.7
 * 「この数は自分で数える」）。SDK は `instructions` の全体を1つの添付
 * （`mcp_instructions_delta`）として数えるので、**その値をこの文字数で按分する**
 * ——数字そのものは作らない。文字列を組み立てるのは core なので、画面に同じ書式を
 * 写させない（規則3）。
 */
export function skillInstructionsFootprint(set: SessionSkillSet | undefined): {
  totalChars: number;
  skills: Array<{ module: string; name: string; chars: number }>;
} {
  if (!set) return { totalChars: 0, skills: [] };
  const modules = [...new Set([...set.active.map((s) => s.module), ...set.othersIn])];
  const totalChars = modules.reduce((sum, m) => sum + (renderSkillInstructions(set, m)?.length ?? 0), 0);
  return {
    totalChars,
    skills: set.active.map((s) => ({ module: s.module, name: s.name, chars: skillLine(s).length })),
  };
}

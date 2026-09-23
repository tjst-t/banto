// Agent Skills（`agentskills.io`）の `SKILL.md` を読む。**形式は発明しない**
// ——YAML の frontmatter（`---` で挟む）と Markdown の本文。必須は `name` と `description`。

import { JSON_SCHEMA, load } from "js-yaml";
import { skillEntryProblem } from "@banto/module-contract";

export interface SkillMd {
  name: string;
  description: string;
  /** frontmatter の全体（`license`・`allowed-tools` など、必須以外も含む）。 */
  frontmatter: Record<string, unknown>;
  body: string;
}

export type SkillMdResult = { ok: true; skill: SkillMd } | { ok: false; problem: string };

/**
 * `SKILL.md` を読む。**読めなければ理由を返す**——黙って既定値で埋めない（規則2）。
 *
 * `dirName` を渡すと「名前はフォルダ名と一致する」（Agent Skills の仕様）も見る。
 */
export function parseSkillMd(text: string, dirName?: string): SkillMdResult {
  const normalized = text.replace(/^﻿/, "").replace(/\r\n/g, "\n");
  const match = normalized.match(/^---\n([\s\S]*?)\n---(?:\n|$)([\s\S]*)$/);
  if (!match) return { ok: false, problem: "先頭に frontmatter（--- で挟んだ YAML）がありません" };
  let parsed: unknown;
  try {
    // **JSON の型だけで読む**——日付などを別の型に化けさせない（名前と説明は文字列）
    parsed = load(match[1]!, { schema: JSON_SCHEMA });
  } catch (err) {
    return { ok: false, problem: `frontmatter の YAML が読めません: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, problem: "frontmatter が「名前: 値」の形になっていません" };
  }
  const frontmatter = parsed as Record<string, unknown>;
  const problem = skillEntryProblem(frontmatter.name, frontmatter.description);
  if (problem) return { ok: false, problem };
  const name = frontmatter.name as string;
  if (dirName !== undefined && name !== dirName) {
    return { ok: false, problem: `名前「${name}」がフォルダ名「${dirName}」と一致しません` };
  }
  return {
    ok: true,
    skill: { name, description: frontmatter.description as string, frontmatter, body: match[2] ?? "" },
  };
}

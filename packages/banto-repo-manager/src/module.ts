/**
 * repo-manager のモジュール定義（ADR-0010 決定25・27・36・task-0039）。
 *
 * 扱うのは **Git リポジトリとワークツリー**であって、店（プロジェクト）の登録簿ではない
 * （決定36a）。プロジェクトは統治の単位で Kobo の `ProjectRegistry` が持ち続け、
 * repo-manager はその下にある**作業場所の実体**を扱う。
 *
 * このファイルは banto-host に依存しない。モジュールの形（BantoModule）は banto-host が
 * 定義しているが、構造的に一致する平たいオブジェクトを返すことで依存を持たずに済ませる
 * ——Worker Pool（`banto-worker-pool/src/module.ts`）と同じ扱い。
 */

import { Type } from "typebox";
import type { NamespacedToolDefinition } from "@banto/core";
import { createRepoManagerTools, type RepoToolOptions } from "./tools.js";

/** POがリポジトリとワークツリーを見て直せる画面（決定18・24 の基本GUIセットと同じ位置づけ）。 */
const repoViews = [
  {
    kind: "repo.manager",
    title: "リポジトリ",
    description:
      "手元にあるリポジトリと、その git ワークツリーの一覧。" +
      "ワークツリーを作る・削除するのもここでできる。" +
      "「どのリポジトリで作業するか」「別ブランチの作業場所を用意したい」ときに開く。" +
      "履歴を変える操作（commit・push）は無い。",
    parameters: Type.Object({
      repo: Type.Optional(
        Type.String({ description: "最初に選ぶリポジトリの id（省略時は先頭）" })
      ),
    }),
    component: "RepoManager",
    category: "workspace",
    icon: "🗂",
  },
];

/** 既定の到達先。Banto に同居させる想定なので相対パス。 */
export const REPO_MANAGER_BASE_URL = "/api/repo-manager";

/** SKILL の置き場所（`packages/banto-repo-manager/skills`）。 */
export function repoManagerSkillsDir(): string {
  return new URL("../skills", import.meta.url).pathname;
}

export function createRepoManagerModule(
  options: RepoToolOptions = {},
  baseUrl: string = REPO_MANAGER_BASE_URL
): {
  name: string;
  title: string;
  description: string;
  endpoint: { baseUrl: string };
  tools: NamespacedToolDefinition[];
  views: typeof repoViews;
  skills: Array<{ name: string; description: string; filePath: string }>;
} {
  return {
    name: "repo-manager",
    title: "リポジトリ",
    description:
      "手元の Git リポジトリと、その git ワークツリーを、番頭が作業できる場所として提供する。" +
      "独自の登録簿は持たず毎回そこから導出する。ワークツリーの作成・削除ができる" +
      "（作業場所の用意であって、commit・push などの履歴の変更は持たない）。",
    endpoint: { baseUrl },
    tools: createRepoManagerTools(options) as NamespacedToolDefinition[],
    views: repoViews,
    // SKILL は decision 26 の第2層（モジュールが出す既定）。frontmatter はパースせず
    // コードで name / description を持ち、本体は `skills/repository/SKILL.md` に置く
    skills: [
      {
        name: "repository",
        description:
          "リポジトリとワークツリーの扱い。どこで作業できるかを把握するとき、" +
          "別ブランチの作業場所（ワークツリー）を用意・削除するとき、リポジトリを" +
          "手元に取り込むときに使う。git の履歴変更（commit・push・branch）は持たず、" +
          "必要なときは職人へ委譲する。",
        filePath: `${repoManagerSkillsDir()}/repository/SKILL.md`,
      },
    ],
  };
}

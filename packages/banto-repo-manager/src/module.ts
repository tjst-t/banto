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

import type { NamespacedToolDefinition } from "@banto/core";
import { createRepoManagerTools, type RepoToolOptions } from "./tools.js";

/** 既定の到達先。Banto に同居させる想定なので相対パス。 */
export const REPO_MANAGER_BASE_URL = "/api/repo-manager";

export function createRepoManagerModule(
  options: RepoToolOptions = {},
  baseUrl: string = REPO_MANAGER_BASE_URL
): {
  name: string;
  title: string;
  description: string;
  endpoint: { baseUrl: string };
  tools: NamespacedToolDefinition[];
  views: never[];
  skills: never[];
} {
  return {
    name: "repo-manager",
    title: "リポジトリ",
    description:
      "ghq が知る Git リポジトリと gwq が知るワークツリーを、番頭が作業できる場所として提供する。" +
      "独自の登録簿は持たず毎回そこから導出する。ワークツリーの作成・削除ができる" +
      "（作業場所の用意であって、commit・push などの履歴の変更は持たない）。",
    endpoint: { baseUrl },
    tools: createRepoManagerTools(options) as NamespacedToolDefinition[],
    views: [],
    skills: [],
  };
}

/**
 * 場所の提供元としての repo-manager（ADR-0010 決定36b・c・task-0039）。
 *
 * `PlaceProvider` の実装。`ghq` が知るリポジトリと `gwq` が知るワークツリーを、
 * 番頭が作業できる**場所**として差し出す。
 *
 * **すべて読み取り専用**（決定38a）。`writable` を付けない——`ghq` が見つけた全リポジトリを
 * 番頭が書ける状態にするのは、許可を1つずつ与えるという決定38 の形を無効にする。
 * 書き込みを許したい場所は、ホスト設定（`BANTO_PLACES`）で明示的に足す。同じパスなら
 * 先に登録された設定側が勝つ。
 */

import type { Place, PlaceProvider } from "@banto/core";
import { runCommand, type CommandRunner } from "./command.js";
import { listGhqRepositories, listGwqWorktrees } from "./discovery.js";

export interface RepoManagerOptions {
  /** 外部コマンドの呼び出し口。既定は実際に `ghq` / `gwq` を起こす。 */
  run?: CommandRunner;
}

/** 提供元の名前。`PlaceRegistry` が失敗を報告するときに出る。 */
export const REPO_MANAGER_PROVIDER_NAME = "repo-manager";

/**
 * `ghq` / `gwq` から場所を導出する提供元を作る。
 *
 * I2: 未導入なら空を返す（決定36b）。コマンドがあるのに失敗したら例外を投げる——
 *     `PlaceRegistry` がそれを記録し、他の提供元で動き続ける。
 */
export function createRepoManagerPlaceProvider(options: RepoManagerOptions = {}): PlaceProvider {
  const run = options.run ?? runCommand;
  return {
    name: REPO_MANAGER_PROVIDER_NAME,
    // D3: 毎回導出する。ここにキャッシュを置かない（リポジトリは番頭の外でも増減する）
    list: async (): Promise<Place[]> => {
      const [repositories, worktrees] = await Promise.all([
        listGhqRepositories(run),
        listGwqWorktrees(run),
      ]);
      // ワークツリーは branch を持つが、共通契約は Place だけなので落として渡す（決定36c）
      return [...repositories, ...worktrees.map(({ id, label, path }) => ({ id, label, path }))];
    },
  };
}

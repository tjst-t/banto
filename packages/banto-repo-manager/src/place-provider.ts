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
import { repoDiscoveryFor } from "./discovery.js";

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
  const discovery = repoDiscoveryFor(run);
  return {
    name: REPO_MANAGER_PROVIDER_NAME,
    /**
     * D3: 台帳は持たない。`ghq`/`gwq` から導出したものをそのまま渡す——ただし
     * **導出は待たせない写し越し**に行う（`RepoDiscovery`）。`gwq list` は 400ms 以上
     * かかり、場所の解決は Tool 呼び出しのたびに起きるので、毎回起こすと GUI が
     * 目に見えて遅くなる。写しが古いときの追いつき方は discovery.ts に書いてある。
     */
    list: async (): Promise<Place[]> => {
      const [repositories, worktrees] = await Promise.all([
        discovery.repositories(),
        discovery.worktrees(),
      ]);
      // ワークツリーは branch を持つが、共通契約は Place だけなので落として渡す（決定36c）。
      //
      // **親リポジトリを指す**（PO裁定 2026-08-05）。ワークツリーは場所としては別だが、
      // 統治の単位＝プロジェクトとしては親と同じ——ブランチを切り替えただけで
      // プロジェクトの記憶（ADR-0003）が見えなくなるのは筋が通らない。
      return [
        ...repositories,
        ...worktrees.map(({ id, label, path }) => {
          const parent = parentRepositoryId(id, repositories);
          return { id, label, path, ...(parent ? { parent } : {}) };
        }),
      ];
    },
    // 探している場所が写しに無いときの逃げ道（決定36c）。呼び手（PlaceRegistry）が
    // 「知らない場所だ」と断る前にこれを呼ぶので、外で作られたワークツリーにも追いつく
    refresh: () => {
      discovery.invalidate();
    },
  };
}

/**
 * ワークツリーの親リポジトリを、**手元にある一覧から導く**（D3：新しい台帳を持たない）。
 *
 * `gwq` の置き場は ghq と同じ並び（`github.com/tjst-t/banto/<ブランチ>`）なので、
 * リポジトリのIDが接頭辞になっているものを選べばよい。**最長一致を採る**——
 * `a/b` と `a/b/c` の両方がリポジトリとして存在しうるため、短い方に吸われないようにする。
 *
 * 当てはまるものが無ければ `undefined`。推測で親を付けない——間違った親を指すと、
 * 別のプロジェクトの記憶に混ざる（ADR-0003 が禁じたその事故）。
 */
function parentRepositoryId(
  worktreeId: string,
  repositories: readonly { id: string }[]
): string | undefined {
  let best: string | undefined;
  for (const repo of repositories) {
    if (!worktreeId.startsWith(`${repo.id}/`)) continue;
    if (best === undefined || repo.id.length > best.length) best = repo.id;
  }
  return best;
}

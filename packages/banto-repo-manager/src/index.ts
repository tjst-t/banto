/**
 * repo-manager: Git リポジトリとワークツリーの場所を提供するモジュール（ADR-0010 決定36）。
 *
 * **状態を持たない。** `ghq` / `gwq` から毎回導出する（D3）。未導入なら場所を1つも返さず、
 * それをエラーにして番頭を止めることもしない（決定36b）。
 */

export { runCommand, output, type CommandRunner, type CommandResult } from "./command.js";
export {
  listGhqRepositories,
  listGwqWorktrees,
  worktreeBaseDir,
  type WorktreePlace,
} from "./discovery.js";
export {
  createRepoManagerPlaceProvider,
  REPO_MANAGER_PROVIDER_NAME,
  type RepoManagerOptions,
} from "./place-provider.js";
export { createRepoManagerTools, type RepoToolOptions } from "./tools.js";
export { createRepoManagerModule, REPO_MANAGER_BASE_URL } from "./module.js";
export { createWorktree, removeWorktree } from "./worktree.js";

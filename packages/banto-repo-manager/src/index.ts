/**
 * repo-manager: Git リポジトリとワークツリーの場所を提供するモジュール（ADR-0010 決定36）。
 *
 * **状態を持たない。** `ghq` / `gwq` から導出する（D3）。未導入なら場所を1つも返さず、
 * それをエラーにして番頭を止めることもしない（決定36b）。導出は重い（`gwq list` で 400ms 超）
 * ので、一覧は短命の写し越しに配る——台帳ではなく、いつでも捨てられる（`RepoDiscovery`）。
 */

export { runCommand, output, type CommandRunner, type CommandResult } from "./command.js";
export {
  listGhqRepositories,
  listGwqWorktrees,
  worktreeBaseDir,
  createRepoDiscovery,
  repoDiscoveryFor,
  type WorktreePlace,
  type RepoDiscovery,
} from "./discovery.js";
export {
  createRepoManagerPlaceProvider,
  REPO_MANAGER_PROVIDER_NAME,
  type RepoManagerOptions,
} from "./place-provider.js";
export { createRepoManagerTools, type RepoToolOptions } from "./tools.js";
export { createRepoManagerModule, REPO_MANAGER_BASE_URL } from "./module.js";
export { createWorktree, removeWorktree } from "./worktree.js";

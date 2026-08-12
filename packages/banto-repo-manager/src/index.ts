/**
 * repo-manager: Git リポジトリとワークツリーの場所を提供するモジュール（ADR-0010 決定36）。
 *
 * **状態を持たない。** 手元の並び（`layout.ts`）と `git worktree list` から導出する（D3）。
 * 何も無ければ場所を1つも返さず、それをエラーにして番頭を止めることもしない（決定36b）。
 * 導出は重い（一覧で 400ms 超）ので、一覧は短命の写し越しに配る——台帳ではなく、
 * いつでも捨てられる（`RepoDiscovery`）。
 *
 * **`ghq` / `gwq` には依存しない**（PO裁定 2026-08-11）。`gwq` はリモートが無いと
 * ワークツリーを作れず、Kobo が1本も回せなくなった。並びは引き継いだので、
 * それらで作った手元の資産はそのまま読める。
 */

export { runCommand, output, type CommandRunner, type CommandResult } from "./command.js";
export {
  listLocalRepositories,
  listGitWorktrees,
  createRepoDiscovery,
  repoDiscoveryFor,
  resetRepoDiscovery,
  type WorktreePlace,
  type RepoDiscovery,
} from "./discovery.js";
export {
  repoRoots,
  worktreeBase,
  listRepositories,
  repositoryId,
  branchDirName,
  worktreePathFor,
  repositoryPathFor,
  type FoundRepository,
} from "./layout.js";
export {
  listWorktrees,
  worktreeForBranch,
  parseWorktreePorcelain,
  type GitWorktree,
} from "./git-worktrees.js";
export {
  createRepoManagerPlaceProvider,
  REPO_MANAGER_PROVIDER_NAME,
  type RepoManagerOptions,
} from "./place-provider.js";
export { createRepoManagerTools, type RepoToolOptions } from "./tools.js";
export { createRepoManagerModule, REPO_MANAGER_BASE_URL } from "./module.js";
export { addTaskWorktree, createWorktree, removeWorktree } from "./worktree.js";

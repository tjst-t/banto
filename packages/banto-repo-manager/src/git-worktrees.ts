/**
 * `git worktree list --porcelain` を読む（PO裁定 2026-08-11）。
 *
 * `gwq list --json` の置き換え。**git が真実**なので、あいだに道具を挟む理由が無い
 * ——`gwq` は同じことを git に聞いて自前の形に直していただけで、その形の解釈
 * （0件のときだけ JSON を返さない、等）にこちらが振り回されていた。
 *
 * D3: 台帳を持たない。リポジトリごとに git へ聞く。
 * I2: git が失敗したら黙って空を返さない（呼び出し側が「ワークツリーが無い」と誤読する）。
 */

import * as path from "node:path";
import { output, type CommandRunner } from "./command.js";

/** 1つのワークツリー。 */
export interface GitWorktree {
  /** 実体の場所。 */
  path: string;
  /** 指しているブランチ（detached なら `(detached)`）。 */
  branch: string;
  /** そのリポジトリの本体（`git worktree list` の先頭）か。 */
  main: boolean;
}

/**
 * そのリポジトリのワークツリーを全部返す（本体を含む）。
 *
 * `--porcelain` は空行区切りのブロックで、1ブロックが1つのワークツリー。
 * 先頭のブロックが本体。
 */
export async function listWorktrees(
  run: CommandRunner,
  repoPath: string
): Promise<GitWorktree[]> {
  const raw = await output(run, "git", ["-C", repoPath, "worktree", "list", "--porcelain"]);
  if (raw === undefined) return []; // git が無い（呼び出し側が別途失敗する）
  return parseWorktreePorcelain(raw);
}

/** `--porcelain` の出力を読む。**形が変わったら空になるのではなく、行が減るだけ**。 */
export function parseWorktreePorcelain(raw: string): GitWorktree[] {
  const out: GitWorktree[] = [];
  for (const block of raw.split("\n\n")) {
    const lines = block.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
    const pathLine = lines.find((l) => l.startsWith("worktree "));
    if (!pathLine) continue;
    const branchLine = lines.find((l) => l.startsWith("branch "));
    const ref = branchLine?.slice("branch ".length).trim();
    out.push({
      path: path.resolve(pathLine.slice("worktree ".length).trim()),
      branch: ref ? ref.replace(/^refs\/heads\//u, "") : "(detached)",
      // 先頭が本体。`git worktree list` は必ず本体から並べる
      main: out.length === 0,
    });
  }
  return out;
}

/**
 * そのブランチをチェックアウトしているワークツリー（本体は除く）。
 *
 * 本体で作業させるとワークツリーの意味が無いので、本体は候補にしない。
 */
export async function worktreeForBranch(
  run: CommandRunner,
  repoPath: string,
  branch: string
): Promise<string | undefined> {
  const all = await listWorktrees(run, repoPath);
  return all.find((w) => !w.main && w.branch === branch)?.path;
}

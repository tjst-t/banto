/**
 * ワークツリーの作成・削除（ADR-0010 決定36h・task-0039）。
 *
 * **`banto-worker-pool/src/pi-rpc-driver.ts` から移してきた。振る舞いは変えていない。**
 * 置き場だけが Worker Pool にあり、Worker Pool 自身は1度も呼んでいなかった——実際に呼ぶのは
 * Kobo（`daemon.ts` / `merge-queue.ts`）だけで、task-0010 の切り出しのときに pi ドライバの
 * 隣にあったヘルパーが付いてきたものと思われる。機能を2箇所に分散させない（決定36h）。
 *
 * ワークツリーの作成・削除は**作業場所の用意**であって Git 履歴の変更ではないので、
 * 決定37（番頭は Git の変更操作を持たない）には触れない。
 *
 * D6: node:child_process / node:fs / node:path のみ。
 */

import * as childProcess from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { runCommand, type CommandRunner } from "./command.js";
import { worktreePathFor } from "./layout.js";
import { worktreeForBranch } from "./git-worktrees.js";

/**
 * Create a git worktree for a task if it does not already exist.
 *
 * Used by SpawnManager to prepare the worktree before spawn().
 * Runs `git worktree add --detach <path>` (detached HEAD = branch is created
 * by the agent if needed).
 *
 * I2: throws on git error (caller converts to task_failed event).
 */
export async function createWorktree(repoPath: string, worktreePath: string): Promise<void> {
  if (fs.existsSync(worktreePath)) return; // idempotent

  fs.mkdirSync(path.dirname(worktreePath), { recursive: true });

  await new Promise<void>((resolve, reject) => {
    const proc = childProcess.spawn(
      "git",
      ["worktree", "add", "--detach", worktreePath],
      {
        cwd: repoPath,
        stdio: "pipe",
      }
    );
    let stderr = "";
    proc.stderr?.on("data", (c: Buffer) => { stderr += c.toString(); });
    proc.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`git worktree add failed (code=${code}): ${stderr}`));
    });
    proc.on("error", (err) => reject(err));
  });
}

/**
 * タスク用のワークツリーを作る（ADR-0013 決定60・task-0060 a6。PO裁定 2026-08-11 で自前に）。
 *
 * **置き場は `layout.ts` が決める。** 以前は `gwq add` に作らせていたが、`gwq` は置き場を
 * `git remote get-url origin` から組み立てるので、**リモートの無いリポジトリでは作れない**
 * ——ひらがなの task-0001 / 0002 はここで止まった（`failed to generate worktree path`）。
 * いまは「リポジトリが根のどこに在るか」から導くので、リモートの有無に依らない。
 * 並びは今までと同じなので、手元のワークツリーはそのまま使える。
 *
 * **冪等**：そのブランチのワークツリーが既にあれば、作らずにその場所を返す。
 * 監査・rework は実装者と同じワークツリーを見る必要があるため、ここが冪等でないと
 * 「作り直して空のディレクトリを監査する」ことになる。
 *
 * **出来上がりの場所は git に聞く**（組み立てた見込みのパスを返さない・D3）。
 *
 * I2: 作れなかったときは黙って別の場所に作らない。理由を添えて投げる
 *     ——呼び出し側（Kobo）は task_failed として記録し、止まる。
 */
export async function addTaskWorktree(opts: {
  repoPath: string;
  /** ワークツリーが指すブランチ（Kobo の慣習は `task/<taskId>`）。 */
  branch: string;
  /** 外部コマンドの実行口。テストで差し替える。 */
  run?: CommandRunner;
  /** 置き場の根。省略すると設定（`BANTO_WORKTREE_BASE`）か既定。 */
  base?: string;
  /** リポジトリの根。id の導出に使う。 */
  roots?: readonly string[];
}): Promise<{ path: string; created: boolean }> {
  const run = opts.run ?? runCommand;

  const existing = await worktreeForBranch(run, opts.repoPath, opts.branch);
  if (existing) return { path: existing, created: false };

  const target = worktreePathFor({
    repoPath: opts.repoPath,
    branch: opts.branch,
    ...(opts.base ? { base: opts.base } : {}),
    ...(opts.roots ? { roots: opts.roots } : {}),
  });

  // 既にブランチがあるなら -b は付けない（rework でブランチだけ残っている場合）
  const branchExists = await run("git", ["-C", opts.repoPath, "rev-parse", "--verify", opts.branch]);
  const args = branchExists.ok
    ? ["-C", opts.repoPath, "worktree", "add", target, opts.branch]
    : ["-C", opts.repoPath, "worktree", "add", "-b", opts.branch, target];

  fs.mkdirSync(path.dirname(target), { recursive: true });
  const result = await run("git", args);
  if (result.notFound) throw new Error("git が導入されていないため、ワークツリーを作れません。");
  if (!result.ok) {
    throw new Error(
      `git worktree add が失敗しました（${target}）: ` +
        `${result.stderr.trim() || result.stdout.trim() || "(出力なし)"}`
    );
  }

  const created = await worktreeForBranch(run, opts.repoPath, opts.branch);
  // I2: 作ったつもりで見当たらないなら、見込みのパスを組み立てて返さない
  if (!created) {
    throw new Error(
      `ワークツリーを作りましたが、${opts.repoPath} の git worktree list に ` +
        `"${opts.branch}" が現れませんでした。`
    );
  }
  return { path: created, created: true };
}

/**
 * Remove a git worktree.
 * Safe to call even if the worktree doesn't exist.
 */
export async function removeWorktree(repoPath: string, worktreePath: string): Promise<void> {
  if (!fs.existsSync(worktreePath)) return;

  await new Promise<void>((resolve) => {
    const proc = childProcess.spawn(
      "git",
      ["worktree", "remove", "--force", worktreePath],
      {
        cwd: repoPath,
        stdio: "pipe",
      }
    );
    proc.on("exit", () => resolve());
    proc.on("error", () => resolve()); // Best-effort
  });
}

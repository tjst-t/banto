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

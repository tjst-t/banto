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
import { output, runCommand, type CommandRunner } from "./command.js";

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
 * タスク用のワークツリーを `gwq` の置き場に作る（ADR-0013 決定60・task-0060 a6）。
 *
 * **置き場所を自分で決めない。** `gwq add` に作らせるので、出来上がりは gwq の設定
 * （`worktree.basedir` と命名テンプレート）に従い、そのまま `gwq list` に載る＝番頭と PO が
 * **場所として中を読める**。Kobo が `<dataDir>/worktrees/` に作っていた頃は、実装中の
 * 中身を誰も読めなかった（決定36h の2段目）。
 *
 * **冪等**：そのブランチのワークツリーが既にあれば、作らずにその場所を返す。
 * 監査・rework は実装者と同じワークツリーを見る必要があるため、ここが冪等でないと
 * 「作り直して空のディレクトリを監査する」ことになる。
 *
 * **出来上がりの場所は git に聞く**（gwq の出力を解釈しない・D3）。`git worktree list
 * --porcelain` はリポジトリに紐づくので、同名ブランチが別リポジトリにあっても取り違えない。
 *
 * I2: `gwq` が無い／失敗したときは黙って別の場所に作らない。理由を添えて投げる
 *     ——呼び出し側（Kobo）は task_failed として記録し、止まる。
 */
export async function addTaskWorktree(opts: {
  repoPath: string;
  /** ワークツリーが指すブランチ（Kobo の慣習は `task/<taskId>`）。 */
  branch: string;
  /** 外部コマンドの実行口。テストで差し替える。 */
  run?: CommandRunner;
}): Promise<{ path: string; created: boolean }> {
  const run = opts.run ?? runCommand;

  const existing = await worktreeForBranch(run, opts.repoPath, opts.branch);
  if (existing) return { path: existing, created: false };

  // 既にブランチがあるなら -b は付けない（rework でブランチだけ残っている場合）
  const branchExists = await run("git", ["-C", opts.repoPath, "rev-parse", "--verify", opts.branch]);
  const args = branchExists.ok ? ["add", opts.branch] : ["add", "-b", opts.branch];
  const result = await run("gwq", args, { cwd: opts.repoPath });
  if (result.notFound) {
    throw new Error(
      "gwq が導入されていないため、ワークツリーを作れません。" +
        "Kobo は置き場所を自分で決めません（決定60）——gwq を入れるか、" +
        "worktreeBaseDir を明示してください。"
    );
  }
  if (!result.ok) {
    throw new Error(
      `gwq ${args.join(" ")} が失敗しました: ${result.stderr.trim() || result.stdout.trim() || "(出力なし)"}`
    );
  }

  const created = await worktreeForBranch(run, opts.repoPath, opts.branch);
  // I2: 作ったつもりで見当たらないなら、見込みのパスを組み立てて返さない
  if (!created) {
    throw new Error(
      `gwq はワークツリーを作りましたが、${opts.repoPath} の git worktree list に ` +
        `"${opts.branch}" が現れませんでした。`
    );
  }
  return { path: created, created: true };
}

/**
 * そのリポジトリで、指定ブランチをチェックアウトしているワークツリーの場所。
 *
 * 本体（先頭のエントリ）は除く——本体で作業させると worktree の意味が無い。
 */
async function worktreeForBranch(
  run: CommandRunner,
  repoPath: string,
  branch: string
): Promise<string | undefined> {
  const raw = await output(run, "git", ["-C", repoPath, "worktree", "list", "--porcelain"]);
  if (raw === undefined) return undefined; // git が無い環境（呼び出し側が別途失敗する）

  // --porcelain は空行区切りのブロック。先頭ブロックが本体
  const blocks = raw.split("\n\n").filter((b) => b.trim().length > 0);
  for (const [index, block] of blocks.entries()) {
    if (index === 0) continue; // 本体
    const lines = block.split("\n").map((l) => l.trim());
    const pathLine = lines.find((l) => l.startsWith("worktree "));
    const branchLine = lines.find((l) => l.startsWith("branch "));
    if (!pathLine || !branchLine) continue;
    const ref = branchLine.slice("branch ".length).trim();
    if (ref === `refs/heads/${branch}` || ref === branch) {
      return path.resolve(pathLine.slice("worktree ".length).trim());
    }
  }
  return undefined;
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

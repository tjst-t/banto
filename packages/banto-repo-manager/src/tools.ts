/**
 * repo-manager 固有の Tool（ADR-0010 決定36c・task-0039 a4）。
 *
 * ワークツリーの作成・削除。**共通契約（`PlaceProvider`）には入れない**——静的パスに
 * 「ワークツリーを追加」は意味がなく、共通化すると片方が空実装になる（契約が間違っている印）。
 *
 * 決定37（番頭は Git の変更操作を持たない）には触れない。ワークツリーの用意は
 * **作業場所の用意**であって履歴の変更ではない。ここに commit / push / branch は無い。
 *
 * **砦が要らない形にしてある。** 引数で受けるのは `ghq` / `gwq` が既に知っている場所の id
 * だけで、任意のパスを受け取らない。作る場所も `gwq` の設定した置き場に従う（自分で決めない）。
 * `worker.delegate` の `worktreePath` のような「番頭が任意のパスを渡せる」穴を作らない。
 */

import * as path from "node:path";
import { Type } from "typebox";
import { defineNamespacedTool, type BantoToolDefinition } from "@banto/core";
import { output, runCommand, type CommandRunner } from "./command.js";
import { listGhqRepositories, listGwqWorktrees } from "./discovery.js";
import { removeWorktree } from "./worktree.js";

export interface RepoToolOptions {
  run?: CommandRunner;
}

export function createRepoManagerTools(options: RepoToolOptions = {}): BantoToolDefinition[] {
  const run = options.run ?? runCommand;

  const list = defineNamespacedTool({
    name: "repo.list",
    label: "Repo: List",
    description:
      "ghq が知っているリポジトリと、gwq が知っているワークツリーの一覧。" +
      "ワークツリーはどのリポジトリのものかも分かる。" +
      "作業できる場所そのものを知りたいだけなら place.list の方が広い（設定で足した作業領域も出る）。",
    parameters: Type.Object({
      query: Type.Optional(Type.String({ description: "id・名前・パスの部分一致で絞る" })),
    }),
    async execute(params) {
      const [repositories, worktrees] = await Promise.all([
        listGhqRepositories(run),
        listGwqWorktrees(run),
      ]);

      // どのリポジトリのワークツリーかを git に聞く（gwq の出力には入っていない）。
      // D3: 導出できるので持たない。件数は数個なので毎回引いてよい
      const withOwner = await Promise.all(
        worktrees.map(async (w) => {
          let repoPath: string | undefined;
          try {
            repoPath = await mainWorktreePath(run, w.path);
          } catch {
            // I2 の例外ではない: 紐付けが分からなくても一覧からは落とさない。
            // 落とすと「見えないワークツリー」ができ、畳み忘れに気づけなくなる
            repoPath = undefined;
          }
          const owner = repoPath ? repositories.find((r) => r.path === repoPath) : undefined;
          return { ...w, repo: owner?.id ?? null, repoPath: repoPath ?? null };
        })
      );

      const needle = params.query?.trim().toLowerCase();
      const match = (v: { id: string; label: string; path: string }): boolean =>
        !needle || [v.id, v.label, v.path].some((f) => f.toLowerCase().includes(needle));

      const repos = repositories.filter(match);
      const trees = withOwner.filter(match);
      const text =
        repos.length === 0 && trees.length === 0
          ? "ghq / gwq が知っているものはありません（未導入か、まだ何も clone していない）"
          : [
              ...repos.map((r) => `${r.id}`),
              ...trees.map((w) => `${w.id} — ワークツリー: ${w.branch}${w.repo ? ` （${w.repo}）` : ""}`),
            ].join("\n");

      return {
        content: [{ type: "text" as const, text }],
        details: { repositories: repos, worktrees: trees },
      };
    },
  });

  const add = defineNamespacedTool({
    name: "repo.worktree.add",
    label: "Repo: Worktree Add",
    description:
      "リポジトリにワークツリー（同じリポジトリの別ブランチを別ディレクトリに置いたもの）を作る。" +
      "同じリポジトリで複数の作業を同時に進めたいときに使う。作られたワークツリーは場所として" +
      "登録され、そのまま file.* や worker.delegate の行き先にできる。" +
      "置き場所は gwq の設定に従うので指定しない。ブランチを切る以外の Git 操作は持たない。",
    parameters: Type.Object({
      repo: Type.String({ description: "対象リポジトリの場所 id（例: github.com/tjst-t/banto）" }),
      branch: Type.String({ description: "ワークツリーが指すブランチ名" }),
      createBranch: Type.Optional(
        Type.Boolean({ description: "ブランチを新しく作る場合は true（既定 false＝既存ブランチ）" })
      ),
    }),
    async execute(params) {
      const repositories = await listGhqRepositories(run);
      const repo = repositories.find((r) => r.id === params.repo);
      // I2: 知らないリポジトリを黙って作らない。どれがあるかを添えて止まる
      if (!repo) {
        throw new Error(
          `リポジトリ "${params.repo}" は ghq が知りません。` +
            `既知: ${repositories.map((r) => r.id).join(", ") || "(なし)"}`
        );
      }

      // 前後を比べて「増えたもの」を見つける。ブランチ名で引くと、別のリポジトリに
      // 同名ブランチのワークツリーがあるときに取り違える
      const before = new Set((await listGwqWorktrees(run)).map((w) => w.path));

      const args = ["add", ...(params.createBranch ? ["-b"] : []), params.branch];
      const result = await run("gwq", args, { cwd: repo.path });
      if (result.notFound) throw new Error("gwq が導入されていません。");
      if (!result.ok) {
        throw new Error(
          `ワークツリーを作れませんでした: ${result.stderr.trim() || result.stdout.trim() || "(出力なし)"}`
        );
      }

      // 作った結果を gwq に聞き直す（自分で組み立てた見込みのパスを返さない。D3）
      const created = (await listGwqWorktrees(run)).find((w) => !before.has(w.path));
      const where = created ? `${created.id}（${created.path}）` : "(gwq の一覧に見当たりません)";
      return {
        content: [
          {
            type: "text" as const,
            text: `${repo.label} にワークツリーを作りました: ${params.branch} → ${where}`,
          },
        ],
        details: { repo: { id: repo.id, path: repo.path }, branch: params.branch, worktree: created ?? null },
      };
    },
  });

  const remove = defineNamespacedTool({
    name: "repo.worktree.remove",
    label: "Repo: Worktree Remove",
    description:
      "ワークツリーを削除する。消えるのは作業ディレクトリだけで、コミットやブランチは残る。" +
      "未コミットの変更があっても消えるので、消してよいか確かめてから使う。",
    parameters: Type.Object({
      worktree: Type.String({ description: "削除するワークツリーの場所 id" }),
    }),
    async execute(params) {
      const worktrees = await listGwqWorktrees(run);
      const target = worktrees.find((w) => w.id === params.worktree);
      // I2: 知らないものを消さない。取り違えて別の作業を消すのが一番困る
      if (!target) {
        throw new Error(
          `ワークツリー "${params.worktree}" は gwq が知りません。` +
            `既知: ${worktrees.map((w) => w.id).join(", ") || "(なし)"}`
        );
      }

      const repoPath = await mainWorktreePath(run, target.path);
      await removeWorktree(repoPath, target.path);

      return {
        content: [
          { type: "text" as const, text: `ワークツリーを削除しました: ${target.id}（${target.branch}）` },
        ],
        details: { worktree: { id: target.id, path: target.path, branch: target.branch }, repoPath },
      };
    },
  });

  return [list, add, remove];
}

/**
 * ワークツリーから、それが属するリポジトリ本体の場所を引く。
 *
 * `git worktree remove` はリポジトリ側から実行する必要がある（消す対象の中からは実行できない）。
 * `git worktree list --porcelain` の**先頭が本体**なので、そこから取る。
 */
async function mainWorktreePath(run: CommandRunner, worktreePath: string): Promise<string> {
  const raw = await output(run, "git", ["-C", worktreePath, "worktree", "list", "--porcelain"]);
  const first = (raw ?? "")
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.startsWith("worktree "));
  // I2: 取れなければ推測しない。親ディレクトリを当てにすると別のリポジトリを操作しうる
  if (!first) throw new Error(`${worktreePath} が属するリポジトリを特定できません。`);
  return path.resolve(first.slice("worktree ".length).trim());
}

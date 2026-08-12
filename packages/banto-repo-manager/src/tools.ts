/**
 * repo-manager 固有の Tool（ADR-0010 決定36c・task-0039 a4）。
 *
 * ワークツリーの作成・削除。**共通契約（`PlaceProvider`）には入れない**——静的パスに
 * 「ワークツリーを追加」は意味がなく、共通化すると片方が空実装になる（契約が間違っている印）。
 *
 * 決定37（番頭は Git の変更操作を持たない）には触れない。ワークツリーの用意は
 * **作業場所の用意**であって履歴の変更ではない。ここに commit / push / branch は無い。
 *
 * **砦が要らない形にしてある。** 引数で受けるのは**手元にある場所の id** だけで、任意の
 * パスを受け取らない。作る場所も並び（`layout.ts`）が決める（呼び出し側に選ばせない）。
 * `worker.delegate` の `worktreePath` のような「番頭が任意のパスを渡せる」穴を作らない。
 *
 * **`ghq` / `gwq` は使わない**（PO裁定 2026-08-11）。並びは引き継いでいるので、
 * それらで作った手元の資産はそのまま読める。
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Type } from "typebox";
import { defineNamespacedTool, type BantoToolDefinition } from "@banto/core";
import { output, runCommand, type CommandRunner } from "./command.js";
import { repoDiscoveryFor } from "./discovery.js";
import { repositoryPathFor } from "./layout.js";
import { addTaskWorktree, removeWorktree } from "./worktree.js";

export interface RepoToolOptions {
  run?: CommandRunner;
}

export function createRepoManagerTools(options: RepoToolOptions = {}): BantoToolDefinition[] {
  const run = options.run ?? runCommand;
  /**
   * 一覧の写し（`place.list` と共有する）。
   *
   * 作る・消す道具も**同じ写しを読む**（どれが在るかを確かめるだけ）。出来上がりの場所は
   * 前後の差分ではなく git に聞いて決めるので、写しが少し古くても取り違えない。
   * 変えたら最後に写しを捨てる（次に聞かれたら導出し直す）。
   */
  const discovery = repoDiscoveryFor(run);

  const list = defineNamespacedTool({
    name: "repo.list",
    label: "Repo: List",
    description:
      "手元にあるリポジトリと、その git ワークツリーの一覧。" +
      "ワークツリーはどのリポジトリのものかも分かる。" +
      "作業できる場所そのものを知りたいだけなら place.list の方が広い（設定で足した作業領域も出る）。",
    parameters: Type.Object({
      query: Type.Optional(Type.String({ description: "id・名前・パスの部分一致で絞る" })),
    }),
    async execute(params) {
      const [repositories, worktrees] = await Promise.all([
        discovery.repositories(),
        discovery.worktrees(),
      ]);

      // どのリポジトリのワークツリーかを git に聞く（置き場の並びから推測しない）。
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
          ? "手元にリポジトリがありません（まだ何も clone / init していない）"
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


  const clone = defineNamespacedTool({
    name: "repo.clone",
    label: "Repo: Clone",
    description:
      "リモートのリポジトリを手元に持ってくる（git clone）。置き場所は手元の並びで決まるので指定しない。" +
      "取り込んだリポジトリはそのまま「場所」として選べるようになる。" +
      "**外に出ていく操作**（ネットワーク越しに取得する）なので、頼まれたときだけ使うこと。",
    parameters: Type.Object({
      repository: Type.String({
        description:
          "取ってくる対象。URL でも <user>/<project> でも <host>/<user>/<project> でもよい",
      }),
      ssh: Type.Optional(Type.Boolean({ description: "SSH で取ってくる（既定 false＝HTTPS）" })),
      shallow: Type.Optional(Type.Boolean({ description: "履歴を浅く取る（大きいリポジトリ向け）" })),
    }),
    async execute(params) {
      const target = params.repository.trim();
      // I2: 空や空白だけからは置き場を決められない
      if (target.length === 0) throw new Error("取ってくる対象が空です。");

      const where = repositoryPathFor(target);
      // 既にあるなら取りに行かない（外に出ていく操作は必要なときだけ）
      if (fs.existsSync(path.join(where.path, ".git"))) {
        return {
          content: [
            {
              type: "text" as const,
              text: `${where.id} は既に手元にあります（${where.path}）`,
            },
          ],
          details: { repository: { id: where.id, path: where.path }, requested: target, alreadyPresent: true },
        };
      }

      const url = cloneUrl(target, where.id, params.ssh === true);
      fs.mkdirSync(path.dirname(where.path), { recursive: true });
      const args = ["clone", ...(params.shallow ? ["--depth", "1"] : []), url, where.path];
      const result = await run("git", args);
      if (result.notFound) throw new Error("git が導入されていません。");
      if (!result.ok) {
        throw new Error(
          `取ってこられませんでした: ${result.stderr.trim() || result.stdout.trim() || "(出力なし)"}`
        );
      }
      // I2: 作ったつもりで無いなら成功に見せない（見込みのパスをそのまま返さない・D3）
      if (!fs.existsSync(path.join(where.path, ".git"))) {
        throw new Error(`${url} を取り込みましたが、${where.path} にリポジトリがありません。`);
      }

      // 場所が増えた。写しを捨てて、次に聞かれたら導出し直させる
      discovery.invalidate();
      return {
        content: [
          { type: "text" as const, text: `取り込みました: ${where.id}（${where.path}）` },
        ],
        details: {
          repository: { id: where.id, path: where.path },
          requested: target,
          alreadyPresent: false,
        },
      };
    },
  });

  const init = defineNamespacedTool({
    name: "repo.init",
    label: "Repo: Init",
    description:
      "新しい Git リポジトリを手元に作る（git init）。置き場所は手元の並びで決まる。" +
      "リモートは作らない——手元に空のリポジトリができるだけで、公開はしない。",
    parameters: Type.Object({
      name: Type.String({
        description: "作る名前。<project> / <user>/<project> / <host>/<user>/<project> のいずれか",
      }),
    }),
    async execute(params) {
      const target = params.name.trim();
      if (target.length === 0) throw new Error("作る名前が空です。");

      // `<project>` だけのときは所有者を補えない。**推測しない**（I2）
      const where = repositoryPathFor(
        target.includes("/") ? target : `${defaultOwner()}/${target}`
      );
      if (fs.existsSync(path.join(where.path, ".git"))) {
        throw new Error(`${where.id} は既にあります（${where.path}）。`);
      }
      fs.mkdirSync(where.path, { recursive: true });
      const result = await run("git", ["-C", where.path, "init"]);
      if (result.notFound) throw new Error("git が導入されていません。");
      if (!result.ok) {
        throw new Error(
          `作れませんでした: ${result.stderr.trim() || result.stdout.trim() || "(出力なし)"}`
        );
      }
      // 場所が増えた。作れていなくても写しは捨てる（増減の判断はこの下でする）
      discovery.invalidate();
      // I2: 作ったつもりで無いなら、そう言う（成功に見せない）
      if (!fs.existsSync(path.join(where.path, ".git"))) {
        throw new Error(`${target} を作りましたが、${where.path} にリポジトリがありません。`);
      }
      return {
        content: [
          { type: "text" as const, text: `作りました: ${where.id}（${where.path}）` },
        ],
        details: { repository: { id: where.id, path: where.path } },
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
      "置き場所は手元の並びで決まるので指定しない。ブランチを切る以外の Git 操作は持たない。",
    parameters: Type.Object({
      repo: Type.String({ description: "対象リポジトリの場所 id（例: github.com/tjst-t/banto）" }),
      branch: Type.String({ description: "ワークツリーが指すブランチ名" }),
      createBranch: Type.Optional(
        Type.Boolean({ description: "ブランチを新しく作る場合は true（既定 false＝既存ブランチ）" })
      ),
    }),
    async execute(params) {
      const repositories = await discovery.repositories();
      const repo = repositories.find((r) => r.id === params.repo);
      // I2: 知らないリポジトリを黙って作らない。どれがあるかを添えて止まる
      if (!repo) {
        throw new Error(
          `リポジトリ "${params.repo}" は手元にありません。` +
            `既知: ${repositories.map((r) => r.id).join(", ") || "(なし)"}`
        );
      }

      // **既にあるなら作らない**（addTaskWorktree と同じ冪等）。作り直すと、
      // そこで進んでいた作業のディレクトリを別物に差し替えることになる
      const created = await addTaskWorktree({ repoPath: repo.path, branch: params.branch, run });
      // 場所が増えた。**ここで捨てないと、作った直後の場所が使えない**（写しに無いため）
      discovery.invalidate();
      return {
        content: [
          {
            type: "text" as const,
            text: created.created
              ? `${repo.label} にワークツリーを作りました: ${params.branch} → ${created.path}`
              : `${repo.label} の ${params.branch} は既にあります: ${created.path}`,
          },
        ],
        details: {
          repo: { id: repo.id, path: repo.path },
          branch: params.branch,
          worktree: { path: created.path, created: created.created },
        },
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
      const worktrees = await discovery.worktrees();
      const target = worktrees.find((w) => w.id === params.worktree);
      // I2: 知らないものを消さない。取り違えて別の作業を消すのが一番困る
      if (!target) {
        throw new Error(
          `ワークツリー "${params.worktree}" は手元にありません。` +
            `既知: ${worktrees.map((w) => w.id).join(", ") || "(なし)"}`
        );
      }

      const repoPath = await mainWorktreePath(run, target.path);
      await removeWorktree(repoPath, target.path);
      // 場所が減った。消えたものを次の一覧に出さない
      discovery.invalidate();

      return {
        content: [
          { type: "text" as const, text: `ワークツリーを削除しました: ${target.id}（${target.branch}）` },
        ],
        details: { worktree: { id: target.id, path: target.path, branch: target.branch }, repoPath },
      };
    },
  });

  return [list, clone, init, add, remove];
}

/**
 * 取ってくる先の URL を組み立てる（`ghq get` の代わり）。
 *
 * 渡されたものが既に URL ならそのまま使う。`<owner>/<repo>` の形なら、id から
 * `https://<host>/<owner>/<repo>.git`（`ssh` なら `git@<host>:<owner>/<repo>.git`）にする
 * ——**推測するのはここだけ**で、置き場は id から一意に決まっている。
 */
function cloneUrl(requested: string, id: string, ssh: boolean): string {
  if (/^[a-z][a-z0-9+.-]*:\/\//iu.test(requested) || /^[^@/]+@[^:]+:/u.test(requested)) {
    return requested;
  }
  const [host, ...rest] = id.split("/");
  const repoPath = rest.join("/");
  return ssh ? `git@${host}:${repoPath}.git` : `https://${host}/${repoPath}.git`;
}

/**
 * `<project>` だけを渡されたときの所有者。
 *
 * **手元のログイン名**を使う。`ghq create` は設定（`ghq.user`）から補っていたが、
 * その設定ごと外したので、推測できる一番素直なものにする。分からなければ `local`
 * ——**置き場が一意に決まりさえすればよい**（外へ出す名前ではない）。
 */
function defaultOwner(): string {
  try {
    return os.userInfo().username || "local";
  } catch {
    return "local";
  }
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

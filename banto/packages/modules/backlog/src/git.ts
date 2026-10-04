// 一覧のブランチを読み書きする git（§4.4「置き場——専用のブランチ」）。
//
// **作業ツリーも index も使わない**——低レベルのコマンドだけ：読むのは `rev-parse` と `cat-file`、書くのは
// `hash-object -w` → `mktree` → `commit-tree` → `update-ref <新> <読んだときの古い値>`（compare-and-swap）。
// どのブランチを checkout していても、作業ツリーに未コミットの変更があっても、触らずに同じ ref を読み書きする。
//
// 外から渡された `GIT_*` は落とす——`GIT_DIR`・`GIT_INDEX_FILE` 等が残っていると、Project の根ではなく別の
// リポジトリ（か別の index）を触る。作者・コミッターは banto（コミットは Module が積むもの）。

import { execFile } from "node:child_process";

/** 一覧のファイル名（ブランチの中のただ1つのファイル）。固定 */
export const TASKS_FILE = "tasks.json";

/** コミットの作者・コミッター */
export const AUTHOR = { name: "banto", email: "banto@localhost" } as const;

export type GitResult = { ok: true; stdout: string } | { ok: false; code: number | string; stderr: string };

/** 待つ長さ（ms）。読み書きは手元だけ、送る・取ってくるは相手次第。**試験で縮める穴** */
export const GIT_TIMEOUTS = { local: 15_000, network: 60_000 };

function gitEnv(): NodeJS.ProcessEnv {
  return {
    ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_"))),
    // 失敗の文言で状態を見分けるので、言語をそろえる
    LC_ALL: "C",
    LANGUAGE: "C",
    // 資格情報を聞いて止まらない（コンテナの中の git には、聞く相手がいない）
    GIT_TERMINAL_PROMPT: "0",
    GIT_AUTHOR_NAME: AUTHOR.name,
    GIT_AUTHOR_EMAIL: AUTHOR.email,
    GIT_COMMITTER_NAME: AUTHOR.name,
    GIT_COMMITTER_EMAIL: AUTHOR.email,
  };
}

/** git を走らせる。**失敗も値で返す**——どの失敗が「そういう状態」かは呼ぶ側が決める */
export function runGit(root: string, args: string[], opts: { input?: string; timeoutMs?: number } = {}): Promise<GitResult> {
  return new Promise((resolve) => {
    const child = execFile(
      "git",
      ["-C", root, ...args],
      { env: gitEnv(), timeout: opts.timeoutMs ?? GIT_TIMEOUTS.local, maxBuffer: 64 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (!err) return resolve({ ok: true, stdout: String(stdout) });
        if ((err as { killed?: boolean }).killed) {
          return resolve({ ok: false, code: "timeout", stderr: `git ${args[0]} が ${Math.round((opts.timeoutMs ?? GIT_TIMEOUTS.local) / 1000)} 秒で答えませんでした` });
        }
        const code = (err as NodeJS.ErrnoException).code ?? "error";
        // git が無い——状態ではなく本当の失敗（規則2）
        if (code === "ENOENT") return resolve({ ok: false, code, stderr: "git コマンドが見つかりません" });
        // stderr は git が言ったものだけ（空のこともある——`--verify -q` の「無い」は黙って 1）
        resolve({ ok: false, code, stderr: String(stderr).trim() });
      },
    );
    if (opts.input !== undefined) child.stdin?.end(opts.input);
  });
}

/** 失敗を理由つきの例外にする（そういう状態ではなく、読めなかった・書けなかったもの） */
export function gitFailure(what: string, r: Extract<GitResult, { ok: false }>): Error {
  return new Error(`${what}：${r.stderr || `git が ${String(r.code)} で終わりました`}`);
}

/** その ref の指すコミット。無ければ undefined（ほかの失敗は投げる） */
export async function resolveRef(root: string, ref: string): Promise<string | undefined> {
  const r = await runGit(root, ["rev-parse", "--verify", "-q", `${ref}^{commit}`]);
  if (r.ok) return r.stdout.trim();
  // 無い——`--verify -q` は何も言わずに 1 で終わる（git の決まり）
  if (r.code === 1 && r.stderr === "") return undefined;
  if (r.code === 1 && /^fatal: Needed a single revision/.test(r.stderr)) return undefined;
  throw gitFailure(`${ref} を読めません`, r);
}

/** Project の根が git のリポジトリか。違えば理由（根が無い・git でない） */
export async function repositoryProblem(root: string): Promise<string | undefined> {
  const r = await runGit(root, ["rev-parse", "--git-dir"]);
  if (r.ok) return undefined;
  if (/not a git repository/i.test(r.stderr)) return "Project の根が git のリポジトリではありません（一覧はリポジトリのブランチに置きます）";
  if (r.code === "ENOENT" || /cannot change to/i.test(r.stderr)) return `Project の根を開けません（${r.stderr}）`;
  throw gitFailure("Project の根の git を読めません", r);
}

/** コミットの中の tasks.json。無ければ undefined */
export async function readTasksBlob(root: string, commit: string): Promise<string | undefined> {
  const r = await runGit(root, ["cat-file", "blob", `${commit}:${TASKS_FILE}`]);
  if (r.ok) return r.stdout;
  if (/does not exist|exists on disk, but not in|Not a valid object name|path .* does not exist/i.test(r.stderr)) return undefined;
  throw gitFailure(`${TASKS_FILE} を読めません`, r);
}

/**
 * tasks.json だけを持つコミットを作る（ref はまだ動かさない）。親は読んだときのコミット——無ければ親を持たない
 * （orphan。コードの履歴とつながらない）
 */
export async function commitTasks(root: string, text: string, parent: string | undefined, message: string): Promise<string> {
  const blob = await runGit(root, ["hash-object", "-w", "--stdin"], { input: text });
  if (!blob.ok) throw gitFailure(`${TASKS_FILE} を書けません`, blob);
  const tree = await runGit(root, ["mktree"], { input: `100644 blob ${blob.stdout.trim()}\t${TASKS_FILE}\n` });
  if (!tree.ok) throw gitFailure("tree を作れません", tree);
  const commit = await runGit(root, ["commit-tree", tree.stdout.trim(), ...(parent ? ["-p", parent] : []), "-F", "-"], { input: message });
  if (!commit.ok) throw gitFailure("コミットを作れません", commit);
  return commit.stdout.trim();
}

const ZERO = "0000000000000000000000000000000000000000";

/**
 * ref を `next` に動かす——**読んだときの値（`expected`、無かったなら undefined）のままなら**（compare-and-swap）。
 * 先を越された（か、同じ ref のロックを取り合った）ら `{ swapped: false, why }`——呼ぶ側が読み直してやり直す。
 * ほかの失敗は投げる
 */
export async function swapRef(
  root: string,
  ref: string,
  next: string,
  expected: string | undefined,
  reason: string,
): Promise<{ swapped: true } | { swapped: false; why: string }> {
  // 古い値に全部 0 を渡すと「まだ無いこと」を確かめる（git の決まり）。sha256 のリポジトリでも同じ長さの 0 を使う
  const zero = next.length === 64 ? ZERO + ZERO.slice(0, 24) : ZERO;
  const r = await runGit(root, ["update-ref", "-m", reason, ref, next, expected ?? zero]);
  if (r.ok) return { swapped: true };
  if (/cannot lock ref/i.test(r.stderr)) return { swapped: false, why: r.stderr };
  throw gitFailure(`${ref} を動かせません`, r);
}

/** `a` が `b` の祖先か（同じなら true） */
export async function isAncestor(root: string, a: string, b: string): Promise<boolean> {
  const r = await runGit(root, ["merge-base", "--is-ancestor", a, b]);
  if (r.ok) return true;
  if (r.code === 1) return false;
  throw gitFailure("履歴を比べられません", r);
}

/** `from` から `to` までのコミットの数（`from..to`） */
export async function countBetween(root: string, from: string, to: string): Promise<number> {
  const r = await runGit(root, ["rev-list", "--count", `${from}..${to}`]);
  if (!r.ok) throw gitFailure("コミットを数えられません", r);
  return Number.parseInt(r.stdout.trim(), 10) || 0;
}

/** そのコミットから根までのコミットの数 */
export async function countAll(root: string, commit: string): Promise<number> {
  const r = await runGit(root, ["rev-list", "--count", commit]);
  if (!r.ok) throw gitFailure("コミットを数えられません", r);
  return Number.parseInt(r.stdout.trim(), 10) || 0;
}

/** origin があるか（URL は見ない——送り先はリポジトリの設定のまま） */
export async function hasOrigin(root: string): Promise<boolean> {
  const r = await runGit(root, ["remote"]);
  if (!r.ok) throw gitFailure("remote を読めません", r);
  return r.stdout.split("\n").some((l) => l.trim() === "origin");
}

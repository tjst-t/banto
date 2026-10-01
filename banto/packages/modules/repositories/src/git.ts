// フォルダの git の事実を読む（docs/specs/v4-modules.md §2.4）。
//
// **この Module は banto 本体で動く**（閉じ込めの外）——ホストのファイルを読めてしまう。だから**読むのは、
// 人が選んだフォルダ（と台帳にあるフォルダ）の git の情報だけ**に絞る：`git -C <path>` で
// 一番上・worktree・origin・ブランチ・コミット数。中のファイルは読まない。**書かない**
// （`GIT_OPTIONAL_LOCKS=0`——status 等が index を書き直すのも止める。ここでは status も呼ばない）。
//
// git かどうか・origin・ブランチは**フォルダが真実**（規則3）。台帳はリモートの場所の写しだけを持つ。

import { execFile } from "node:child_process";
import { realpath, stat } from "node:fs/promises";
import { dirname, sep } from "node:path";
import { parseRemoteUrl, type RemoteLocation } from "./remote.js";

/** フォルダから読めたこと */
export type FolderFacts =
  /** 無い（フォルダでないものを指していても、ここ） */
  | { kind: "missing" }
  /** git のリポジトリではない */
  | { kind: "not-git" }
  /** リポジトリの中のフォルダ——一番上は `top` */
  | { kind: "inside"; top: string }
  /** 別のリポジトリの worktree——本体は `main` */
  | { kind: "worktree"; main: string }
  | {
      kind: "repo";
      /** 一番上（realpath） */
      path: string;
      remote: RemoteLocation;
      /** いまのブランチ。detached なら undefined */
      branch?: string;
      commits: number;
      /** このリポジトリの worktree（本体は含まない。realpath） */
      worktrees: string[];
    };

/** git を走らせた結果。**失敗も値で返す**——どの失敗が「そういう状態」で、どれが本当の失敗かは呼ぶ側が決める */
type GitResult = { ok: true; stdout: string } | { ok: false; code: number | string; stderr: string };

const GIT_TIMEOUT_MS = 10_000;

/**
 * git に渡す環境。**外から渡された `GIT_*` は落とす**——`GIT_DIR` 等が残っていると、選んだフォルダではなく
 * 別のリポジトリを読む
 */
const GIT_ENV: NodeJS.ProcessEnv = {
  ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_"))),
  // 失敗の文言で状態を見分けるので、言語をそろえる
  LC_ALL: "C",
  LANGUAGE: "C",
  // 読むだけ——index のロックも取らない・資格情報を聞かない
  GIT_OPTIONAL_LOCKS: "0",
  GIT_TERMINAL_PROMPT: "0",
};

function git(cwd: string, args: string[]): Promise<GitResult> {
  return new Promise((resolve) => {
    execFile(
      "git",
      ["-C", cwd, ...args],
      {
        timeout: GIT_TIMEOUT_MS,
        maxBuffer: 1024 * 1024,
        env: GIT_ENV,
      },
      (err, stdout, stderr) => {
        if (!err) return resolve({ ok: true, stdout: String(stdout) });
        const code = (err as NodeJS.ErrnoException).code ?? "error";
        // git が無い——状態ではなく本当の失敗（規則2：「git でない」と取り違えない）
        if (code === "ENOENT") return resolve({ ok: false, code, stderr: "git コマンドが見つかりません" });
        resolve({ ok: false, code, stderr: String(stderr || err.message) });
      },
    );
  });
}

function fail(what: string, r: Extract<GitResult, { ok: false }>): never {
  throw new Error(`${what}を読めませんでした：${r.stderr.trim() || `git が ${String(r.code)} で終わりました`}`);
}

async function realOrSelf(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return path;
  }
}

/**
 * そのフォルダの git の事実。**「そういう状態」は値で、読めなかったことは例外で返す**
 * ——権限で読めない・git が無い・持ち主が違うと断られた（dubious ownership）を「git でない」と言わない（規則2）
 */
export async function readFolder(path: string): Promise<FolderFacts> {
  let real: string;
  try {
    real = await realpath(path);
    if (!(await stat(real)).isDirectory()) return { kind: "missing" };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return { kind: "missing" };
    throw new Error(`${path} を読めませんでした：${(err as Error).message}`);
  }

  // git の管理用のフォルダ（`.git` の中）——一番上はその親
  const gitDirAt = real.split(sep).lastIndexOf(".git");
  if (gitDirAt > 0) return { kind: "inside", top: real.split(sep).slice(0, gitDirAt).join(sep) || sep };

  const top = await git(real, ["rev-parse", "--show-toplevel"]);
  if (!top.ok) {
    if (/not a git repository/i.test(top.stderr)) return { kind: "not-git" };
    fail(`${path} の git の情報`, top);
  }
  const topPath = await realOrSelf(top.stdout.trim());
  if (topPath !== real) return { kind: "inside", top: topPath };

  // worktree の一覧——**最初の1つが本体**（git の決まり）。本体でなければ、どこかの worktree
  const wt = await git(real, ["worktree", "list", "--porcelain"]);
  if (!wt.ok) fail(`${path} の worktree`, wt);
  const listed = await Promise.all(
    wt.stdout
      .split("\n")
      .filter((l) => l.startsWith("worktree "))
      .map((l) => realOrSelf(l.slice("worktree ".length))),
  );
  const main = listed[0];
  if (main !== undefined && main !== real) return { kind: "worktree", main };

  const [origin, branch, count] = await Promise.all([
    git(real, ["remote", "get-url", "origin"]),
    git(real, ["symbolic-ref", "--short", "-q", "HEAD"]),
    git(real, ["rev-list", "--count", "HEAD"]),
  ]);
  let remote: RemoteLocation;
  if (origin.ok) remote = parseRemoteUrl(origin.stdout.trim());
  else if (/no such remote/i.test(origin.stderr)) remote = { kind: "none" };
  else fail(`${path} の origin`, origin);

  // detached は code 1 で何も出さない（-q）。それ以外の失敗は本当の失敗
  if (!branch.ok && !(branch.code === 1 && branch.stderr.trim() === "")) fail(`${path} のブランチ`, branch);

  let commits = 0;
  if (count.ok) commits = Number.parseInt(count.stdout.trim(), 10) || 0;
  // まだコミットが無い（HEAD が指す先が無い）は 0。それ以外は本当の失敗
  else if (!/unknown revision|ambiguous argument 'HEAD'/i.test(count.stderr)) fail(`${path} のコミット`, count);

  return {
    kind: "repo",
    path: real,
    remote,
    ...(branch.ok && branch.stdout.trim() ? { branch: branch.stdout.trim() } : {}),
    commits,
    worktrees: listed.slice(1),
  };
}

/** そのパスか、その上で、いちばん近くにあるフォルダ（無いパスを打たれたときの戻り先） */
export async function nearestExistingFolder(path: string): Promise<string> {
  let at = path;
  for (;;) {
    try {
      if ((await stat(at)).isDirectory()) return at;
    } catch {
      // 無い——上へ
    }
    const up = dirname(at);
    if (up === at) return at;
    at = up;
  }
}

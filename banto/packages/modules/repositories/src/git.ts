// フォルダの git の事実を読む（docs/specs/v4-modules.md §2.4）。
//
// **この Module は banto 本体で動く**（閉じ込めの外）——ホストのファイルを読めてしまう。だから**読むのは、
// 人が選んだフォルダ（と台帳にあるフォルダ）の git の情報だけ**に絞る：`git -C <path>` で
// 一番上・worktree・origin・ブランチ・コミット数。中のファイルは読まない。**書かない**
// （`GIT_OPTIONAL_LOCKS=0`——status 等が index を書き直すのも止める。ここでは status も呼ばない）。
//
// git かどうか・origin・ブランチは**フォルダが真実**（規則3）。台帳はリモートの場所の写しだけを持つ。
//
// **リポジトリの設定（`.git/config`）は、そのフォルダを置いた人が書ける**——`core.fsmonitor`・`core.hooksPath`・
// `core.sshCommand`・`core.pager`・`credential.helper` 等はコマンドを指せるので、そのまま git を走らせると
// banto 本体の権限でよそのコードが走る（読むだけのつもりのコマンドでも、index を読むものは fsmonitor を起こす）。
// **「使うコマンドがたまたま安全」に頼らない**：コマンドを指せる設定は、どのコマンドでも呼び出しの側の設定
// （`GIT_CONFIG_COUNT`——ファイルのどの段より強い）で潰し、走らせてよいサブコマンドを一覧で絞る（`GIT_COMMANDS`）。
// 段階3（clone・fetch）で ssh や資格情報を使うときは、ここで潰したものを**この Module が明示して**上書きする。

import { execFile, spawn } from "node:child_process";
import { realpath, stat } from "node:fs/promises";
import { dirname, sep } from "node:path";
import { parseRemoteUrl, type RemoteLocation } from "./remote.js";

/** フォルダから読めたこと */
export type FolderFacts =
  /** 無い（フォルダでないものを指していても、ここ） */
  | { kind: "missing" }
  /** git のリポジトリではない */
  | { kind: "not-git" }
  /** 作業ツリーの無い（bare）リポジトリ——Import できない */
  | { kind: "bare" }
  /** git の管理用のフォルダで、どの作業ツリーのものか決められない（`--separate-git-dir` 等） */
  | { kind: "git-dir" }
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
      /** コミット数。数えられなかった（時間切れ等）ときは無く、理由が `commitsProblem`——飾りなので行は読めたことにする */
      commits?: number;
      commitsProblem?: string;
      /** このリポジトリの worktree（本体は含まない。realpath） */
      worktrees: string[];
    };

/** git を走らせた結果。**失敗も値で返す**——どの失敗が「そういう状態」で、どれが本当の失敗かは呼ぶ側が決める */
type GitResult = { ok: true; stdout: string } | { ok: false; code: number | string; stderr: string };

/** 待つ長さ（ms）。**試験で縮める穴**——数えるのは飾りなので、切れても行は読めたことにする */
export const GIT_TIMEOUTS = { default: 10_000, count: 10_000 };

/**
 * **走らせてよいサブコマンド**（先頭の語）。増やすときは、そのコマンドが設定から何を起こしうるかを見てから
 * （試験がこの一覧を固定している）
 */
export const GIT_COMMANDS: readonly string[] = [
  "rev-parse",
  "worktree list",
  "remote get-url",
  "symbolic-ref",
  "rev-list",
  // 段階3：作る・取ってくる（環境は `writeEnv`——資格情報の渡し方だけを明示して上書きする）
  "config --get init.defaultBranch",
  "init",
  "clone",
];

/**
 * **コマンドを指せる設定を潰す**（呼び出しの側の設定。リポジトリ・ユーザー・システムのどの設定より強い）。
 * 空の値は「無し」（`credential.helper` は空で一覧を空にする）、`false` は走らせても何もしないコマンド
 */
export const GIT_CONFIG_OVERRIDES: ReadonlyArray<readonly [string, string]> = [
  ["core.fsmonitor", "false"],
  ["core.hooksPath", "/dev/null"],
  ["core.sshCommand", "false"],
  ["core.pager", "cat"],
  ["core.editor", "false"],
  ["sequence.editor", "false"],
  ["core.askPass", ""],
  ["credential.helper", ""],
  ["diff.external", ""],
  ["gpg.program", "false"],
  ["core.alternateRefsCommand", ""],
  ["protocol.ext.allow", "never"],
];

/**
 * git に渡す環境。**外から渡された `GIT_*` は落とす**——`GIT_DIR` 等が残っていると、選んだフォルダではなく
 * 別のリポジトリを読む（`GIT_SSH_COMMAND`・`GIT_PAGER` 等で上の潰しを外されることもない）
 */
export const GIT_ENV: NodeJS.ProcessEnv = {
  ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_"))),
  // 失敗の文言で状態を見分けるので、言語をそろえる
  LC_ALL: "C",
  LANGUAGE: "C",
  // 読むだけ——index のロックも取らない・資格情報を聞かない
  GIT_OPTIONAL_LOCKS: "0",
  GIT_TERMINAL_PROMPT: "0",
  GIT_PAGER: "cat",
  GIT_CONFIG_COUNT: String(GIT_CONFIG_OVERRIDES.length),
  ...Object.fromEntries(
    GIT_CONFIG_OVERRIDES.flatMap(([key, value], i) => [
      [`GIT_CONFIG_KEY_${i}`, key],
      [`GIT_CONFIG_VALUE_${i}`, value],
    ]),
  ),
};

/** 一覧に無いサブコマンドは走らせない——書き足すときに一覧を見直させる */
function allowedCommand(args: string[]): string | undefined {
  const line = args.join(" ");
  return GIT_COMMANDS.find((c) => line.startsWith(c + " ") || line === c);
}

function git(cwd: string, args: string[], timeoutMs = GIT_TIMEOUTS.default, env: NodeJS.ProcessEnv = GIT_ENV): Promise<GitResult> {
  const command = allowedCommand(args);
  if (!command) return Promise.resolve({ ok: false, code: "refused", stderr: `git ${args[0] ?? ""} は走らせない決まりです` });
  return new Promise((resolve) => {
    execFile(
      "git",
      ["-C", cwd, ...args],
      {
        timeout: timeoutMs,
        maxBuffer: 1024 * 1024,
        env,
      },
      (err, stdout, stderr) => {
        if (!err) return resolve({ ok: true, stdout: String(stdout) });
        // 時間切れ——git の文言は空なので、何が起きたかをこちらで言う
        if ((err as { killed?: boolean }).killed) {
          const limit = timeoutMs >= 1000 ? `${Math.round(timeoutMs / 1000)} 秒` : `${timeoutMs} ms`;
          return resolve({ ok: false, code: "timeout", stderr: `git ${command} が ${limit}で答えませんでした` });
        }
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

  // **どこにいるかは git に聞く**（パスの要素の名前で決めない——ただのフォルダが `.git` という名前のこともある）
  const where = await git(real, ["rev-parse", "--is-bare-repository", "--is-inside-git-dir", "--absolute-git-dir"]);
  if (!where.ok) {
    if (/not a git repository/i.test(where.stderr)) return { kind: "not-git" };
    fail(`${path} の git の情報`, where);
  }
  const [bare, insideGitDir, gitDirRaw] = where.stdout.trim().split("\n");
  const gitDir = await realOrSelf(gitDirRaw ?? "");
  if (bare === "true") return gitDir === real ? { kind: "bare" } : { kind: "inside", top: gitDir };
  if (insideGitDir === "true") {
    // git の管理用のフォルダ（`.git` の中）——一番上は、その `.git` の親（submodule の `.git/modules/…` も同じ）
    const parts = gitDir.split(sep);
    const at = parts.lastIndexOf(".git");
    if (at > 0) return { kind: "inside", top: parts.slice(0, at).join(sep) || sep };
    return { kind: "git-dir" };
  }

  const top = await git(real, ["rev-parse", "--show-toplevel"]);
  if (!top.ok) fail(`${path} の git の情報`, top);
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
    git(real, ["rev-list", "--count", "HEAD"], GIT_TIMEOUTS.count),
  ]);
  let remote: RemoteLocation;
  if (origin.ok) remote = parseRemoteUrl(origin.stdout.trim());
  else if (/no such remote/i.test(origin.stderr)) remote = { kind: "none" };
  else fail(`${path} の origin`, origin);

  // detached は code 1 で何も出さない（-q）。それ以外の失敗は本当の失敗
  if (!branch.ok && !(branch.code === 1 && branch.stderr.trim() === "")) fail(`${path} のブランチ`, branch);

  // コミット数は飾り——**数えられなくても行は読めたことにし、数えられなかった理由を添える**（大きな履歴・遅い
  // ディスクで時間切れになっても、行ごと「読めない」にしない）。まだコミットが無い（HEAD の先が無い）は 0
  let commits: { commits: number } | { commitsProblem: string };
  if (count.ok) commits = { commits: Number.parseInt(count.stdout.trim(), 10) || 0 };
  else if (/unknown revision|ambiguous argument 'HEAD'/i.test(count.stderr)) commits = { commits: 0 };
  else commits = { commitsProblem: count.stderr.trim() || `git が ${String(count.code)} で終わりました` };

  return {
    kind: "repo",
    path: real,
    remote,
    ...(branch.ok && branch.stdout.trim() ? { branch: branch.stdout.trim() } : {}),
    ...commits,
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

// ── 作る・取ってくる（段階3：新しいリポジトリ・URL から clone） ─────────────────────────────

/**
 * 取ってくるときの資格情報の渡し方。**読む口で潰したもののうち、どれを誰が上書きするかをここで明示する**（§2.4）
 * - `none`：何も使わない（登録したアカウントの無い GitHub——公開のものだけ）
 * - `machine`：このマシンの git の設定のまま（GitHub の外）。`credential.helper`・`core.sshCommand`・`core.askPass` を潰さない
 *   ——人がこのマシンに置いた設定（ユーザー・システムの段）で、clone する前のリポジトリの設定はまだ無い
 * - `helper`：`credential.helper` を、この Module が立てた一度きりの helper だけにする（トークンは引数にも環境にも置かない）
 * - `ssh-agent`：Vault が立てた ssh-agent の窓口だけを使う ssh にする
 */
export type GitCredential =
  | { kind: "none" }
  | { kind: "machine" }
  | { kind: "helper"; command: string }
  | { kind: "ssh-agent"; socket: string };

/** ssh を使うときのコマンド（Vault の窓口だけを使う。初めての相手は覚える——accept-new） */
export function sshCommandFor(socket: string): string {
  return `ssh -o IdentityAgent="${socket}" -o BatchMode=yes -o StrictHostKeyChecking=accept-new`;
}

/**
 * 作る・取ってくる git の環境。**読む口と同じ潰しから始める**（fsmonitor・hooksPath・pager 等は clone の間も潰したまま
 * ——clone の checkout で hooks を走らせない）。外から渡した設定は環境の `GIT_CONFIG_*` だけで、clone 先の
 * `.git/config` には書き残らない。読む口の環境（`GIT_ENV`）からその都度作る（試験が PATH・HOME を替えられるように）
 */
export function writeEnv(credential: GitCredential): NodeJS.ProcessEnv {
  const base = Object.fromEntries(Object.entries(GIT_ENV).filter(([k]) => !k.startsWith("GIT_CONFIG_")));
  const machineOwned = new Set(["credential.helper", "core.sshCommand", "core.askPass"]);
  let overrides: Array<readonly [string, string]> = GIT_CONFIG_OVERRIDES.filter(
    ([k]) => credential.kind !== "machine" || !machineOwned.has(k),
  );
  // 取ってくる仕事では、手元のパスを相手にさせない（submodule 等で file:// を辿らない）
  overrides.push(["protocol.file.allow", "never"]);
  // 空にした一覧のあとに足す（同じ段の中では順に読まれる——空で消し、次で1つだけ足す）
  if (credential.kind === "helper") overrides.push(["credential.helper", credential.command]);
  if (credential.kind === "ssh-agent") {
    overrides = overrides.map(([k, v]) => (k === "core.sshCommand" ? ([k, sshCommandFor(credential.socket)] as const) : ([k, v] as const)));
  }
  return {
    ...base,
    GIT_CONFIG_COUNT: String(overrides.length),
    ...Object.fromEntries(
      overrides.flatMap(([key, value], i) => [
        [`GIT_CONFIG_KEY_${i}`, key],
        [`GIT_CONFIG_VALUE_${i}`, value],
      ]),
    ),
  };
}

/** このマシンの git が決めている既定のブランチ名（`init.defaultBranch`）。無ければ undefined */
export async function configuredDefaultBranch(cwd: string): Promise<string | undefined> {
  const r = await git(cwd, ["config", "--get", "init.defaultBranch"]);
  if (r.ok) return r.stdout.trim() || undefined;
  // 設定が無い——`git config --get` は 1 で終わる（git の決まり。ほかの失敗は 1 以外）
  if (r.code === 1) return undefined;
  return fail("git の既定のブランチ名", r);
}

/** 空のリポジトリを作る（フォルダも作る）。ブランチ名は呼ぶ側が決めて渡す */
export async function gitInit(path: string, branch: string): Promise<void> {
  const r = await git(dirname(path), ["init", "-q", "-b", branch, "--", path], GIT_TIMEOUTS.default, writeEnv({ kind: "none" }));
  if (!r.ok) throw new Error(`git init できませんでした：${r.stderr.trim() || String(r.code)}`);
}

/** clone の進み具合（git が `--progress` で言うものを読んだ値） */
export interface CloneProgress {
  /** `Receiving objects`・`Resolving deltas` 等 */
  phase: string;
  percent?: number;
}

export type CloneResult =
  | { ok: true }
  | { ok: false; kind: "failed" | "timeout" | "cancelled"; message: string };

/** 時間の決まり（ms）。**試験で縮める穴** */
export const CLONE_TIMEOUTS = {
  /** 何も言ってこないまま、これだけ経ったらやめる（大きなリポジトリは長くかかるので、全体の上限は置かない） */
  idle: 5 * 60_000,
};

const PROGRESS = /^(?:remote: )?([A-Za-z][A-Za-z ]+?):\s+(\d+)%/;

/**
 * clone する。**全体の時間の上限は置かず、何も言ってこない時間で切る**——大きなリポジトリは何分もかかるが、
 * その間 git は進み具合を言い続ける。黙ったままのもの（相手が答えない・認証で止まった）だけを切る
 */
export function gitClone(input: {
  url: string;
  dest: string;
  credential: GitCredential;
  onProgress?: (p: CloneProgress) => void;
  signal?: AbortSignal;
}): Promise<CloneResult> {
  if (!allowedCommand(["clone"])) return Promise.resolve({ ok: false, kind: "failed", message: "git clone は走らせない決まりです" });
  return new Promise((resolve) => {
    // `--` の後に URL——`-` で始まる字を git に option と読ませない
    const child = spawn("git", ["clone", "--progress", "--", input.url, input.dest], {
      env: writeEnv(input.credential),
      stdio: ["ignore", "ignore", "pipe"],
    });
    const tail: string[] = [];
    let ended: "timeout" | "cancelled" | undefined;
    let idle: NodeJS.Timeout | undefined;
    const arm = () => {
      clearTimeout(idle);
      idle = setTimeout(() => {
        ended = "timeout";
        child.kill("SIGTERM");
      }, CLONE_TIMEOUTS.idle);
    };
    arm();
    const onAbort = () => {
      ended = "cancelled";
      child.kill("SIGTERM");
    };
    input.signal?.addEventListener("abort", onAbort, { once: true });
    let buffer = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      arm();
      buffer += chunk;
      // 進み具合は \r で上書きされる——\r と \n のどちらでも区切る
      const parts = buffer.split(/[\r\n]/);
      buffer = parts.pop() ?? "";
      for (const line of parts) {
        const t = line.trim();
        if (!t) continue;
        const m = t.match(PROGRESS);
        if (m) input.onProgress?.({ phase: m[1]!, percent: Number(m[2]) });
        else {
          tail.push(t);
          if (tail.length > 20) tail.shift();
        }
      }
    });
    const finish = (r: CloneResult) => {
      clearTimeout(idle);
      input.signal?.removeEventListener("abort", onAbort);
      resolve(r);
    };
    child.on("error", (err) => finish({ ok: false, kind: "failed", message: (err as NodeJS.ErrnoException).code === "ENOENT" ? "git コマンドが見つかりません" : err.message }));
    child.on("close", (code) => {
      if (code === 0 && !ended) return finish({ ok: true });
      if (ended === "timeout") {
        const mins = CLONE_TIMEOUTS.idle >= 60_000 ? `${Math.round(CLONE_TIMEOUTS.idle / 60_000)} 分` : `${CLONE_TIMEOUTS.idle} ms`;
        return finish({ ok: false, kind: "timeout", message: `${mins}のあいだ git が何も言ってこなかったので、やめました` });
      }
      if (ended === "cancelled") return finish({ ok: false, kind: "cancelled", message: "やめました" });
      const lines = tail.filter((l) => !/^Cloning into /.test(l));
      finish({ ok: false, kind: "failed", message: lines.join("\n") || `git clone が ${String(code)} で終わりました` });
    });
  });
}

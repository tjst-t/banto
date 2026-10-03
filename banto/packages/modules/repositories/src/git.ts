// フォルダの git の事実を読む（docs/specs/v4-modules.md §2.4）。
//
// **この Module は banto 本体で動く**（閉じ込めの外）——ホストのファイルを読めてしまう。だから**読むのは、
// 人が選んだフォルダ（と台帳にあるフォルダ）の git の情報だけ**に絞る：`git -C <path>` で
// 一番上・worktree・origin・ブランチ・コミット数。中のファイルは読まない。**書かない**
// （`GIT_OPTIONAL_LOCKS=0`——status 等が index を書き直すのも止める）。例外は「このマシンから削除」の前に
// 失われるものを数えるときだけ（段階4、`readLosses`）——`git status` が変更を見るので、filter を空にしてから呼ぶ。
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
export const GIT_TIMEOUTS = { default: 10_000, count: 10_000, losses: 60_000 };

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
  // 段階4：このマシンから削除する前に、失われるものを数える（`readLosses`）・worktree を片づける
  "for-each-ref",
  "config --name-only --get-regexp",
  "status",
  "ls-files",
  // worktree の記録を1つだけ片づける（フォルダはこちらで消したあと——git には消させない）
  "worktree remove",
  // 段階5：GitHub に公開——origin を足し、いまのブランチを push する（環境は `writeEnv`）
  "remote add",
  "push",
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

function git(
  cwd: string,
  args: string[],
  timeoutMs = GIT_TIMEOUTS.default,
  env: NodeJS.ProcessEnv = GIT_ENV,
  maxBuffer = 1024 * 1024,
): Promise<GitResult> {
  const command = allowedCommand(args);
  if (!command) return Promise.resolve({ ok: false, code: "refused", stderr: `git ${args[0] ?? ""} は走らせない決まりです` });
  return new Promise((resolve) => {
    execFile(
      "git",
      ["-C", cwd, ...args],
      {
        timeout: timeoutMs,
        maxBuffer,
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

  // detached は code 1 で何も出さない（-q）。それ以外の失敗は 128（git の決まり、実測）。**stderr が空かでは見ない**
  // ——`git()` は stderr が空のとき失敗の文言を入れて返すので、以前の「code 1 かつ stderr が空」は成り立たず、
  // detached HEAD のリポジトリが「読めません」になっていた（段階5で見つけた）
  if (!branch.ok && branch.code !== 1) fail(`${path} のブランチ`, branch);

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
  | { kind: "ssh-agent"; socket: string; knownHosts: string };

/** シェルに渡す1語（git は `!` の helper・`core.sshCommand` をシェルで読む） */
export function shellQuote(s: string): string {
  return `"${s.replace(/(["\\$`])/g, "\\$1")}"`;
}

/** ssh のコマンドに埋めるパス。**絶対パス・素直な字だけ**——Vault の実装（第三者も名乗れる）が返す値を、そのまま埋めない */
const SAFE_PATH = /^\/[A-Za-z0-9._\/-]+$/;

/**
 * GitHub へ ssh で取ってくるときのコマンド。**人の ssh の設定を読まない**（`-F /dev/null`）・Vault の ssh-agent の窓口
 * だけを使う・**相手の鍵は GitHub が公開している値だけを信じる**（`knownHosts`、`StrictHostKeyChecking=yes`——初めての
 * 相手を覚えて人の `~/.ssh/known_hosts` に書く accept-new はやめた）
 */
export function sshCommandFor(socket: string, knownHosts: string): string {
  for (const [what, p] of [["ssh-agent の窓口", socket], ["known_hosts", knownHosts]] as const) {
    if (!SAFE_PATH.test(p)) throw new Error(`${what}の場所が受け付けられない形です（絶対パスで、英数字と . _ / - だけ）：${JSON.stringify(p.slice(0, 80))}`);
  }
  return [
    "ssh -F /dev/null",
    `-o IdentityAgent=${shellQuote(socket)}`,
    "-o BatchMode=yes",
    "-o StrictHostKeyChecking=yes",
    `-o UserKnownHostsFile=${shellQuote(knownHosts)}`,
    "-o GlobalKnownHostsFile=/dev/null",
  ].join(" ");
}

/**
 * 作る・取ってくる git の環境。**読む口と同じ潰しから始める**（fsmonitor・hooksPath・pager 等は clone の間も潰したまま
 * ——clone の checkout で hooks を走らせない）。外から渡した設定は環境の `GIT_CONFIG_*` だけで、clone 先の
 * `.git/config` には書き残らない。読む口の環境（`GIT_ENV`）からその都度作る（試験が PATH・HOME を替えられるように）
 */
export function writeEnv(credential: GitCredential): NodeJS.ProcessEnv {
  const base = Object.fromEntries(Object.entries(GIT_ENV).filter(([k]) => !k.startsWith("GIT_CONFIG_")));
  // **GitHub へ取ってくるとき（machine 以外）は、人の git の設定（ユーザー・システムの段）を読まない**——
  // `filter.lfs.smudge` 等は相手の `.gitattributes` から起動し、`url.*.insteadOf` は https を ssh に書き換えて嘘の
  // 失敗にする。proxy は環境変数（HTTPS_PROXY 等）で効く
  const ownConfig = credential.kind === "machine" ? {} : { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
  const machineOwned = new Set(["credential.helper", "core.sshCommand", "core.askPass"]);
  let overrides: Array<readonly [string, string]> = GIT_CONFIG_OVERRIDES.filter(
    ([k]) => credential.kind !== "machine" || !machineOwned.has(k),
  );
  // 取ってくる仕事では、手元のパスを相手にさせない（submodule 等で file:// を辿らない）
  overrides.push(["protocol.file.allow", "never"]);
  // 空にした一覧のあとに足す（同じ段の中では順に読まれる——空で消し、次で1つだけ足す）
  if (credential.kind === "helper") overrides.push(["credential.helper", credential.command]);
  if (credential.kind === "ssh-agent") {
    const ssh = sshCommandFor(credential.socket, credential.knownHosts);
    overrides = overrides.map(([k, v]) => (k === "core.sshCommand" ? ([k, ssh] as const) : ([k, v] as const)));
  }
  return {
    ...base,
    ...ownConfig,
    // git-lfs が入っていても、clone で大きな中身を取りに行かせない（人の設定を読む machine でも）
    GIT_LFS_SKIP_SMUDGE: "1",
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
  /**
   * `message` は見せる文言（git の最後の行たち）。`own` は**相手（`remote:`）の行を除いた**行——失敗の分類はこれだけで
   * 決める（相手が「Repository not found」等を言って分類を偽れないように）
   */
  | { ok: false; kind: "failed" | "timeout" | "cancelled"; message: string; own?: string };

/** 時間の決まり（ms）。**試験で縮める穴** */
export const CLONE_TIMEOUTS = {
  /** 何も言ってこないまま、これだけ経ったらやめる（大きなリポジトリは長くかかるので、全体の上限は置かない） */
  idle: 5 * 60_000,
};

const PROGRESS = /^(?:remote: )?([A-Za-z][A-Za-z ]+?):\s+(\d+)%/;

/**
 * 進み具合を言い続ける git（clone・push）を走らせる。**全体の時間の上限は置かず、何も言ってこない時間で切る**——
 * 大きなリポジトリは何分もかかるが、その間 git は進み具合を言い続ける。黙ったままのもの（相手が答えない・認証で
 * 止まった）だけを切る
 */
function streamGit(input: {
  args: string[];
  cwd?: string;
  credential: GitCredential;
  onProgress?: (p: CloneProgress) => void;
  signal?: AbortSignal;
  /** 見せる文言から外す行（「Cloning into …」等） */
  quiet?: RegExp;
}): Promise<CloneResult> {
  const command = allowedCommand(input.args);
  if (!command) return Promise.resolve({ ok: false, kind: "failed", message: `git ${input.args[0] ?? ""} は走らせない決まりです` });
  return new Promise((resolve) => {
    const child = spawn("git", input.args, {
      env: writeEnv(input.credential),
      stdio: ["ignore", "ignore", "pipe"],
      ...(input.cwd ? { cwd: input.cwd } : {}),
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
      // 改行の来ない出力で際限なく伸ばさない——**区切ったあとの残り**が長すぎたら、そこまでを1行として扱う
      // （区切る前に切ると、同じ塊に入っていた git 自身の行——fatal: 等——まで捨てる。実測で10回中2回）
      if (buffer.length > 64 * 1024) {
        parts.push(buffer.slice(0, 2000) + "…");
        buffer = "";
      }
      for (const line of parts) {
        const t = line.trim();
        if (!t) continue;
        const m = t.match(PROGRESS);
        if (m) input.onProgress?.({ phase: m[1]!, percent: Number(m[2]) });
        else {
          // 1行も長すぎれば切る（残りの上限の手前で改行が来ると、長い1行がそのまま来る）
          tail.push(t.length > 2000 ? t.slice(0, 2000) + "…" : t);
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
      const lines = tail.filter((l) => !(input.quiet && input.quiet.test(l)));
      finish({
        ok: false,
        kind: "failed",
        message: lines.join("\n") || `git ${command} が ${String(code)} で終わりました`,
        own: lines.filter((l) => !/^remote:/i.test(l)).join("\n"),
      });
    });
  });
}

/** clone する（`streamGit`）。`--` の後に URL——`-` で始まる字を git に option と読ませない */
export function gitClone(input: {
  url: string;
  dest: string;
  credential: GitCredential;
  onProgress?: (p: CloneProgress) => void;
  signal?: AbortSignal;
}): Promise<CloneResult> {
  return streamGit({
    args: ["clone", "--progress", "--", input.url, input.dest],
    credential: input.credential,
    ...(input.onProgress ? { onProgress: input.onProgress } : {}),
    ...(input.signal ? { signal: input.signal } : {}),
    quiet: /^Cloning into /,
  });
}

// ── GitHub に公開（段階5） ────────────────────────────────────────────────────────

/** 公開するときに見る、いまのブランチの事実 */
export interface BranchFacts {
  /** いまのブランチ。detached なら undefined */
  branch?: string;
  /** まだコミットが無い（git init したばかり） */
  unborn: boolean;
  /** いまのブランチのコミット数（数えられなければ undefined） */
  commits?: number;
  /** ほかのブランチ（最初の push では送らない——人があとで送る） */
  otherBranches: string[];
  /** 最後のコミット（件名と、committer の時刻 ISO 8601） */
  lastCommit?: { subject: string; at: string };
  /** origin に同じ名前のブランチが（最後に取ってきた時点で）あるか */
  onOrigin: boolean;
}

export async function branchFacts(path: string): Promise<BranchFacts> {
  const head = await git(path, ["symbolic-ref", "-q", "--short", "HEAD"]);
  if (!head.ok && head.code !== 1) fail(`${path} のいまのブランチ`, head);
  const branch = head.ok ? head.stdout.trim() : undefined;
  const born = await git(path, ["rev-parse", "--verify", "-q", "HEAD"]);
  if (!born.ok && born.code !== 1) fail(`${path} のコミット`, born);
  const unborn = !born.ok;
  const heads = await git(path, ["for-each-ref", "--format=%(refname:short)", "refs/heads"]);
  if (!heads.ok) fail(`${path} のブランチ`, heads);
  const otherBranches = heads.stdout.split("\n").filter((b) => b && b !== branch);
  if (unborn) return { ...(branch ? { branch } : {}), unborn, commits: 0, otherBranches, onOrigin: false };
  const count = await git(path, ["rev-list", "--count", "HEAD"], GIT_TIMEOUTS.count);
  const last = branch ? await git(path, ["for-each-ref", "--format=%(subject)%09%(committerdate:iso-strict)", `refs/heads/${branch}`]) : undefined;
  const [subject, at] = last?.ok ? (last.stdout.replace(/\n$/, "").split("\t") as [string, string]) : [];
  const remote = branch ? await git(path, ["for-each-ref", "--format=%(refname)", `refs/remotes/origin/${branch}`]) : undefined;
  return {
    ...(branch ? { branch } : {}),
    unborn,
    ...(count.ok ? { commits: Number.parseInt(count.stdout.trim(), 10) || 0 } : {}),
    otherBranches,
    ...(subject !== undefined && at ? { lastCommit: { subject, at } } : {}),
    onOrigin: !!remote?.ok && remote.stdout.trim() !== "",
  };
}

/**
 * **push の送り先や TLS を、そのリポジトリの設定が変えていないか**。`.git/config` はフォルダを置いた人が書ける——
 * `url.*.insteadOf`・`pushInsteadOf`・`remote.origin.pushurl` はトークンを渡す先を同じ GitHub の別のリポジトリに
 * 変えられ、`http.*`（proxy・sslVerify・sslCAInfo 等）は TLS を外して中身を読ませられる。あれば push しない
 * （上書きで消せない——git の設定は環境から「無し」にできず、足すだけ）。読むのはリポジトリの段だけ（GitHub への
 * 仕事では人の設定の段を読まない、`writeEnv`）
 */
export async function pushBlockers(path: string): Promise<string[]> {
  const r = await git(
    path,
    ["config", "--name-only", "--get-regexp", "^(url|http)\\.|^remote\\.origin\\.(pushurl|proxy|receivepack)$"],
    GIT_TIMEOUTS.default,
    writeEnv({ kind: "none" }),
  );
  if (r.ok) return [...new Set(r.stdout.split("\n").filter(Boolean))];
  if (r.code === 1) return [];
  return fail(`${path} の設定`, r);
}

/** origin を足す（呼ぶ側が「origin がまだ無い」を確かめてから。URL に資格情報は入れない） */
export async function gitRemoteAdd(path: string, url: string): Promise<void> {
  const r = await git(path, ["remote", "add", "origin", url], GIT_TIMEOUTS.default, writeEnv({ kind: "none" }));
  if (!r.ok) throw new Error(`origin を足せませんでした：${r.stderr.trim() || String(r.code)}`);
}

/**
 * いまのブランチを origin に push し、以後それを追う（`--set-upstream`）。送るのはそのブランチだけ
 * （`refs/heads/<b>:refs/heads/<b>`——ほかのブランチ・タグは送らない）
 */
export function gitPush(input: {
  path: string;
  branch: string;
  credential: GitCredential;
  onProgress?: (p: CloneProgress) => void;
  signal?: AbortSignal;
}): Promise<CloneResult> {
  return streamGit({
    args: ["push", "--progress", "--set-upstream", "origin", `refs/heads/${input.branch}:refs/heads/${input.branch}`],
    cwd: input.path,
    credential: input.credential,
    ...(input.onProgress ? { onProgress: input.onProgress } : {}),
    ...(input.signal ? { signal: input.signal } : {}),
  });
}

// ── このマシンから削除する前に、失われるものを数える（段階4） ─────────────────────────────

/** 削除で失われうるもの。`problems` があれば「数えきれていない」——無いとは言わない（規則2） */
export interface LossReport {
  /**
   * ブランチごとの、どのリモートにも無いコミット（最後に取ってきた時点のリモートと比べる——取り直しはしない）。
   * ブランチどうしで重なる（枝分かれ元のコミットは両方に入る）ので、合計は `unpushedTotal`
   */
  unpushed: Array<{ branch: string; commits: number }>;
  /** ブランチ・タグの分を重ねずに数えた、どのリモートにも無いコミットの数（タグだけが指すコミットも入る） */
  unpushedTotal: number;
  /** どのブランチ・タグ・リモートにも無いコミット（detached HEAD で作ったもの） */
  detached: number;
  /** 上流（いまリモートにあるもの）も、どのリモートの同じ名前も無いブランチ */
  localOnlyBranches: string[];
  /** どのリモートにも無いコミットを指すタグ（リモートにあるコミットを指すタグが push 済みかは、見ていない） */
  localOnlyTags: string[];
  /** コミットしていない変更（index・作業ツリー） */
  changed: number;
  /** 追跡していないもの（ignore 済みは数えない。中身ごと追跡していないフォルダは1件） */
  untracked: number;
  stashes: number;
  /** 数えられなかったもの（時間切れ・git が断った）と、あるが中を数えていないもの（notes 等の ref・submodule） */
  problems: string[];
}

/** 失われるものの数（problems を除く） */
export function lossCount(l: LossReport): number {
  return l.unpushedTotal + l.detached + l.localOnlyBranches.length + l.localOnlyTags.length + l.changed + l.untracked + l.stashes;
}

/** 環境に呼び出しの側の設定を足す（`GIT_CONFIG_COUNT` の続きに並べる） */
function withConfig(env: NodeJS.ProcessEnv, pairs: Array<readonly [string, string]>): NodeJS.ProcessEnv {
  const start = Number(env.GIT_CONFIG_COUNT ?? "0");
  const next: NodeJS.ProcessEnv = { ...env, GIT_CONFIG_COUNT: String(start + pairs.length) };
  pairs.forEach(([k, v], i) => {
    next[`GIT_CONFIG_KEY_${start + i}`] = k;
    next[`GIT_CONFIG_VALUE_${start + i}`] = v;
  });
  return next;
}

/** 数えるときの出力の上限（大きいリポジトリでも、ファイルの一覧・コミットの一覧が溢れないように） */
const LOSSES_MAX_BUFFER = 256 * 1024 * 1024;

/**
 * そのリポジトリ（か worktree）を消すと失われるものを数える。**台帳のフォルダの git だけを読む**（読む口の潰しは
 * そのまま）。`git status` はファイルの中身を比べるときに、リポジトリの設定の filter（`clean`・`process`）を起こす
 * （実測）——**その設定の filter の名前を先に読み、全部を空に上書きしてから**走らせる。submodule の中は読まない。
 * **数えないもの**（reflog にだけあるコミット・LFS の未 push のファイル・ignore 済みのファイル・submodule の中）は
 * 画面と仕様が「数えていない」と言う。notes 等のほかの ref にだけあるコミット・submodule は、あれば `problems` に出す
 */
export async function readLosses(path: string): Promise<LossReport> {
  const report: LossReport = { unpushed: [], unpushedTotal: 0, detached: 0, localOnlyBranches: [], localOnlyTags: [], changed: 0, untracked: 0, stashes: 0, problems: [] };
  const t = GIT_TIMEOUTS.losses;
  const run = (args: string[], env: NodeJS.ProcessEnv = GIT_ENV) => git(path, args, t, env, LOSSES_MAX_BUFFER);
  const note = (what: string, r: Extract<GitResult, { ok: false }>) =>
    report.problems.push(`${what}を数えられませんでした（${r.stderr.trim() || String(r.code)}）`);
  const num = (r: { stdout: string }) => Number.parseInt(r.stdout.trim(), 10) || 0;

  // ブランチと上流、リモートにある ref、リモートの名前
  const heads = await run(["for-each-ref", "--format=%(refname:short)%09%(upstream)", "refs/heads"]);
  const remotes = await run(["for-each-ref", "--format=%(refname)", "refs/remotes"]);
  const remoteConf = await run(["config", "--name-only", "--get-regexp", "^remote\\..*\\.url$"]);
  if (!heads.ok) note("ブランチ", heads);
  if (!remotes.ok) note("リモートのブランチ", remotes);
  // 1 は「リモートの設定が無い」
  if (!remoteConf.ok && remoteConf.code !== 1) note("リモートの名前", remoteConf);
  if (heads.ok && remotes.ok && (remoteConf.ok || remoteConf.code === 1)) {
    const remoteRefs = new Set(remotes.stdout.split("\n").filter(Boolean));
    const remoteNames = remoteConf.ok
      ? remoteConf.stdout.split("\n").filter(Boolean).map((k) => k.replace(/^remote\./, "").replace(/\.url$/, ""))
      : [];
    for (const line of heads.stdout.split("\n").filter(Boolean)) {
      const [branch, upstream] = line.split("\t") as [string, string | undefined];
      const count = await run(["rev-list", "--count", `refs/heads/${branch}`, "--not", "--remotes"]);
      if (!count.ok) note(`ブランチ ${branch} のコミット`, count);
      else if (num(count) > 0) report.unpushed.push({ branch, commits: num(count) });
      // 上流は「いまリモートの ref としてあるもの」だけ（リモートで消えた上流・手元のブランチを上流にしたものは無い扱い）。
      // 同じ名前は `refs/remotes/<リモート>/<ブランチ>` の完全一致で見る（`endsWith` だと別のブランチに当たる）
      const hasUpstream = !!upstream && remoteRefs.has(upstream);
      const sameName = remoteNames.some((r) => remoteRefs.has(`refs/remotes/${r}/${branch}`));
      if (!hasUpstream && !sameName) report.localOnlyBranches.push(branch);
    }
  }
  // どのリモートにも無いコミット——ブランチとタグの分を重ねずに。タグだけが指すコミット（ブランチから外れた）も入る
  const total = await run(["rev-list", "--count", "--branches", "--tags", "--not", "--remotes"]);
  if (total.ok) report.unpushedTotal = num(total);
  else note("push していないコミット", total);
  // どのリモートにも無いコミットを指すタグ
  const tags = await run(["for-each-ref", "--format=%(refname:short)%09%(objectname)%09%(*objectname)", "refs/tags"]);
  if (!tags.ok) note("タグ", tags);
  else if (tags.stdout.trim()) {
    const loose = await run(["rev-list", "--tags", "--not", "--remotes"]);
    if (!loose.ok) note("タグのコミット", loose);
    else {
      const unpushed = new Set(loose.stdout.split("\n").filter(Boolean));
      for (const line of tags.stdout.split("\n").filter(Boolean)) {
        const [name, object, peeled] = line.split("\t") as [string, string, string | undefined];
        if (unpushed.has(peeled || object)) report.localOnlyTags.push(name);
      }
    }
  }
  // detached HEAD で作ったコミット
  const head = await run(["symbolic-ref", "-q", "HEAD"]);
  if (!head.ok && head.code === 1) {
    const loose = await run(["rev-list", "--count", "HEAD", "--not", "--branches", "--tags", "--remotes"]);
    if (loose.ok) report.detached = num(loose);
    else if (!/unknown revision|ambiguous argument 'HEAD'/i.test(loose.stderr)) note("どのブランチにも無いコミット", loose);
  }
  // ブランチ・タグ・リモート・stash・HEAD の外の ref（notes・filter-branch の refs/original 等）にだけあるコミット
  const others = await run(["for-each-ref", "--format=%(refname)"]);
  if (!others.ok) note("ほかの ref", others);
  else {
    const names = others.stdout
      .split("\n")
      .filter((r) => r && !/^refs\/(heads|tags|remotes)\//.test(r) && r !== "refs/stash");
    if (names.length > 0) {
      // 名前を並べると ref が多いリポジトリ（refs/pull/* 等）で引数が溢れる——除いて --all で
      const only = await run([
        "rev-list", "--count",
        "--exclude=refs/heads/*", "--exclude=refs/tags/*", "--exclude=refs/remotes/*", "--exclude=refs/stash", "--all",
        "--not", "--branches", "--tags", "--remotes", "HEAD",
      ]);
      if (!only.ok) note(`ほかの ref（${names.slice(0, 3).join("・")}）`, only);
      else if (num(only) > 0) {
        report.problems.push(
          `ブランチ・タグの外の ref（${names.slice(0, 3).join("・")}${names.length > 3 ? " ほか" : ""}）にだけあるコミットが ${num(only)} 件あります——中身は数えていません`,
        );
      }
    }
  }
  // コミットしていない変更・追跡していないもの——filter を空にしてから
  const filters = await run(["config", "--name-only", "--get-regexp", "^filter\\."]);
  const drivers = new Set<string>();
  if (filters.ok) {
    for (const key of filters.stdout.split("\n").filter(Boolean)) drivers.add(key.replace(/^filter\./, "").replace(/\.[^.]+$/, ""));
  } else if (filters.code !== 1) {
    // 1 は「filter の設定が無い」。それ以外は読めていない——status を走らせない（何が起きるか分からない）
    note("filter の設定", filters);
  }
  if (filters.ok || filters.code === 1) {
    const neutral = [...drivers].flatMap((d) => [
      [`filter.${d}.clean`, ""] as const,
      [`filter.${d}.smudge`, ""] as const,
      [`filter.${d}.process`, ""] as const,
      [`filter.${d}.required`, "false"] as const,
    ]);
    const env = withConfig(GIT_ENV, [...neutral, ["status.submoduleSummary", "false"]]);
    const status = await run(["status", "--porcelain=v1", "-z", "--untracked-files=normal", "--ignore-submodules=all"], env);
    if (!status.ok) note("コミットしていない変更", status);
    else {
      const parts = status.stdout.split("\0");
      for (let i = 0; i < parts.length; i += 1) {
        const entry = parts[i]!;
        if (entry.length < 3) continue;
        if (entry.startsWith("??")) report.untracked += 1;
        else report.changed += 1;
        // 名前の変更は、次の要素が元の名前
        if (entry[0] === "R" || entry[0] === "C") i += 1;
      }
    }
  }
  // stash
  const stash = await run(["rev-parse", "--verify", "-q", "refs/stash"]);
  if (stash.ok) {
    const n = await run(["rev-list", "--walk-reflogs", "--count", "refs/stash"]);
    if (n.ok) report.stashes = num(n);
    else note("stash", n);
  } else if (stash.code !== 1) note("stash", stash);
  // submodule の中は数えない（読むと、その中の設定から何が起きるか分からない）——あれば、数えていないと言う。
  // `.gitmodules` が無くても index に submodule（mode 160000）があることがある
  let submodules = false;
  try {
    await stat(`${path}/.gitmodules`);
    submodules = true;
  } catch {
    const staged = await run(["ls-files", "--stage", "-z"]);
    if (!staged.ok) note("submodule", staged);
    else submodules = staged.stdout.split("\0").some((e) => e.startsWith("160000 "));
  }
  if (submodules) report.problems.push("submodule の中の変更は数えていません");
  return report;
}

/**
 * worktree を消したあと、本体の側の**その worktree の記録だけ**を片づける（`git worktree prune` は、ほかの
 * 見つからない worktree の記録まで消す——たまたま外付けの場所にあって見えていないもの等）
 */
export async function removeWorktreeRecord(main: string, worktree: string): Promise<void> {
  const r = await git(main, ["worktree", "remove", "--force", "--", worktree]);
  if (!r.ok) throw new Error(`本体（${main}）の worktree の記録を片づけられませんでした：${r.stderr.trim() || String(r.code)}`);
}

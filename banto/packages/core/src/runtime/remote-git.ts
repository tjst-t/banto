// **別のサーバの Project の git と、1本のブランチの中身をやり取りする**（決定・2026-10-20、Backlog #466、
// `docs/specs/v4-modules.md` §2.4「ブランチを送る口」の「別のサーバの Project」・v4-security.md §1）。
//
// Repositories（banto 本体で動き、資格情報を持つ）は別のサーバの根に触れない。ここは実行場所の接続の上で、向こうの git に
// **bundle を作らせる・取り込ませるだけ**をする（中継の `relayProjectGit*`）。資格情報は向こうへ出ない。
//
// - **向こうの git は Project の中のユーザーで動かす**：machine は VM のユーザー（箱そのもの）、containers はコンテナの中のユーザー
//   （`incus exec`、条件3）。VM のユーザーでは動かさない——中の root が仕込んだ git の設定・フックで VM のユーザーを動かせる
// - コマンドは core が組み、根とブランチ名は位置引数で渡す（台本に埋めない）。ブランチ名は `isSafeBranchName` を通したものだけ
// - 向こうから来るもの（origin の設定・bundle）は申告として扱う。bundle は上限（`PROJECT_GIT_BUNDLE_MAX_BYTES`）を越えたら
//   読むのをやめて断る。中身を確かめるのは受け取った Repositories（`transfer.fsckObjects`）
// - フックと fsmonitor は止めて流す（`-c core.hooksPath=/dev/null -c core.fsmonitor=false`）——Backlog の同期のたびに、中の
//   ものを走らせない

import { PROJECT_GIT_BUNDLE_MAX_BYTES, isCommitId, isSafeBranchName, type ProjectGitOrigin } from "@banto/module-contract";

/** 箱の中で1つ流した結果（標準出力はバイトのまま） */
export interface ProjectRun {
  code: number;
  stdout: Buffer;
  stderr: string;
  /** 標準出力が上限を越えたので止めた */
  overflow?: true;
}

/** 箱の中で argv を流す口（`RemoteSshRuntime.runInProject`） */
export type RunInProject = (
  projectId: string,
  argv: readonly string[],
  opts: { stdin?: Buffer; maxStdoutBytes: number; timeoutMs: number },
) => Promise<ProjectRun>;

export interface RemoteProjectGitDeps {
  /** 別のサーバの Project の根（向こうのパス）。別のサーバの Project でなければ undefined */
  remoteRootOf(projectId: string): string | undefined;
  run: RunInProject;
  /** 1回の上限（ms。試験で縮める） */
  timeoutMs?: number;
}

/** 断り（呼び出し元にそのまま返す文言） */
export class ProjectGitError extends Error {}

/** bundle を運ぶ1回の上限（6MB を遅い線でも運べる長さ） */
const PROJECT_GIT_TIMEOUT_MS = 5 * 60_000;
/** origin の設定は小さい */
const ORIGIN_MAX_BYTES = 256 * 1024;
/** そのブランチが無い（bundle の台本が返す） */
const EXIT_ABSENT = 7;

/**
 * 台本の頭：言語をそろえ、資格情報を聞かせない。`$1` は根、`$2` はブランチ名。**向こうの git も時間で切る**（レビュー L3）——
 * core が線を切っても向こうの git は走り切りうるので、`timeout` があれば core の上限より短い `BANTO_GIT_LIMIT` 秒で止める
 */
const PRELUDE = [
  "export LC_ALL=C LANGUAGE=C GIT_TERMINAL_PROMPT=0 GIT_OPTIONAL_LOCKS=0",
  'T=""',
  'case "$BANTO_GIT_LIMIT" in ""|*[!0-9]*) ;; *) command -v timeout >/dev/null 2>&1 && T="timeout -k 5 $BANTO_GIT_LIMIT" ;; esac',
].join("\n");
const GIT = '$T git -c core.hooksPath=/dev/null -c core.fsmonitor=false -C "$1"';
/** 取り込む bundle の一時ファイルの名前の頭（片づけ損ねたものは、次に取り込むときに消す） */
const UNBUNDLE_TMP_PREFIX = "banto-unbundle.";

/**
 * origin の設定（リポジトリの段だけ。`include` は辿らない）。根が git でなければ `not-repo` の1行。値は `--null`
 * （`<名前>\n<値>\0`）
 */
export const ORIGIN_SCRIPT = [
  PRELUDE,
  `if ! out=$(${GIT} rev-parse --git-dir 2>&1); then`,
  '  case "$out" in *"not a git repository"*) echo not-repo; exit 0 ;; esac',
  "  printf '%s\\n' \"$out\" >&2; exit 4",
  "fi",
  `${GIT} config --local --null --get-regexp '^remote\\.origin\\.(url|pushurl)$|^url\\..*\\.(insteadof|pushinsteadof)$'`,
  'c=$?; [ "$c" -eq 1 ] && exit 0; exit "$c"',
  "",
].join("\n");

/** そのブランチだけの bundle を標準出力へ。ブランチが無ければ 7 で終わる */
export const BUNDLE_SCRIPT = [
  PRELUDE,
  `${GIT} rev-parse -q --verify "refs/heads/$2^{commit}" >/dev/null`,
  `case $? in 0) ;; 1) exit ${EXIT_ABSENT} ;; *) exit 4 ;; esac`,
  `exec ${GIT} bundle create -q - "refs/heads/$2"`,
  "",
].join("\n");

/**
 * 標準入力の bundle のそのブランチを `refs/remotes/origin/<b>` に取り込む（追跡の ref なので `+`。手元のブランチには触らない。
 * タグ・submodule は取らない）。bundle は中のユーザーの一時ファイルに置き、終わったら消す
 */
export const UNBUNDLE_SCRIPT = [
  PRELUDE,
  'd="${TMPDIR:-/tmp}"',
  // 前の回が片づけ損ねたもの（線が切れた・止められた）を消す。走っている回のもの（上限は数分）には触らない
  `find "$d" -maxdepth 1 -name '${UNBUNDLE_TMP_PREFIX}*' -user "$(id -u)" -mmin +30 -exec rm -f -- {} + 2>/dev/null`,
  `t=$(mktemp "$d/${UNBUNDLE_TMP_PREFIX}XXXXXX") || exit 4`,
  "trap 'rm -f -- \"$t\"' EXIT",
  // 止められたとき（線が切れた・時間切れ）も消してから終わる
  "for s in HUP INT PIPE TERM; do trap 'rm -f -- \"$t\"; exit 1' \"$s\"; done",
  'cat > "$t" || exit 4',
  `${GIT} fetch -q --no-tags --no-recurse-submodules --no-write-fetch-head "$t" "+refs/heads/$2:refs/remotes/origin/$2"`,
  "",
].join("\n");

/** `refs/remotes/origin/<b>` を、向こうにもうあるコミット（`$3`）に合わせる。無いコミットなら 4 で終わる */
export const TRACK_SCRIPT = [
  PRELUDE,
  `${GIT} rev-parse -q --verify "$3^{commit}" >/dev/null || { printf 'コミット %s がこのリポジトリにありません\\n' "$3" >&2; exit 4; }`,
  `exec ${GIT} update-ref -m "banto: Repositories が origin へ送った" "refs/remotes/origin/$2" "$3"`,
  "",
].join("\n");

/** `git config --null --get-regexp` の出力を、origin の URL と送り先を変える設定の名前に分ける */
export function parseOriginConfig(out: string): ProjectGitOrigin {
  if (out.trim() === "not-repo") return { kind: "not-repo" };
  const urls: string[] = [];
  const redirects = new Set<string>();
  for (const entry of out.split("\0")) {
    if (!entry) continue;
    const nl = entry.indexOf("\n");
    const key = nl < 0 ? entry : entry.slice(0, nl);
    const value = nl < 0 ? "" : entry.slice(nl + 1);
    if (key.toLowerCase() === "remote.origin.url") urls.push(value);
    else redirects.add(key);
  }
  return { kind: "repo", urls, redirects: [...redirects] };
}

/** 向こうの言葉の最後（長すぎるものは切る） */
function tail(stderr: string): string {
  const lines = stderr.split("\n").map((l) => l.trim()).filter((l) => l && !/^hint:/.test(l));
  const joined = lines.slice(-4).join("\n");
  return joined.length > 600 ? `${joined.slice(0, 600)}…` : joined;
}

export class RemoteProjectGit {
  constructor(private readonly deps: RemoteProjectGitDeps) {}

  private rootOf(projectId: string): string {
    const root = this.deps.remoteRootOf(projectId);
    if (root === undefined) throw new ProjectGitError("この Project は別のサーバで動いていません（この機械の Project の根は Repositories が直接読みます）");
    return root;
  }

  private branchOf(branch: string): string {
    if (!isSafeBranchName(branch)) throw new ProjectGitError(`ブランチ名として受け付けられない形です：${JSON.stringify(branch.slice(0, 80))}`);
    return branch;
  }

  private run(projectId: string, script: string, args: string[], opts: { stdin?: Buffer; maxStdoutBytes: number }): Promise<ProjectRun> {
    const timeoutMs = this.deps.timeoutMs ?? PROJECT_GIT_TIMEOUT_MS;
    // 向こうの git は core の上限の 9 割で止める（core が線を切るより先に、向こうで終わらせる）
    const limitSec = Math.max(1, Math.floor((timeoutMs * 0.9) / 1000));
    return this.deps.run(projectId, ["env", `BANTO_GIT_LIMIT=${limitSec}`, "/bin/sh", "-c", script, "banto-git", ...args], { ...opts, timeoutMs });
  }

  async origin(projectId: string): Promise<ProjectGitOrigin> {
    const r = await this.run(projectId, ORIGIN_SCRIPT, [this.rootOf(projectId)], { maxStdoutBytes: ORIGIN_MAX_BYTES });
    if (r.overflow) throw new ProjectGitError("origin の設定が大きすぎます");
    if (r.code !== 0) throw new ProjectGitError(`この Project のリポジトリの origin を読めませんでした：${tail(r.stderr) || `終了コード ${r.code}`}`);
    return parseOriginConfig(r.stdout.toString("utf8"));
  }

  /** そのブランチの bundle。向こうにそのブランチが無ければ undefined */
  async bundle(projectId: string, branch: string): Promise<Buffer | undefined> {
    const root = this.rootOf(projectId);
    const r = await this.run(projectId, BUNDLE_SCRIPT, [root, this.branchOf(branch)], { maxStdoutBytes: PROJECT_GIT_BUNDLE_MAX_BYTES });
    if (r.overflow) {
      throw new ProjectGitError(`${branch} が大きすぎて、別のサーバとの間で運べません（上限は ${PROJECT_GIT_BUNDLE_MAX_BYTES / 1024 / 1024}MB）`);
    }
    if (r.code === EXIT_ABSENT) return undefined;
    if (r.code !== 0) throw new ProjectGitError(`この Project のリポジトリで ${branch} を bundle にできませんでした：${tail(r.stderr) || `終了コード ${r.code}`}`);
    return r.stdout;
  }

  /** bundle のそのブランチを、向こうの `refs/remotes/origin/<branch>` に取り込む */
  async unbundle(projectId: string, branch: string, bundle: Buffer): Promise<void> {
    const root = this.rootOf(projectId);
    const b = this.branchOf(branch);
    if (bundle.length > PROJECT_GIT_BUNDLE_MAX_BYTES) throw new ProjectGitError(`${branch} の bundle が大きすぎます`);
    const r = await this.run(projectId, UNBUNDLE_SCRIPT, [root, b], { stdin: bundle, maxStdoutBytes: ORIGIN_MAX_BYTES });
    if (r.code !== 0) throw new ProjectGitError(`この Project のリポジトリに ${branch} を取り込めませんでした：${tail(r.stderr) || `終了コード ${r.code}`}`);
  }

  /** 向こうの `refs/remotes/origin/<branch>` を、向こうにもうあるコミットに合わせる（送り終えたあと） */
  async track(projectId: string, branch: string, commit: string): Promise<void> {
    const root = this.rootOf(projectId);
    const b = this.branchOf(branch);
    if (!isCommitId(commit)) throw new ProjectGitError(`コミットの名前の形が違います：${JSON.stringify(commit.slice(0, 80))}`);
    const r = await this.run(projectId, TRACK_SCRIPT, [root, b, commit], { maxStdoutBytes: ORIGIN_MAX_BYTES });
    if (r.code !== 0) throw new ProjectGitError(`この Project のリポジトリの origin/${branch} を進められませんでした：${tail(r.stderr) || `終了コード ${r.code}`}`);
  }
}

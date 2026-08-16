/**
 * MergeGate: pre-merge checks for tasks entering the 'merging' state.
 *
 * Two checks are performed in order:
 *   1. Scope violation check: `git diff --name-only base...branch` against task's scope.paths.
 *      Any file outside scope.paths is a violation → gate fails (P1 enforcement).
 *   2. Verify command execution: acceptance[].verify commands run via child_process
 *      in the rebased worktree (I1: daemon executes them directly, no agent self-report).
 *      Execution logs are written to <dataDir>/gate-logs/<taskId>/<acId>/.
 *      A non-zero exit code fails the gate (I2: stop, record, don't skip).
 *
 * On gate failure: StateMachine.fail() is called (I2: unrecoverable, transition to failed).
 * A merge_gate_evaluated event is appended with passed=false and the reason(s).
 *
 * On gate pass: merge_gate_evaluated with passed=true is appended.
 * The caller (S75f66b-5: serial merge processor) then proceeds to git merge.
 *
 * D3: gate judgment is recorded as events only; no derived state is persisted.
 * D5: all logic here; no Surface-layer code.
 * D6: child_process from stdlib; no additional dependencies.
 * P1: touch only this module (new) + gate-evaluator.ts exports + events.ts append.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { EventLog, TaskRecord, TaskStatus } from "@banto/core";
import { StateMachine } from "@banto/core";
import { fileMatchesScopePaths } from "./gate-evaluator.js";
import {
  DEFAULT_VERIFY_PROFILE,
  DEFAULT_VERIFY_TIMEOUT_MINUTES,
  MAX_VERIFY_TIMEOUT_MINUTES,
  gateEvidenceBlockers,
  landedWithoutHumanApproval,
} from "./review-policy.js";

const execFileAsync = promisify(execFile);

/** 時間切れの終了コード（`timeout(1)` と同じ）。 */
export const VERIFY_TIMEOUT_EXIT = 124;

// ── Public types ──────────────────────────────────────────────────────────────

/** Input for the scope violation check. */
export interface ScopeCheckInput {
  /** Git repository root (used as cwd for git diff). */
  repoPath: string;
  /** Base ref (mainline, e.g. "main"). */
  base: string;
  /** Branch ref to check (the task's implementation branch). */
  branch: string;
  /** scope.paths globs from the task definition (must be non-empty). */
  scopePaths: string[];
}

/** Result of the scope violation check. */
export interface ScopeCheckResult {
  passed: boolean;
  /** Files that are outside scope.paths (empty when passed=true). */
  violations: string[];
}

/** A single acceptance criterion's verify command and its result. */
export interface VerifyResult {
  /** Acceptance criterion ID (e.g. "a1"). */
  acId: string;
  /** The verify command string, or undefined if there was none. */
  command: string | undefined;
  /** Exit code of the command (0 = pass). null when command is absent. */
  exitCode: number | null;
  /** Path to the directory containing stdout/stderr logs. Path reference only (spec §2.1). */
  logDirPath: string | undefined;
}

/** Full result of a merge gate evaluation. */
export interface MergeGateResult {
  passed: boolean;
  scopeResult: ScopeCheckResult;
  verifyResults: VerifyResult[];
  /** Human-readable reasons for gate failure. */
  reasons: string[];
  /** Log directory paths for verify commands (path references only, per spec §2.1). */
  logPaths: string[];
  /**
   * **どの環境で検査したか**（realign 第2便・段1）。検証環境を立てたときだけ付く。
   * `merge_gate_evaluated.environmentDigest` にそのまま入る。
   */
  environmentDigest?: string;
  /**
   * **どの環境の実体で検査したか**。`verifyRunner.provision()` が返した envId。
   * `environmentDigest`（プロファイルの指紋）とは別物——`merge_gate_evaluated.environmentId`
   * にそのまま入る。
   */
  environmentId?: string;
  /**
   * **どのコミットの上で検査したか**（realign 第2便・段1）。`base` を解決した SHA。
   * `merge_gate_evaluated.baseCommit` にそのまま入る。
   */
  baseCommit?: string;
}

/** Options for runMergeGate. */
export interface MergeGateOptions {
  /** Absolute path to the daemon's data directory (gate logs go under <dataDir>/gate-logs/). */
  dataDir: string;
  /** Git repository root. */
  repoPath: string;
  /** Base branch (mainline). */
  base: string;
  /** Task implementation branch. */
  branch: string;
  /** Absolute path to the worktree where verify commands are executed. */
  worktreePath: string;
  /**
   * 検証コマンド1本あたりの制限時間。既定は `DEFAULT_VERIFY_TIMEOUT_MINUTES`。
   *
   * **既定は 60 秒だった**（task-0071 で直した）。検証コマンドはテスト一式そのものなので
   * 分の単位で要る——同じことを検証環境側は 2026-08-01 に裁定済みだったが、
   * ゲート側だけ取り残されていた（spec-environment §5.1）。
   */
  verifyTimeoutMs?: number;
  /**
   * 時間切れで延ばすときの上限。既定は `MAX_VERIFY_TIMEOUT_MINUTES`。
   *
   * 時間切れは「判断」ではなく「事故」なので、上限まで倍にして1回やり直す。
   * 上限があるのは、マージキューが直列で1本の居座りが後ろを全部止めるため。
   */
  maxVerifyTimeoutMs?: number;
  /**
   * 検証を回す場所（PO裁定 2026-08-07・task-0075）。**必須**。
   *
   * **Kobo はホストで検証を走らせない。** 受け持つプロジェクトのテストは、そのプロジェクトが
   * 宣言した検証環境の中で回す——ホストで走らせると、ホストの状態（入っている道具・空いている
   * ポート）が検証結果に混ざる。実際に混ざった（inc-0032）：banto の Kobo が 3000番に
   * 居座っていたせいで loamium のテストが1件、永久に落ちていた。
   *
   * 渡されないときは**ゲートを通さない**。ホストへ落とすと、いちばん静かに壊れる形
   * （「たまたま通った」）に戻る。
   */
  verifyRunner?: GateVerifyRunner;
  /** 検証環境のプロファイル名（`meta/config.yaml` の `verify.profile`）。 */
  verifyProfile?: string;
  /** プロファイルの在り処。 */
  repoPathForProfile?: string;
}

/**
 * 検証を回す場所（task-0075）。Kobo は Environment Pool 経由でしか検証しない。
 *
 * ここを口にしているのは、**ゲートが Environment Pool の実装を知らないため**——
 * Kobo は `env.*` Tool を呼ぶだけで、立てる・回す・畳むの中身は持ち主のもの（決定32）。
 * 試験は偽の runner を差せる。
 */
export interface GateVerifyRunner {
  /** 立てる。**畳むのは呼び出し側の責任**（`runMergeGate` が finally で畳む）。 */
  provision(opts: {
    repoPath: string;
    workdir: string;
    profile: string;
    taskId: string;
    projectTag: string;
  }): Promise<{
    envId: string;
    /**
     * **立てた環境の中身の指紋**（realign 第2便・段1）。プロファイルの定義から作る
     * （`envProfileDigest`）。ゲートの証拠に「どの環境で検査したか」を刻むための値。
     *
     * 任意なのは、環境の持ち主（Environment Pool）が返さないこともあるため
     * ——**返らないなら刻まない**。分からないものを名前で埋めると、名前が同じまま
     * 中身が変わった環境を「同じ環境」と言ってしまう（I2）。
     */
    profileDigest?: string;
  }>;
  run(opts: {
    envId: string;
    cmd: string;
    timeoutMs: number;
  }): Promise<{ exit: number; logPath?: string; logTail?: string }>;
  teardown(envId: string): Promise<void>;
}

// ── Scope violation check ─────────────────────────────────────────────────────

/**
 * Check whether the diff between base and branch contains any files outside
 * the task's scope.paths.
 *
 * Runs `git diff --name-only <base>...<branch>` in the repository root.
 * Each changed file is matched against the scope.paths globs using
 * fileMatchesScopePaths (exported from gate-evaluator, D6: reuse).
 * Files not matched by any pattern are recorded as violations.
 *
 * Pure judgment: does NOT modify any git state.
 * I2: git exec failures (non-zero exit from git) are thrown, not swallowed.
 */
export async function checkScopeViolations(input: ScopeCheckInput): Promise<ScopeCheckResult> {
  const { repoPath, base, branch, scopePaths } = input;

  // `git diff --name-only A...B` lists files changed between the common ancestor and B.
  // Using three-dot diff is the canonical way to check what a branch introduces
  // (independent of what has landed on base since the branch point).
  let stdout: string;
  try {
    const result = await execFileAsync(
      "git",
      ["diff", "--name-only", `${base}...${branch}`],
      { cwd: repoPath }
    );
    stdout = result.stdout;
  } catch (err) {
    // I2: git errors are not swallowed; rethrow so the caller can fail the gate.
    throw new Error(
      `checkScopeViolations: git diff failed in ${repoPath}: ${String(err)}`
    );
  }

  const changedFiles = stdout
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  const violations: string[] = [];
  for (const file of changedFiles) {
    if (!fileMatchesScopePaths(file, scopePaths)) {
      violations.push(file);
    }
  }

  return {
    passed: violations.length === 0,
    violations,
  };
}

// ── Verify command execution ──────────────────────────────────────────────────

/**
 * 受け入れ条件1本を**検証環境の中で**走らせ、結果をゲートのログへ写す（task-0075）。
 *
 * ログは2箇所にある：検証環境が書いた全文（`logPath`）と、ここが書く写し
 * （`<dataDir>/gate-logs/<taskId>/<acId>/`）。**写しを残すのは、環境を畳むと中身が
 * 消えるから**——判断の材料が畳んだ瞬間に無くなるのでは、後から辿れない（spec §6）。
 *
 * **時間切れは「判断」ではなく「事故」**（task-0071）。上限まで一気に延ばして1回だけ
 * やり直す。テストが本当に落ちた（exit≠0 かつ≠124）ものはやり直さない——それは検証が
 * 出した判定であって、二度走らせても同じことを二度言われるだけ。
 */
async function runVerifyInEnv(opts: {
  runner: GateVerifyRunner;
  envId: string;
  acId: string;
  command: string;
  logBaseDir: string;
  timeoutMs: number;
  maxTimeoutMs: number;
  taskId: string;
}): Promise<{ exitCode: number; logDirPath: string; stretchedTo: number }> {
  const { runner, envId, acId, command, logBaseDir, timeoutMs, maxTimeoutMs, taskId } = opts;

  const safeDirName = acId.replace(/[^a-zA-Z0-9_-]/g, "_");
  const logDirPath = path.join(logBaseDir, safeDirName);
  fs.mkdirSync(logDirPath, { recursive: true });

  const writeFailure = (message: string): void => {
    fs.writeFileSync(path.join(logDirPath, "stdout.txt"), "", "utf-8");
    fs.writeFileSync(path.join(logDirPath, "stderr.txt"), `${message}\n`, "utf-8");
  };

  let stretchedTo = 0;
  let result: { exit: number; logPath?: string; logTail?: string };
  try {
    result = await runner.run({ envId, cmd: command, timeoutMs });
  } catch (err) {
    // I2: 走らせられなかったことを「テストが落ちた」と混同しない。理由を残して失敗にする
    writeFailure(
      `[banto-gate] 検証環境でコマンドを走らせられませんでした: ${err instanceof Error ? err.message : String(err)}`
    );
    return { exitCode: 1, logDirPath, stretchedTo };
  }

  if (result.exit === VERIFY_TIMEOUT_EXIT && timeoutMs < maxTimeoutMs) {
    process.stderr.write(
      `[banto-gate] ${taskId}/${acId} が ${Math.round(timeoutMs / 60000)} 分で時間切れ。` +
        `${Math.round(maxTimeoutMs / 60000)} 分に延ばしてもう一度試します\n`
    );
    stretchedTo = maxTimeoutMs;
    try {
      result = await runner.run({ envId, cmd: command, timeoutMs: maxTimeoutMs });
    } catch (err) {
      writeFailure(
        `[banto-gate] 延長して走らせられませんでした: ${err instanceof Error ? err.message : String(err)}`
      );
      return { exitCode: 1, logDirPath, stretchedTo };
    }
  }

  fs.writeFileSync(
    path.join(logDirPath, "stdout.txt"),
    [`[banto-gate] 検証環境 ${envId} で実行: ${command}`, result.logTail ?? "(ログなし)"].join("\n"),
    "utf-8"
  );
  fs.writeFileSync(
    path.join(logDirPath, "stderr.txt"),
    result.logPath ? `検証環境の全文ログ: ${result.logPath}\n` : "",
    "utf-8"
  );
  return { exitCode: result.exit, logDirPath, stretchedTo };
}

/**
 * **同じ検証コマンドを持つ受け入れ条件を束ねる**（task-0219）。
 *
 * 同じコミット・同じ環境で同じコマンドを12回回しても、返ってくる答えは12回とも同じ
 * ——費用だけ12倍で、得られる情報は1倍。task-0165 は全量 `npm test` を12本ぶん回そうとして
 * 検証環境の寿命（45分）を越え、3周まわして一度も判定に到達しなかった。
 *
 * 束ねる鍵は**コマンド文字列の完全一致**。正規化して「意味が同じもの」まで畳もうとしない
 * ——取り違えのほうが害が大きい。並びは**最初に現れた条件の順**（走らせる順を変えない）。
 */
function groupAcceptanceByCommand(
  withCommands: Array<{ id: string; verify?: string }>
): Map<string, string[]> {
  const groups = new Map<string, string[]>();
  for (const ac of withCommands) {
    const command = ac.verify!;
    const acIds = groups.get(command);
    if (acIds) acIds.push(ac.id);
    else groups.set(command, [ac.id]);
  }
  return groups;
}

/**
 * 束ねた側（2本目以降）の受け入れ条件にも、**自分の名前の置き場**を残す（task-0219）。
 *
 * 結果を配るだけだと `gate-logs/<taskId>/` に先頭の条件のディレクトリしか無く、証拠に
 * 並んだ acId から辿ろうとした人が「この条件の検証ログが無い」と読む。中身は共有した実行を
 * 指す1行——**どの実行をもって通した（落とした）のか**が後から辿れることだけが要る。
 */
function writeSharedRunPointer(opts: {
  logBaseDir: string;
  acId: string;
  sharedWith: string;
  logDirPath: string;
}): void {
  const safeDirName = opts.acId.replace(/[^a-zA-Z0-9_-]/g, "_");
  const dirPath = path.join(opts.logBaseDir, safeDirName);
  try {
    fs.mkdirSync(dirPath, { recursive: true });
    fs.writeFileSync(
      path.join(dirPath, "shared-run.txt"),
      `[banto-gate] ${opts.sharedWith} と同じ検証コマンドのため、1回にまとめて走らせました。\n` +
        `この条件の検証ログ: ${opts.logDirPath}\n`,
      "utf-8"
    );
  } catch (err) {
    // I2: 目印を残せなかったことは黙らせない。ただし**判定そのものは既に出ている**
    // ——ここで throw して検証全体を落とすほうが害が大きい
    process.stderr.write(
      `[banto-gate] ${opts.acId}: 束ねた実行への目印を書けませんでした: ${String(err)}\n`
    );
  }
}

// ── 受け入れ条件の検証（共有）─────────────────────────────────────────────────

/** 検証環境の中で走った受け入れ条件1本の結果。 */
export interface AcceptanceVerifyRun {
  acId: string;
  command: string;
  exitCode: number;
  /** stdout.txt / stderr.txt の写しがある場所。全文の置き場所はこの中に書いてある。 */
  logDirPath: string;
}

/** `runAcceptanceVerify` の結果。 */
export interface AcceptanceVerifyOutcome {
  /**
   * **検証に到達できなかった理由**（環境が用意できない等）。`undefined` なら到達した。
   *
   * I2: 到達できなかったことを「通った」とも「落ちた」とも言わない。呼び出し側が
   * それぞれの立場で裁く——ゲートは通さない、前倒しの検証は先へ進める。
   */
  blocked?: string;
  runs: AcceptanceVerifyRun[];
  /** 時間切れで延ばしたときの、実際に使った一番長い制限時間（0 なら延ばしていない）。 */
  stretchedTo: number;
  environmentId?: string;
  environmentDigest?: string;
}

/** `runAcceptanceVerify` に渡すもの。 */
export interface AcceptanceVerifyOptions {
  taskId: string;
  projectTag: string;
  /** 走らせる受け入れ条件（`verify` を持たないものは無視する）。 */
  acceptance: Array<{ id: string; verify?: string }>;
  /** 検証環境に映すディレクトリ（タスクのワークツリー）。 */
  worktreePath: string;
  /** 写しを置く場所。`<ここ>/<acId>/stdout.txt` に書く。 */
  logBaseDir: string;
  runner?: GateVerifyRunner;
  profile?: string;
  repoPathForProfile?: string;
  timeoutMs?: number;
  maxTimeoutMs?: number;
}

/**
 * **受け入れ条件の検証を検証環境の中で回す**（task-0213 で `runMergeGate` から切り出した）。
 *
 * 切り出した理由は**同じことを2箇所に実装しないため**。マージ前ゲートと、職人が
 * 「終わった」と言った時点の前倒しの検証は、**同じ経路で同じコマンドを回す**必要がある
 * ——別実装にすると「ゲートは通るのに職人のところでは落ちる」（およびその逆）が起きて、
 * どちらが本当なのか誰にも言えなくなる。
 *
 * **立てるのは1回**。受け入れ条件ごとに立て直すと、テスト一式を何度も用意することになる。
 * 畳むのは finally——途中で落ちても畳む（I3）。
 *
 * **走らせるのも、コマンドが同じなら1回**（task-0219）。詳しくは `groupAcceptanceByCommand`。
 * 畳むのは実行の回数だけで、`runs` には acId が全件並ぶ——条件ごとの合否が欠けると、
 * 後から「何をもって通した（落とした）のか」を条件の単位で言えなくなる。
 */
export async function runAcceptanceVerify(
  opts: AcceptanceVerifyOptions
): Promise<AcceptanceVerifyOutcome> {
  const {
    taskId,
    projectTag,
    acceptance,
    worktreePath,
    logBaseDir,
    runner,
    profile = DEFAULT_VERIFY_PROFILE,
    repoPathForProfile,
    timeoutMs = DEFAULT_VERIFY_TIMEOUT_MINUTES * 60_000,
    maxTimeoutMs = MAX_VERIFY_TIMEOUT_MINUTES * 60_000,
  } = opts;

  const withCommands = acceptance.filter((ac) => ac.verify);
  const runs: AcceptanceVerifyRun[] = [];
  let stretchedTo = 0;

  if (withCommands.length === 0) return { runs, stretchedTo };

  if (!runner) {
    // I2: **ホストへ落とさない。** 落とすと「たまたま通った」が戻る
    return { blocked: "verify_runner_missing（Kobo に検証環境が配線されていない）", runs, stretchedTo };
  }
  if (!repoPathForProfile) {
    return { blocked: "verify_repo_unknown（プロファイルの在り処が分からない）", runs, stretchedTo };
  }

  let envId: string | undefined;
  let environmentDigest: string | undefined;
  try {
    // 段1: 立てた環境の指紋も受け取る。**証拠に刻むのは、立った環境のもの**
    // ——プロファイル名だけでは、名前が同じまま中身が変わったことを言えない
    ({ envId, profileDigest: environmentDigest } = await runner.provision({
      repoPath: repoPathForProfile,
      workdir: worktreePath,
      profile,
      taskId,
      projectTag,
    }));
  } catch (err) {
    // I2: 立てられないことを「検証が落ちた」と混同しない。**確かめていない**と言う
    return {
      blocked:
        `verify_env_unavailable:${profile}` +
        `（${err instanceof Error ? err.message : String(err)}）`,
      runs,
      stretchedTo,
    };
  }

  try {
    // 走らせるのは**コマンドごとに1回**（task-0219）。結果は同じコマンドを持つ全条件へ配る。
    // 畳むのは走らせる回数だけで、`runs` には従来どおり acId が全件並ぶ
    for (const [command, acIds] of groupAcceptanceByCommand(withCommands)) {
      const outcome = await runVerifyInEnv({
        runner,
        envId,
        acId: acIds[0]!,
        command,
        logBaseDir,
        timeoutMs,
        maxTimeoutMs,
        taskId,
      });
      if (outcome.stretchedTo > 0) stretchedTo = Math.max(stretchedTo, outcome.stretchedTo);
      for (const acId of acIds) {
        if (acId !== acIds[0]) {
          writeSharedRunPointer({ logBaseDir, acId, sharedWith: acIds[0]!, logDirPath: outcome.logDirPath });
        }
        runs.push({
          acId,
          command,
          exitCode: outcome.exitCode,
          logDirPath: outcome.logDirPath,
        });
      }
    }
  } finally {
    // I3: 途中で落ちても畳む。畳めなかったことは黙らせない
    try {
      await runner.teardown(envId);
    } catch (err) {
      process.stderr.write(
        `[banto-gate] ${taskId}: 検証環境 ${envId} を畳めませんでした: ${String(err)}\n`
      );
    }
  }

  return {
    runs,
    stretchedTo,
    environmentId: envId,
    ...(environmentDigest !== undefined ? { environmentDigest } : {}),
  };
}

// ── 検証ログの切り詰め ────────────────────────────────────────────────────────

/** 職人へ返すログの既定の上限（行）。 */
export const VERIFY_LOG_MAX_LINES = 60;

/** 「失敗した箇所」として拾う行の目印。 */
const FAILURE_MARKERS =
  /(FAIL|FAILED|✗|✘|×|not ok|AssertionError|Error:|error TS\d+|npm ERR!|Exception|panic:|Killed|SIGKILL|failing|failed)/;

/**
 * **検証の出力を、職人の文脈へ載せられる大きさに切り詰める**（task-0213・a7）。
 *
 * 検証は一式（`npm test`）なので、出力は数千行になる。それを丸ごと指示文へ入れると、
 * 職人の文脈が出力で埋まる——袋の外へ追い出した意味が半分無くなる。
 *
 * 残すのは**失敗した箇所と末尾**：どこで落ちたかは失敗行に、なぜ止まったかは末尾
 * （集計・スタック）に出る。真ん中の「通った行」は捨ててよい。
 *
 * I2: **切ったことは黙らせない。** 何行落としたかと、全文がどこにあるかを必ず添える
 * ——添えないと、職人は「これが全部だ」と読んで、見えていない失敗を無いことにする。
 */
export function summarizeVerifyLog(
  text: string,
  opts: { maxLines?: number; fullLogPath?: string } = {}
): string {
  const maxLines = opts.maxLines ?? VERIFY_LOG_MAX_LINES;
  const where = opts.fullLogPath ? `全文: ${opts.fullLogPath}` : "全文の置き場所は不明";
  const lines = text.replace(/\s+$/, "").split("\n");
  if (lines.length <= maxLines) return lines.join("\n");

  // 末尾は必ず残す。残りの枠で失敗行を頭から拾う（上限の 1/3 まで）
  const failureQuota = Math.max(1, Math.floor(maxLines / 3));
  const tailCount = maxLines - failureQuota;
  const tailStart = lines.length - tailCount;
  const failures: Array<{ index: number; line: string }> = [];
  for (let i = 0; i < tailStart && failures.length < failureQuota; i++) {
    const line = lines[i] ?? "";
    if (FAILURE_MARKERS.test(line)) failures.push({ index: i, line });
  }

  const kept = failures.length + tailCount;
  const out: string[] = [
    `（全 ${lines.length} 行のうち ${lines.length - kept} 行を切り詰めました。${where}）`,
  ];
  if (failures.length > 0) {
    out.push("── 失敗した箇所 ──");
    for (const f of failures) out.push(`${f.index + 1}: ${f.line}`);
    out.push(`（失敗した箇所はここまで。全部見るなら ${where}）`);
  }
  out.push(`── 末尾 ${tailCount} 行 ──`);
  out.push(...lines.slice(tailStart));
  return out.join("\n");
}

// ── Main gate function ────────────────────────────────────────────────────────

/**
 * Run the full merge gate for a task.
 *
 * Steps:
 *   1. Scope violation check (git diff vs scope.paths).
 *   2. Verify command execution for each acceptance entry that has a `verify` field.
 *      Runs in the rebased worktree (opts.worktreePath).
 *   3. Append a merge_gate_evaluated event to the EventLog.
 *   4. If gate failed: call StateMachine.fail() to transition the task to 'failed' (I2).
 *
 * The task must be in status 'merging' at the call site. StateMachine.fail() will
 * emit state_transitioned(→failed) + task_failed. The merge_gate_evaluated event
 * is appended BEFORE the fail transition so the audit trail is ordered correctly.
 *
 * Returns the MergeGateResult for the caller's inspection.
 */
export async function runMergeGate(
  log: EventLog,
  task: TaskRecord,
  opts: MergeGateOptions
): Promise<MergeGateResult> {
  const {
    dataDir,
    repoPath,
    base,
    branch,
    worktreePath,
    verifyTimeoutMs = DEFAULT_VERIFY_TIMEOUT_MINUTES * 60_000,
    maxVerifyTimeoutMs = MAX_VERIFY_TIMEOUT_MINUTES * 60_000,
    verifyRunner,
    verifyProfile = DEFAULT_VERIFY_PROFILE,
    repoPathForProfile,
  } = opts;

  /** 時間切れで延ばしたときの、実際に使った一番長い制限時間（0 なら延ばしていない）。 */
  let stretchedTo = 0;

  const taskId = task.id;
  const projectTag = task.projectTag;

  // ── 1. Scope violation check ──────────────────────────────────────────────
  const scopePaths = getScopePaths(task);
  let scopeResult: ScopeCheckResult;

  if (scopePaths.length === 0) {
    // D2: fail-closed — a task with no scope.paths cannot prove any change is in scope.
    // All changes are treated as out-of-scope violations. The explicit reason surfaces this
    // in the audit trail so PO can correct the task definition.
    scopeResult = {
      passed: false,
      violations: ["scope.paths is empty — gate fail-closed (all changes out of scope)"],
    };
  } else {
    try {
      scopeResult = await checkScopeViolations({
        repoPath,
        base,
        branch,
        scopePaths,
      });
    } catch (err) {
      // I2: git exec failure → gate fail; record and stop
      scopeResult = {
        passed: false,
        violations: [`git_exec_error: ${String(err)}`],
      };
    }
  }

  // ── 2. Verify command execution ───────────────────────────────────────────
  //
  // **検証は検証環境の中で回す**（PO裁定 2026-08-07・task-0075）。ホストでは走らせない
  // ——ホストの状態（入っている道具・空いているポート）が検証結果に混ざるため。
  // 実際に混ざった（inc-0032）：banto の Kobo が 3000番に居座っていたせいで、
  // loamium のテストが1件、永久に落ちていた。`make` が入っていないせいで3件落ちてもいた。
  //
  // **立てるのは1回**。受け入れ条件ごとに立て直すと、テスト一式を何度も用意することになる。
  // 畳むのは finally——途中で落ちても畳む（I3）。
  //
  // task-0213: ここの中身は `runAcceptanceVerify` へ切り出した。**前倒しの検証
  // （職人が「終わった」と言った時点で Kobo が袋の外で回すもの）と同じ経路を使うため**
  // ——別実装にすると「ゲートは通るのに職人のところでは落ちる」が起きる。
  const acceptance = getAcceptance(task);
  const logBaseDir = path.join(dataDir, "gate-logs", taskId);
  const verifyResults: VerifyResult[] = [];

  const verified = await runAcceptanceVerify({
    taskId,
    projectTag,
    acceptance,
    worktreePath,
    logBaseDir,
    ...(verifyRunner ? { runner: verifyRunner } : {}),
    profile: verifyProfile,
    ...(repoPathForProfile !== undefined ? { repoPathForProfile } : {}),
    timeoutMs: verifyTimeoutMs,
    maxTimeoutMs: maxVerifyTimeoutMs,
  });

  /** 検証に到達できなかった理由（環境が用意できない等）。空なら到達した。 */
  const verifyBlocked = verified.blocked;
  if (verified.stretchedTo > 0) stretchedTo = Math.max(stretchedTo, verified.stretchedTo);
  for (const run of verified.runs) {
    verifyResults.push({
      acId: run.acId,
      command: run.command,
      exitCode: run.exitCode,
      logDirPath: run.logDirPath,
    });
  }

  /** **どの環境で検査したか**（realign 第2便・段1）。立てられたときだけ付く。 */
  const environmentDigest = verified.environmentDigest;
  /**
   * **どの環境の実体で検査したか**。`envId` そのもの。立てられたときだけ付く。
   * **証拠に刻むのは、立った環境の実体そのもの**——指紋だけでは
   * 「どの回か」を後から一意に辿れない（dentaku task-0020 の誤誘導）
   */
  const environmentId = verified.environmentId;

  // verify を持たない受け入れ条件は、そのまま「走らせるものが無い」として並べる
  for (const ac of acceptance) {
    if (ac.verify) continue;
    verifyResults.push({ acId: ac.id, command: undefined, exitCode: null, logDirPath: undefined });
  }

  // ── 3. Aggregate result ───────────────────────────────────────────────────
  const reasons: string[] = [];
  const logPaths: string[] = [];

  // Scope violations
  if (!scopeResult.passed) {
    for (const v of scopeResult.violations) {
      reasons.push(`scope_violation:${v}`);
    }
  }

  // I2: **検証に到達できなかったことを「通った」にしない。** 確かめていないのだから、
  // 通してはいけない——ホストへ落とす道を残すと、ここが静かに緩む
  if (verifyBlocked) {
    reasons.push(verifyBlocked);
  }

  // Verify command failures
  for (const vr of verifyResults) {
    if (vr.exitCode !== null && vr.exitCode !== 0) {
      // **時間切れは他の失敗と区別する**（task-0071）。テストが落ちたのか、
      // 待ち切れなかったのかで、次にやることが違う——番頭が読んで判断できるように、
      // 「何分まで延ばして駄目だったのか」まで理由に入れる（I2）
      if (vr.exitCode === VERIFY_TIMEOUT_EXIT) {
        const waited = Math.round((stretchedTo > 0 ? stretchedTo : verifyTimeoutMs) / 60_000);
        reasons.push(
          `verify_timeout:${vr.acId}(${waited}分待っても終わらず` +
            `${stretchedTo > 0 ? "・延長済み" : ""}）`
        );
      } else {
        reasons.push(`verify_failed:${vr.acId}(exit=${vr.exitCode})`);
      }
    }
    if (vr.logDirPath !== undefined) {
      logPaths.push(vr.logDirPath);
    }
  }

  /**
   * **どのコミットの上で検査したか**（realign 第2便・段1）。
   *
   * `passed` は「この土台の上でなら通る」という主張でしかない。メインラインが
   * 進めば前提が変わる——それを後から言えるように、`base` を SHA へ解決して残す。
   * I2: 解決できなければ**付けない**。嘘の SHA を書くより「無い」と言う。
   */
  const baseCommit = await resolveCommit(repoPath, base);

  /**
   * **自動着地で来たものは、刻めていなければ通さない**（realign 第3便・番頭裁定 2026-08-14）。
   *
   * この2つ（`baseCommit` / `environmentDigest`）はゲートの出力なので、監査の分岐の
   * 時点には無い。だから自動着地の可否の**入力**ではなく、**ゲートの成立条件**として
   * ここで見る——状態機械を作り替えてゲートを前倒しするより影響が小さい。
   *
   * **人の承認を経た経路には効かせない**（`landedWithoutHumanApproval`）。人が見ている
   * ものと機械だけで通すものを同じ基準にすると、**既存の緑が理由なく落ちる**。
   * この非対称は意図であって漏れではない。
   */
  if (landedWithoutHumanApproval(log.readAllEvents(), projectTag, taskId)) {
    reasons.push(...gateEvidenceBlockers({ baseCommit, environmentDigest }));
  }

  const passed = reasons.length === 0;

  const result: MergeGateResult = {
    passed,
    scopeResult,
    verifyResults,
    reasons,
    logPaths,
    ...(environmentDigest !== undefined ? { environmentDigest } : {}),
    ...(environmentId !== undefined ? { environmentId } : {}),
    ...(baseCommit !== undefined ? { baseCommit } : {}),
  };

  // ── 4. Append merge_gate_evaluated event ──────────────────────────────────
  log.append({
    type: "merge_gate_evaluated",
    projectTag,
    taskId,
    passed,
    reasons,
    logPaths,
    // 段1: **何に対して通ったのか**。この2つが無いと、通った判定がまだ有効かを
    // 計算できず、第3便（人の承認なしの着地）を安全に倒せない
    ...(environmentDigest !== undefined ? { environmentDigest } : {}),
    ...(environmentId !== undefined ? { environmentId } : {}),
    ...(baseCommit !== undefined ? { baseCommit } : {}),
  });

  // ── 5. Fail the task if gate did not pass ─────────────────────────────────
  if (!passed) {
    // I2: gate failure is unrecoverable for this merge attempt — transition to failed.
    // The task status at this point should be 'merging'.
    const currentStatus = task.status as TaskStatus;
    StateMachine.fail(log, taskId, {
      currentStatus,
      reason: `merge_gate_failed: ${reasons.join("; ")}`,
    }, projectTag);
  }

  return result;
}

// ── Internal helpers ──────────────────────────────────────────────────────────

/**
 * ref を SHA へ解決する（realign 第2便・段1）。
 *
 * I2: 解決できなければ `undefined`。**「分からない」を埋めない**——ここで ref 名
 * （`main`）をそのまま返すと、あとから読む側は SHA だと思って比較し、常に一致しない
 * か、常に一致するかのどちらかになる。どちらも証拠として役に立たない。
 */
async function resolveCommit(repoPath: string, ref: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", ref], { cwd: repoPath });
    const sha = stdout.trim();
    return sha.length > 0 ? sha : undefined;
  } catch {
    return undefined;
  }
}

/** Extract scope.paths from a TaskRecord (D3: derived from record). */
function getScopePaths(task: TaskRecord): string[] {
  const scope = task["scope"] as Record<string, unknown> | undefined;
  if (!scope || typeof scope !== "object") return [];
  const paths = scope["paths"];
  if (!Array.isArray(paths)) return [];
  return paths.filter((p): p is string => typeof p === "string");
}

/**
 * Extract acceptance criteria (with optional verify) from a TaskRecord.
 *
 * 公開しているのは、**契約に検査があるか**を監査の分岐でも見るため（realign 第3便）。
 * 読み方を2つ持つと、ゲートが回す本数と分岐が数える本数がずれる（D3）。
 */
export function getAcceptance(task: TaskRecord): Array<{ id: string; text: string; verify?: string }> {
  const acceptance = task["acceptance"];
  if (!Array.isArray(acceptance)) return [];
  return acceptance
    .filter((a): a is Record<string, unknown> => !!a && typeof a === "object")
    .map((a) => ({
      id: String(a["id"] ?? ""),
      text: String(a["text"] ?? ""),
      ...(typeof a["verify"] === "string" ? { verify: a["verify"] } : {}),
    }))
    .filter((a) => a.id.length > 0);
}

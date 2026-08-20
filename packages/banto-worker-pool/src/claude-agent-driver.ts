/**
 * ClaudeAgentDriver — 職人を **Claude Code（Agent SDK）** で動かす `RuntimeDriver`。
 *
 * `PiRpcDriver` と対等な差し替え先（決定11・ADR-0010 決定3：モジュールはハーネスに依存しない）。
 * Worker Pool から見た口は同じ spawn / inject / subscribe / kill で、Claude Code 固有の話は
 * すべてこの中と `claude-agent/host.ts` に閉じる。
 *
 * 子プロセスとして `claude-agent/host.ts` を起こし、標準入出力の JSONL で話す
 * （pi の RPC のうち Worker Pool が使う分だけと同じ言葉）。同居させない理由は host.ts の頭に書いた。
 *
 * D5: 判断は無い。渡されたものを Claude Code の言葉へ写して起こすだけ。
 * D6: 依存は node 標準と Agent SDK（子プロセス側）。ここでは SDK を import しない
 *     ——番頭ホストや Kobo にドライバを積むだけで SDK を読み込ませないため。
 * I2: 起動失敗は spawn_failed を出してから投げる。黙って「起きたつもり」にしない。
 */

import * as childProcess from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import type {
  DriverEvent,
  DriverEventHandler,
  RuntimeDriver,
  SessionHandle,
  SpawnOptions,
} from "@banto/core";
import { attachJsonlReader, createHandleGrip, waitForSpawnError, type HandleGrip } from "./child-session.js";
import { workerSpawnEnv } from "./worker-env.js";
import {
  CLAUDE_DEFAULT_MODEL,
  CLAUDE_KOBO_TOOL_NAMES,
  CLAUDE_REPORT_TOOL_NAMES,
  CLAUDE_WEB_TOOL_NAMES,
  resolveClaudeModel,
  toClaudeToolNames,
  type ClaudeModelTier,
} from "./claude-agent/naming.js";
import { readSessionIdFromLines } from "./claude-agent/session-log.js";

// ドライバの識別子は名前の対応表（naming.ts）に置いてある——工房（pool.ts）も
// 名指しからランタイムを言い当てるのに要り、ドライバ本体を読み込ませたくないため
export { CLAUDE_AGENT_DRIVER_ID } from "./claude-agent/naming.js";

/**
 * 起動直後の状態問い合わせ（get_state）に答えが返るまでの既定の待ち。
 *
 * **既定 10s の根拠**: 実機（banto・dentaku 双方）で新規起動の名乗りは通常 1〜3s で返る観測から、
 * 詰まった環境でも一呼吸待てるだけの余裕を見て据え置いた（2026-08-16時点）。この待ちを伸ばす
 * こと自体は詰まりの原因（いまだ未特定・調査ノート参照）を直しはしない——**時間を買うだけの
 * 手当て**である。環境ごとに変えられるよう `BANTO_CLAUDE_START_TIMEOUT_MS` で上書きできる。
 */
const DEFAULT_START_TIMEOUT_MS = 10_000;

/**
 * inject（指示の差し込み）の応答を待つ既定の上限。
 *
 * 既定は起動と同じ 10s——「届いたか分からないまま進まない」ための待ちで、起動より短くする
 * 理由も長くする理由も無い。`BANTO_CLAUDE_INJECT_TIMEOUT_MS` で上書きできる。
 */
const DEFAULT_INJECT_TIMEOUT_MS = 10_000;

/**
 * 環境変数からミリ秒の待ちを読む（`resolveMaxConcurrentWorkers` と同じ流儀）。
 *
 * I2: 読めない値を黙って既定へ落とさない——「変えたつもりで効いていない」を例外にする。
 */
function readTimeoutMs(envName: string, defaultMs: number): number {
  const raw = process.env[envName];
  if (raw === undefined || raw.trim() === "") return defaultMs;
  const parsed = Number.parseInt(raw.trim(), 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${envName} を読み取れません: "${raw}"（正の整数ミリ秒。既定 ${defaultMs}）`);
  }
  return parsed;
}

/** 呼び出し時点の環境変数を読む（モジュール読込時に固定しない——試験が per-call で上書きできる）。 */
function startTimeoutMs(): number {
  return readTimeoutMs("BANTO_CLAUDE_START_TIMEOUT_MS", DEFAULT_START_TIMEOUT_MS);
}

function injectTimeoutMs(): number {
  return readTimeoutMs("BANTO_CLAUDE_INJECT_TIMEOUT_MS", DEFAULT_INJECT_TIMEOUT_MS);
}

/**
 * 起動待ち（get_state の応答待ち）の「時間切れ」を作る仕掛け。
 *
 * task-0291: 同じ間欠（フルスイート負荷下でだけ落ちる）に3度目の手当てを打つにあたり、
 * 「タイムアウトの数字を上げる」をやめて壁時計依存そのものを断つ。ここを差し替え可能に
 * しておけば、試験は実時間を1ミリ秒も待たずに「間に合わなかった」を作れる——かつ、
 * 一度も `schedule` のコールバックを呼ばなければ、本物の応答がどれだけ遅れても
 * レースに負けない＝「間に合った」側は実時間の上限そのものが無くなる。
 *
 * 既定（`REAL_START_TIMEOUT_SCHEDULER`）は今までどおり実時間の `setTimeout`
 * ——番頭ホスト・Kobo からは何も変わらない。差し替えは試験専用。
 */
export interface StartTimeoutScheduler {
  schedule(ms: number, onTimeout: () => void): { cancel: () => void };
}

const REAL_START_TIMEOUT_SCHEDULER: StartTimeoutScheduler = {
  schedule(ms, onTimeout) {
    const timer = setTimeout(onTimeout, ms);
    timer.unref?.();
    return { cancel: () => clearTimeout(timer) };
  },
};

/**
 * 子が既に終わっているかを見る（task-0192 系・a6）。
 *
 * **書く前にここを見る。** 死んだ子の stdin へ書こうとすると `write EPIPE` になり、
 * `proc.stdin` に `error` の受け手が居なければプロセスごと落ちる（Node の決まり）。
 * 終わっていれば、書かずに「exit=N / signal=S で先に終わっている」と分かる理由を返す。
 */
function deadChildReason(proc: childProcess.ChildProcess, stderrTail: { value: string }): string | undefined {
  if (proc.exitCode === null && proc.signalCode === null) return undefined;
  const tail = stderrTail.value.trim().slice(-500);
  return (
    `子が exit=${proc.exitCode ?? "null"} / signal=${proc.signalCode ?? "null"} で先に終わっています` +
    (tail ? `（stderr 末尾: ${tail}）` : "")
  );
}

export interface ClaudeAgentDriverOptions {
  /** セッションJSONL の置き場（spawn 時に個別指定が無いとき）。 */
  sessionBaseDir?: string;
  /**
   * モデルの指定が無いときの既定。設定画面・環境変数から差し替える（決定41）。
   * 別名（`opus` / `sonnet` / `haiku`）でも具体名（`claude-opus-5`）でもよい。
   */
  defaultModel?: string;
  /** ホストの場所（試験で差し替えるための口）。 */
  hostPath?: string;
  /** ホストを起こす実行ファイル。既定は現在の node。 */
  nodePath?: string;
  /**
   * ホストの前に渡す node の引数。省略すると、ホストが `.ts` のときだけ tsx を読み込む
   * （このリポジトリの他の入口と同じ形）。
   */
  nodeArgs?: string[];
  /**
   * 職人が読む設定の出どころ（`user` / `project` / `local`）。既定は `project`
   * ——作業対象のリポジトリの作法（CLAUDE.md 等）には従わせる。職人自身の記憶ではないので
   * D11 に反しない：worktree の中にあり、外から読める。
   */
  settingSources?: ("user" | "project" | "local")[];
  /**
   * 起動待ちのタイムアウトを作る仕掛け（試験専用の差し替え口）。省略時は実時間の
   * `setTimeout`。番頭ホスト・Kobo からは指定しない——本物の待ちはこれまでどおり。
   */
  startTimeoutScheduler?: StartTimeoutScheduler;
}

interface ActiveSession {
  pid: number;
  sessionId: string;
  sessionPath: string;
  proc: childProcess.ChildProcess;
  stopReader: () => void;
  grip: HandleGrip;
  /** 死活判定の材料（a6）。起動から持ち越し、inject / kill でも同じ理由付けに使う。 */
  stderrTail: { value: string };
}

/** 起動を1回試みた結果。失敗した子プロセスはここで既に始末済み（孤児を残さない）。 */
type StartAttemptResult =
  | {
      ok: true;
      pid: number;
      sessionId: string;
      sessionPath: string;
      proc: childProcess.ChildProcess;
      grip: HandleGrip;
      stopReader: () => void;
      stderrTail: { value: string };
    }
  | { ok: false; error: string };

export class ClaudeAgentDriver implements RuntimeDriver {
  private readonly sessionBaseDir: string;
  private defaultModel: string;
  private readonly hostPath: string;
  private readonly nodePath: string;
  private readonly nodeArgsOverride: string[] | undefined;
  private readonly settingSources: ("user" | "project" | "local")[];
  private readonly startTimeoutScheduler: StartTimeoutScheduler;
  private readonly sessions = new Map<string, ActiveSession>();
  private readonly handlers = new Set<DriverEventHandler>();
  private readonly pending = new Map<
    string,
    { resolve: (msg: Record<string, unknown>) => void; timer: NodeJS.Timeout }
  >();
  private requestCounter = 0;

  constructor(opts: ClaudeAgentDriverOptions = {}) {
    this.sessionBaseDir = opts.sessionBaseDir ?? "";
    this.defaultModel = opts.defaultModel ?? CLAUDE_DEFAULT_MODEL;
    this.hostPath = opts.hostPath ?? new URL("./claude-agent/host.ts", import.meta.url).pathname;
    this.nodePath = opts.nodePath ?? process.execPath;
    this.nodeArgsOverride = opts.nodeArgs;
    this.settingSources = opts.settingSources ?? ["project"];
    this.startTimeoutScheduler = opts.startTimeoutScheduler ?? REAL_START_TIMEOUT_SCHEDULER;
  }

  /**
   * ホストの前に渡す node の引数。
   *
   * **tsx は絶対パスで渡す。** `--import tsx` と書くと、子プロセスの cwd（＝職人の worktree）を
   * 起点に解決されるので、このリポジトリの外で働く職人は起動時に落ちる——実機で踏んだ。
   * 職人が働く場所はプロジェクトごとに違うのだから、ここは呼び出し元の場所から解決する。
   */
  private resolveNodeArgs(): string[] {
    if (this.nodeArgsOverride) return this.nodeArgsOverride;
    if (!this.hostPath.endsWith(".ts")) return []; // ビルド済み（.js）なら要らない
    try {
      // ここの解決は**このファイルの場所**が起点（createRequire）。`import.meta.resolve` は
      // 読み込まれ方（ESM/CJS への変換）で欠けることがあり、実機でそれを踏んだ
      const loader = createRequire(import.meta.url).resolve("tsx");
      return ["--import", pathToFileURL(loader).href];
    } catch (err) {
      // I2: 見つからないまま「たぶん通る」で起こさない。理由を添えて止める
      throw new Error(
        `[claude-agent] tsx を解決できません（TypeScript のホストを起こせません）: ${String(err)}`
      );
    }
  }

  /**
   * いま職人に渡している既定（`runtime: claude-code` を名指しされ、モデルの指定も
   * 等級の割り当ても無いときに使う）。
   *
   * **等級ごとの割り当ては工房が持つ**（`WorkerPool` の `tierAssignments`）——
   * どのバックエンドのモデルも同じ1つの表に並べるため、ここには持たない。
   */
  currentDefaults(): { model: string } {
    return { model: this.defaultModel };
  }

  /** 既定のモデルを差し替える。**次に起こす職人から**効く。 */
  setDefaults(next: { model?: string }): void {
    if (next.model) this.defaultModel = next.model;
  }

  // ── RuntimeDriver.spawn ─────────────────────────────────────────────────

  async spawn(opts: SpawnOptions): Promise<SessionHandle> {
    const sessionPath = opts.sessionPath || this.defaultSessionPath(opts.taskId);
    fs.mkdirSync(path.dirname(sessionPath), { recursive: true });

    const driverOptions = opts.driverOptions ?? {};
    const explicitModel =
      typeof driverOptions["model"] === "string" ? (driverOptions["model"] as string) : undefined;
    // 名指し（工房が等級の割り当てを解いた結果もここに来る）> 等級の別名 > 既定
    const tier = opts.modelTier as ClaudeModelTier | undefined;
    const model = resolveClaudeModel(explicitModel, tier, this.defaultModel);
    const network = driverOptions["network"] === true;

    // 決定30d: 起こし直しは同じセッションの再開。Claude の session id は、前に書いた
    // セッションJSONL の先頭から読み戻す（番頭はファイルの場所しか渡してこない）
    const resumeFrom =
      typeof driverOptions["resumeSessionPath"] === "string"
        ? (driverOptions["resumeSessionPath"] as string)
        : undefined;
    const resume = resumeFrom ? this.readResumeSessionId(resumeFrom) : undefined;
    // a5: 切り分けの材料として記録するだけ。「大きすぎると再開できない」はまだ確かめていない
    // 仮説——ここでは条件に使わず、その場で安く取れる値（jsonl のバイト数）を残すだけ
    const resumeSessionBytes = resumeFrom ? this.safeFileSize(resumeFrom) : undefined;

    // 職人が報告・質問を返すための到達先（決定29e。pi 側と同じ環境変数）
    const extraEnv: Record<string, string> = {};
    if (typeof driverOptions["workerPoolUrl"] === "string") {
      extraEnv["BANTO_WORKER_POOL_URL"] = driverOptions["workerPoolUrl"] as string;
    }
    if (typeof driverOptions["projectTag"] === "string") {
      extraEnv["BANTO_PROJECT"] = driverOptions["projectTag"] as string;
    }
    if (typeof driverOptions["daemonUrl"] === "string") {
      extraEnv["BANTO_DAEMON_URL"] = driverOptions["daemonUrl"] as string;
    }
    if (opts.taskId) extraEnv["BANTO_TASK_ID"] = opts.taskId;
    /**
     * **自分の袋（cgroup）の名簿**（inc-0066 第2段）。ホストは働き始める前に、
     * ここへ自分の pid を書いて袋へ入る。
     *
     * 親（工房）が spawn の後に書く形では、書く前にホストが `claude` CLI を起こす競合が残る。
     * 自分で入れば以後の子孫は自動的に同じ袋の中で生まれる——**11GB を抱えたのはその子**
     * だったのだから、ここが取りこぼすと第2段の意味が無くなる。
     */
    if (typeof driverOptions["cgroupProcs"] === "string") {
      extraEnv["BANTO_WORKER_CGROUP_PROCS"] = driverOptions["cgroupProcs"] as string;
    }

    const MAX_START_ATTEMPTS = 2;

    const attempt1 = await this.startAttempt(opts, sessionPath, model, network, resume, extraEnv);
    if (attempt1.ok) return this.finishSpawn(attempt1);

    const hadResume = Boolean(resume);
    this.logStartAttempt({
      attempt: 1,
      maxAttempts: MAX_START_ATTEMPTS,
      resumed: hadResume,
      fellBackFromResume: false,
      resumeSessionBytes,
      outcome: "failed",
      detail: attempt1.error,
    });

    /**
     * a2/a4: 起こし直すのは**ここ1回だけ**。まだ職人に何の指示も渡していない段階
     * （get_state の名乗り待ちで止まっただけ）なので、起こし直しても仕事が二重に走らない。
     * `--resume` 付きの起動が失敗した場合は、退路として `--resume` を外す——袋小路
     * （再開が失敗し続けると rework が永久に通らない。dentaku task-0042 で実際に起きた）を
     * 避けるほうが、会話の続きを失うより安い。
     */
    const attempt2 = await this.startAttempt(opts, sessionPath, model, network, undefined, extraEnv);
    if (attempt2.ok) {
      this.logStartAttempt({
        attempt: 2,
        maxAttempts: MAX_START_ATTEMPTS,
        resumed: false,
        fellBackFromResume: hadResume,
        resumeSessionBytes,
        outcome: "succeeded",
      });
      return this.finishSpawn(attempt2);
    }

    this.logStartAttempt({
      attempt: 2,
      maxAttempts: MAX_START_ATTEMPTS,
      resumed: false,
      fellBackFromResume: hadResume,
      resumeSessionBytes,
      outcome: "failed",
      detail: attempt2.error,
    });

    // a3: 2回目も名乗りが返らなければ、これまでと同じ形（spawn_failed → 例外）で失敗を返す。
    // 無限に粘らない・握り潰さない。診断（a5）は文面にも添えて、journal を辿らなくても分かるようにする
    const finalError =
      `${attempt2.error}（試行 2/${MAX_START_ATTEMPTS}、` +
      `resume=${hadResume ? "退路で新規セッションへ切替" : "なし"}` +
      (resumeSessionBytes !== undefined ? `、再開元セッション ${resumeSessionBytes} bytes` : "") +
      `）`;
    this.emit({ type: "spawn_failed", error: finalError });
    throw new Error(finalError);
  }

  /**
   * 職人の起動を1回だけ試みる。名乗り（get_state の応答）が返らなければ
   * `{ ok: false }` を返す——**失敗した子プロセスはここで始末してから返す**（孤児を残さない）。
   * 呼び出し側（`spawn`）が「1回だけ起こし直す」を組み立てる。
   *
   * `pid` が取れない（`spawn` 自体の失敗、例: ワークツリーが無い）場合はここで投げる。
   * 同じ引数で起こし直しても結果は変わらないので、この失敗は retry の対象にしない
   * （呼び出し側で catch しないので、そのまま外へ抜ける）。
   */
  private async startAttempt(
    opts: SpawnOptions,
    sessionPath: string,
    model: string,
    network: boolean,
    resumeId: string | undefined,
    extraEnv: Record<string, string>
  ): Promise<StartAttemptResult> {
    // I2: 読めない環境変数は、子を起こす**前**に落とす。起こしたあとで投げると、この
    // 関数の外（`grip.hold` の外）へ例外が抜けて後始末（SIGKILL）を通らず孤児になる
    const ms = startTimeoutMs();

    const args = [
      ...this.resolveNodeArgs(),
      this.hostPath,
      "--session-file",
      sessionPath,
      "--model",
      model,
      "--setting-sources",
      this.settingSources.join(","),
    ];
    if (opts.systemPrompt.trim().length > 0) {
      args.push("--append-system-prompt", opts.systemPrompt);
    }
    // imp-0004: 空配列は「ランタイムの既定のまま」。絞るときだけ渡す
    if (opts.tools.length > 0) {
      args.push("--tools", this.resolveTools(opts.tools, network).join(","));
    }
    if (network) args.push("--network");
    if (resumeId) args.push("--resume", resumeId);

    const proc = childProcess.spawn(this.nodePath, args, {
      cwd: opts.worktreePath,
      // imp-0043: 工房の実行環境（NODE_ENV=production）を職人へ押し付けない
      env: workerSpawnEnv(process.env, extraEnv),
      stdio: ["pipe", "pipe", "pipe"],
    });

    /**
     * **起こせなかったことで工房ごと落とさない**（PO報告 2026-08-11）。
     *
     * `spawn` が失敗すると `error` イベントが**非同期に**飛ぶ。受け手が1人も居ない
     * `error` は Node の決まりで**プロセスごと落ちる**——実際、ワークツリーが無い
     * （＝`cwd` が無い）rework で `spawn ENOENT` が飛び、**工房のサービスが死んだ**。
     * 死ねば動いていた他の職人も道連れになる（systemd が起こし直すまで全部止まる）。
     *
     * だから**一番先に**受け手を立てる。下の `pid === undefined` で投げる経路より前で
     * なければ意味が無い——投げてから飛んできた `error` は誰も受けていない。
     */
    let spawnError: Error | undefined;
    proc.on("error", (err: Error) => {
      spawnError = err;
      // 起動待ちの `once("error")` が居れば、そちらが理由を組み立てて返す。
      // 居ない（もう投げたあと）なら、ここで受け止めたこと自体が仕事
      process.stderr.write(`[claude-agent] 職人のプロセスで異常: ${err.message}\n`);
    });

    // 職人が残っていても親（ホスト・テスト）が抜けられるように放しておく。
    // 待つあいだだけ掴み直す（inc-0020）
    proc.unref();
    for (const stream of [proc.stdout, proc.stderr, proc.stdin]) {
      (stream as unknown as net.Socket | null)?.unref?.();
    }
    const grip = createHandleGrip(proc);

    const pid = proc.pid;
    if (pid === undefined) {
      // I2: なぜ起こせなかったかを添える。「pid が取れません」だけでは手が打てない
      //     ——実際の原因は「ワークツリー（cwd）が無い」だった
      const why = await waitForSpawnError(() => spawnError);
      const errMsg =
        "[claude-agent] 職人のプロセスを起こせませんでした" +
        (why ? `: ${why.message}` : "（pid が取れません）") +
        `（作業場所: ${opts.worktreePath}）`;
      this.emit({ type: "spawn_failed", error: errMsg });
      throw new Error(errMsg);
    }

    // 子の標準エラーは親へ流す（認証切れ・設定不足はここに出る）。末尾は死活理由の材料として残す（a6）
    const stderrTail = { value: "" };
    proc.stderr?.on("data", (chunk: Buffer) => {
      process.stderr.write(chunk);
      stderrTail.value = (stderrTail.value + chunk.toString("utf-8")).slice(-4000);
    });

    /**
     * task-0192 系（a6）: 死んだ子への write は `write EPIPE` として `proc.stdin` から
     * 非同期に飛ぶことがある。受け手が居なければプロセスごと落ちる——書く側は書く前に
     * 生死を見るが（下記）、それでも間に合わない分の受け皿としてここに置く。揉み消すのでは
     * なく記録する（I2）。本体の失敗は書き込み側の catch/callback が扱う。
     */
    proc.stdin?.on("error", (err: Error) => {
      process.stderr.write(
        `[claude-agent] stdin error（記録のみ・書き込み側が本体の失敗を扱う）: ${err.message}\n`
      );
    });

    const start = await grip.hold(
      () =>
        new Promise<
          | { ok: true; sessionId: string; sessionPath: string; stopReader: () => void }
          | { ok: false; error: string }
        >((resolve) => {
          let settled = false;
          let timeoutHandle: { cancel: () => void } | undefined;
          const settle = (
            value:
              | { ok: true; sessionId: string; sessionPath: string; stopReader: () => void }
              | { ok: false; error: string }
          ): void => {
            if (settled) return;
            settled = true;
            proc.off("exit", onEarlyExit);
            proc.off("error", onSpawnError);
            timeoutHandle?.cancel();
            resolve(value);
          };
          const onEarlyExit = (code: number | null, signal: NodeJS.Signals | null): void => {
            settle({
              ok: false,
              error:
                `[claude-agent] ホストが即座に終了しました（code=${code}, signal=${signal}）。` +
                "Claude Code の認証（claude login）と @anthropic-ai/claude-agent-sdk の導入を確認してください。",
            });
          };
          const onSpawnError = (err: Error): void => {
            settle({ ok: false, error: `[claude-agent] 起動に失敗しました: ${err.message}` });
          };
          proc.once("exit", onEarlyExit);
          proc.once("error", onSpawnError);

          const stopReader = attachJsonlReader(proc.stdout!, (line) => {
            let msg: Record<string, unknown>;
            try {
              msg = JSON.parse(line) as Record<string, unknown>;
            } catch {
              return; // JSON でない行（起動時の雑音）は捨てる
            }
            if (msg["type"] === "response" && typeof msg["id"] === "string") {
              this.settlePending(msg["id"], msg);
            }
            if (
              msg["type"] === "response" &&
              msg["command"] === "get_state" &&
              msg["success"] === true
            ) {
              const data = msg["data"] as Record<string, unknown> | undefined;
              settle({
                ok: true,
                sessionId: typeof data?.["sessionId"] === "string" ? data["sessionId"] : `${opts.taskId}-${Date.now()}`,
                sessionPath:
                  typeof data?.["sessionFile"] === "string" ? data["sessionFile"] : sessionPath,
                stopReader,
              });
            }
          });

          // a6: 書く前に生死を見る。子が既に終わっていれば EPIPE を起こさせず、理由を添えて断る
          const dead = deadChildReason(proc, stderrTail);
          if (dead) {
            settle({ ok: false, error: `[claude-agent] ${dead}` });
          } else {
            proc.stdin?.write(JSON.stringify({ type: "get_state" }) + "\n", (err) => {
              if (err) settle({ ok: false, error: `[claude-agent] 標準入力へ書けません: ${err.message}` });
            });
          }

          // I2: 名乗りが返らないまま「起きたつもり」で進まない。掴んだ handle も外す
          // task-0291: 実時間の setTimeout ではなく注入された scheduler 経由——既定は
          // 変わらないが、試験は壁時計を待たずに「時間切れ」を作れる
          timeoutHandle = this.startTimeoutScheduler.schedule(ms, () => {
            settle({
              ok: false,
              error: `[claude-agent] ホストが ${ms}ms 以内に応答しませんでした。`,
            });
          });
        })
    );

    if (!start.ok) {
      try {
        proc.kill("SIGKILL");
      } catch {
        // 既に終わっている
      }
      return { ok: false, error: start.error };
    }

    return {
      ok: true,
      pid,
      sessionId: start.sessionId,
      sessionPath: start.sessionPath,
      proc,
      grip,
      stopReader: start.stopReader,
      stderrTail,
    };
  }

  /** 起動に成功した1回分から、稼働中セッションを組み立てて登録する。 */
  private finishSpawn(attempt: Extract<StartAttemptResult, { ok: true }>): SessionHandle {
    const { pid, sessionId, sessionPath, proc, grip, stopReader, stderrTail } = attempt;
    const session: ActiveSession = { pid, sessionId, sessionPath, proc, stopReader, grip, stderrTail };
    this.sessions.set(sessionId, session);

    proc.once("exit", (code, signal) => {
      grip.release();
      this.emit({
        type: "process_exited",
        pid,
        sessionId,
        exitCode: code,
        signal,
      });
      this.sessions.delete(sessionId);
      stopReader();
      proc.removeAllListeners();
    });

    this.emit({
      type: "process_started",
      pid,
      sessionId,
      sessionPath,
    });

    return { pid, sessionId, sessionPath };
  }

  /**
   * 起動の試行・失敗・退路を、次の切り分けに使える形で残す（a5）。
   *
   * `DriverEvent`（`spawn_failed` 等、`@banto/core`）は `error: string` しか運べない契約
   * ——ここは番頭ホストの見た目には出ない、工房の journal（stderr）向けの記録。**大きさは
   * 記録するだけで、条件（分岐）には使わない**——「大きすぎると再開できない」はまだ
   * 確かめていない仮説であり、それを判断に混ぜると仮説が検証もされず既成事実化する。
   */
  private logStartAttempt(info: {
    attempt: number;
    maxAttempts: number;
    resumed: boolean;
    fellBackFromResume: boolean;
    resumeSessionBytes: number | undefined;
    outcome: "failed" | "succeeded";
    detail?: string;
  }): void {
    process.stderr.write(
      "[claude-agent] 起動診断 " +
        JSON.stringify({
          attempt: info.attempt,
          maxAttempts: info.maxAttempts,
          resumed: info.resumed,
          fellBackFromResume: info.fellBackFromResume,
          resumeSessionBytes: info.resumeSessionBytes ?? null,
          outcome: info.outcome,
          ...(info.detail ? { detail: info.detail } : {}),
        }) +
        "\n"
    );
  }

  // ── RuntimeDriver.inject ────────────────────────────────────────────────

  async inject(sessionId: string, message: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`[claude-agent] inject: session '${sessionId}' が居ません（既に終わっている？）。`);
    }
    // a6: 書く前に生死を見る。EPIPE ではなく理由が分かる失敗にする
    const dead = deadChildReason(session.proc, session.stderrTail);
    if (dead) {
      throw new Error(`[claude-agent] inject: ${dead}`);
    }
    const id = `inject-${++this.requestCounter}`;
    const command = JSON.stringify({ id, type: "prompt", message }) + "\n";
    const response = this.awaitResponse(id);
    const result = await session.grip.hold(async () => {
      await new Promise<void>((resolve, reject) => {
        session.proc.stdin?.write(command, (err) => {
          if (err) reject(new Error(`[claude-agent] inject write error: ${err.message}`));
          else resolve();
        });
      });
      return response;
    });
    // I2: 受け付けられなかったことを成功に見せない。黙らせると指示が消える
    if (result["success"] !== true) {
      throw new Error(`[claude-agent] inject rejected: ${String(result["error"] ?? "unknown error")}`);
    }
  }

  // ── RuntimeDriver.subscribe / kill ──────────────────────────────────────

  subscribe(handler: DriverEventHandler): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  async kill(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return; // 冪等：既に終わっている・知らない職人
    this.sessions.delete(sessionId);
    const proc = session.proc;
    session.stopReader();

    // a6: 死んでいれば abort を書こうとしない（EPIPE を起こさせない）
    const alreadyDead = Boolean(deadChildReason(proc, session.stderrTail));
    if (!alreadyDead) {
      try {
        proc.stdin?.write(JSON.stringify({ type: "abort" }) + "\n");
      } catch {
        // 終了経路の書き込み失敗は無視する
      }
    }
    try {
      proc.stdin?.destroy();
      proc.stderr?.destroy();
    } catch {
      // 同上
    }

    if (alreadyDead) {
      try {
        proc.stdout?.destroy();
      } catch {
        /* ignore */
      }
      return;
    }

    proc.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        proc.kill("SIGKILL");
        resolve();
      }, 2000);
      timeout.unref?.();
      proc.on("exit", () => {
        clearTimeout(timeout);
        resolve();
      });
    });

    try {
      proc.stdout?.destroy();
    } catch {
      /* ignore */
    }
    proc.removeAllListeners();
    proc.stdout?.removeAllListeners();
    proc.stderr?.removeAllListeners();
    proc.stdin?.removeAllListeners();
  }

  /** 稼働中のセッションID（試験の後片付け用）。 */
  listActiveSessions(): string[] {
    return [...this.sessions.keys()];
  }

  // ── 内側 ────────────────────────────────────────────────────────────────

  /**
   * 渡す道具を Claude Code の名前に写し、消えては困るものを足す（imp-0004・imp-0005）。
   *
   * 番頭が `["read","grep"]` のつもりで絞ったときに報告経路まで消えると、職人は報告も
   * 質問もできないのに誰も気づけない。pi 側の `resolveTools` と同じ約束をここでも守る。
   */
  private resolveTools(requested: readonly string[], network: boolean): string[] {
    const mapped = toClaudeToolNames(requested);
    for (const keep of [
      ...CLAUDE_REPORT_TOOL_NAMES,
      // 工場の口も消さない（PO報告 2026-08-11）。載っていない構成では呼ばれないだけ
      ...CLAUDE_KOBO_TOOL_NAMES,
      ...(network ? CLAUDE_WEB_TOOL_NAMES : []),
    ]) {
      if (!mapped.includes(keep)) mapped.push(keep);
    }
    return mapped;
  }

  /**
   * 前のセッションファイルから Claude の session id を読む。
   *
   * I2: 読めないまま「新しい会話」で起こし直さない。前提を引き継げていないことが
   *     番頭からは見えないため——読めなければ理由を添えて投げる。
   */
  private readResumeSessionId(sessionPath: string): string {
    let lines: string[];
    try {
      lines = fs.readFileSync(sessionPath, "utf-8").split("\n");
    } catch (err) {
      throw new Error(
        `[claude-agent] 起こし直しの元セッションを読めません（${sessionPath}）: ${String(err)}`
      );
    }
    const sessionId = readSessionIdFromLines(lines);
    if (!sessionId) {
      throw new Error(
        `[claude-agent] 元セッションに Claude の session id がありません（${sessionPath}）。` +
          "別のランタイムで起こした職人の可能性があります。"
      );
    }
    return sessionId;
  }

  /** 再開しようとしたセッションの大きさ（bytes）。切り分けの材料として持つだけの best-effort。 */
  private safeFileSize(filePath: string): number | undefined {
    try {
      return fs.statSync(filePath).size;
    } catch {
      return undefined;
    }
  }

  private awaitResponse(id: string, timeoutMs = injectTimeoutMs()): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`[claude-agent] '${id}' の応答が ${timeoutMs}ms 以内に返りませんでした。`));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, timer });
    });
  }

  private settlePending(id: string, msg: Record<string, unknown>): void {
    const waiter = this.pending.get(id);
    if (!waiter) return;
    clearTimeout(waiter.timer);
    this.pending.delete(id);
    waiter.resolve(msg);
  }

  private emit(event: DriverEvent): void {
    for (const handler of this.handlers) {
      try {
        handler(event);
      } catch {
        // I2 の例外: 購読者の失敗でドライバを落とさない
      }
    }
  }

  private defaultSessionPath(taskId: string): string {
    const base = this.sessionBaseDir || path.join(process.cwd(), "data", "sessions");
    return path.join(base, `${taskId}.jsonl`);
  }
}

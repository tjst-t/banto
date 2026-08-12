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

/** inject の応答を待つ上限。届いたか分からないまま進まないため（I2）。 */
const INJECT_TIMEOUT_MS = 10_000;

/** 起動直後の状態問い合わせに答えが返るまでの待ち。 */
const START_TIMEOUT_MS = 10_000;

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
}

interface ActiveSession {
  pid: number;
  sessionId: string;
  sessionPath: string;
  proc: childProcess.ChildProcess;
  stopReader: () => void;
  grip: HandleGrip;
}

export class ClaudeAgentDriver implements RuntimeDriver {
  private readonly sessionBaseDir: string;
  private defaultModel: string;
  private readonly hostPath: string;
  private readonly nodePath: string;
  private readonly nodeArgsOverride: string[] | undefined;
  private readonly settingSources: ("user" | "project" | "local")[];
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
    if (resume) args.push("--resume", resume);

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

    const proc = childProcess.spawn(this.nodePath, args, {
      cwd: opts.worktreePath,
      env: { ...process.env, ...extraEnv },
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

    // 子の標準エラーは親へ流す（認証切れ・設定不足はここに出る）
    proc.stderr?.on("data", (chunk: Buffer) => process.stderr.write(chunk));

    const start = await grip.hold(
      () =>
        new Promise<
          | { ok: true; sessionId: string; sessionPath: string; stopReader: () => void }
          | { ok: false; error: string }
        >((resolve) => {
          let settled = false;
          const settle = (
            value:
              | { ok: true; sessionId: string; sessionPath: string; stopReader: () => void }
              | { ok: false; error: string }
          ): void => {
            if (settled) return;
            settled = true;
            proc.off("exit", onEarlyExit);
            proc.off("error", onSpawnError);
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

          proc.stdin?.write(JSON.stringify({ type: "get_state" }) + "\n", (err) => {
            if (err) settle({ ok: false, error: `[claude-agent] 標準入力へ書けません: ${err.message}` });
          });

          // I2: 名乗りが返らないまま「起きたつもり」で進まない。掴んだ handle も外す
          const timer = setTimeout(() => {
            settle({
              ok: false,
              error: `[claude-agent] ホストが ${START_TIMEOUT_MS}ms 以内に応答しませんでした。`,
            });
          }, START_TIMEOUT_MS);
          timer.unref?.();
        })
    );

    if (!start.ok) {
      try {
        proc.kill("SIGKILL");
      } catch {
        // 既に終わっている
      }
      this.emit({ type: "spawn_failed", error: start.error });
      throw new Error(start.error);
    }

    const session: ActiveSession = {
      pid,
      sessionId: start.sessionId,
      sessionPath: start.sessionPath,
      proc,
      stopReader: start.stopReader,
      grip,
    };
    this.sessions.set(start.sessionId, session);

    proc.once("exit", (code, signal) => {
      grip.release();
      this.emit({
        type: "process_exited",
        pid,
        sessionId: start.sessionId,
        exitCode: code,
        signal,
      });
      this.sessions.delete(start.sessionId);
      start.stopReader();
      proc.removeAllListeners();
    });

    this.emit({
      type: "process_started",
      pid,
      sessionId: start.sessionId,
      sessionPath: start.sessionPath,
    });

    return { pid, sessionId: start.sessionId, sessionPath: start.sessionPath };
  }

  // ── RuntimeDriver.inject ────────────────────────────────────────────────

  async inject(sessionId: string, message: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`[claude-agent] inject: session '${sessionId}' が居ません（既に終わっている？）。`);
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

    try {
      proc.stdin?.write(JSON.stringify({ type: "abort" }) + "\n");
    } catch {
      // 終了経路の書き込み失敗は無視する
    }
    try {
      proc.stdin?.destroy();
      proc.stderr?.destroy();
    } catch {
      // 同上
    }

    if (proc.exitCode !== null || proc.signalCode !== null) {
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

  private awaitResponse(id: string, timeoutMs = INJECT_TIMEOUT_MS): Promise<Record<string, unknown>> {
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

/**
 * PiRpcDriver — RuntimeDriver implementation using `pi --mode rpc`.
 *
 * Spawns `pi` as a child process in RPC mode (headless, stdin/stdout JSONL).
 * One pi process = one session.
 *
 * Protocol (rpc.md):
 *   Commands: JSON lines written to child stdin.
 *   Responses: JSON lines (type: "response") from child stdout.
 *   Events:    JSON lines (type != "response") from child stdout.
 *
 * I2: spawn failures (binary missing, immediate exit) are surfaced as rejections
 *     or spawn_failed events — never swallowed.
 * D3: session state is tracked by the daemon via events; the driver only manages
 *     the process lifecycle.
 * D5: no judgment logic here — pure process management + protocol translation.
 * D6: uses only child_process (stdlib) and @earendil-works/pi-coding-agent binary.
 *     (pi-coding-agent is the VISION tech_constraints-mandated runtime.)
 */

import * as childProcess from "node:child_process";
import * as net from "node:net";
import * as fs from "node:fs";
import * as path from "node:path";
import type { RuntimeDriver, SpawnOptions, SessionHandle, DriverEvent, DriverEventHandler } from "@banto/core";
import type { LlmCatalog, ModelConstraints, ModelTier } from "@banto/core";
import { attachJsonlReader, createHandleGrip, waitForSpawnError, type HandleGrip } from "./child-session.js";
import { workerSpawnEnv } from "./worker-env.js";

// 職人と JSONL で話す枠組みは Claude Code のドライバと共通（child-session.ts）。
// 公開の口を変えないよう、ここから再輸出しておく
export { createHandleGrip, type HandleGrip } from "./child-session.js";

/**
 * spawn 時の driverOptions から制約（vision / local / free）を読む。
 * 番頭が職人へ振るときに「画像を読む」「外に出さない」を付けられるようにするための口。
 */
function readConstraints(driverOptions: Record<string, unknown> | undefined): ModelConstraints {
  const raw = driverOptions?.["constraints"];
  if (!raw || typeof raw !== "object") return {};
  const src = raw as Record<string, unknown>;
  const out: ModelConstraints = {};
  if (src["vision"] === true) out.vision = true;
  if (src["local"] === true) out.local = true;
  if (src["free"] === true) out.free = true;
  return out;
}

// ── Session record ──────────────────────────────────────────────────────────

interface ActiveSession {
  pid: number;
  sessionId: string;
  sessionPath: string;
  proc: childProcess.ChildProcess;
  stopReader: () => void;
  /** 応答を待つあいだだけ handle を掴む（inc-0020）。 */
  grip: HandleGrip;
}

// ── PiRpcDriver ─────────────────────────────────────────────────────────────

/** Options for constructing a PiRpcDriver. */
export interface PiRpcDriverOptions {
  /**
   * Path to the pi CLI entry-point (dist/cli.js).
   * Defaults to the binary bundled with @earendil-works/pi-coding-agent.
   */
  piCliPath?: string;
  /**
   * Root directory for session JSONL files when sessionPath is not provided
   * per-spawn. Defaults to <dataDir>/sessions.
   * Per spec §2.1 sessions are stored outside the event log.
   */
  sessionBaseDir?: string;
  /**
   * Default LLM provider passed to pi via --provider.
   * Can be overridden per-spawn via SpawnOptions.driverOptions.provider.
   * Default: "opencode"
   */
  defaultProvider?: string;
  /**
   * Default LLM model passed to pi via --model.
   * Can be overridden per-spawn via SpawnOptions.driverOptions.model.
   * Default: "deepseek-v4-flash-free"
   */
  defaultModel?: string;
  /**
    * Absolute path to the banto-executor.ts extension file.
    * When set, passed as --extension <path> on every spawn so that
    * report_phase/report_done tools are available in the pi session.
    * Can be overridden per-spawn via SpawnOptions.driverOptions.extensionPath.
    */
  extensionPath?: string;
  /**
   * LLM Catalog for tier-based model resolution (ADR-0004).
   * When set, modelTier in SpawnOptions is resolved through the catalog.
   * Falls back to defaultProvider/defaultModel if catalog is not set.
   */
  catalog?: LlmCatalog;
}

/** inject の応答を待つ上限。届いたかどうか分からないまま進まないため（I2）。 */
const INJECT_TIMEOUT_MS = 10_000;

export class PiRpcDriver implements RuntimeDriver {
  /**
   * Resolved pi CLI path. Null means "not yet resolved".
   * Resolution is deferred to first spawn() call so that constructing
   * PiRpcDriver does not throw when pi is absent (e.g. test environments
   * that register a CaptureDriver before any spawn). I2: the error surfaces
   * at spawn() time, not at construction time, so the daemon starts cleanly
   * and tests using a different driver never encounter it.
   */
  private piCliPath: string | null;
  private readonly piCliPathOverride: string | undefined;
  private readonly sessionBaseDir: string;
  private defaultProvider: string;
  private defaultModel: string;
  private readonly extensionPath: string | undefined;
  private readonly catalog: LlmCatalog | undefined;
  private readonly sessions = new Map<string, ActiveSession>();
  private readonly handlers: Set<DriverEventHandler> = new Set();
  /**
   * 送ったコマンドの応答待ち（id で対応づける）。
   *
   * これが無いと「書けた＝届いた」と思い込むことになる。実際、職人がターン中に指示を送ると
   * pi 側は受け付けずエラー応答を返すのに、こちらは成功として扱い**指示が黙って消えていた**。
   */
  private readonly pending = new Map<
    string,
    { resolve: (msg: Record<string, unknown>) => void; reject: (err: Error) => void; timer: NodeJS.Timeout }
  >();
  private requestCounter = 0;

  constructor(opts: PiRpcDriverOptions = {}) {
    // Defer pi CLI resolution to spawn() time (lazy). This allows the daemon
    // to construct without throwing in environments where pi is not installed
    // (e.g. test environments that override the driver before any spawn).
    // I2: the error surfaces at spawn() — never swallowed.
    this.piCliPathOverride = opts.piCliPath;
    this.piCliPath = null; // resolved lazily on first spawn

    this.sessionBaseDir = opts.sessionBaseDir ?? "";
    this.defaultProvider = opts.defaultProvider ?? "opencode";
    this.defaultModel = opts.defaultModel ?? "deepseek-v4-flash-free";
    this.extensionPath = opts.extensionPath;
    this.catalog = opts.catalog;
  }

  /** いま職人に渡している既定のモデル（設定画面に見せる）。 */
  currentDefaults(): { provider: string; model: string } {
    return { provider: this.defaultProvider, model: this.defaultModel };
  }

  /**
   * 職人の既定のモデルを差し替える（決定41：設定画面から）。
   *
   * **その場で効く**——次に起こす職人から。動いている職人はそのまま
   * （途中でモデルが変わる方が分かりにくい）。
   */
  setDefaults(next: { provider?: string; model?: string }): void {
    if (next.provider) this.defaultProvider = next.provider;
    if (next.model) this.defaultModel = next.model;
  }

  /**
   * Resolve the pi CLI path on first use.
   * I2: throws if not found — callers must handle the error.
   */
  private resolvePiCli(): string {
    if (this.piCliPath !== null) return this.piCliPath;

    if (this.piCliPathOverride) {
      this.piCliPath = this.piCliPathOverride;
      return this.piCliPath;
    }

    // Try to resolve from the package's own node_modules first, then parent.
    // fileURLToPath(import.meta.url) gives the current file path.
    const candidates = [
      // Installed as a dependency of banto-daemon
      new URL(
        "../../../node_modules/@earendil-works/pi-coding-agent/dist/cli.js",
        import.meta.url
      ).pathname,
      // Monorepo root node_modules (npm workspaces hoist)
      new URL(
        "../../../../node_modules/@earendil-works/pi-coding-agent/dist/cli.js",
        import.meta.url
      ).pathname,
    ];
    const found = candidates.find((p) => {
      try {
        fs.accessSync(p);
        return true;
      } catch {
        return false;
      }
    });
    if (!found) {
      throw new Error(
        "pi CLI not found. Install @earendil-works/pi-coding-agent or set piCliPath."
      );
    }
    this.piCliPath = found;
    return this.piCliPath;
  }

  // ── RuntimeDriver.spawn ─────────────────────────────────────────────────

  async spawn(opts: SpawnOptions): Promise<SessionHandle> {
    const worktreePath = opts.worktreePath;
    const sessionPath = opts.sessionPath || this._defaultSessionPath(opts.taskId);

    // Ensure session directory exists.
    const sessionDir = path.dirname(sessionPath);
    fs.mkdirSync(sessionDir, { recursive: true });

    // Resolve provider and model:
    // 1. per-spawn driverOptions override
    // 2. catalog resolution from (tier, constraints) — ADR-0004
    // 3. constructor defaults
    //
    // Constraints are never relaxed: if the caller asked for a local-only model and
    // none satisfies it, we must not silently fall back to one that leaves the host.
    const providerOverride =
      opts.driverOptions?.provider && typeof opts.driverOptions.provider === "string"
        ? opts.driverOptions.provider
        : null;
    const modelOverride =
      opts.driverOptions?.model && typeof opts.driverOptions.model === "string"
        ? opts.driverOptions.model
        : null;

    let provider: string;
    let model: string;

    if (providerOverride && modelOverride) {
      provider = providerOverride;
      model = modelOverride;
    } else if (this.catalog && !providerOverride && !modelOverride) {
      const constraints = readConstraints(opts.driverOptions);
      const resolved = this.catalog.resolveForWorker(opts.modelTier as ModelTier | undefined, constraints);
      if (resolved) {
        provider = resolved.model.provider;
        model = resolved.model.id;
      } else if (Object.keys(constraints).length > 0) {
        // I2: 制約を満たせないまま黙って別のモデルで動かさない
        const named = Object.entries(constraints)
          .filter(([, v]) => v)
          .map(([k]) => k)
          .join(", ");
        const errMsg = `条件を満たすモデルがありません（tier: ${opts.modelTier ?? "既定"}, 制約: ${named}）`;
        this.emit({ type: "spawn_failed", error: errMsg });
        throw new Error(errMsg);
      } else {
        provider = this.defaultProvider;
        model = this.defaultModel;
      }
    } else {
      provider = providerOverride ?? this.defaultProvider;
      model = modelOverride ?? this.defaultModel;
    }

    // Resolve extension path: per-spawn override → constructor default.
    const extensionPath =
      (opts.driverOptions?.extensionPath && typeof opts.driverOptions.extensionPath === "string"
        ? opts.driverOptions.extensionPath
        : null) ?? this.extensionPath;

    // Resolve pi CLI path lazily (deferred from constructor for test-environment safety).
    // I2: throws if not found — error propagates to daemon.spawnTask() → recordTaskFailed.
    // Emit spawn_failed before throwing so subscribers (runtime-driver-contract tests) see it.
    let piCli: string;
    try {
      piCli = this.resolvePiCli();
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      this.emit({ type: "spawn_failed", error: errMsg });
      throw err;
    }

    // Build pi CLI arguments.
    // pi --mode rpc --session-dir <dir> --provider <p> --model <m> [--extension <ext>]
    // We use --session-dir so pi stores the JSONL in a location we know.
    const args = [
      piCli,
      "--mode",
      "rpc",
      "--session-dir",
      sessionDir,
      "--provider",
      provider,
      "--model",
      model,
    ];

    // imp-0004: 立場を伝えるシステムプロンプト。**追記**であって差し替えではない。
    // pi の既定プロンプトには使えるツールの一覧と作法が入っており、`--system-prompt` で
    // 丸ごと置き換えるとそれが消える——職人に足したいのは立場であって、道具の説明を
    // 奪うことではない。
    if (opts.systemPrompt.trim().length > 0) {
      args.push("--append-system-prompt", opts.systemPrompt);
    }

    // imp-0004: 使わせる Tool の限定。空配列は「ランタイムの既定のまま」の意味で、
    // `--tools` を渡さない——空の許可リストを渡すと道具が1つも無い職人になる。
    //
    // pi の `--tools` は組み込みだけでなく**拡張の Tool にも効く**（実プロセスで確認済み）。
    // 絞るときに報告経路の Tool を書き落とすと職人は黙って報告できなくなるので、
    // 何を残すかは呼び出し側（WorkerPool）が組み立てる。
    if (opts.tools.length > 0) {
      args.push("--tools", opts.tools.join(","));
    }

    // 決定30d: 起こし直しは同じセッションの再開。元の会話が復元される
    if (
      opts.driverOptions?.resumeSessionPath &&
      typeof opts.driverOptions.resumeSessionPath === "string"
    ) {
      args.push("--session", opts.driverOptions.resumeSessionPath);
    }

    if (extensionPath) {
      args.push("--extension", extensionPath);
    }

    // 決定29e: 職人には起動元の拡張（Kobo の banto-executor 等）と Worker Pool の報告経路の
    // 両方が要ることがある。pi は --extension を複数回受け付けるので、追加分をここで足す。
    const extraExtensions = Array.isArray(opts.driverOptions?.extensionPaths)
      ? (opts.driverOptions.extensionPaths as unknown[]).filter(
          (p): p is string => typeof p === "string" && p !== extensionPath
        )
      : [];
    for (const extra of extraExtensions) {
      args.push("--extension", extra);
    }

    // Collect per-spawn environment variables from driverOptions.
    // BANTO_DAEMON_URL, BANTO_PROJECT, BANTO_TASK_ID are injected here so the
    // banto-executor extension can reach the daemon and report state transitions.
    const extraEnv: Record<string, string> = {};
    if (opts.driverOptions?.daemonUrl && typeof opts.driverOptions.daemonUrl === "string") {
      extraEnv["BANTO_DAEMON_URL"] = opts.driverOptions.daemonUrl;
    }
    if (opts.driverOptions?.projectTag && typeof opts.driverOptions.projectTag === "string") {
      extraEnv["BANTO_PROJECT"] = opts.driverOptions.projectTag;
    }
    if (opts.taskId) {
      extraEnv["BANTO_TASK_ID"] = opts.taskId;
    }
    // 決定29: 職人が起動元へ報告・質問するための到達先（worker-report 拡張が読む）
    if (opts.driverOptions?.workerPoolUrl && typeof opts.driverOptions.workerPoolUrl === "string") {
      extraEnv["BANTO_WORKER_POOL_URL"] = opts.driverOptions.workerPoolUrl;
    }

    // Spawn pi as a child process (node CLI entry-point).
    const proc = childProcess.spawn("node", args, {
      cwd: worktreePath,
      // imp-0043: 工房の実行環境（NODE_ENV=production）を職人へ押し付けない
      env: workerSpawnEnv(process.env, extraEnv),
      stdio: ["pipe", "pipe", "pipe"],
    });

    /**
     * **起こせなかったことで工房ごと落とさない**（PO報告 2026-08-11）。
     *
     * `spawn` の失敗理由は**非同期に** `error` イベントで飛ぶ。受け手が1人も居ない
     * `error` は Node の決まりでプロセスごと落とす——ワークツリー（`cwd`）が無いだけで
     * 工房のサービスが死に、動いていた他の職人も道連れになった（claude-agent 側で実測）。
     * **投げるより先に**受け手を立てる。
     */
    let spawnError: Error | undefined;
    proc.on("error", (err: Error) => {
      spawnError = err;
      process.stderr.write(`[pi-rpc] 職人のプロセスで異常: ${err.message}\n`);
    });

    // Unreference the child process and its stdio sockets so they do NOT
    // prevent the parent Node.js event loop from exiting when tests/daemon
    // are shutting down. The daemon tracks the process via the sessions map
    // and calls kill() explicitly for managed shutdown.
    // The stdio pipes are net.Socket at runtime even though TypeScript types
    // them as Readable/Writable (D6: cast documented here).
    proc.unref();
    if (proc.stdout) (proc.stdout as unknown as net.Socket).unref();
    if (proc.stderr) (proc.stderr as unknown as net.Socket).unref();
    if (proc.stdin) (proc.stdin as unknown as net.Socket).unref();

    // 応答を待つあいだだけ掴み直す（inc-0020）。unref したものを待つと、他に
    // ref された handle が無いとき await の途中で親プロセスが黙って畳まれる
    const grip = createHandleGrip(proc);

    const pid = proc.pid;
    if (pid === undefined) {
      // I2: なぜ起こせなかったかを添える（作業場所が無い、が実際の原因だった）
      const why = await waitForSpawnError(() => spawnError);
      throw new Error(
        `[pi-rpc] Failed to spawn pi process${why ? `: ${why.message}` : " (pid undefined)"}` +
          `（作業場所: ${worktreePath}）`
      );
    }

    // Forward stderr to daemon's stderr for diagnostics.
    proc.stderr?.on("data", (chunk: Buffer) => {
      process.stderr.write(chunk);
    });

    // Session ID: we'll read it from pi's get_state response once started.
    // In the interim, use a stable local ID derived from taskId.
    let sessionId = `${opts.taskId}-${Date.now()}`;
    let resolvedSessionPath = sessionPath;

    // We need to wait briefly for the process to start before reading state.
    // If the process exits immediately (no API key etc.), we handle it below.
    const startResult = await grip.hold(() => new Promise<
      | { ok: true; sessionId: string; sessionPath: string; stopReader: () => void }
      | { ok: false; error: string }
    >((resolve) => {
      let settled = false;
      let stopReader: (() => void) | null = null;
      let stateQueried = false;

      // Cleanup functions — registered during startup, removed after settle
      const onEarlyExit = (code: number | null, signal: NodeJS.Signals | null) => {
        settle({
          ok: false,
          error: `pi process exited immediately (code=${code}, signal=${signal}). Check API key / provider config.`,
        });
      };
      const onSpawnError = (err: Error) => {
        settle({ ok: false, error: `pi spawn error: ${err.message}` });
      };

      function settle(
        val:
          | { ok: true; sessionId: string; sessionPath: string; stopReader: () => void }
          | { ok: false; error: string }
      ) {
        if (!settled) {
          settled = true;
          // Remove startup listeners immediately to avoid dangling references
          proc.off("exit", onEarlyExit);
          proc.off("error", onSpawnError);
          resolve(val);
        }
      }

      // Handle early exit
      proc.once("exit", onEarlyExit);

      // Handle spawn error (binary not found etc.)
      proc.once("error", onSpawnError);

      // Read stdout for get_state response
      stopReader = attachJsonlReader(proc.stdout!, (line) => {
        let msg: Record<string, unknown>;
        try {
          msg = JSON.parse(line) as Record<string, unknown>;
        } catch {
          return; // non-JSON lines (e.g. pi startup messages) are ignored
        }

        // 応答待ちしているコマンドがあれば渡す（inject 等）
        if (msg["type"] === "response" && typeof msg["id"] === "string") {
          this.settlePending(msg["id"], msg);
        }

        // Accept the get_state response whenever it arrives (before or after timeout).
        // NOTE: !stateQueried must NOT be included: stateQueried is set to true when
        // the query is sent (200ms delay), but the response arrives after that.
        // Including !stateQueried would prevent accepting the response.
        if (
          msg["type"] === "response" &&
          msg["command"] === "get_state" &&
          msg["success"] === true
        ) {
          const data = msg["data"] as Record<string, unknown> | undefined;
          const sid = typeof data?.["sessionId"] === "string" ? data["sessionId"] : sessionId;
          const sFile =
            typeof data?.["sessionFile"] === "string" ? data["sessionFile"] : resolvedSessionPath;

          if (stopReader) {
            settle({ ok: true, sessionId: sid, sessionPath: sFile, stopReader });
          }
        }
      });

      // After a brief startup delay, send get_state to obtain the session ID.
      setTimeout(() => {
        if (settled) return;
        stateQueried = true;
        const cmd = JSON.stringify({ type: "get_state" }) + "\n";
        proc.stdin?.write(cmd, (err) => {
          if (err && !settled) {
            settle({ ok: false, error: `Failed to write to pi stdin: ${err.message}` });
          }
        });

        // If we don't get a response within 3 s, fall back to the synthetic session ID.
        setTimeout(() => {
          if (!settled) {
            settle({
              ok: true,
              sessionId,
              sessionPath: resolvedSessionPath,
              stopReader: stopReader ?? (() => undefined),
            });
          }
        }, 3000);
      }, 200);
    }));

    if (!startResult.ok) {
      // I2: spawn failure is surfaced — emit spawn_failed and reject.
      this.emit({ type: "spawn_failed", error: startResult.error });
      throw new Error(startResult.error);
    }

    sessionId = startResult.sessionId;
    resolvedSessionPath = startResult.sessionPath;
    const { stopReader } = startResult;

    // Register the session
    const session: ActiveSession = {
      pid,
      sessionId,
      sessionPath: resolvedSessionPath,
      proc,
      stopReader,
      grip,
    };
    this.sessions.set(sessionId, session);

    // Watch for process exit after spawn completes (once — cleans itself up)
    proc.once("exit", (code, signal) => {
      // 終わった職人の掴みは必ず放す。残すとホストが抜けられなくなる（inc-0020）
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
      // Remove all listeners to allow GC of the proc object
      proc.removeAllListeners();
    });

    // Emit process_started
    this.emit({ type: "process_started", pid, sessionId, sessionPath: resolvedSessionPath });

    return { pid, sessionId, sessionPath: resolvedSessionPath };
  }

  // ── Active session list (for test cleanup) ─────────────────────────────

  /** Returns the session IDs of all currently active (non-exited) sessions. */
  listActiveSessions(): string[] {
    return [...this.sessions.keys()];
  }

  // ── RuntimeDriver.inject ────────────────────────────────────────────────

  async inject(sessionId: string, message: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`[pi-rpc] inject: session '${sessionId}' not found or already exited.`);
    }

    const id = `inject-${++this.requestCounter}`;
    // streamingBehavior が無いと、職人がターン中のとき pi は prompt を受け付けない。
    // followUp なら「いま忙しければ次のターンとして積む」ので取りこぼさない——
    // 質問への回答は、職人がその質問のターンを終えた直後に届けばよい。
    const cmd = JSON.stringify({ id, type: "prompt", message, streamingBehavior: "followUp" }) + "\n";

    // 応答待ちを先に張ってから書く（応答が先に返る競合を避ける）
    const response = this.awaitResponse(id);
    // 書き込みも応答待ちも、unref した stdio の上で起きる。待つあいだは掴んでおく
    // ——放したままだと、他に ref された handle が無いとき親が黙って畳まれる（inc-0020）
    const result = await session.grip.hold(async () => {
      try {
        await new Promise<void>((resolve, reject) => {
          session.proc.stdin?.write(cmd, (err) => {
            if (err) reject(new Error(`[pi-rpc] inject write error: ${err.message}`));
            else resolve();
          });
        });
      } catch (err) {
        this.settlePending(id, { success: false, error: String(err) });
        throw err;
      }
      return response;
    });
    // I2: 受け付けられなかったことを成功に見せない。ここを黙らせると指示が消える
    if (result["success"] !== true) {
      throw new Error(`[pi-rpc] inject rejected by pi: ${String(result["error"] ?? "unknown error")}`);
    }
  }

  /** id に対応する応答を待つ。応答が来ないまま黙って進まないよう、時間で打ち切る（I2）。 */
  private awaitResponse(id: string, timeoutMs = INJECT_TIMEOUT_MS): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`[pi-rpc] no response for '${id}' within ${timeoutMs}ms`));
      }, timeoutMs);
      // タイマーでプロセスを引き留めない（親の終了を妨げない）
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
    });
  }

  private settlePending(id: string, msg: Record<string, unknown>): void {
    const waiter = this.pending.get(id);
    if (!waiter) return;
    clearTimeout(waiter.timer);
    this.pending.delete(id);
    waiter.resolve(msg);
  }

  // ── RuntimeDriver.subscribe ─────────────────────────────────────────────

  subscribe(handler: DriverEventHandler): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  // ── RuntimeDriver.kill ──────────────────────────────────────────────────

  async kill(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      // Idempotent: already exited or unknown session
      return;
    }

    // Remove from sessions map immediately (prevents double-kill race)
    this.sessions.delete(sessionId);

    const proc = session.proc;

    // Detach stdout reader to release the stream reference
    session.stopReader();

    // Send RPC abort first (graceful), then close stdin (EOF)
    try {
      const cmd = JSON.stringify({ type: "abort" }) + "\n";
      proc.stdin?.write(cmd);
    } catch {
      // Ignore write errors on shutdown path
    }
    // Close stdin so pi sees EOF
    try {
      proc.stdin?.destroy();
    } catch {
      // Ignore
    }

    // Destroy stderr pipe (we don't need it after kill)
    try {
      proc.stderr?.destroy();
    } catch {
      // Ignore
    }

    // If already exited, nothing more to do
    if (proc.exitCode !== null || proc.signalCode !== null) {
      try { proc.stdout?.destroy(); } catch { /* ignore */ }
      return;
    }

    // Send SIGTERM and wait for exit
    proc.kill("SIGTERM");

    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        proc.kill("SIGKILL");
        resolve();
      }, 2000);
      proc.on("exit", () => {
        clearTimeout(timeout);
        resolve();
      });
    });

    // Destroy stdout after exit and remove all listeners to fully release pipe references
    try {
      proc.stdout?.destroy();
    } catch {
      // Ignore
    }
    // Remove all event listeners to allow GC
    proc.removeAllListeners();
    proc.stdout?.removeAllListeners();
    proc.stderr?.removeAllListeners();
    proc.stdin?.removeAllListeners();
  }

  // ── Internal helpers ────────────────────────────────────────────────────

  private emit(event: DriverEvent): void {
    for (const h of this.handlers) {
      try {
        h(event);
      } catch {
        // I2: handler errors do not crash the driver
      }
    }
  }

  private _defaultSessionPath(taskId: string): string {
    const base = this.sessionBaseDir || path.join(process.cwd(), "data", "sessions");
    return path.join(base, `${taskId}.jsonl`);
  }
}

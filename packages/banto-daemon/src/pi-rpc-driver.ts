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
 * D6: uses only child_process (stdlib) and @mariozechner/pi-coding-agent binary.
 *     (pi-coding-agent is the VISION tech_constraints-mandated runtime.)
 */

import * as childProcess from "node:child_process";
import * as net from "node:net";
import * as fs from "node:fs";
import * as path from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { RuntimeDriver, SpawnOptions, SessionHandle, DriverEvent, DriverEventHandler } from "@banto/core";

// ── JSONL framing (spec: rpc.md §Framing) ──────────────────────────────────
// Split on LF only. Do NOT use readline (also splits on U+2028/U+2029).

function attachJsonlReader(
  stream: NodeJS.ReadableStream,
  onLine: (line: string) => void
): () => void {
  const decoder = new StringDecoder("utf8");
  let buffer = "";

  function onData(chunk: Buffer | string) {
    buffer += typeof chunk === "string" ? chunk : decoder.write(chunk);
    while (true) {
      const idx = buffer.indexOf("\n");
      if (idx === -1) break;
      let line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      // Strip trailing CR (accept optional \r\n per spec)
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (line.length > 0) onLine(line);
    }
  }

  function onEnd() {
    const remaining = buffer + decoder.end();
    if (remaining.length > 0) {
      const line = remaining.endsWith("\r") ? remaining.slice(0, -1) : remaining;
      if (line.length > 0) onLine(line);
    }
  }

  stream.on("data", onData);
  stream.on("end", onEnd);

  return () => {
    stream.off("data", onData);
    stream.off("end", onEnd);
  };
}

// ── Session record ──────────────────────────────────────────────────────────

interface ActiveSession {
  pid: number;
  sessionId: string;
  sessionPath: string;
  proc: childProcess.ChildProcess;
  stopReader: () => void;
}

// ── PiRpcDriver ─────────────────────────────────────────────────────────────

/** Options for constructing a PiRpcDriver. */
export interface PiRpcDriverOptions {
  /**
   * Path to the pi CLI entry-point (dist/cli.js).
   * Defaults to the binary bundled with @mariozechner/pi-coding-agent.
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
   * Default: "opencode-go"
   */
  defaultProvider?: string;
  /**
   * Default LLM model passed to pi via --model.
   * Can be overridden per-spawn via SpawnOptions.driverOptions.model.
   * Default: "deepseek-v4-flash"
   */
  defaultModel?: string;
  /**
   * Absolute path to the banto-executor.ts extension file.
   * When set, passed as --extension <path> on every spawn so that
   * report_phase/report_done tools are available in the pi session.
   * Can be overridden per-spawn via SpawnOptions.driverOptions.extensionPath.
   */
  extensionPath?: string;
}

export class PiRpcDriver implements RuntimeDriver {
  private readonly piCliPath: string;
  private readonly sessionBaseDir: string;
  private readonly defaultProvider: string;
  private readonly defaultModel: string;
  private readonly extensionPath: string | undefined;
  private readonly sessions = new Map<string, ActiveSession>();
  private readonly handlers: Set<DriverEventHandler> = new Set();

  constructor(opts: PiRpcDriverOptions = {}) {
    // Resolve pi CLI path relative to this package's node_modules.
    // D6: @mariozechner/pi-coding-agent is the only new dependency (VISION mandate).
    if (opts.piCliPath) {
      this.piCliPath = opts.piCliPath;
    } else {
      // Try to resolve from the package's own node_modules first, then parent.
      // fileURLToPath(import.meta.url) gives the current file path.
      const candidates = [
        // Installed as a dependency of banto-daemon
        new URL(
          "../../../node_modules/@mariozechner/pi-coding-agent/dist/cli.js",
          import.meta.url
        ).pathname,
        // Monorepo root node_modules (npm workspaces hoist)
        new URL(
          "../../../../node_modules/@mariozechner/pi-coding-agent/dist/cli.js",
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
          "pi CLI not found. Install @mariozechner/pi-coding-agent or set piCliPath."
        );
      }
      this.piCliPath = found;
    }

    this.sessionBaseDir = opts.sessionBaseDir ?? "";
    this.defaultProvider = opts.defaultProvider ?? "opencode-go";
    this.defaultModel = opts.defaultModel ?? "deepseek-v4-flash";
    this.extensionPath = opts.extensionPath;
  }

  // ── RuntimeDriver.spawn ─────────────────────────────────────────────────

  async spawn(opts: SpawnOptions): Promise<SessionHandle> {
    const worktreePath = opts.worktreePath;
    const sessionPath = opts.sessionPath || this._defaultSessionPath(opts.taskId);

    // Ensure session directory exists.
    const sessionDir = path.dirname(sessionPath);
    fs.mkdirSync(sessionDir, { recursive: true });

    // Resolve provider and model: per-spawn driverOptions override constructor defaults.
    const provider =
      (opts.driverOptions?.provider && typeof opts.driverOptions.provider === "string"
        ? opts.driverOptions.provider
        : null) ?? this.defaultProvider;
    const model =
      (opts.driverOptions?.model && typeof opts.driverOptions.model === "string"
        ? opts.driverOptions.model
        : null) ?? this.defaultModel;

    // Resolve extension path: per-spawn override → constructor default.
    const extensionPath =
      (opts.driverOptions?.extensionPath && typeof opts.driverOptions.extensionPath === "string"
        ? opts.driverOptions.extensionPath
        : null) ?? this.extensionPath;

    // Build pi CLI arguments.
    // pi --mode rpc --session-dir <dir> --provider <p> --model <m> [--extension <ext>]
    // We use --session-dir so pi stores the JSONL in a location we know.
    const args = [
      this.piCliPath,
      "--mode",
      "rpc",
      "--session-dir",
      sessionDir,
      "--provider",
      provider,
      "--model",
      model,
    ];

    if (extensionPath) {
      args.push("--extension", extensionPath);
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

    // Spawn pi as a child process (node CLI entry-point).
    const proc = childProcess.spawn("node", args, {
      cwd: worktreePath,
      env: { ...process.env, ...extraEnv },
      stdio: ["pipe", "pipe", "pipe"],
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

    const pid = proc.pid;
    if (pid === undefined) {
      throw new Error(`[pi-rpc] Failed to spawn pi process (pid undefined).`);
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
    const startResult = await new Promise<
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
    });

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
    };
    this.sessions.set(sessionId, session);

    // Watch for process exit after spawn completes (once — cleans itself up)
    proc.once("exit", (code, signal) => {
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

    const cmd = JSON.stringify({ type: "prompt", message }) + "\n";
    await new Promise<void>((resolve, reject) => {
      session.proc.stdin?.write(cmd, (err) => {
        if (err) reject(new Error(`[pi-rpc] inject write error: ${err.message}`));
        else resolve();
      });
    });
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

// ── Worktree helper ─────────────────────────────────────────────────────────

/**
 * Create a git worktree for a task if it does not already exist.
 *
 * Used by SpawnManager to prepare the worktree before spawn().
 * Runs `git worktree add --detach <path>` (detached HEAD = branch is created
 * by the agent if needed).
 *
 * I2: throws on git error (caller converts to task_failed event).
 */
export async function createWorktree(repoPath: string, worktreePath: string): Promise<void> {
  if (fs.existsSync(worktreePath)) return; // idempotent

  fs.mkdirSync(path.dirname(worktreePath), { recursive: true });

  await new Promise<void>((resolve, reject) => {
    const proc = childProcess.spawn(
      "git",
      ["worktree", "add", "--detach", worktreePath],
      {
        cwd: repoPath,
        stdio: "pipe",
      }
    );
    let stderr = "";
    proc.stderr?.on("data", (c: Buffer) => { stderr += c.toString(); });
    proc.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`git worktree add failed (code=${code}): ${stderr}`));
    });
    proc.on("error", (err) => reject(err));
  });
}

/**
 * Remove a git worktree.
 * Safe to call even if the worktree doesn't exist.
 */
export async function removeWorktree(repoPath: string, worktreePath: string): Promise<void> {
  if (!fs.existsSync(worktreePath)) return;

  await new Promise<void>((resolve) => {
    const proc = childProcess.spawn(
      "git",
      ["worktree", "remove", "--force", worktreePath],
      {
        cwd: repoPath,
        stdio: "pipe",
      }
    );
    proc.on("exit", () => resolve());
    proc.on("error", () => resolve()); // Best-effort
  });
}

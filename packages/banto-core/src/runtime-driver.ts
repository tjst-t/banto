/**
 * RuntimeDriver contract — spec daemon-core §3.5.
 *
 * Abstracts session lifecycle: spawn / inject / subscribe / kill.
 * banto-core is pi-agnostic; this file contains ONLY types and a registry.
 * The pi-rpc implementation lives in the Worker Pool module
 * (packages/banto-worker-pool)——Kobo から独立したモジュール（ADR-0010 決定23）。
 *
 * D5: no judgment logic here — drivers are thin adapters.
 * D3: session state is tracked via events, not driver internals.
 */

// ── Session handle ──────────────────────────────────────────────────────────

/** Opaque handle returned by RuntimeDriver.spawn(). */
export interface SessionHandle {
  /** OS process ID of the spawned child process. */
  pid: number;
  /** Unique session ID (driver-assigned; used for inject/kill correlation). */
  sessionId: string;
  /**
   * Absolute path to the session JSONL file.
   * Recorded in agent_spawned event as a path reference (not content) per spec §2.1.
   */
  sessionPath: string;
}

// ── Spawn options ───────────────────────────────────────────────────────────

/** Options passed to RuntimeDriver.spawn(). */
export interface SpawnOptions {
  /** Task identifier (banto task ID). */
  taskId: string;
  /** Absolute path to the git worktree the session should operate in. */
  worktreePath: string;
  /** Absolute path where the session JSONL should be stored. */
  sessionPath: string;
  /**
   * 立場・作法を伝えるシステムプロンプト。空文字なら何も足さない。
   *
   * ドライバはこれをランタイムの既定プロンプトに**追記**する（差し替えではない）。
   * 既定プロンプトには使える道具の一覧と作法が入っており、丸ごと置き換えると
   * それが失われる——ここで渡したいのは立場であって、道具の説明の削除ではない（imp-0004）。
   */
  systemPrompt: string;
  /**
   * このセッションで使わせる Tool 名の**許可リスト**。空配列は「ランタイムの既定のまま」。
   *
   * 絞ると拡張が足した Tool も対象になる（pi の `--tools` の挙動）。報告経路のように
   * 消えては困る Tool は、呼び出し側がここに含める責任を持つ。
   */
  tools: string[];
  /** Model tier hint (spec §3.5). Driver maps tier → concrete model. */
  modelTier?: "reasoning" | "standard" | "fast";
  /**
   * Extra driver-specific options (e.g. --provider, --model override).
   * Typed as unknown to keep the contract runtime-neutral.
   */
  driverOptions?: Record<string, unknown>;
}

// ── Event emitted by drivers ────────────────────────────────────────────────

/** Minimal session event emitted by a driver to the daemon event bus. */
export type DriverEvent =
  | {
      type: "process_started";
      pid: number;
      sessionId: string;
      sessionPath: string;
    }
  | {
      type: "process_exited";
      pid: number;
      sessionId: string;
      exitCode: number | null;
      signal: string | null;
    }
  | {
      type: "spawn_failed";
      /** Human-readable error. I2: failures are not swallowed. */
      error: string;
    };

/** Callback type for driver event subscriptions. */
export type DriverEventHandler = (event: DriverEvent) => void;

// ── RuntimeDriver interface ─────────────────────────────────────────────────

/**
 * Contract every runtime driver must satisfy.
 *
 * Methods:
 *   spawn   — start a new agent session in the given worktree.
 *   inject  — send a message into an active session.
 *   subscribe — register a handler for driver-level lifecycle events.
 *   kill    — terminate an active session.
 */
export interface RuntimeDriver {
  /**
   * Spawn a new session for the given task.
   *
   * If spawn fails (e.g. binary missing, no API key) the driver MUST either:
   *   (a) reject the returned Promise with a descriptive Error, OR
   *   (b) emit a spawn_failed DriverEvent (if the failure is detected asynchronously).
   * Callers translate failures into task_failed events (I2).
   */
  spawn(opts: SpawnOptions): Promise<SessionHandle>;

  /**
   * Inject a plain-text message into a running session.
   * Used by the daemon to deliver steering / initial prompt after spawn.
   *
   * @param sessionId — must match a handle returned by spawn().
   * @param message   — text message to deliver (RPC `prompt` command).
   */
  inject(sessionId: string, message: string): Promise<void>;

  /**
   * Subscribe to driver lifecycle events.
   * Returns an unsubscribe function.
   */
  subscribe(handler: DriverEventHandler): () => void;

  /**
   * Terminate the session identified by sessionId.
   * MUST be safe to call on an already-exited session (idempotent).
   */
  kill(sessionId: string): Promise<void>;
}

// ── Driver registry ─────────────────────────────────────────────────────────

/** Known driver identifiers. */
export type DriverId = "pi-rpc" | "claude-agent-sdk";

/** Registry mapping driver IDs to RuntimeDriver instances. */
export class RuntimeDriverRegistry {
  private readonly drivers = new Map<string, RuntimeDriver>();

  /**
   * Register a driver under the given ID.
   * Overwrites any previously registered driver with the same ID.
   */
  register(id: string, driver: RuntimeDriver): void {
    this.drivers.set(id, driver);
  }

  /**
   * Look up a driver by ID.
   * Returns undefined if not registered.
   */
  get(id: string): RuntimeDriver | undefined {
    return this.drivers.get(id);
  }

  /**
   * List all registered driver IDs.
   */
  list(): string[] {
    return [...this.drivers.keys()];
  }
}

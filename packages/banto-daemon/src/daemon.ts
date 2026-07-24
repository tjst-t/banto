/**
 * Daemon: core orchestration engine.
 *
 * Composes:
 *   - EventLog (append-only JSONL truth)
 *   - StateStore (in-memory derived state, rebuilt on replay)
 *   - EventIndex (in-memory task/project history views)
 *   - ProjectRegistry (project metadata)
 *   - StateMachine (transition rules)
 *   - WsEventServer (real-time event broadcast)
 *   - TaskWatcher (polling watcher for work/tasks/*.md)
 *   - Scheduler (periodic tick jobs: gate re-evaluation, rotation, etc.)
 *
 * D3: state is derived from events, never written directly.
 * D5: all logic lives here; HTTP/WS layers are pure routing/transport.
 * I2: errors propagate; no silent swallowing.
 */

import * as http from "node:http";
import * as path from "node:path";
import * as childProcess from "node:child_process";
import {
  EventLog,
  StateStore,
  EventIndex,
  StateMachine,
  RuntimeDriverRegistry,
} from "@banto/core";
import type { OrchestrationEvent, TaskStatus, TaskRecord, TransitionResult, RuntimeDriver, SpawnOptions } from "@banto/core";
import { ProjectRegistry } from "./project-registry.js";
import type { ProjectEntry } from "./project-registry.js";
import { WsEventServer } from "./ws-server.js";
import { createHttpServer } from "./http-server.js";
import { TaskWatcher } from "./task-watcher.js";
import { Scheduler } from "./scheduler.js";
import type { TickJob } from "./scheduler.js";
import { GateEvaluator, evaluatePendingGates } from "./gate-evaluator.js";
import { PiRpcDriver, createWorktree } from "./pi-rpc-driver.js";
import { SpawnLedger, isProcessAlive, killOrphanProcess } from "./spawn-ledger.js";
import type { LedgerEntry } from "./spawn-ledger.js";

export interface DaemonConfig {
  /** Port to listen on. Default: 3000 */
  port: number;
  /** Root data directory (event log + registry). Default: ./data */
  dataDir: string;
  /**
   * Polling interval (ms) for the task-definition watcher.
   * Default: 2000 ms. Set to a smaller value in tests for faster feedback.
   */
  watchIntervalMs: number;
  /**
   * Tick interval in milliseconds for the periodic scheduler.
   * Default: 60000 (1 minute) for production.
   * Override to a small value (e.g. 500) in tests to reduce wait time.
   */
  tickIntervalMs: number;
  /**
   * Base directory for git worktrees created for spawned tasks.
   * Default: <dataDir>/worktrees
   */
  worktreeBaseDir?: string;
  /**
   * Base directory for session JSONL files.
   * Default: <dataDir>/sessions
   */
  sessionBaseDir?: string;
  /**
   * Interval (ms) for the spawn-ledger reconcile job.
   * Default: tickIntervalMs (shares the tick cadence).
   * Set to a small value (e.g. 500) in tests for fast detection.
   */
  reconcileIntervalMs?: number;
  /**
   * tmux session name for PO observation windows.
   * When set, spawnTask() opens a tmux window named <taskId> in this session
   * showing `tail -f <sessionPath>` for live agent transcript visibility.
   * Default: "banto". Set to "" to disable tmux integration.
   *
   * Spec-ui §1.4: POはtmuxアタッチで対話内容を目視できる.
   * D6: uses tmux CLI (stdlib-equivalent; no new npm dependency).
   * Best-effort: tmux failure does NOT fail the task spawn.
   */
  tmuxSession?: string;
  /**
   * LLM provider name passed to pi via --provider.
   * Default: "opencode-go" (VISION: models are interchangeable via opencode).
   * Override via BANTO_PI_PROVIDER environment variable.
   */
  piProvider?: string;
  /**
   * LLM model ID passed to pi via --model.
   * Default: "deepseek-v4-flash" (cheap, fast model for executor tasks).
   * Override via BANTO_PI_MODEL environment variable.
   */
  piModel?: string;
  /**
   * Maximum number of concurrently-running agent sessions (physical quota, 層B).
   * Compared against ledger.size on each auto-spawn tick.
   * When full, new spawns are silently skipped and re-evaluated on the next tick.
   * No rejection event is emitted on quota skip — re-evaluation is silent (spec-multi-project §3).
   *
   * Default: 5. Override via BANTO_MAX_CONCURRENT_SESSIONS environment variable.
   */
  maxConcurrentSessions?: number;
}

export class Daemon {
  private readonly config: DaemonConfig;
  private readonly log: EventLog;
  private store: StateStore;
  private index: EventIndex;
  private readonly registry: ProjectRegistry;
  private readonly httpServer: http.Server;
  private readonly wsServer: WsEventServer;
  private readonly watcher: TaskWatcher;
  private readonly scheduler: Scheduler;
  private readonly gateEvaluator: GateEvaluator;
  /**
   * Dedup map for gate_evaluated events: "projectTag/taskId" → last result key.
   * In-memory; resets on daemon restart (first eval after restart is always recorded).
   * See evaluatePendingGates for dedup logic.
   */
  private readonly lastGateKey: Map<string, string> = new Map();
  /**
   * RuntimeDriver registry — maps driver IDs to RuntimeDriver implementations.
   * Spec §3.5: pi-rpc is the reference implementation; additional drivers can be
   * registered by callers (e.g. in tests, or when claude-agent-sdk is added).
   */
  readonly driverRegistry: RuntimeDriverRegistry;

  /**
   * Spawn ledger — persistent registry of active child processes (spec §3).
   * Written atomically to <dataDir>/spawn-ledger.json.
   * Exposed as readonly for tests (e.g. to inspect entries after spawn).
   */
  readonly ledger: SpawnLedger;

  /**
   * Separate interval handle for the reconcile job, running at reconcileIntervalMs
   * (which may differ from the main tick). Null until start() is called.
   */
  private reconcileTimer: NodeJS.Timeout | null = null;

  private constructor(config: DaemonConfig) {
    this.config = config;
    this.log = EventLog.open(config.dataDir);
    this.store = StateStore.replay(this.log);
    this.index = EventIndex.build(this.log);
    this.registry = ProjectRegistry.open(config.dataDir);

    // Open spawn ledger — I2: corruption → error event + empty ledger (never crash).
    const { ledger, corruptionError } = SpawnLedger.open(config.dataDir);
    this.ledger = ledger;
    if (corruptionError) {
      // Record the corruption as a daemon-internal event (I2: don't swallow).
      // We record it during construction (before start()) so it's in the log.
      this.log.append({
        type: "tick_job_failed",
        projectTag: "daemon",
        jobName: "spawn-ledger-open",
        error: corruptionError,
      });
    }

    // Initialize driver registry with the pi-rpc reference implementation.
    // D6: PiRpcDriver uses only child_process (stdlib) + the pi binary.
    this.driverRegistry = new RuntimeDriverRegistry();
    // Resolve banto-executor extension path relative to this file (daemon.ts lives in
    // packages/banto-daemon/src/; the extension is in pi-extension/ sibling dir).
    const extensionPath = new URL(
      "./pi-extension/banto-executor.ts",
      import.meta.url
    ).pathname;
    const piDriver = new PiRpcDriver({
      sessionBaseDir: config.sessionBaseDir ?? path.join(config.dataDir, "sessions"),
      defaultProvider: config.piProvider ?? "opencode-go",
      defaultModel: config.piModel ?? "deepseek-v4-flash",
      extensionPath,
    });
    this.driverRegistry.register("pi-rpc", piDriver);

    this.httpServer = createHttpServer(this);
    this.wsServer = new WsEventServer(this.httpServer, (projectTag) =>
      this.log.getEventsByProject(projectTag)
    );
    this.watcher = new TaskWatcher(this, config.watchIntervalMs);

    // GateEvaluator: implements spec-multi-project §3 three-condition gate.
    // AlwaysPassQuota is the default until Sprint S9d7fdb provides real quota.
    this.gateEvaluator = new GateEvaluator();

    // Scheduler: drives periodic jobs (D6: setInterval only, no external library).
    this.scheduler = new Scheduler(this.log, config.tickIntervalMs);

    // Built-in job: rotation check (spec §5, spec §2.3).
    // Checks if the active segment exceeds the size threshold and rotates if so.
    this.scheduler.registerJob("rotation-check", () => {
      if (this.log.shouldRotate()) {
        const snapshotState = StateStore.replay(this.log).toSnapshotState();
        this.log.rotate(snapshotState);
        // After rotation, rebuild in-memory state from the new active segment.
        this.refreshState();
      }
    });

    // Built-in job: dependency gate re-evaluation (spec §5, spec-multi-project §3).
    // Evaluates all three gate conditions (deps, scope overlap, quota) for queued tasks.
    this.scheduler.registerJob("gate-reeval", () => {
      this.runGateReeval();
    });

    // Built-in job: auto-spawn (S75f66b-2, spec-daemon-core §6).
    // Enumerates ready tasks from derived state (D3: no separate bookkeeping) and
    // calls spawnTask() for any that are not already in the ledger.
    // Physical quota (maxConcurrentSessions) is checked against ledger size first;
    // when full, skip silently — no rejection event, re-evaluated on next tick (I2-compliant:
    // quota-skip is not an error; spawn failures still go through recordTaskFailed).
    this.scheduler.registerJob("auto-spawn", () => {
      void this.runAutoSpawn();
    });
  }

  static create(config: Partial<DaemonConfig> = {}): Daemon {
    const resolved: DaemonConfig = {
      port: config.port ?? parseInt(process.env["BANTO_PORT"] ?? "3000", 10),
      dataDir: config.dataDir ?? process.env["BANTO_DATA_DIR"] ?? "./data",
      watchIntervalMs: config.watchIntervalMs ?? 2000,
      tickIntervalMs:
        config.tickIntervalMs ??
        parseInt(process.env["BANTO_TICK_INTERVAL_MS"] ?? "60000", 10),
      worktreeBaseDir: config.worktreeBaseDir,
      sessionBaseDir: config.sessionBaseDir,
      reconcileIntervalMs: config.reconcileIntervalMs,
      tmuxSession: config.tmuxSession,
      piProvider: config.piProvider ?? process.env["BANTO_PI_PROVIDER"] ?? "opencode-go",
      piModel: config.piModel ?? process.env["BANTO_PI_MODEL"] ?? "deepseek-v4-flash",
      maxConcurrentSessions:
        config.maxConcurrentSessions ??
        // parseInt of a non-numeric env value yields NaN, and `size >= NaN` is
        // always false (quota silently unenforced) — fall back to the default.
        (Number.parseInt(process.env["BANTO_MAX_CONCURRENT_SESSIONS"] ?? "5", 10) || 5),
    };
    return new Daemon(resolved);
  }

  /**
   * Register a named periodic job to run on every tick.
   * This is the public API for adding jobs from outside the daemon
   * (e.g. from tests or future extension points).
   *
   * I2: job failures are caught, recorded as tick_job_failed events,
   * and the scheduler continues (see Scheduler.runAllJobs).
   */
  registerTickJob(name: string, fn: TickJob): void {
    this.scheduler.registerJob(name, fn);
  }

  /** Start listening. Returns a promise that resolves when the server is bound. */
  async start(): Promise<void> {
    // Recover orphans from the ledger BEFORE accepting new requests.
    // Spec §3: "daemon再起動時は台帳から孤児を引き取り再接続する"
    await this.recoverOrphans();

    await new Promise<void>((resolve, reject) => {
      this.httpServer.once("error", reject);
      this.httpServer.listen(this.config.port, "0.0.0.0", () => {
        process.stdout.write(
          `[banto-daemon] listening on port ${this.config.port} (dataDir=${this.config.dataDir})\n`
        );
        this.watcher.start();
        this.scheduler.start();
        resolve();
      });
    });

    // Start the reconcile timer (separate from the main tick so tests can tune it).
    const reconcileMs =
      this.config.reconcileIntervalMs ?? this.config.tickIntervalMs;
    this.reconcileTimer = setInterval(() => {
      void this.reconcileLedger();
    }, reconcileMs);
    // Unref so the timer does not prevent the event loop from exiting in tests.
    if (this.reconcileTimer.unref) this.reconcileTimer.unref();
  }

  /** Stop the daemon gracefully. */
  stop(): Promise<void> {
    this.watcher.stop();
    this.scheduler.stop();
    if (this.reconcileTimer) {
      clearInterval(this.reconcileTimer);
      this.reconcileTimer = null;
    }
    return new Promise((resolve, reject) => {
      this.wsServer.close(() => {
        this.httpServer.close((err) => {
          if (err) reject(err);
          else {
            this.log.close();
            resolve();
          }
        });
      });
    });
  }

  /** Return the bound port (useful in tests when port=0). */
  get port(): number {
    const addr = this.httpServer.address();
    if (addr && typeof addr === "object") return addr.port;
    return this.config.port;
  }

  // ── Project registry ───────────────────────────────────────────────────────

  listProjects(): ProjectEntry[] {
    return this.registry.list();
  }

  registerProject(id: string, repoPath: string, profile: string = "default"): ProjectEntry {
    return this.registry.register(id, repoPath, profile);
  }

  projectExists(id: string): boolean {
    return this.registry.has(id);
  }

  // ── Task operations ────────────────────────────────────────────────────────

  getTasksByProject(projectTag: string): TaskRecord[] {
    return this.store.getTasksByProject(projectTag);
  }

  /**
   * Get a task by project + taskId.
   * Uses composite key lookup (O(1)) to enforce <project>/<id> namespace
   * isolation (spec-multi-project §2).
   */
  getTask(projectTag: string, taskId: string): TaskRecord | undefined {
    return this.store.getTask(taskId, projectTag);
  }

  /**
   * Get events for a task, scoped to the given project.
   * Passes projectTag to EventIndex to enforce namespace isolation
   * (spec-multi-project §2): two projects may share the same taskId.
   */
  getTaskEvents(projectTag: string, taskId: string): OrchestrationEvent[] {
    return this.index.getTaskHistory(taskId, projectTag);
  }

  /**
   * Get all events scoped to a project (including task_ingest_rejected and
   * daemon-internal events like tick_job_failed under projectTag="daemon").
   * Reads from the log directly for a full audit trail, consistent with the
   * WS catch-up path.
   */
  getProjectEvents(projectTag: string): OrchestrationEvent[] {
    return this.log.getEventsByProject(projectTag);
  }

  /**
   * Get ALL events from the log (daemon-wide).
   * Used by the daemon-level events endpoint (/api/v1/events).
   */
  getAllEvents(): OrchestrationEvent[] {
    return this.log.readAllEvents();
  }

  /**
   * Create a new task in draft status.
   * Appends task_created event and refreshes in-memory state.
   */
  createTask(
    projectTag: string,
    taskId: string,
    title: string,
    extra: Record<string, unknown> = {}
  ): TaskRecord {
    // Use composite key lookup to check for duplicate within this project only
    const existing = this.store.getTask(taskId, projectTag);
    if (existing) {
      throw new Error(`Task '${taskId}' already exists in project '${projectTag}'`);
    }

    const { id: _id, title: _title, ...rest } = extra; // eslint-disable-line @typescript-eslint/no-unused-vars
    const event = this.log.append({
      type: "task_created",
      projectTag,
      taskId,
      payload: { title, ...rest },
    });

    this.applyAndBroadcast(event);

    const task = this.store.getTask(taskId, projectTag);
    if (!task) throw new Error("Invariant: task not found after creation"); // I2
    return task;
  }

  // ── Session spawn ──────────────────────────────────────────────────────────

  /**
   * Spawn a pi-rpc session for a task that is in "ready" status.
   *
   * Workflow:
   *   1. Validate the task is in "ready" state.
   *   2. Look up the project repo path.
   *   3. Create a git worktree at <worktreeBaseDir>/<projectTag>/<taskId>.
   *   4. Spawn pi via the registered driver (default: "pi-rpc").
   *   5. Append agent_spawned event — sessionPath only, not transcript content (spec §2.1).
   *   6. Transition task → "planning" (state machine enforces the guard).
   *   7. Subscribe to driver events; when process exits, append agent_exited event.
   *
   * I2: any failure (worktree, spawn) appends task_failed + task never transitions.
   *
   * @param projectTag  Project tag.
   * @param taskId      Task ID (must be in "ready" state).
   * @param driverId    Driver to use (default: "pi-rpc").
   * @param spawnExtra  Additional SpawnOptions fields (tools, systemPrompt, etc.).
   */
  async spawnTask(
    projectTag: string,
    taskId: string,
    driverId = "pi-rpc",
    spawnExtra: Partial<SpawnOptions> = {}
  ): Promise<{ worktreePath: string; sessionPath: string; pid: number; sessionId: string; tmuxWindow?: string }> {
    // 1. Validate task state
    const task = this.store.getTask(taskId, projectTag);
    if (!task) throw new Error(`Task '${taskId}' not found in project '${projectTag}'`);
    if (task.status !== "ready") {
      throw new Error(
        `Task '${taskId}' must be in 'ready' state to spawn (current: ${task.status})`
      );
    }

    // 2. Look up project repo path (for worktree creation)
    const project = this.registry.list().find((p) => p.id === projectTag);
    const repoPath = project?.repoPath ?? "";

    // 3. Resolve paths
    const worktreeBase =
      this.config.worktreeBaseDir ?? path.join(this.config.dataDir, "worktrees");
    const worktreePath = path.join(worktreeBase, projectTag, taskId);
    const sessionBase =
      this.config.sessionBaseDir ?? path.join(this.config.dataDir, "sessions");
    const sessionPath = path.join(sessionBase, projectTag, `${taskId}.jsonl`);

    // 4. Create git worktree (if repo is available)
    if (repoPath) {
      try {
        await createWorktree(repoPath, worktreePath);
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        this.recordTaskFailed(projectTag, taskId, `worktree creation failed: ${reason}`);
        throw err;
      }
    }

    // 5. Look up driver
    const driver = this.driverRegistry.get(driverId);
    if (!driver) {
      const reason = `Driver '${driverId}' not registered`;
      this.recordTaskFailed(projectTag, taskId, reason);
      throw new Error(reason);
    }

    // 6. Spawn session
    let handle: { pid: number; sessionId: string; sessionPath: string };
    try {
      // Inject daemon URL, projectTag, taskId into driverOptions so the pi driver
      // can pass them as BANTO_DAEMON_URL/BANTO_PROJECT/BANTO_TASK_ID to the child
      // process env. The banto-executor extension reads these to call the daemon API.
      const daemonUrl = `http://localhost:${this.port}`;
      const mergedDriverOptions: Record<string, unknown> = {
        ...spawnExtra.driverOptions,
        daemonUrl,
        projectTag,
      };
      const opts: SpawnOptions = {
        taskId,
        worktreePath,
        sessionPath,
        systemPrompt: spawnExtra.systemPrompt ?? "",
        tools: spawnExtra.tools ?? [],
        modelTier: spawnExtra.modelTier,
        driverOptions: mergedDriverOptions,
      };
      handle = await driver.spawn(opts);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      this.recordTaskFailed(projectTag, taskId, `spawn failed: ${reason}`);
      throw err;
    }

    // 7. Append agent_spawned event — session path reference ONLY (spec §2.1)
    const spawnedEvent = this.log.append({
      type: "agent_spawned",
      projectTag,
      taskId,
      pid: handle.pid,
      sessionPath: handle.sessionPath,
      worktree: worktreePath,
      modelTier: spawnExtra.modelTier ?? "standard",
    });
    this.applyAndBroadcast(spawnedEvent);

    // 8. Transition to "planning"
    this.transition(projectTag, taskId, "planning", "agent spawned");

    // 9. Open a tmux window for PO observation (spec-ui §1.4, DEC-S254276-004).
    // Best-effort: failure does NOT fail the task spawn.
    // The window displays a tail of the session JSONL so POが tmux attach -t banto で
    // エージェントの進行を目視できる.
    let tmuxWindow: string | undefined;
    const tmuxSession = this.config.tmuxSession ?? "banto";
    if (tmuxSession) {
      tmuxWindow = openTmuxWindow(tmuxSession, taskId, handle.sessionPath);
    }

    // 10. Register in spawn ledger (spec §3: persistent process registry).
    // I3: only processes we spawned are in the ledger.
    const ledgerEntry: LedgerEntry = {
      pid: handle.pid,
      projectTag,
      taskId,
      sessionPath: handle.sessionPath,
      worktree: worktreePath,
      driverId,
      sessionId: handle.sessionId,
      spawnedAt: new Date().toISOString(),
      ...(tmuxWindow ? { tmux_window: tmuxWindow } : {}),
    };
    this.ledger.add(ledgerEntry);

    // 11. Subscribe to driver events for this session → agent_exited + ledger removal
    const unsub = driver.subscribe((event) => {
      if (event.type === "process_exited" && event.sessionId === handle.sessionId) {
        const exitedEvent = this.log.append({
          type: "agent_exited",
          projectTag,
          taskId,
          pid: event.pid,
          exitCode: event.exitCode,
          signal: event.signal,
        });
        this.applyAndBroadcast(exitedEvent);
        // Remove from ledger: process is gone, no longer needs recovery.
        this.ledger.remove(projectTag, taskId);
        // Best-effort: kill the tmux window when the session exits.
        if (tmuxWindow) {
          closeTmuxWindow(tmuxWindow);
        }
        unsub();
      }
    });

    return {
      worktreePath,
      sessionPath: handle.sessionPath,
      pid: handle.pid,
      sessionId: handle.sessionId,
      ...(tmuxWindow ? { tmuxWindow } : {}),
    };
  }

  // ── Spawn ledger public API ────────────────────────────────────────────────

  /**
   * Return all current ledger entries (active spawned sessions).
   * Used by tests and the HTTP API to inspect spawn state.
   */
  getLedgerEntries(): ReturnType<SpawnLedger["list"]> {
    return this.ledger.list();
  }

  // ── Orphan recovery ────────────────────────────────────────────────────────

  /**
   * On daemon (re)start: read the ledger and handle surviving orphan processes.
   *
   * Spec §3 confirmed decision: pi-rpc stdin/stdout pipes are gone after daemon
   * restart → full re-attach is not possible. Strategy:
   *   (a) pid still alive → SIGTERM + SIGKILL, then emit task_failed
   *       (reason: daemon_restart_orphaned). This ensures no ghost pi processes
   *       linger and the task state is unambiguous.
   *   (b) pid already dead → emit task_failed (reason: orphan_pid_not_found).
   * Either way: ledger entry is removed after handling.
   */
  private async recoverOrphans(): Promise<void> {
    const entries = this.ledger.list();
    if (entries.length === 0) return;

    process.stdout.write(
      `[banto-daemon] recovering ${entries.length} orphan(s) from spawn ledger\n`
    );

    for (const entry of entries) {
      const { pid, projectTag, taskId } = entry;

      if (isProcessAlive(pid)) {
        process.stdout.write(
          `[banto-daemon] orphan pid=${pid} task=${projectTag}/${taskId} alive → terminating\n`
        );
        try {
          await killOrphanProcess(pid);
        } catch {
          // Best-effort: if kill fails, record and continue
        }
        const reason = "daemon_restart_orphaned";
        this.recordTaskFailed(projectTag, taskId, reason);
      } else {
        process.stdout.write(
          `[banto-daemon] orphan pid=${pid} task=${projectTag}/${taskId} already dead → recording failure\n`
        );
        this.recordTaskFailed(projectTag, taskId, "orphan_pid_not_found");
      }

      // Remove from ledger regardless of pid state (I3: ledger = live processes only)
      this.ledger.remove(projectTag, taskId);
    }
  }

  /**
   * Reconcile job: compare ledger entries against live OS processes.
   * Detects processes that died without triggering the normal exit path
   * (e.g. SIGKILL from outside the daemon).
   *
   * For each dead entry:
   *   - emit task_failed event (reason: "process_not_found")
   *   - remove from ledger
   *
   * Orphan worktrees are logged (not deleted per spec §3 task 4).
   *
   * Called by the reconcile timer (reconcileIntervalMs cadence).
   */
  private async reconcileLedger(): Promise<void> {
    const entries = this.ledger.list();
    for (const entry of entries) {
      const { pid, projectTag, taskId, worktree } = entry;
      if (!isProcessAlive(pid)) {
        process.stdout.write(
          `[banto-daemon] reconcile: pid=${pid} task=${projectTag}/${taskId} is dead → task_failed\n`
        );
        this.recordTaskFailed(projectTag, taskId, "process_not_found");
        this.ledger.remove(projectTag, taskId);

        // Log orphan worktree (spec §3 task 4: detect, do not delete)
        if (worktree) {
          process.stdout.write(
            `[banto-daemon] orphan worktree detected (not deleted): ${worktree}\n`
          );
        }
      }
    }
  }

  /**
   * Record an unrecoverable task failure (I2).
   *
   * Uses StateMachine.fail() which emits:
   *   1. state_transitioned(from=currentStatus, to="failed") — D3: single status source
   *   2. task_failed(reason)                                 — metadata
   *
   * If the task does not exist or is already terminal, only task_failed is appended
   * (the state machine handles the already-terminal guard internally).
   *
   * Private helper used by spawnTask error paths and orphan recovery.
   */
  // NOTE(review S254276-2 F2): StateMachine.fail() appends state_transitioned +
  // task_failed, but only the last appended event is broadcast to WS subscribers
  // (same trade-off as transition()). Live WS view may miss the intermediate
  // state_transitioned; REST state is always consistent. Revisit with the
  // attention-queue UI sprint (S30a8fd).
  private recordTaskFailed(projectTag: string, taskId: string, reason: string): void {
    const task = this.store.getTask(taskId, projectTag);
    if (task) {
      // Use StateMachine.fail() which handles any → failed cross-cutting transition.
      // This is the correct path for planning/implementing/etc. → failed.
      StateMachine.fail(
        this.log,
        taskId,
        { currentStatus: task.status as TaskStatus, reason },
        projectTag
      );
    } else {
      // Task not found in in-memory store (rare: event log has it, store out of sync,
      // or task was never created). Append task_failed event directly (I2).
      this.log.append({
        type: "task_failed",
        projectTag,
        taskId,
        reason,
      });
    }
    // Refresh in-memory state and broadcast the latest event(s).
    this.refreshState();
    const allEvents = this.log.readAllEvents();
    if (allEvents.length > 0) {
      const lastEvent = allEvents[allEvents.length - 1];
      this.wsServer.broadcast(lastEvent);
    }
  }

  /**
   * Attempt a state transition for a task.
   * On rejection: appends transition_rejected event (I2) and returns { ok: false }.
   * Refreshes in-memory state and broadcasts on success.
   *
   * Gate re-evaluation is triggered when a task reaches a state that could
   * resolve a block on queued tasks (any resolved or permanent-terminal state).
   * This covers both condition 1 (dependency resolved) and condition 2
   * (scope-overlap ancestor finishes review).
   */
  transition(
    projectTag: string,
    taskId: string,
    to: string,
    reason?: string
  ): TransitionResult {
    const task = this.store.getTask(taskId, projectTag);
    if (!task) return { ok: false, reason: "task_not_found" };

    const fromStatus = task.status as TaskStatus;
    const toStatus = to as TaskStatus;

    const result = StateMachine.transition(
      this.log,
      taskId,
      fromStatus,
      toStatus,
      projectTag,
      reason
    );

    // Refresh state + index regardless of result (rejection events are also appended)
    this.refreshState();
    // Broadcast the last appended event (transition or rejection)
    const allEvents = this.log.readAllEvents();
    if (allEvents.length > 0) {
      const lastEvent = allEvents[allEvents.length - 1];
      this.wsServer.broadcast(lastEvent);
    }

    // Re-evaluate pending gates when the new status could unblock queued tasks.
    // This covers:
    //   - Condition 1: dep reached a resolved state (approved/merging/merged/evaluating/closed)
    //   - Condition 1: dep reached a permanent block state (failed/superseded — triggers
    //     permanent-block gate_evaluated records so the PO sees the block reason)
    //   - Condition 2: a scope-overlapping ancestor advanced past unreviewed states
    // We run on any successful transition that changes status so we don't miss edge cases.
    if (result.ok) {
      this.runGateReeval();
    }

    return result;
  }

  /**
   * Emit a task_ingest_rejected event (I2: file validation failure is recorded, not swallowed).
   * Called by TaskWatcher when a task definition file fails validation.
   * D3: no task record is created; the rejection is the only artifact.
   */
  emitIngestRejected(projectTag: string, filePath: string, reason: string): void {
    const event = this.log.append({
      type: "task_ingest_rejected",
      projectTag,
      filePath,
      reason,
    });
    // Refresh state (no-op for state, but keeps index current) and broadcast
    this.applyAndBroadcast(event);
  }

  // ── Internal helpers ───────────────────────────────────────────────────────

  /**
   * Apply a freshly-appended event to in-memory state and broadcast via WS.
   * D3: StateStore and EventIndex are always derived from the log.
   */
  private applyAndBroadcast(event: OrchestrationEvent): void {
    this.refreshState();
    this.wsServer.broadcast(event);
  }

  /**
   * Rebuild in-memory state by replaying the log.
   * Called after every write to keep derived state consistent.
   * D3: no mutable in-place mutation; always a clean replay.
   */
  private refreshState(): void {
    this.store = StateStore.replay(this.log);
    this.index = EventIndex.build(this.log);
  }

  /**
   * Run gate re-evaluation for all queued tasks.
   *
   * Delegates to GateEvaluator (spec-multi-project §3: three conditions).
   * Every judgment is recorded as gate_evaluated event (D3, I2).
   * Refreshes in-memory state after any promotions.
   *
   * Called from:
   *   (a) Scheduler tick (gate-reeval job) — periodic sweep
   *   (b) After every successful state transition — immediate re-evaluation
   *       when a dependency or scope-ancestor changes status
   */
  private runGateReeval(): void {
    const allTasks = this.store.getAllTasks();
    const queuedCount = allTasks.filter((t) => t.status === "queued").length;
    const promoted = evaluatePendingGates(
      this.log,
      allTasks,
      this.wsServer,
      this.gateEvaluator,
      this.lastGateKey
    );
    // Refresh state if there are any queued tasks or if a promotion occurred.
    // gate_evaluated events are now written only on first evaluation or result change
    // (dedup via lastGateKey). Even when no new events are written, we refresh if
    // tasks were promoted to keep the index consistent.
    // D3: state and index are always derived from the log.
    if (queuedCount > 0 || promoted > 0) {
      this.refreshState();
    }
  }

  /**
   * Auto-spawn tick job (S75f66b-2, spec-daemon-core §6).
   *
   * On every scheduler tick:
   *   1. Check physical quota: if ledger.size >= maxConcurrentSessions, skip silently.
   *      (No rejection event — just re-evaluated on the next tick.)
   *   2. Enumerate all tasks whose derived state is "ready" AND that are not already
   *      in the spawn ledger (i.e. not yet spawned). D3: no extra bookkeeping.
   *   3. Spawn each eligible task via spawnTask(), stopping when the quota is full.
   *   4. spawn failures are already routed to task_failed via recordTaskFailed inside
   *      spawnTask() — do NOT re-spawn failed tasks (they will no longer be "ready").
   *
   * I2: errors are not swallowed. spawnTask() propagates to recordTaskFailed internally;
   * errors from the auto-spawn loop are caught by the Scheduler (tick_job_failed).
   * D3: "already spawned" check uses the ledger (live-process registry), not a separate flag.
   */
  private async runAutoSpawn(): Promise<void> {
    const maxSessions = this.config.maxConcurrentSessions ?? 5;

    // Check quota FIRST — if already at limit, skip the whole sweep.
    if (this.ledger.size >= maxSessions) {
      return;
    }

    // Enumerate ready tasks from derived state (D3: no extra flag).
    const readyTasks = this.store.getAllTasks().filter((t) => t.status === "ready");

    for (const task of readyTasks) {
      // Re-check quota each iteration — previous spawns in this loop count.
      if (this.ledger.size >= maxSessions) {
        break;
      }

      // Skip tasks that are already in the ledger (already spawned, session is live).
      // D3: "spawned" judgment comes from the ledger, which tracks live OS processes.
      if (this.ledger.get(task.projectTag, task.id)) {
        continue;
      }

      // spawnTask() handles all failure paths via recordTaskFailed (I2).
      // After a successful spawn the task transitions to "planning" (no longer "ready"),
      // so it won't appear in the next tick's ready list.
      // After a failed spawn the task transitions to "failed" (also no longer "ready").
      // Either way, no re-spawn loop is possible.
      try {
        await this.spawnTask(task.projectTag, task.id);
      } catch {
        // Failure already recorded inside spawnTask() via recordTaskFailed (I2),
        // unless spawnTask() threw before reaching it (e.g. the status-not-ready
        // guard) — in that case the task is already in a non-ready state and no
        // further action is needed.
        // Do not re-throw — let the scheduler continue with remaining ready tasks.
        // The Scheduler catches errors from the job function itself; this catch prevents
        // a single task's failure from aborting the rest of the auto-spawn sweep.
      }
    }
  }
}

// ── tmux integration helpers ───────────────────────────────────────────────────
//
// Spec-ui §1.4: POはtmux attach -t banto でエージェントの進行を目視できる.
// DEC-S254276-004: tmux new-window でビューウィンドウを開き、セッションJSONLを tail -f する.
//
// Implementation choice (v1): option (b) — the tmux window shows `tail -f <sessionPath>`
// so PO can see the raw session transcript in real-time.
// Rationale: pi RPC driver controls pi via stdin/stdout pipes (this daemon's process).
// Opening pi as a TUI inside tmux (option c) would require a separate pi process with
// a separate prompt — creating confusion about which pi is authoritative.
// `tail -f` lets PO observe the actual RPC session transcript without bifurcating control.
// tmux_window is recorded in the spawn ledger (DEC-S254276-004) so PO can look it up.
//
// D6: tmux is a system tool (no npm dependency added).
// I2: tmux errors are logged to stderr but do NOT fail the spawn.

/**
 * Ensure the tmux session `sessionName` exists (create if absent).
 * Returns true if the session is usable after this call.
 */
function ensureTmuxSession(sessionName: string): boolean {
  // Check if session exists
  const check = childProcess.spawnSync(
    "tmux",
    ["has-session", "-t", sessionName],
    { encoding: "utf8" }
  );
  if (check.status === 0) return true; // already exists

  // Create detached session
  const create = childProcess.spawnSync(
    "tmux",
    ["new-session", "-d", "-s", sessionName],
    { encoding: "utf8" }
  );
  if (create.status !== 0) {
    process.stderr.write(
      `[banto-daemon] tmux new-session failed: ${create.stderr ?? ""}\n`
    );
    return false;
  }
  return true;
}

/**
 * Open a new tmux window in `sessionName` named `windowName`.
 * The window runs `tail -f <sessionPath>` with a startup echo so the pane is
 * immediately non-empty (PO visual feedback before the agent writes its first line).
 *
 * Returns the window address "sessionName:windowName" on success, undefined on failure.
 *
 * D6: uses tmux CLI (stdlib-equivalent).
 * I2: failure is logged to stderr; caller receives undefined and continues.
 */
function openTmuxWindow(
  sessionName: string,
  windowName: string,
  sessionPath: string
): string | undefined {
  if (!ensureTmuxSession(sessionName)) return undefined;

  // The shell command shown in the window:
  //   1. Echo a header line so capture-pane is immediately non-empty.
  //   2. tail -f the session JSONL once it appears (--retry waits for file to appear).
  const cmd = `echo "[banto] Agent session started: ${windowName}" && tail -f --retry "${sessionPath}"`;

  const result = childProcess.spawnSync(
    "tmux",
    ["new-window", "-d", "-t", sessionName, "-n", windowName, cmd],
    { encoding: "utf8" }
  );

  if (result.status !== 0) {
    process.stderr.write(
      `[banto-daemon] tmux new-window failed for ${windowName}: ${result.stderr ?? ""}\n`
    );
    return undefined;
  }

  const windowAddr = `${sessionName}:${windowName}`;
  process.stdout.write(
    `[banto-daemon] tmux window opened: ${windowAddr} (tail ${sessionPath})\n`
  );
  return windowAddr;
}

/**
 * Close a tmux window by its address (e.g. "banto:T-001").
 * Best-effort: errors are logged, not thrown.
 */
function closeTmuxWindow(windowAddr: string): void {
  const result = childProcess.spawnSync(
    "tmux",
    ["kill-window", "-t", windowAddr],
    { encoding: "utf8" }
  );
  if (result.status !== 0) {
    process.stderr.write(
      `[banto-daemon] tmux kill-window ${windowAddr} failed: ${result.stderr ?? ""}\n`
    );
  }
}

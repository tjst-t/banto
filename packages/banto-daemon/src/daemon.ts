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

  private constructor(config: DaemonConfig) {
    this.config = config;
    this.log = EventLog.open(config.dataDir);
    this.store = StateStore.replay(this.log);
    this.index = EventIndex.build(this.log);
    this.registry = ProjectRegistry.open(config.dataDir);

    // Initialize driver registry with the pi-rpc reference implementation.
    // D6: PiRpcDriver uses only child_process (stdlib) + the pi binary.
    this.driverRegistry = new RuntimeDriverRegistry();
    const piDriver = new PiRpcDriver({
      sessionBaseDir: config.sessionBaseDir ?? path.join(config.dataDir, "sessions"),
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
  start(): Promise<void> {
    return new Promise((resolve, reject) => {
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
  }

  /** Stop the daemon gracefully. */
  stop(): Promise<void> {
    this.watcher.stop();
    this.scheduler.stop();
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
  ): Promise<{ worktreePath: string; sessionPath: string; pid: number; sessionId: string }> {
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
      const opts: SpawnOptions = {
        taskId,
        worktreePath,
        sessionPath,
        systemPrompt: spawnExtra.systemPrompt ?? "",
        tools: spawnExtra.tools ?? [],
        modelTier: spawnExtra.modelTier,
        driverOptions: spawnExtra.driverOptions,
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

    // 9. Subscribe to driver events for this session → agent_exited
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
        unsub();
      }
    });

    return {
      worktreePath,
      sessionPath: handle.sessionPath,
      pid: handle.pid,
      sessionId: handle.sessionId,
    };
  }

  /**
   * Record an unrecoverable task failure (I2).
   * Appends task_failed event and transitions task to "failed" status.
   * Private helper used by spawnTask error paths.
   */
  private recordTaskFailed(projectTag: string, taskId: string, reason: string): void {
    const failedEvent = this.log.append({
      type: "task_failed",
      projectTag,
      taskId,
      reason,
    });
    this.applyAndBroadcast(failedEvent);
    // Also transition state to "failed" so state machine reflects the failure
    this.transition(projectTag, taskId, "failed", reason);
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
}

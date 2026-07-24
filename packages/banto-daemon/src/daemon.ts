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
import * as fs from "node:fs";
import * as path from "node:path";
import * as childProcess from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  EventLog,
  StateStore,
  EventIndex,
  StateMachine,
  RuntimeDriverRegistry,
  parseEnvProfiles as _parseEnvProfiles,
} from "@banto/core";
import type { OrchestrationEvent, TaskStatus, TaskRecord, TransitionResult, RuntimeDriver, SpawnOptions, ParseEnvProfilesResult } from "@banto/core";
import { ProjectRegistry } from "./project-registry.js";
import type { ProjectEntry } from "./project-registry.js";
import { WsEventServer } from "./ws-server.js";
import { createHttpServer } from "./http-server.js";
import { TaskWatcher } from "./task-watcher.js";
import { Scheduler } from "./scheduler.js";
import type { TickJob } from "./scheduler.js";
import { GateEvaluator, evaluatePendingGates } from "./gate-evaluator.js";
import type { QuotaCheck } from "./gate-evaluator.js";
import { PiRpcDriver, createWorktree } from "./pi-rpc-driver.js";
import { SpawnLedger, isProcessAlive, killOrphanProcess } from "./spawn-ledger.js";
import type { LedgerEntry } from "./spawn-ledger.js";
import { processMergeQueue } from "./merge-queue.js";
import {
  fileConflictTask,
  deriveOriginResolutionPairs,
} from "./conflict-filer.js";
import { EnvLedger, countLiveByProfile } from "./env-ledger.js";
import type { EnvLedgerEntry } from "./env-ledger.js";
import { runDriverVerb, resolveDriverPath, DEFAULT_DRIVER_TIMEOUT_MS } from "./env-driver-runner.js";
import type {
  ProvisionOutput,
  HealthcheckOutput,
  RunOutput,
  ListOutput,
} from "@banto/core";

// ── Daemon-local skill asset loader ───────────────────────────────────────────
//
// Resolves prompt assets (skills/*.md) relative to THIS FILE's location
// (packages/banto-daemon/src/daemon.ts → ../../../skills/).
// This is separate from banto-core's loadPromptAsset, which resolves relative
// to the core package's location (correct for production deployments where
// @banto/core is installed in the monorepo root, but not when @banto/core is
// accessed via a node_modules workspace symlink pointing to a different checkout).
//
// D2: criteria in text files (skills/), mechanism in code here.
// I2: throws clearly if the file is missing.
// D6: uses only node:fs, node:path, node:url (stdlib).

const _daemonDir = path.dirname(fileURLToPath(import.meta.url));
// daemon.ts lives at packages/banto-daemon/src/; root is 3 levels up.
const _repoRoot = path.resolve(_daemonDir, "..", "..", "..");

function loadSkillAsset(name: string): string {
  const assetPath = path.join(_repoRoot, "skills", `${name}.md`);
  if (!fs.existsSync(assetPath)) {
    throw new Error(
      `Skill asset not found: "${name}" (looked at ${assetPath}). Create skills/${name}.md.`
    );
  }
  return fs.readFileSync(assetPath, "utf-8");
}

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
  /**
   * When true, skip auto-spawning the audit session on implementing→auditing transition.
   * Intended for test suites that test gate/tick logic and do not need audit session spawn.
   * Default: false (audit sessions are auto-spawned in production).
   */
  disableAuditSpawn?: boolean;
  /**
   * When true, disable the auto-spawn tick job (which would spawn pi agents for ready tasks).
   * Intended for test suites that test gate/quota logic and do not need agent spawn.
   * Default: false (auto-spawn runs in production).
   */
  disableAutoSpawn?: boolean;
  /**
   * Timeout in milliseconds for a single driver verb invocation (spec-environment §8 decision).
   * Planning note: daemon-side uniform configurable default.
   * Default: 30 000 ms (30 s).
   */
  driverTimeoutMs?: number;
  /**
   * Maximum number of teardown retry attempts before giving up and filing a cadence card.
   * Story-5 TTL enforcer: on exhaustion → markTeardownFailed + card_generated(cadence).
   * Default: 3 retries.
   */
  ttlTeardownRetryLimit?: number;
  /**
   * Delay in milliseconds between teardown retry attempts.
   * Default: 1 000 ms (1 s).
   */
  ttlTeardownRetryDelayMs?: number;
  /**
   * Interval (ms) for the env reconcile tick.
   * Default: reconcileIntervalMs (shares the spawn-reconcile cadence).
   * Set to a small value (e.g. 500) in tests for fast detection.
   */
  envReconcileIntervalMs?: number;
  /**
   * When true, disable the TTL enforcer tick job and the env reconcile tick job.
   * Intended for test suites that do not need TTL/reconcile.
   * Default: false.
   */
  disableEnvTtlEnforcer?: boolean;
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
   * Environment ledger — persistent registry of provisioned environments (spec-environment §5).
   * Written atomically to <dataDir>/env-ledger.json.
   * Exposed as readonly for tests (e.g. to inspect entries after provision).
   */
  readonly envLedger: EnvLedger;

  /**
   * Separate interval handle for the reconcile job, running at reconcileIntervalMs
   * (which may differ from the main tick). Null until start() is called.
   */
  private reconcileTimer: NodeJS.Timeout | null = null;

  /**
   * Re-entrancy guard for the serial merge queue tick.
   *
   * S75f66b-5 review fix: the Scheduler drives the "merge-queue" job on every tick.
   * If a tick fires while a previous processMergeQueue() is still awaiting (e.g. git
   * rebase on a large repo), two concurrent calls to processMergeQueue() could run,
   * violating the serial guarantee (spec §4.1) and causing git race conditions.
   *
   * Fix: local boolean guard — skip the tick if already running.
   * Decision: local guard (not a Scheduler-wide change) to minimise scope impact (P1).
   * Always reset in finally{} so a panicking inner call never permanently locks the queue.
   */
  private _mergeQueueRunning = false;

  /**
   * Re-entrancy guard for the auto-spawn tick.
   *
   * S75f66b-5 E2E fix: driver.spawn() awaits ~200ms (get_state probe) + up to 3s fallback.
   * If a second tick fires before the first runAutoSpawn() resolves, both see the same
   * "ready" task with no ledger entry (the entry is added only after spawn() resolves).
   * Both then call spawnTask(), causing multiple concurrent sessions for the same task.
   *
   * Fix: same pattern as _mergeQueueRunning — skip if already running.
   * Always reset in finally{} so a panicking inner call never permanently locks spawning.
   */
  private _autoSpawnRunning = false;

  /**
   * Re-entrancy guard for the TTL enforcer tick (Story-5).
   *
   * A forced teardown (including retries) can take multiple seconds. If a second tick
   * fires before the first _runEnvTtlEnforcer() resolves, both would attempt teardown
   * for the same expired entries simultaneously, causing duplicate retries and duplicate
   * events. Mirror the _mergeQueueRunning pattern.
   * Always reset in finally{} so a panicking inner call never permanently locks the enforcer.
   */
  private _envTtlEnforcerRunning = false;

  /**
   * Re-entrancy guard for the env reconcile tick (Story-5).
   *
   * Driver `list` calls are I/O operations that can be slow. If a second tick fires
   * before _runEnvReconcile() resolves, both would compare the same stale ledger snapshot
   * against the same driver output. Mirror the _mergeQueueRunning pattern.
   * Always reset in finally{} so a panicking inner call never permanently locks the reconcile.
   */
  private _envReconcileRunning = false;

  /**
   * Separate interval handle for the env reconcile tick (Story-5).
   * May differ from the main tick (envReconcileIntervalMs).
   * Null until start() is called.
   */
  private envReconcileTimer: NodeJS.Timeout | null = null;

  /**
   * In-flight spawn map: deduplicates concurrent spawnTask() calls for the same task.
   *
   * The spawn-ledger only records COMPLETED spawns (after driver.spawn() resolves
   * and the ledger entry is written). During the 200ms–3.2s window of driver.spawn(),
   * the task is neither in the ledger nor in a non-"ready" status (the transition to
   * "planning" happens AFTER driver.spawn() returns). Without this guard, concurrent
   * callers (e.g. auto-spawn tick + explicit test spawn) both see a "ready" task not
   * in the ledger and both call spawnTask(), spawning two pi processes for one task.
   *
   * The map stores the Promise returned by the first call. Subsequent callers for the
   * same task key join that Promise and get the same result (promise deduplication).
   * This is safe because the result (worktreePath, sessionPath, pid, sessionId) is
   * identical for all callers — only one pi process is ever spawned.
   *
   * Invariant: key is `${projectTag}/${taskId}`. Removed in finally{} of spawnTask().
   * D3: this is NOT persisted — it only exists for the lifetime of one spawnTask() call.
   */
  private readonly _inFlightSpawns: Map<string, Promise<{ worktreePath: string; sessionPath: string; pid: number; sessionId: string; tmuxWindow?: string }>> = new Map();

  /**
   * Set of in-flight background async operations deferred via setImmediate
   * (e.g. audit session spawn, rework session spawn triggered by handleAuditVerdict).
   *
   * Tracked so Daemon.stop() can await all of them before closing the event log.
   * Each entry is a Promise that resolves when the background operation settles
   * (success or error — errors are handled internally via recordTaskFailed).
   * Entries are removed in their own finally{} blocks.
   *
   * D3/I2: ensures no events are silently dropped due to log-close-before-write.
   */
  private readonly _backgroundOps: Set<Promise<void>> = new Set();

  /**
   * No-flood dedup map for env_profile_rejected events (S9d7fdb-1, AC-S9d7fdb-1-2).
   * Key: "projectTag/profileName", Value: mtime of meta/environments.yaml at last emit.
   * An event is only emitted when the file's mtime has changed since the last emission.
   * Mirrors the TaskWatcher no-flood pattern (mtime unchanged = already processed).
   * In-memory only; resets on daemon restart (first call after restart always emits).
   */
  private readonly _envProfileRejectMtime: Map<string, number> = new Map();

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

    // Open env ledger — same I2 pattern as spawn ledger.
    const { ledger: envLedger, corruptionError: envLedgerError } = EnvLedger.open(config.dataDir);
    this.envLedger = envLedger;
    if (envLedgerError) {
      this.log.append({
        type: "tick_job_failed",
        projectTag: "daemon",
        jobName: "env-ledger-open",
        error: envLedgerError,
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
    // S9d7fdb-4: inject real quota check (replaces AlwaysPassQuota stub).
    // The quota check reads live env-ledger entries (D3: derived, not stored separately).
    const envLedgerRef = this; // captured reference so the closure sees the current ledger
    const envQuotaCheck: QuotaCheck = {
      check(task: import("@banto/core").TaskRecord): boolean {
        // Get the profile name from the task's environment field.
        const profileName = typeof task["environment"] === "string" ? task["environment"] : undefined;
        if (!profileName) {
          // Task has no environment profile — quota check passes (no env required).
          return true;
        }
        // Look up the profile to get quota.max_instances.
        // We re-read profiles via the daemon method to stay D3-compliant (no caching).
        const { valid } = envLedgerRef.getEnvironmentProfiles(task.projectTag);
        const profile = valid.find((p) => p.name === profileName);
        if (!profile || !profile.quota) {
          // Profile not found or no quota configured → no restriction.
          return true;
        }
        // Count live entries for this profile (D3: derived from ledger).
        const liveCount = countLiveByProfile(envLedgerRef.envLedger.listLive(), profileName);
        return liveCount < profile.quota.max_instances;
      },
    };
    this.gateEvaluator = new GateEvaluator(envQuotaCheck);

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
    // disableAutoSpawn: test suites that test gate/quota logic can opt out of auto-spawn
    // to prevent the pi driver from failing (no pi binary in test envs) and marking tasks failed.
    if (!config.disableAutoSpawn) {
      this.scheduler.registerJob("auto-spawn", () => {
        void this.runAutoSpawn();
      });
    }

    // Built-in job: serial merge queue (S75f66b-5, spec-daemon-core §4.1).
    // Processes the HEAD of the merge queue only (one task at a time — serial discipline).
    // Queue is derived purely from event log replay (D3: no persistence file).
    // Rebase → merge gate → fast-forward merge → task_merged + merged transition.
    // Merged tasks without hypothesis are auto-closed.
    // Rebase conflicts: auto-file conflict task + pause origin (S75f66b-6).
    this.scheduler.registerJob("merge-queue", () => this.runMergeQueueTick());

    // Built-in job: conflict-resolution outcome check (S75f66b-6, spec-daemon-core §4.2).
    // On each tick, derive paused-origin↔conflict-resolution pairs (D3: from event log).
    // If a resolution task reached merged/closed: resume the origin task to merging.
    // If a resolution task failed: chain-fail the origin task (I2: stop, don't swallow).
    this.scheduler.registerJob("conflict-resolution-check", () => {
      this.runConflictResolutionCheck();
    });

    // Built-in job: env TTL enforcer (Story-5, spec-environment §5).
    // Scans live ledger entries, force-tears-down any with ttlDeadline < now.
    // Retries on failure; escalates via card_generated(cadence) on retry exhaustion (I2, D8).
    // disableEnvTtlEnforcer: opt-out for test suites that do not need TTL/reconcile.
    //
    // Note: the job fn RETURNS the Promise (no `void`) so the Scheduler can await it
    // in runAllJobs() and drain it on stop(). This ensures no events are appended after
    // log.close() (D3/I2: no events must be silently dropped).
    if (!config.disableEnvTtlEnforcer) {
      this.scheduler.registerJob("env-ttl-enforcer", () => this._runEnvTtlEnforcer());
    }
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
      disableAuditSpawn: config.disableAuditSpawn ?? false,
      disableAutoSpawn: config.disableAutoSpawn ?? false,
      driverTimeoutMs: config.driverTimeoutMs ?? DEFAULT_DRIVER_TIMEOUT_MS,
      ttlTeardownRetryLimit: config.ttlTeardownRetryLimit ?? 3,
      ttlTeardownRetryDelayMs: config.ttlTeardownRetryDelayMs ?? 1000,
      envReconcileIntervalMs: config.envReconcileIntervalMs,
      disableEnvTtlEnforcer: config.disableEnvTtlEnforcer ?? false,
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

    // F2 (governance): emit daemon_config event when spawn-suppressing flags are set,
    // so the suppression is visible in the event log (「黙って迂回できる経路を作らない」,
    // priority rule 2). Without this, a production daemon started with disableAutoSpawn
    // would silently not auto-spawn — invisible to the PO via GET /events.
    // Pattern mirrors audit_spawn_disabled.
    if (this.config.disableAutoSpawn || this.config.disableAuditSpawn) {
      const configEvent = this.log.append({
        type: "daemon_config",
        projectTag: "daemon",
        autoSpawnDisabled: this.config.disableAutoSpawn === true,
        auditSpawnDisabled: this.config.disableAuditSpawn === true,
      });
      this.applyAndBroadcast(configEvent);
    }

    // Start the spawn-ledger reconcile timer (separate from the main tick so tests can tune it).
    const reconcileMs =
      this.config.reconcileIntervalMs ?? this.config.tickIntervalMs;
    this.reconcileTimer = setInterval(() => {
      void this.reconcileLedger();
    }, reconcileMs);
    // Unref so the timer does not prevent the event loop from exiting in tests.
    if (this.reconcileTimer.unref) this.reconcileTimer.unref();

    // Start the env reconcile timer (Story-5, spec-environment §5).
    // Compares driver list output against the env ledger.
    // Uses envReconcileIntervalMs if set, else reconcileMs.
    //
    // D3/I2: in-flight reconcile ops are tracked via _backgroundOps so daemon.stop()
    // can drain them before closing the log (no events must be lost).
    if (!this.config.disableEnvTtlEnforcer) {
      const envReconcileMs =
        this.config.envReconcileIntervalMs ?? reconcileMs;
      this.envReconcileTimer = setInterval(() => {
        this._trackBackground(this._runEnvReconcile());
      }, envReconcileMs);
      if (this.envReconcileTimer.unref) this.envReconcileTimer.unref();
    }
  }

  /** Stop the daemon gracefully. */
  async stop(): Promise<void> {
    this.watcher.stop();
    // Drain the scheduler FIRST: awaits any in-flight runAllJobs() so no scheduler
    // job can try to append events after log.close() (D3/I2: log is the single
    // runtime truth — no writes must be silently dropped).
    await this.scheduler.stop();
    // Drain background operations: audit/rework sessions are spawned via setImmediate
    // for HTTP-response ordering, and their async bodies (driver.spawn → recordTaskFailed)
    // must complete before we close the event log (D3/I2: no events must be dropped).
    if (this._backgroundOps.size > 0) {
      await Promise.allSettled([...this._backgroundOps]);
    }
    if (this.reconcileTimer) {
      clearInterval(this.reconcileTimer);
      this.reconcileTimer = null;
    }
    if (this.envReconcileTimer) {
      clearInterval(this.envReconcileTimer);
      this.envReconcileTimer = null;
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
    // 0. In-flight deduplication: if a concurrent spawnTask() call is already in progress
    //    for this task, join the existing Promise and return its result (no second spawn).
    //    driver.spawn() takes 200ms–3.2s, during which the task is still "ready" (no
    //    transition yet) and the ledger has no entry yet. Without this guard, concurrent
    //    callers (e.g. auto-spawn tick + explicit test spawn) both see a "ready" task
    //    with no ledger entry and both call spawnTask(), creating two pi processes.
    //
    //    Promise deduplication: all callers for the same key receive the same result
    //    (worktreePath, sessionPath, pid, sessionId). Only one pi process is ever spawned.
    const spawnKey = `${projectTag}/${taskId}`;
    const existing = this._inFlightSpawns.get(spawnKey);
    if (existing) {
      // Join the in-flight spawn — same result, no second pi process.
      return existing;
    }

    // Build the promise for this spawn (kept in the map until it settles).
    const spawnPromise = this._spawnTaskBody(projectTag, taskId, driverId, spawnExtra).finally(() => {
      this._inFlightSpawns.delete(spawnKey);
    });
    this._inFlightSpawns.set(spawnKey, spawnPromise);
    return spawnPromise;
  }

  // Inner implementation extracted to allow finally cleanup on all paths.
  private async _spawnTaskBody(
    projectTag: string,
    taskId: string,
    driverId: string,
    spawnExtra: Partial<SpawnOptions>
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

    // Clean up spawn-ledger entries for audit and rework sessions.
    // When a task fails, any associated audit or rework sessions are no longer needed.
    // Their processes will be cleaned up by the orphan reconcile job, but we remove
    // the ledger entries now to keep the ledger accurate (D3: no stale derived state).
    this.ledger.remove(projectTag, `${taskId}:audit`);
    this.ledger.remove(projectTag, `${taskId}:rework`);

    // S9d7fdb-4 (AC-S9d7fdb-4-4): Tear down environments on task failure.
    // recordTaskFailed() is the cross-cutting "failed" path (used by spawn error paths,
    // orphan recovery, audit failures). We trigger teardown here too so that ALL
    // paths to "failed" guarantee env cleanup (not just the HTTP /transition route).
    // Fire-and-forget (same pattern as transition() hook).
    this._trackBackground(new Promise<void>((resolve) => {
      setImmediate(() => void this._teardownTaskEnvs(projectTag, taskId).then(resolve, resolve));
    }));
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

    // Cross-cutting transitions: failed and superseded are reachable from any non-terminal state.
    // Route through StateMachine.fail() / StateMachine.supersede() instead of the transition table.
    let result: TransitionResult;
    if (toStatus === "failed") {
      result = StateMachine.fail(
        this.log,
        taskId,
        { currentStatus: fromStatus, reason: reason ?? "transition_to_failed" },
        projectTag
      );
    } else if (toStatus === "superseded") {
      result = StateMachine.supersede(
        this.log,
        taskId,
        { currentStatus: fromStatus, by: reason ?? "unknown" },
        projectTag
      );
    } else {
      result = StateMachine.transition(
        this.log,
        taskId,
        fromStatus,
        toStatus,
        projectTag,
        reason
      );
    }

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

      // S9d7fdb-4 (AC-S9d7fdb-4-4): Teardown-on-terminal-state guarantee.
      // When a task reaches a terminal state (failed / closed / superseded),
      // tear down its environments so no external resources outlive the task.
      // Fire-and-forget: teardown failure is surfaced in the event log (I2).
      // The state transition is committed immediately (D3: events are the truth);
      // teardown is deferred so the HTTP response for the transition is sent first.
      const TERMINAL_STATES = new Set(["failed", "closed", "superseded"]);
      if (TERMINAL_STATES.has(toStatus)) {
        this._trackBackground(new Promise<void>((resolve) => {
          setImmediate(() => void this._teardownTaskEnvs(projectTag, taskId).then(resolve, resolve));
        }));
      }

      // S75f66b-3: Auto-spawn audit session on implementing→auditing transition.
      // The audit session is the structural gate — it always runs before review/merge.
      // D5: all orchestration logic here; HTTP layer is pure routing.
      // disableAuditSpawn: test suites that test gate/tick logic can opt out of the
      // side effect to avoid pi CLI resolution errors in CI environments.
      if (fromStatus === "implementing" && toStatus === "auditing") {
        if (this.config.disableAuditSpawn) {
          // F2 (governance): emit observable event so the bypass is visible in the log.
          // "黙って迂回できる経路を作らない" — suppression must never be silent.
          const disabledEvent = this.log.append({
            type: "audit_spawn_disabled",
            projectTag,
            taskId,
          });
          this.applyAndBroadcast(disabledEvent);
        } else {
          // Fire-and-forget: spawn failure recorded via recordTaskFailed (I2).
          // Deferred to next tick so the HTTP response is sent before any synchronous
          // work in spawnAuditSession (e.g. loadPromptAsset, driver lookup) that might
          // call recordTaskFailed, which would mutate task state before the caller sees
          // the 200/auditing response.
          // Tracked in _backgroundOps (registered synchronously before setImmediate fires)
          // so Daemon.stop() can drain it before log.close() (D3/I2: no events dropped).
          this._trackBackground(new Promise<void>((resolve) => {
            setImmediate(() => void this.spawnAuditSession(projectTag, taskId).then(resolve, resolve));
          }));
        }
      }
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

  // ── Audit session orchestration ────────────────────────────────────────────

  /**
   * Spawn an audit session for a task that just entered 'auditing' state.
   *
   * S75f66b-3 (AC-S75f66b-3-1, AC-S75f66b-3-2):
   *   - Spawns via the registered driver (default: "pi-rpc") using the auditor extension.
   *   - Emits audit_started event with session path reference (spec §2.1).
   *   - Registers in spawn ledger (spec §3: orphan recovery applies to audit sessions too).
   *   - Audit session uses banto-auditor pi extension which injects audit-system.md +
   *     audit-checklist.md from skills/ (D2: criteria in text, mechanism in code).
   *
   * I2: spawn failures are routed to recordTaskFailed.
   */
  private async spawnAuditSession(
    projectTag: string,
    taskId: string,
    driverId = "pi-rpc"
  ): Promise<void> {
    const task = this.store.getTask(taskId, projectTag);
    if (!task) {
      process.stderr.write(
        `[banto-daemon] spawnAuditSession: task ${projectTag}/${taskId} not found\n`
      );
      return;
    }

    // Resolve the audit extension path (sibling of banto-executor.ts).
    const auditExtensionPath = new URL(
      "./pi-extension/banto-auditor.ts",
      import.meta.url
    ).pathname;

    // Look up the worktree from the spawn ledger (the executor session's worktree).
    // If not in ledger (executor already exited), fall back to the standard worktree path.
    const worktreeBase =
      this.config.worktreeBaseDir ?? path.join(this.config.dataDir, "worktrees");
    const worktreePath = path.join(worktreeBase, projectTag, taskId);
    const sessionBase =
      this.config.sessionBaseDir ?? path.join(this.config.dataDir, "sessions");
    // Audit sessions get a distinct session file: <taskId>-audit-<n>.jsonl
    const auditIndex = this.countConsecutiveAuditFails(projectTag, taskId) + 1;
    const auditSessionPath = path.join(
      sessionBase,
      projectTag,
      `${taskId}-audit-${auditIndex}.jsonl`
    );

    // Build audit system prompt: loaded from skills/ at spawn time (D2, AC-S75f66b-3-2).
    let auditSystemPrompt: string;
    try {
      const sysPrompt = loadSkillAsset("audit-system");
      const checklist = loadSkillAsset("audit-checklist");
      auditSystemPrompt =
        sysPrompt + "\n\n## 監査チェックリスト\n\n" + checklist;
    } catch (err) {
      const reason = `audit prompt assets missing: ${err instanceof Error ? err.message : String(err)}`;
      this.recordTaskFailed(projectTag, taskId, reason);
      return;
    }

    const driver = this.driverRegistry.get(driverId);
    if (!driver) {
      const reason = `Audit driver '${driverId}' not registered`;
      this.recordTaskFailed(projectTag, taskId, reason);
      return;
    }

    const daemonUrl = `http://localhost:${this.port}`;
    const spawnOpts: SpawnOptions = {
      taskId,
      worktreePath,
      sessionPath: auditSessionPath,
      systemPrompt: auditSystemPrompt,
      tools: [], // registered by the banto-auditor extension
      modelTier: "reasoning", // spec §3.5: 監査 = reasoning tier
      driverOptions: {
        daemonUrl,
        projectTag,
        // Override extension to banto-auditor instead of banto-executor
        extensionPath: auditExtensionPath,
      },
    };

    let handle: { pid: number; sessionId: string; sessionPath: string };
    try {
      handle = await driver.spawn(spawnOpts);
    } catch (err) {
      const reason = `audit session spawn failed: ${err instanceof Error ? err.message : String(err)}`;
      this.recordTaskFailed(projectTag, taskId, reason);
      return;
    }

    // Emit audit_started event (S75f66b-3, spec §2.1: path reference only).
    const auditStartedEvent = this.log.append({
      type: "audit_started",
      projectTag,
      taskId,
      sessionPath: handle.sessionPath,
      worktree: worktreePath,
    });
    this.applyAndBroadcast(auditStartedEvent);

    // Also emit agent_spawned with role marker so it's distinguishable from executor spawns.
    // The "audit" role is embedded in the sessionPath naming convention and audit_started event.
    const spawnedEvent = this.log.append({
      type: "agent_spawned",
      projectTag,
      taskId,
      pid: handle.pid,
      sessionPath: handle.sessionPath,
      worktree: worktreePath,
      modelTier: "reasoning",
    });
    this.applyAndBroadcast(spawnedEvent);

    // Register in spawn ledger (spec §3: orphan recovery applies to audit sessions too).
    const ledgerEntry: LedgerEntry = {
      pid: handle.pid,
      projectTag,
      taskId: `${taskId}:audit`, // distinguish audit session in ledger
      sessionPath: handle.sessionPath,
      worktree: worktreePath,
      driverId,
      sessionId: handle.sessionId,
      spawnedAt: new Date().toISOString(),
    };
    this.ledger.add(ledgerEntry);

    // Inject task-specific audit context into the audit session.
    // The banto-auditor extension provides the generic audit system prompt + checklist
    // via before_agent_start hook. Here we inject the SPECIFIC task context:
    //   - task ID, title, acceptance criteria, worktree path, scope
    // This gives the audit LLM concrete information to act on (D2: criteria in text,
    // not hardcoded in extension). Without this inject, the audit LLM only has the
    // generic checklist and cannot determine WHAT file to look for in the worktree.
    // I2: inject failure is logged but not fatal — audit session may still succeed
    // if the LLM infers context from the worktree directory listing.
    const acceptanceRaw = (task as Record<string, unknown>)["acceptance"];
    const acceptanceCriteria: Array<{ id: string; text: string; verify?: string }> =
      Array.isArray(acceptanceRaw)
        ? (acceptanceRaw as Array<Record<string, string>>).map((a) => ({
            id: String(a["id"] ?? ""),
            text: String(a["text"] ?? ""),
            ...(a["verify"] ? { verify: String(a["verify"]) } : {}),
          }))
        : [];

    const scopeRaw = (task as Record<string, unknown>)["scope"] as Record<string, unknown> | undefined;
    const scopePaths: string[] = Array.isArray(scopeRaw?.["paths"])
      ? (scopeRaw["paths"] as unknown[]).map(String)
      : [];

    const auditContextMessage = [
      `## タスク監査コンテキスト`,
      ``,
      `**タスクID**: ${taskId}`,
      `**プロジェクト**: ${projectTag}`,
      `**タイトル**: ${String(task["title"] ?? "")}`,
      ``,
      `**ワークツリーパス**: ${worktreePath}`,
      `（このディレクトリに実装者が作成・変更したファイルがあります）`,
      ``,
      `**スコープ（変更が期待されるファイル）**:`,
      scopePaths.length > 0
        ? scopePaths.map((p) => `- ${p}`).join("\n")
        : "- (スコープ未指定)",
      ``,
      `**受け入れ基準 (acceptance criteria)**:`,
      acceptanceCriteria.length > 0
        ? acceptanceCriteria
            .map(
              (a) =>
                `- [${a.id}] ${a.text}` +
                (a.verify ? ` （検証コマンド: \`${a.verify}\`）` : "")
            )
            .join("\n")
        : "- (基準未指定)",
      ``,
      `## 監査手順`,
      ``,
      `1. ワークツリーパス (${worktreePath}) に移動して実装内容を確認してください`,
      `2. scope.paths に指定されたファイルが存在し、acceptance criteria を満たしているか検証してください`,
      `3. verify コマンドがある場合はそれを実行して結果を確認してください`,
      `4. すべての基準を満たしていれば \`audit_report\` ツールを呼び出し verdict="pass" を報告してください`,
      `5. 問題があれば verdict="fail" と具体的な findings を報告してください`,
      ``,
      `**重要**: 検査が完了したら必ず \`audit_report\` ツールを呼び出してください。呼び出さないと監査が完了しません。`,
    ].join("\n");

    try {
      await driver.inject(handle.sessionId, auditContextMessage);
    } catch (injectErr) {
      process.stderr.write(
        `[banto-daemon] spawnAuditSession: inject context failed for ${projectTag}/${taskId}: ` +
          `${injectErr instanceof Error ? injectErr.message : String(injectErr)}\n`
      );
    }

    // Subscribe to driver events: remove from ledger when audit session exits.
    // If audit session exits without verdict, recordTaskFailed (I2: no ghost sessions).
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
        this.ledger.remove(projectTag, `${taskId}:audit`);

        // If the task is still in 'auditing' after the session exited, treat as failure (I2).
        const currentTask = this.store.getTask(taskId, projectTag);
        if (currentTask && currentTask.status === "auditing") {
          process.stderr.write(
            `[banto-daemon] audit session exited without verdict for ${projectTag}/${taskId} — recording failure\n`
          );
          this.recordTaskFailed(
            projectTag,
            taskId,
            "audit_session_exited_without_verdict"
          );
        }
        unsub();
      }
    });
  }

  /**
   * Handle an audit verdict submitted via POST /api/v1/projects/:proj/tasks/:id/audit-report.
   *
   * S75f66b-3 (AC-S75f66b-3-3, AC-S75f66b-3-4):
   *   pass → merging (review.policy=auto) or review-ready (otherwise)
   *   fail (1st consecutive) → implementing (rework) + new executor session with findings
   *   fail (2nd consecutive) → failed (I2: stop, don't swallow)
   *
   * D3: consecutive fail count is DERIVED from the event log (audit_verdict events).
   *     No counter stored as a separate field.
   *
   * @returns { ok: true } on success, throws on invalid state.
   */
  handleAuditVerdict(
    projectTag: string,
    taskId: string,
    verdict: "pass" | "fail",
    findings: string[]
  ): { ok: boolean } {
    const task = this.store.getTask(taskId, projectTag);
    if (!task) {
      throw new Error(`task_not_found: ${projectTag}/${taskId}`);
    }
    if (task.status !== "auditing") {
      throw new Error(
        `task_wrong_state: expected 'auditing', got '${task.status}'`
      );
    }

    // Record the verdict event first (D3: event is the truth).
    const verdictEvent = this.log.append({
      type: "audit_verdict",
      projectTag,
      taskId,
      verdict,
      findings,
    });
    this.applyAndBroadcast(verdictEvent);

    if (verdict === "pass") {
      // Determine target status from review.policy (stored in task payload, D3).
      // review.policy is loaded from the task definition at creation time (watcher ingestion).
      const reviewPolicy = (task["review"] as { policy?: string } | undefined)?.policy ?? "manual";
      const targetStatus = reviewPolicy === "auto" ? "merging" : "review-ready";

      this.transition(projectTag, taskId, targetStatus, "audit_passed");
    } else {
      // Fail path: count consecutive audit fails from event log (D3: no stored counter).
      const consecutiveFails = this.countConsecutiveAuditFails(projectTag, taskId);

      if (consecutiveFails >= 2) {
        // 2nd consecutive fail → failed (I2: stop, record, don't swallow).
        StateMachine.fail(
          this.log,
          taskId,
          {
            currentStatus: task.status as TaskStatus,
            reason: `audit_failed_twice: ${findings.join("; ")}`,
          },
          projectTag
        );
        this.refreshState();
        const allEvents = this.log.readAllEvents();
        if (allEvents.length > 0) {
          this.wsServer.broadcast(allEvents[allEvents.length - 1]);
        }
        // Clean up audit and rework ledger entries (no more sessions should run).
        // D3: ledger is derived from live processes; failed task has no live sessions.
        this.ledger.remove(projectTag, `${taskId}:audit`);
        this.ledger.remove(projectTag, `${taskId}:rework`);
      } else {
        // 1st consecutive fail → rework: auditing → implementing + spawn rework session.
        this.transition(projectTag, taskId, "implementing", "audit_fail_rework");
        // Spawn a new executor session with findings injected (void: fire-and-forget, I2 inside).
        // Deferred to next tick to ensure the HTTP response reflects the implementing state
        // before any sync work in spawnReworkSession mutates the state further.
        // Tracked in _backgroundOps (registered synchronously before setImmediate fires)
        // so Daemon.stop() can drain it before log.close() (D3/I2: no events dropped).
        this._trackBackground(new Promise<void>((resolve) => {
          setImmediate(() => void this.spawnReworkSession(projectTag, taskId, findings).then(resolve, resolve));
        }));
      }
    }

    return { ok: true };
  }

  /**
   * Spawn a rework executor session with audit findings injected into the system prompt.
   *
   * S75f66b-3 (AC-S75f66b-3-4): after first audit fail, the task returns to 'implementing'
   * and a new executor session is spawned with the audit findings in its context.
   *
   * The task must be in 'ready' state for spawnTask(). Since we just transitioned it to
   * 'implementing', we need to set it back to 'ready' first (daemon internal operation).
   *
   * I2: spawn failures are routed to recordTaskFailed.
   * D3: findings injected via system prompt only — not stored as a separate field.
   */
  private async spawnReworkSession(
    projectTag: string,
    taskId: string,
    findings: string[]
  ): Promise<void> {
    // To use spawnTask(), the task must be in 'ready' state.
    // Transition: implementing → (need ready). Since implementing→auditing→implementing
    // leaves us in implementing, we need to go back through the gate.
    // Design decision: for rework, we bypass the gate and directly spawn via driver.
    // The rework session uses the same worktree as the original executor session.

    const task = this.store.getTask(taskId, projectTag);
    if (!task) {
      process.stderr.write(
        `[banto-daemon] spawnReworkSession: task ${projectTag}/${taskId} not found\n`
      );
      return;
    }

    const executorExtensionPath = new URL(
      "./pi-extension/banto-executor.ts",
      import.meta.url
    ).pathname;

    const worktreeBase =
      this.config.worktreeBaseDir ?? path.join(this.config.dataDir, "worktrees");
    const worktreePath = path.join(worktreeBase, projectTag, taskId);
    const sessionBase =
      this.config.sessionBaseDir ?? path.join(this.config.dataDir, "sessions");

    // Count rework sessions so we can give each a distinct session file.
    const reworkIndex = this.countReworkSessions(projectTag, taskId) + 1;
    const sessionPath = path.join(
      sessionBase,
      projectTag,
      `${taskId}-rework-${reworkIndex}.jsonl`
    );

    // Build system prompt from executor-system asset (no findings injected here —
    // D1: findings are delivered via driver.inject() after spawn, which is the
    // runtime-driver contract's guaranteed delivery path. PiRpcDriver ignores
    // systemPrompt at the spawn call but processes inject() as the first RPC message).
    let executorPrompt: string;
    try {
      executorPrompt = loadSkillAsset("executor-system");
    } catch (err) {
      const reason = `executor-system asset missing: ${err instanceof Error ? err.message : String(err)}`;
      this.recordTaskFailed(projectTag, taskId, reason);
      return;
    }

    const driver = this.driverRegistry.get("pi-rpc");
    if (!driver) {
      this.recordTaskFailed(projectTag, taskId, "pi-rpc driver not registered for rework");
      return;
    }

    const daemonUrl = `http://localhost:${this.port}`;
    const spawnOpts: SpawnOptions = {
      taskId,
      worktreePath,
      sessionPath,
      systemPrompt: executorPrompt,
      tools: [],
      modelTier: "standard",
      driverOptions: {
        daemonUrl,
        projectTag,
        extensionPath: executorExtensionPath,
      },
    };

    let handle: { pid: number; sessionId: string; sessionPath: string };
    try {
      handle = await driver.spawn(spawnOpts);
    } catch (err) {
      const reason = `rework session spawn failed: ${err instanceof Error ? err.message : String(err)}`;
      this.recordTaskFailed(projectTag, taskId, reason);
      return;
    }

    // D1: deliver findings via inject() — the runtime-driver contract's sanctioned
    // message path. This is the guaranteed delivery channel; systemPrompt is ignored
    // by PiRpcDriver (it does not pass it to the pi process). inject() sends the
    // findings as the first RPC `prompt` message into the running session.
    // I2: inject failure is logged but not fatal — the session is already spawned and
    // the executor can still complete (the audit will re-check on the next verdict).
    const findingsMessage =
      "## 監査指摘（前回の提出で発見された問題）\n\n" +
      "以下の指摘を解決してから report_done を呼んでください:\n\n" +
      findings.map((f) => `- ${f}`).join("\n");
    try {
      await driver.inject(handle.sessionId, findingsMessage);
    } catch (injectErr) {
      process.stderr.write(
        `[banto-daemon] spawnReworkSession: inject findings failed for ${projectTag}/${taskId}: ` +
          `${injectErr instanceof Error ? injectErr.message : String(injectErr)}\n`
      );
    }

    // Record agent_spawned for the rework session.
    const spawnedEvent = this.log.append({
      type: "agent_spawned",
      projectTag,
      taskId,
      pid: handle.pid,
      sessionPath: handle.sessionPath,
      worktree: worktreePath,
      modelTier: "standard",
    });
    this.applyAndBroadcast(spawnedEvent);

    // Register rework session in ledger.
    const ledgerEntry: LedgerEntry = {
      pid: handle.pid,
      projectTag,
      taskId: `${taskId}:rework`, // distinguish from primary executor in ledger
      sessionPath: handle.sessionPath,
      worktree: worktreePath,
      driverId: "pi-rpc",
      sessionId: handle.sessionId,
      spawnedAt: new Date().toISOString(),
    };
    this.ledger.add(ledgerEntry);

    // Subscribe to process exit.
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
        this.ledger.remove(projectTag, `${taskId}:rework`);
        unsub();
      }
    });
  }

  /**
   * Count consecutive audit fails from the event log (D3: derived, not stored).
   *
   * Definition of "consecutive": count audit_verdict(fail) events walking backwards
   * from the most recent, stopping at the first audit_verdict(pass) or
   * state_transitioned to a non-auditing active state that wasn't a rework.
   *
   * S75f66b-3: used by handleAuditVerdict to decide rework vs. fail.
   */
  private countConsecutiveAuditFails(projectTag: string, taskId: string): number {
    const events = this.index.getTaskHistory(taskId, projectTag);
    // Walk backwards through audit_verdict events.
    // Count fails until we see a pass (reset) or run out of events.
    let consecutiveFails = 0;
    for (let i = events.length - 1; i >= 0; i--) {
      const ev = events[i];
      if (ev.type === "audit_verdict") {
        if (ev.verdict === "fail") {
          consecutiveFails++;
        } else {
          // pass resets the streak
          break;
        }
      }
      // state_transitioned(auditing→implementing) is a rework — continue counting
      // audit_started, agent_spawned etc. are intermediate — continue
    }
    return consecutiveFails;
  }

  /**
   * Count rework sessions (implementing sessions after first audit) for naming.
   * D3: derived from event log (count agent_spawned events after first audit_started).
   */
  private countReworkSessions(projectTag: string, taskId: string): number {
    const events = this.index.getTaskHistory(taskId, projectTag);
    let foundFirstAudit = false;
    let reworkCount = 0;
    for (const ev of events) {
      if (ev.type === "audit_started") {
        foundFirstAudit = true;
      }
      if (foundFirstAudit && ev.type === "agent_spawned") {
        reworkCount++;
      }
    }
    return reworkCount;
  }

  // ── Environment profile API (S9d7fdb-1) ───────────────────────────────────

  /**
   * Read and validate environment profiles from meta/environments.yaml for the project.
   *
   * D3: profiles are file-intent; re-read from disk on every call (not cached/stored).
   *     Caller (HTTP handler) reads on each request — no stale derived state.
   * I2: YAML parse errors and per-profile validation failures are returned as `failures`
   *     (never thrown or swallowed). The daemon does NOT crash on invalid profiles.
   *
   * No-flood pattern for env_profile_rejected events (mirrors watcher-reject no-flood):
   *   - Failures are emitted as events at most once per (projectTag, profileName, mtime)
   *     so repeated reads of the same malformed file do not flood the event log.
   *   - The dedup map (_envProfileRejectMtime) is keyed by "projectTag/profileName"
   *     and stores the file's mtime at the time of the last rejection event.
   *
   * @returns parsed valid profiles and any failures (for HTTP response).
   */
  getEnvironmentProfiles(projectTag: string): ParseEnvProfilesResult {
    const proj = this.registry.get(projectTag);
    if (!proj) {
      return { valid: [], failures: [] };
    }

    const envFile = path.join(proj.repoPath, "meta", "environments.yaml");
    if (!fs.existsSync(envFile)) {
      return { valid: [], failures: [] };
    }

    let content: string;
    let mtimeMs: number;
    try {
      const stat = fs.statSync(envFile);
      mtimeMs = stat.mtimeMs;
      content = fs.readFileSync(envFile, "utf-8");
    } catch (err) {
      // I2: cannot read file — return failures without crashing daemon
      return {
        valid: [],
        failures: [{ name: "<file>", reason: `cannot read meta/environments.yaml: ${String(err)}` }],
      };
    }

    // D6: _parseEnvProfiles is from @banto/core (no new dep; aliased import at top of file)
    const result = _parseEnvProfiles(content);

    // Emit env_profile_rejected events for each failure (no-flood: dedup by mtime)
    for (const failure of result.failures) {
      const key = `${projectTag}/${failure.name}`;
      const lastMtime = this._envProfileRejectMtime.get(key);
      if (lastMtime !== mtimeMs) {
        // New or modified failure — emit event and record mtime
        this._envProfileRejectMtime.set(key, mtimeMs);
        const event = this.log.append({
          type: "env_profile_rejected",
          projectTag,
          profileName: failure.name,
          reason: failure.reason,
        });
        this.applyAndBroadcast(event);
      }
      // If lastMtime === mtimeMs: same mtime = already emitted → skip (no-flood)
    }

    return result;
  }

  /**
   * Attempt to provision an environment for a task by resolving its profile.
   *
   * S9d7fdb-1 (AC-S9d7fdb-1-3): Story 1 only covers profile-resolution.
   * The actual driver invocation lands in Story 2.
   *
   * Returns { ok: true } if the profile is found (provision would proceed in Story 2).
   * Returns { ok: false, httpStatus: 404, error } if the profile is unknown.
   * Emits env_provision_failed event on failure (I2: not swallowed).
   *
   * @param projectTag  Project tag.
   * @param taskId      Task whose `environment` field names the profile.
   * @param profileName Profile name to look up (from task frontmatter).
   */
  resolveEnvProfile(
    projectTag: string,
    taskId: string,
    profileName: string
  ): { ok: true; profileName: string } | { ok: false; httpStatus: number; error: string } {
    const { valid } = this.getEnvironmentProfiles(projectTag);
    const found = valid.find((p) => p.name === profileName);
    if (!found) {
      const reason = `profile_not_found: "${profileName}" is not defined in meta/environments.yaml`;
      // I2: emit failure event (not swallowed)
      const event = this.log.append({
        type: "env_provision_failed",
        projectTag,
        taskId,
        profileName,
        reason,
      });
      this.applyAndBroadcast(event);
      return { ok: false, httpStatus: 404, error: reason };
    }
    return { ok: true, profileName: found.name };
  }

  // ── Environment driver API (S9d7fdb-2) ────────────────────────────────────

  /**
   * Provision an environment for a task using its named profile's driver.
   *
   * S9d7fdb-2 (AC-S9d7fdb-2-2): This replaces the Story 1 stub that returned 202.
   *
   * Steps:
   *   1. Resolve profile → driver name + config block.
   *   2. Resolve absolute driver path (builtin or external).
   *   3. Run `driver provision` with stdin {config, taskId}.
   *   4. Run `driver healthcheck` with the returned handle.
   *   5. Record env_provisioned event + ledger entry.
   *
   * D1: field names passed to driver are spec §2 FIXED: config, taskId, handle.
   * I2: any driver failure → ok: false + env_provision_failed event (not swallowed).
   * I3: taskId is passed to the driver so it can apply the naming prefix.
   *
   * Returns the new envId on success.
   */
  async provisionEnv(
    projectTag: string,
    taskId: string,
    profileName: string
  ): Promise<
    | { ok: true; envId: string; profileName: string; healthcheck: { ok: boolean; detail?: string } }
    | { ok: false; httpStatus: number; error: string }
  > {
    const { valid } = this.getEnvironmentProfiles(projectTag);
    const profile = valid.find((p) => p.name === profileName);
    if (!profile) {
      const reason = `profile_not_found: "${profileName}" is not defined in meta/environments.yaml`;
      const event = this.log.append({
        type: "env_provision_failed",
        projectTag,
        taskId,
        profileName,
        reason,
      });
      this.applyAndBroadcast(event);
      return { ok: false, httpStatus: 404, error: reason };
    }

    // S9d7fdb-4: quota enforcement (spec-environment §5, D3: derived from ledger).
    // Count live entries for this profile; reject if max_instances is reached.
    if (profile.quota && profile.quota.max_instances > 0) {
      const liveCount = countLiveByProfile(this.envLedger.listLive(), profileName);
      if (liveCount >= profile.quota.max_instances) {
        const reason = `quota_exceeded: profile "${profileName}" max_instances=${profile.quota.max_instances} reached (${liveCount} live)`;
        const event = this.log.append({
          type: "env_provision_failed",
          projectTag,
          taskId,
          profileName,
          reason,
        });
        this.applyAndBroadcast(event);
        // Trigger gate re-eval so gate_evaluated events are updated with quota block reason.
        this.runGateReeval();
        return { ok: false, httpStatus: 409, error: reason };
      }
    }

    const driverPath = resolveDriverPath(profile.driver);
    const timeoutMs = this.config.driverTimeoutMs ?? DEFAULT_DRIVER_TIMEOUT_MS;

    // Step 1: provision
    const provisionResult = await runDriverVerb(
      driverPath,
      "provision",
      { config: profile.config ?? {}, taskId },
      timeoutMs
    );

    if (!provisionResult.ok) {
      const reason = `driver_provision_failed: ${provisionResult.error}`;
      const event = this.log.append({
        type: "env_provision_failed",
        projectTag,
        taskId,
        profileName,
        reason,
      });
      this.applyAndBroadcast(event);
      return { ok: false, httpStatus: 502, error: reason };
    }

    const provOut = provisionResult.output as ProvisionOutput;
    if (!provOut.handle || typeof provOut.handle !== "object") {
      const reason = "driver_provision_failed: provision output missing handle";
      const event = this.log.append({
        type: "env_provision_failed",
        projectTag,
        taskId,
        profileName,
        reason,
      });
      this.applyAndBroadcast(event);
      return { ok: false, httpStatus: 502, error: reason };
    }

    const handle = provOut.handle;

    // Step 2: healthcheck
    const hcResult = await runDriverVerb(
      driverPath,
      "healthcheck",
      { handle },
      timeoutMs
    );

    let healthcheck: { ok: boolean; detail?: string };
    if (!hcResult.ok) {
      // Healthcheck driver failure — treat as ok: false with detail
      healthcheck = { ok: false, detail: hcResult.error };
    } else {
      const hcOut = hcResult.output as HealthcheckOutput;
      healthcheck = { ok: hcOut.ok === true, detail: hcOut.detail };
    }

    // Step 3: record in ledger + emit event
    const envId = `${taskId}-${profileName}-${Date.now()}`;
    const now = new Date();
    // ttlDeadline: createdAt + profile.ttlMs (Story-5 enforces TTL; we only persist the deadline).
    const ttlDeadline = new Date(now.getTime() + profile.ttlMs).toISOString();
    const entry: EnvLedgerEntry = {
      envId,
      projectTag,
      taskId,
      profileName,
      driver: profile.driver,
      handle,
      createdAt: now.toISOString(),
      ttlDeadline,
    };
    this.envLedger.add(entry);

    const event = this.log.append({
      type: "env_provisioned",
      projectTag,
      taskId,
      envId,
      profileName,
      driver: profile.driver,
      healthcheck,
    });
    this.applyAndBroadcast(event);

    return { ok: true, envId, profileName, healthcheck };
  }

  /**
   * Tear down an environment (idempotent — spec-environment §2).
   *
   * S9d7fdb-2 (AC-S9d7fdb-2-4): teardown is idempotent; already-torn-down = success.
   *
   * I2: driver failure on a NON-idempotent error → ok: false (not swallowed).
   *     But if the environment was already torn down, return ok: true immediately.
   * I3: ledger entry marked tornDownAt after teardown.
   */
  async teardownEnv(
    projectTag: string,
    taskId: string,
    envId?: string
  ): Promise<{ ok: true } | { ok: false; httpStatus: number; error: string }> {
    // Find the env entry — if envId given, use it; else use the latest live entry for task
    let entry: EnvLedgerEntry | undefined;
    if (envId) {
      entry = this.envLedger.get(envId);
      if (!entry) {
        // Already torn down or never existed — idempotent success (spec §2: teardown冪等)
        return { ok: true };
      }
    } else {
      const liveEntries = this.envLedger.listByTask(projectTag, taskId);
      entry = liveEntries[liveEntries.length - 1];
      if (!entry) {
        // No live environment for this task — idempotent success
        return { ok: true };
      }
    }

    if (entry.tornDownAt) {
      // Already torn down — idempotent success
      return { ok: true };
    }

    const driverPath = resolveDriverPath(entry.driver);
    const timeoutMs = this.config.driverTimeoutMs ?? DEFAULT_DRIVER_TIMEOUT_MS;

    const result = await runDriverVerb(
      driverPath,
      "teardown",
      { handle: entry.handle },
      timeoutMs
    );

    if (!result.ok) {
      // I2: driver non-zero exit is a failure — return it (but note: spec requires
      // drivers themselves to be idempotent; the daemon surfaces driver failures faithfully).
      return { ok: false, httpStatus: 502, error: `driver_teardown_failed: ${result.error}` };
    }

    // Mark as torn down in ledger
    this.envLedger.markTornDown(entry.envId);

    const event = this.log.append({
      type: "env_torn_down",
      projectTag,
      taskId,
      envId: entry.envId,
    });
    this.applyAndBroadcast(event);

    return { ok: true };
  }

  /**
   * Run a command in a provisioned environment.
   *
   * S9d7fdb-2 (AC-S9d7fdb-2-3): returns {exit, log_path}; log_path is under the
   * task's aggregation directory.
   *
   * D3: events carry path references only, never log bodies (spec-environment §6).
   * I2: non-zero exit from the environment command is REPORTED (not swallowed) via
   *     the log_path and the returned exit field.
   */
  async runEnvCmd(
    projectTag: string,
    taskId: string,
    cmd: string,
    envId?: string
  ): Promise<
    | { ok: true; exit: number; log_path: string }
    | { ok: false; httpStatus: number; error: string }
  > {
    const entry = this._resolveEnvEntry(projectTag, taskId, envId);
    if (!entry) {
      return { ok: false, httpStatus: 404, error: "env_not_found: no live environment for this task" };
    }

    const driverPath = resolveDriverPath(entry.driver);
    const timeoutMs = this.config.driverTimeoutMs ?? DEFAULT_DRIVER_TIMEOUT_MS;

    const result = await runDriverVerb(
      driverPath,
      "run",
      { handle: entry.handle, cmd },
      timeoutMs
    );

    if (!result.ok) {
      // I2: driver failure (e.g. process gone) → error, not swallowed
      return { ok: false, httpStatus: 502, error: `driver_run_failed: ${result.error}` };
    }

    const runOut = result.output as RunOutput;
    if (typeof runOut.exit !== "number" || typeof runOut.log_path !== "string") {
      return { ok: false, httpStatus: 502, error: "driver_run_failed: invalid output (missing exit or log_path)" };
    }

    return { ok: true, exit: runOut.exit, log_path: runOut.log_path };
  }

  /**
   * Collect artifacts from a provisioned environment into the task's aggregation directory.
   *
   * S9d7fdb-2 (AC-S9d7fdb-2-3): spec-environment §6 — daemon defines the dest path.
   *
   * D3: events carry path references only, never log bodies.
   */
  async collectEnv(
    projectTag: string,
    taskId: string,
    envId?: string
  ): Promise<
    | { ok: true; dest: string }
    | { ok: false; httpStatus: number; error: string }
  > {
    const entry = this._resolveEnvEntry(projectTag, taskId, envId);
    if (!entry) {
      return { ok: false, httpStatus: 404, error: "env_not_found: no live environment for this task" };
    }

    // Daemon defines the aggregation directory (spec §6: daemon規約, driver writes to dest)
    const dest = this._taskArtifactsDir(projectTag, taskId);

    const driverPath = resolveDriverPath(entry.driver);
    const timeoutMs = this.config.driverTimeoutMs ?? DEFAULT_DRIVER_TIMEOUT_MS;

    const result = await runDriverVerb(
      driverPath,
      "collect",
      { handle: entry.handle, dest },
      timeoutMs
    );

    if (!result.ok) {
      return { ok: false, httpStatus: 502, error: `driver_collect_failed: ${result.error}` };
    }

    return { ok: true, dest };
  }

  /**
   * List artifacts for a task (files under the task's aggregation directory).
   *
   * S9d7fdb-2 (AC-S9d7fdb-2-3): GET /api/v1/projects/:proj/tasks/:taskId/environment/artifacts
   */
  listTaskArtifacts(projectTag: string, taskId: string): string[] {
    const dir = this._taskArtifactsDir(projectTag, taskId);
    if (!fs.existsSync(dir)) return [];
    try {
      return this._listFilesRecursive(dir);
    } catch {
      return [];
    }
  }

  /**
   * List all live environments (from the env ledger).
   *
   * S9d7fdb-2 (AC-S9d7fdb-2-2): GET /api/v1/environments.
   */
  listAllEnvironments(): EnvLedgerEntry[] {
    return this.envLedger.listLive();
  }

  /**
   * List live environments for a specific task.
   */
  listTaskEnvironments(projectTag: string, taskId: string): EnvLedgerEntry[] {
    return this.envLedger.listByTask(projectTag, taskId);
  }

  // ── Private env helpers ───────────────────────────────────────────────────

  /**
   * S9d7fdb-4 (AC-S9d7fdb-4-4): Tear down all live environments for a task.
   *
   * Called when a task reaches a terminal state (failed / closed / superseded).
   * Ensures no external resources outlive the task (spec-environment §5, I3).
   *
   * Idempotent: entries already torn down are skipped (teardownEnv is itself idempotent).
   * I2: teardown failures are logged via stderr; they do NOT swallow silently.
   *     The Story-5 TTL/reconcile tick acts as a second line of defense.
   *
   * Fire-and-forget: caller tracks this via _trackBackground.
   */
  private async _teardownTaskEnvs(projectTag: string, taskId: string): Promise<void> {
    const liveEntries = this.envLedger.listByTask(projectTag, taskId);
    if (liveEntries.length === 0) return;

    for (const entry of liveEntries) {
      if (entry.tornDownAt) continue; // already torn down — idempotent skip
      const result = await this.teardownEnv(projectTag, taskId, entry.envId);
      if (!result.ok) {
        // I2: surface teardown failure — not swallowed. Story-5 TTL tick is the backstop.
        // Write to stderr AND append to event log so the PO can see it via GET /events.
        const errorMsg = result.error;
        process.stderr.write(
          `[banto-daemon] teardown-on-terminal: failed to tear down env ${entry.envId} ` +
            `for task ${projectTag}/${taskId}: ${errorMsg}\n`
        );
        // Append tick_job_failed event so the failure is observable via the event log
        // (I2 observability: PO can see teardown failure at GET /events, not just stderr).
        const failEvent = this.log.append({
          type: "tick_job_failed",
          projectTag,
          jobName: "teardown-on-terminal",
          error: `env ${entry.envId} taskId=${taskId}: ${errorMsg}`,
        });
        this.applyAndBroadcast(failEvent);
      }
    }
    // Trigger gate re-eval so quota-blocked tasks can be promoted now that a slot freed.
    this.runGateReeval();
  }

  // ── Story-5: TTL enforcer ─────────────────────────────────────────────────

  /**
   * TTL enforcer tick (Story-5, AC-S9d7fdb-5-1/5-2).
   *
   * Scans live ledger entries for any with ttlDeadline < now. For each expired entry:
   *   1. Attempt forced teardown via the driver.
   *   2. Retry up to ttlTeardownRetryLimit times (with ttlTeardownRetryDelayMs delay).
   *   3. On success: mark torn down + emit env_torn_down(reason: ttl_expired).
   *   4. On retry exhaustion: mark teardownFailed in ledger + emit card_generated(cadence)
   *      so the PO sees it at the next cadence review. I2: NOT silently dropped.
   *
   * Re-entrancy guard: skips the tick if a previous run is still in-flight.
   * D3: TTL judgments are derived from ledger.ttlDeadline + Date.now() at tick time;
   *     no additional state is persisted for this judgment.
   * D8: escalation card carries the envId, taskId, and projectTag as the origin reference.
   */
  private async _runEnvTtlEnforcer(): Promise<void> {
    if (this._envTtlEnforcerRunning) return;
    this._envTtlEnforcerRunning = true;

    try {
      const now = Date.now();
      const liveEntries = this.envLedger.listLive();
      const expired = liveEntries.filter(
        (e) => !e.teardownFailed && new Date(e.ttlDeadline).getTime() < now
      );

      for (const entry of expired) {
        await this._forceTeardownWithRetry(entry);
      }
    } finally {
      this._envTtlEnforcerRunning = false;
    }
  }

  /**
   * Attempt forced teardown of an expired env entry with bounded retries.
   * On success: markTornDown + env_torn_down(reason: ttl_expired).
   * On exhaustion: markTeardownFailed + card_generated(cadence).
   *
   * I2: each failure attempt is recorded via tick_job_failed before retry.
   * I3: teardown is idempotent; already-gone resources succeed immediately.
   * D8: cadence card carries origin reference (envId, taskId, projectTag).
   */
  private async _forceTeardownWithRetry(entry: EnvLedgerEntry): Promise<void> {
    const retryLimit = this.config.ttlTeardownRetryLimit ?? 3;
    const retryDelayMs = this.config.ttlTeardownRetryDelayMs ?? 1000;
    const driverPath = resolveDriverPath(entry.driver);
    const timeoutMs = this.config.driverTimeoutMs ?? DEFAULT_DRIVER_TIMEOUT_MS;

    for (let attempt = 0; attempt <= retryLimit; attempt++) {
      if (attempt > 0) {
        await new Promise<void>((r) => setTimeout(r, retryDelayMs));
      }

      const result = await runDriverVerb(driverPath, "teardown", { handle: entry.handle }, timeoutMs);
      if (result.ok) {
        // Success: mark as torn down in ledger and emit event.
        this.envLedger.markTornDown(entry.envId);
        const event = this.log.append({
          type: "env_torn_down",
          projectTag: entry.projectTag,
          taskId: entry.taskId,
          envId: entry.envId,
          reason: "ttl_expired",
        });
        this.applyAndBroadcast(event);
        // Trigger gate re-eval so quota-blocked tasks can be promoted.
        this.runGateReeval();
        return;
      }

      // Failure: record via tick_job_failed (I2: never silently dropped).
      const failEvent = this.log.append({
        type: "tick_job_failed",
        projectTag: entry.projectTag,
        jobName: "env-ttl-enforcer",
        error: `ttl teardown attempt ${attempt + 1}/${retryLimit + 1} failed for env ${entry.envId}: ${result.error}`,
      });
      this.applyAndBroadcast(failEvent);
    }

    // Retry limit exhausted: mark ledger entry as teardown_failed (I2: not removed),
    // and file a cadence card so the PO sees it at the next cadence review (D8).
    this.envLedger.markTeardownFailed(entry.envId);

    // Write the cadence card file (D3: event carries only the path reference, not content).
    const cardId = `env-ttl-failed-${entry.envId}-${Date.now()}`;
    const cardsDir = path.join(this.config.dataDir, "cards");
    fs.mkdirSync(cardsDir, { recursive: true });
    const cardPath = path.join(cardsDir, `${cardId}.json`);
    const cardContent = {
      cardId,
      cardType: "cadence",
      title: `TTL teardown failed: env ${entry.envId}`,
      projectTag: entry.projectTag,
      taskId: entry.taskId,
      envId: entry.envId,
      driver: entry.driver,
      ttlDeadline: entry.ttlDeadline,
      retryLimit,
      createdAt: new Date().toISOString(),
    };
    fs.writeFileSync(cardPath, JSON.stringify(cardContent, null, 2), "utf8");

    const cardEvent = this.log.append({
      type: "card_generated",
      projectTag: entry.projectTag,
      taskId: entry.taskId,
      cardId,
      cardType: "cadence",
      cardPath,
    });
    this.applyAndBroadcast(cardEvent);
  }

  // ── Story-5: env reconcile ─────────────────────────────────────────────────

  /**
   * Env reconcile tick (Story-5, AC-S9d7fdb-5-3).
   *
   * For each registered driver (derived from live ledger entries), calls `list`
   * to get the actual resources the driver manages. Compares against the ledger:
   *
   *   Orphan (in driver list, NOT in ledger): emit card_generated(cadence).
   *   Vanished (in ledger, NOT in driver list): remove from ledger + emit env_torn_down(reason: vanished).
   *
   * D3: judgments are derived purely from ledger + driver list at tick time.
   *     No extra mapping file is persisted.
   * I2: driver `list` failure is recorded via tick_job_failed and the tick continues.
   * Re-entrancy guard: skips the tick if a previous run is still in-flight.
   *
   * Naming convention: driver-managed resources that were created by this daemon are
   * expected to carry a name that begins with a taskId from the current ledger.
   * Resources whose names match `<taskId>-*` for any known taskId are ledger-owned.
   * Resources that do NOT match any known taskId are orphans.
   */
  private async _runEnvReconcile(): Promise<void> {
    if (this._envReconcileRunning) return;
    this._envReconcileRunning = true;

    try {
      // Collect all unique drivers from the live env ledger entries.
      const allEntries = this.envLedger.list();
      const liveEntries = this.envLedger.listLive();

      // Build a set of unique drivers to query.
      const driversToQuery = new Set<string>();
      for (const e of allEntries) {
        driversToQuery.add(e.driver);
      }

      for (const driverName of driversToQuery) {
        const driverPath = resolveDriverPath(driverName);
        const timeoutMs = this.config.driverTimeoutMs ?? DEFAULT_DRIVER_TIMEOUT_MS;

        const listResult = await runDriverVerb(driverPath, "list", {}, timeoutMs);
        if (!listResult.ok) {
          // I2: list failure is not swallowed — record and continue to next driver.
          const failEvent = this.log.append({
            type: "tick_job_failed",
            projectTag: "daemon",
            jobName: "env-reconcile",
            error: `driver "${driverName}" list failed: ${listResult.error}`,
          });
          this.applyAndBroadcast(failEvent);
          continue;
        }

        const driverItems = listResult.output as ListOutput;
        if (!Array.isArray(driverItems)) {
          const failEvent = this.log.append({
            type: "tick_job_failed",
            projectTag: "daemon",
            jobName: "env-reconcile",
            error: `driver "${driverName}" list returned non-array`,
          });
          this.applyAndBroadcast(failEvent);
          continue;
        }

        // Entries in the ledger for this driver (including torn-down / failed — we use
        // them to correlate names, so we don't raise orphan alerts for entries the daemon
        // knows about but has already torn down).
        const ledgerEntriesForDriver = allEntries.filter((e) => e.driver === driverName);
        const liveEntriesForDriver = liveEntries.filter((e) => e.driver === driverName);

        // Build a set of "known" names (taskId-prefixed names in the ledger for this driver).
        // A driver item whose name matches a known ledger name is NOT an orphan.
        const knownNames = new Set<string>(
          ledgerEntriesForDriver
            .map((e) => {
              // The process driver uses "<taskId>-env" as the name; docker uses compose project names.
              // The handle carries the name field (if any).
              const handleName = (e.handle as Record<string, unknown>)["name"];
              return typeof handleName === "string" ? handleName : null;
            })
            .filter((n): n is string => n !== null)
        );

        // Also build a set of known envIds (for vanished detection).
        const liveEnvIds = new Set<string>(liveEntriesForDriver.map((e) => e.envId));

        // Detect orphans: in driver list, NOT in ledger (no matching name).
        for (const item of driverItems) {
          if (!knownNames.has(item.name)) {
            // Orphan detected: file a cadence card.
            const cardId = `env-orphan-${driverName.replace(/[^a-zA-Z0-9-]/g, "_")}-${item.name.replace(/[^a-zA-Z0-9-]/g, "_")}-${Date.now()}`;
            const cardsDir = path.join(this.config.dataDir, "cards");
            fs.mkdirSync(cardsDir, { recursive: true });
            const cardPath = path.join(cardsDir, `${cardId}.json`);
            const cardContent = {
              cardId,
              cardType: "cadence",
              title: `Orphan environment detected: ${item.name} (driver: ${driverName})`,
              driver: driverName,
              resourceName: item.name,
              resourceHandle: item.handle,
              resourceCreated: item.created,
              createdAt: new Date().toISOString(),
            };
            fs.writeFileSync(cardPath, JSON.stringify(cardContent, null, 2), "utf8");

            const cardEvent = this.log.append({
              type: "card_generated",
              // Use "daemon" as the projectTag for daemon-internal events that cannot
              // be scoped to a specific project (the orphan has no known project).
              projectTag: "daemon",
              cardId,
              cardType: "cadence",
              cardPath,
            });
            this.applyAndBroadcast(cardEvent);
          }
        }

        // Detect vanished: in ledger (live), NOT in driver list.
        const driverItemNames = new Set<string>(driverItems.map((i) => i.name));
        for (const liveEntry of liveEntriesForDriver) {
          if (liveEntry.teardownFailed) continue; // already escalated — skip
          const handleName = (liveEntry.handle as Record<string, unknown>)["name"];
          if (typeof handleName === "string" && !driverItemNames.has(handleName)) {
            // Vanished: remove from ledger and emit event.
            void liveEnvIds; // suppress unused var warning
            this.envLedger.remove(liveEntry.envId);
            const event = this.log.append({
              type: "env_torn_down",
              projectTag: liveEntry.projectTag,
              taskId: liveEntry.taskId,
              envId: liveEntry.envId,
              reason: "vanished",
            });
            this.applyAndBroadcast(event);
            // Trigger gate re-eval so quota-blocked tasks can be promoted.
            this.runGateReeval();
          }
        }
      }
    } finally {
      this._envReconcileRunning = false;
    }
  }

  private _resolveEnvEntry(
    projectTag: string,
    taskId: string,
    envId?: string
  ): EnvLedgerEntry | undefined {
    if (envId) {
      const e = this.envLedger.get(envId);
      return e && !e.tornDownAt ? e : undefined;
    }
    const live = this.envLedger.listByTask(projectTag, taskId);
    return live[live.length - 1];
  }

  /**
   * Resolve the task-scoped artifact aggregation directory.
   * spec-environment §6: "収集先パスの規約はdaemonが定め、ドライバは渡されたdestに書くのみ"
   *
   * Path: <dataDir>/env-artifacts/<projectTag>/<taskId>
   */
  private _taskArtifactsDir(projectTag: string, taskId: string): string {
    return path.join(this.config.dataDir, "env-artifacts", projectTag, taskId);
  }

  /**
   * Recursively list all files under a directory.
   * Returns absolute paths.
   */
  private _listFilesRecursive(dir: string): string[] {
    const result: string[] = [];
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        result.push(...this._listFilesRecursive(full));
      } else {
        result.push(full);
      }
    }
    return result;
  }

  // ── Internal helpers ───────────────────────────────────────────────────────

  /**
   * Register a background async operation for drain tracking.
   *
   * Background ops (audit/rework session spawns via setImmediate) are registered
   * here so Daemon.stop() can await them all before closing the event log.
   * The promise is removed from the set when it settles (success or error).
   *
   * D3/I2: prevents silent event drops when stop() closes the log while a background
   * op is still in-flight and trying to append (e.g. recordTaskFailed on spawn failure).
   */
  private _trackBackground(p: Promise<void>): void {
    const tracked = p.finally(() => {
      this._backgroundOps.delete(tracked);
    });
    this._backgroundOps.add(tracked);
  }

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
    // Re-entrancy guard: skip if a previous auto-spawn sweep is still awaiting.
    // driver.spawn() takes 200ms–3.2s (get_state probe + fallback), so a 500ms tick
    // can fire before the previous sweep completes, causing double-spawn for the same task.
    if (this._autoSpawnRunning) {
      return;
    }
    this._autoSpawnRunning = true;

    try {
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
    } finally {
      // Always reset so the next tick can proceed (I2: no permanent lock).
      this._autoSpawnRunning = false;
    }
  }

  /**
   * Serial merge queue tick job (S75f66b-5, spec-daemon-core §4.1).
   *
   * Delegates to processMergeQueue() from merge-queue.ts.
   * Passes:
   *   - getProjectRepoPath: looks up project repo from ProjectRegistry
   *   - getAllTasks: delegates to StateStore.getAllTasks()
   *   - onMergeComplete: triggers gate re-eval for dependent tasks
   *
   * Re-entrancy guard (_mergeQueueRunning): skips the tick if a previous call is
   * still awaiting (e.g. git rebase on a large repo took longer than tickIntervalMs).
   * This preserves the serial guarantee even when the scheduler fires multiple ticks
   * before the previous processMergeQueue() completes (review fix S75f66b-5).
   *
   * D3: queue is derived from event log replay inside processMergeQueue().
   * I2: errors propagate to scheduler (recorded as tick_job_failed).
   */
  private async runMergeQueueTick(): Promise<void> {
    // Re-entrancy guard: skip tick if a previous processMergeQueue() is still running.
    // Preserves serial guarantee (spec §4.1) when tick interval < merge processing time.
    if (this._mergeQueueRunning) {
      return;
    }
    this._mergeQueueRunning = true;

    const worktreeBase =
      this.config.worktreeBaseDir ?? path.join(this.config.dataDir, "worktrees");

    try {
    await processMergeQueue(this.log, {
      dataDir: this.config.dataDir,
      worktreeBaseDir: worktreeBase,
      mainline: "main",
      getProjectRepoPath: (projectTag: string) => {
        const proj = this.registry.list().find((p) => p.id === projectTag);
        return proj?.repoPath;
      },
      getAllTasks: () => {
        // Refresh state before reading tasks so we get the latest derived state.
        this.refreshState();
        return this.store.getAllTasks();
      },
      onMergeComplete: (taskId: string, projectTag: string) => {
        // After a merge (or gate fail), trigger gate re-evaluation so any tasks
        // that depended on this task can be promoted to ready.
        this.runGateReeval();
        // Also refresh state + broadcast latest event so HTTP/WS clients are current.
        this.refreshState();
        const allEvents = this.log.readAllEvents();
        if (allEvents.length > 0) {
          const lastEvent = allEvents[allEvents.length - 1];
          this.wsServer.broadcast(lastEvent!);
        }
        // Suppress unused parameter warning (taskId/projectTag used for future logging)
        void taskId;
        void projectTag;
      },
      // S75f66b-6: auto-file conflict task + pause origin on rebase failure.
      onRebaseConflict: async (
        _log,
        originTaskId,
        originProjectTag,
        error,
        conflictedFiles
      ) => {
        await this.handleRebaseConflict(
          originTaskId,
          originProjectTag,
          error,
          conflictedFiles
        );
      },
    });

    // After the tick, always refresh state so in-memory store reflects any changes
    // made by processMergeQueue (transitions appended to the log).
    this.refreshState();
    // Broadcast the latest event (if any new ones were appended)
    const allEvents = this.log.readAllEvents();
    if (allEvents.length > 0) {
      const lastEvent = allEvents[allEvents.length - 1];
      this.wsServer.broadcast(lastEvent!);
    }
    } finally {
      // Always reset the guard so a future tick can proceed (I2: no permanent lock).
      this._mergeQueueRunning = false;
    }
  }
  /**
   * Handle a rebase conflict from the merge queue.
   *
   * S75f66b-6 (AC-S75f66b-6-1):
   *   1. Idempotency guard: if the origin task is already paused, skip filing
   *      (tick may have re-observed the same conflict before the pause settled).
   *   2. File a kind:conflict task to work/tasks/ (next task-NNNN number).
   *      status: queued so the watcher ingests it via the normal path (D4).
   *   3. Pause the origin task (paused, suspended_from=merging).
   *   4. Refresh state + broadcast so HTTP/WS clients reflect the pause.
   *
   * D3: no mapping file written — correspondence is derived from refs[0] in events.
   * D4: conflict task file goes through work/tasks/ + watcher (not direct createTask).
   * I2: any error is logged; does not throw (recorded as tick_job_failed by scheduler).
   */
  private async handleRebaseConflict(
    originTaskId: string,
    originProjectTag: string,
    error: Error,
    conflictedFiles: string[]
  ): Promise<void> {
    // 1. Idempotency guard: if origin is already paused, don't file again.
    //    This covers the case where the tick re-fires before the watcher ingests
    //    the conflict task (the origin stays in merging between the file write and
    //    the watcher's next poll cycle).
    // NOTE: The origin task is currently in `merging` (the merge queue put it there).
    // After we pause it here it becomes `paused`. If the tick fires again before the
    // watcher injects the conflict task, the origin is already paused → skip.
    this.refreshState();
    const originTask = this.store.getTask(originTaskId, originProjectTag);
    if (!originTask) {
      process.stderr.write(
        `[banto-daemon] handleRebaseConflict: origin task ${originProjectTag}/${originTaskId} not found\n`
      );
      return;
    }
    if (originTask.status === "paused") {
      // Already paused (idempotent — the tick re-observed the same conflict). Skip.
      return;
    }

    // 2. Find the project's repo path to write the conflict task file.
    const proj = this.registry.list().find((p) => p.id === originProjectTag);
    if (!proj) {
      process.stderr.write(
        `[banto-daemon] handleRebaseConflict: project ${originProjectTag} not in registry\n`
      );
      // Record as tick_job_failed (I2: not silent).
      this.log.append({
        type: "tick_job_failed",
        projectTag: "daemon",
        jobName: "conflict-filer",
        error: `project ${originProjectTag} not found in registry for conflict task filing`,
      });
      return;
    }

    // 3. File the conflict task (writes to work/tasks/).
    //    The watcher will ingest it via the normal path on its next poll (D4).
    let filed: { taskId: string; filePath: string };
    try {
      filed = fileConflictTask({
        projectTag: originProjectTag,
        originTaskId,
        originTaskTitle: String(originTask["title"] ?? originTaskId),
        originTaskBranch: `task/${originTaskId}`,
        mainline: "main",
        conflictedFiles,
        rebaseErrorMessage: error.message,
        repoPath: proj.repoPath,
      });
    } catch (fileErr) {
      const reason = `conflict task filing failed for ${originProjectTag}/${originTaskId}: ${
        fileErr instanceof Error ? fileErr.message : String(fileErr)
      }`;
      process.stderr.write(`[banto-daemon] ${reason}\n`);
      this.log.append({
        type: "tick_job_failed",
        projectTag: "daemon",
        jobName: "conflict-filer",
        error: reason,
      });
      return;
    }

    process.stdout.write(
      `[banto-daemon] conflict task filed: ${filed.taskId} for origin ${originProjectTag}/${originTaskId} (${filed.filePath})\n`
    );

    // 4. Pause the origin task (suspended_from=merging).
    //    StateMachine.pause() emits state_transitioned(merging→paused) + task_paused.
    const pauseResult = StateMachine.pause(
      this.log,
      originTaskId,
      "merging",
      originProjectTag
    );
    if (!pauseResult.ok) {
      process.stderr.write(
        `[banto-daemon] handleRebaseConflict: failed to pause ${originProjectTag}/${originTaskId}: ${pauseResult.reason}\n`
      );
      // Still continue: the conflict file was already written.
    }

    // Refresh state and broadcast.
    this.refreshState();
    const allEvents = this.log.readAllEvents();
    if (allEvents.length > 0) {
      this.wsServer.broadcast(allEvents[allEvents.length - 1]!);
    }
  }

  /**
   * Conflict resolution outcome check tick job (S75f66b-6, spec-daemon-core §4.2).
   *
   * On each tick, derive paused-origin↔conflict-resolution pairs from the task store (D3).
   * For each pair:
   *   - Resolution task merged/closed → resume origin to merging (re-enters the queue).
   *   - Resolution task failed        → chain-fail origin (I2: stop, don't swallow).
   *
   * D3: correspondence derived from refs[0] (discovered-from convention) — no mapping file.
   * I2: chain-fail is used when resolution fails (origin cannot proceed without resolution).
   */
  private runConflictResolutionCheck(): void {
    this.refreshState();
    const allTasks = this.store.getAllTasks();
    const pairs = deriveOriginResolutionPairs(allTasks);

    for (const pair of pairs) {
      const { originTaskId, originProjectTag, resolutionTaskId, resolutionProjectTag } = pair;

      const resolutionTask = this.store.getTask(resolutionTaskId, resolutionProjectTag);
      if (!resolutionTask) continue;

      const resStatus = resolutionTask.status;

      if (resStatus === "merged" || resStatus === "closed") {
        // Resolution task succeeded → resume origin back to merging.
        // The origin will re-enter the merge queue and be processed on the next tick.
        const originTask = this.store.getTask(originTaskId, originProjectTag);
        if (!originTask || originTask.status !== "paused") continue;

        const resumeResult = StateMachine.resume(
          this.log,
          originTaskId,
          "paused",
          "merging",
          originProjectTag
        );

        if (resumeResult.ok) {
          process.stdout.write(
            `[banto-daemon] conflict resolved: origin ${originProjectTag}/${originTaskId} resumed to merging ` +
              `(resolution ${resolutionProjectTag}/${resolutionTaskId} ${resStatus})\n`
          );
          // AC-S75f66b-6-3: record the origin↔resolution linkage explicitly.
          // A po_operation event captures the correlation so the audit trail shows
          // WHICH resolution task caused the resume (D3: derived from events, not
          // a mapping file; I2: the linkage is in the log, not just ordering).
          this.log.append({
            type: "po_operation",
            projectTag: originProjectTag,
            operation: "conflict_resolved",
            taskId: originTaskId,
            payload: { resolutionTaskId, resolutionProjectTag },
          });
        } else {
          process.stderr.write(
            `[banto-daemon] conflict-resolution-check: resume failed for ${originProjectTag}/${originTaskId}: ${resumeResult.reason}\n`
          );
        }

        this.refreshState();
        const allEvents = this.log.readAllEvents();
        if (allEvents.length > 0) {
          this.wsServer.broadcast(allEvents[allEvents.length - 1]!);
        }

        // Re-evaluate gates so the resumed (merging) task can be processed.
        this.runGateReeval();
      } else if (resStatus === "failed") {
        // Resolution task failed → chain-fail origin (I2: stop, record, don't swallow).
        const originTask = this.store.getTask(originTaskId, originProjectTag);
        if (!originTask || originTask.status !== "paused") continue;

        const failReason = `conflict_resolution_failed: resolution task ${resolutionTaskId} failed`;
        StateMachine.fail(
          this.log,
          originTaskId,
          { currentStatus: "paused", reason: failReason },
          originProjectTag
        );

        process.stdout.write(
          `[banto-daemon] conflict resolution failed: origin ${originProjectTag}/${originTaskId} chain-failed ` +
            `(resolution ${resolutionProjectTag}/${resolutionTaskId} failed)\n`
        );

        this.refreshState();
        const allEvents = this.log.readAllEvents();
        if (allEvents.length > 0) {
          this.wsServer.broadcast(allEvents[allEvents.length - 1]!);
        }
      }
      // If resolution task is still active (not terminal), do nothing on this tick.
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

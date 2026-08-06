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
  parseEnvProfiles as _parseEnvProfiles,
} from "@banto/core";
import type { OrchestrationEvent, TaskStatus, TaskRecord, TransitionResult } from "@banto/core";
import { ProjectRegistry } from "./project-registry.js";
import type { ProjectEntry } from "./project-registry.js";
import { WsEventServer } from "./ws-server.js";
import { createHttpServer } from "./http-server.js";
import { TaskWatcher } from "./task-watcher.js";
import { Scheduler } from "./scheduler.js";
import type { TickJob } from "./scheduler.js";
import { GateEvaluator, evaluatePendingGates } from "./gate-evaluator.js";
import type { QuotaCheck } from "./gate-evaluator.js";
import { addTaskWorktree, createWorktree } from "@banto/repo-manager";
import { processMergeQueue } from "./merge-queue.js";
import {
  fileConflictTask,
  deriveOriginResolutionPairs,
} from "./conflict-filer.js";
// ADR-0013 決定60: 台帳を持つ能力（職人・検証環境）は**モジュールが持つ**。Kobo は
// `worker.*` / `env.*` を**モジュール経由で呼ぶ側**になり、台帳・ドライバ・sops・
// pi の起動をここに持たない
import { createModuleClient } from "@banto/core";
import type { ModuleClient } from "@banto/core";

/**
 * Environment Pool から返る環境の**見え方**（ADR-0013 決定60）。
 *
 * Environment Pool の内部型をそのまま持ち込まない——Kobo が要るのはこれだけで、
 * 全部を写すとモジュールの内部の形に縛られる（決定27b：契約は Tool、実装は相手の都合）。
 */
interface EnvView {
  envId: string;
  profile: string;
  taskId: string;
  projectTag: string;
  state: "live" | "torn-down" | "teardown-failed";
  url?: string;
  ttlDeadline?: string;
}

/** 同上、検証プロファイルの見え方。quota だけがゲートの判定に効く。 */
interface EnvProfileView {
  name: string;
  driver: string;
  quota?: { max_instances: number };
}

/**
 * Kobo が職人を起こすときの名乗り（決定29 の `origin`＝報告の宛先）。
 *
 * 番頭はスレッドごとの `banto:<threadId>` を名乗る。**Kobo 由来の職人がこれで見分けられる**
 * ことが要点で、番頭の職人ビューアにも Kobo の職人が並び（決定18 のドリルダウン）、
 * 番頭からは畳めない（決定63）。
 */
export const KOBO_ORIGIN = "kobo";

/** 職人の役目。Worker Pool 上の taskId の接尾辞になる（`task-0001:audit`）。 */
type WorkerRole = "executor" | "audit" | "rework";

/**
 * Worker Pool 側の taskId。
 *
 * 同じタスクに実装者と監査人が同時に居るので、台帳の鍵（projectTag + taskId）を
 * 分けないと片方が上書きされる。**接尾辞は pi の子プロセスにも `BANTO_TASK_ID` として
 * 渡る**ので、Kobo の拡張（banto-executor / banto-auditor）は `:` の手前だけを使う。
 */
function poolTaskId(taskId: string, role: WorkerRole): string {
  return role === "executor" ? taskId : `${taskId}:${role}`;
}

/** Worker Pool 側の taskId を、タスクと役目に戻す。 */
function splitPoolTaskId(id: string): { taskId: string; role: WorkerRole } {
  const at = id.indexOf(":");
  if (at < 0) return { taskId: id, role: "executor" };
  const suffix = id.slice(at + 1);
  return {
    taskId: id.slice(0, at),
    role: suffix === "audit" || suffix === "rework" ? suffix : "executor",
  };
}

/** モデルの等級。Kobo が知ってよいのはここまで（決定60a）。 */
type ModelTier = "reasoning" | "standard" | "fast";

const TIER_ORDER: ModelTier[] = ["fast", "standard", "reasoning"];

/** タスクが指定した等級。無効な値は既定（standard）に落とす。 */
function taskModelTier(task: TaskRecord): ModelTier {
  const raw = task["model_tier"];
  return TIER_ORDER.includes(raw as ModelTier) ? (raw as ModelTier) : "standard";
}

/**
 * 失敗駆動の昇格（spec-daemon-core §3.5）。監査に落ちた回数だけ一段ずつ上げる。
 *
 * **Kobo がするのは文字列を1つ選ぶことだけ**で、どのモデルになるかは Worker Pool が
 * 決める（決定60a）。
 */
function escalateTier(tier: ModelTier, steps: number): ModelTier {
  const index = Math.min(TIER_ORDER.indexOf(tier) + Math.max(0, steps), TIER_ORDER.length - 1);
  return TIER_ORDER[index]!;
}

/** Worker Pool から返る職人の**見え方**（要るところだけ。決定27b）。 */
interface WorkerView {
  projectTag: string;
  taskId: string;
  origin: string;
  sessionId: string;
  sessionPath: string;
  worktree: string;
  pid: number;
  alive: boolean;
  state: "running" | "waiting" | "exited" | "closed";
}

/** 起こした職人1人分（Kobo が帳簿に残す最小限）。 */
export interface SpawnedSession {
  sessionId: string;
  pid: number;
  /** セッションJSONL の場所（中身ではなく参照だけ。spec §2.1）。 */
  sessionPath: string;
  worktreePath: string;
}

/** 同上、職人に起きたことの見え方（`worker.events`）。 */
interface WorkerEventView {
  id: number;
  type: string;
  origin: string;
  projectTag: string;
  taskId: string;
  sessionId: string;
  data: Record<string, unknown>;
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
   * ワークツリーの置き場を**明示するときだけ**指定する。
   *
   * 既定（未指定）では `gwq` に作らせる（決定60・a6）——置き場所は gwq の設定に従い、
   * そのまま `gwq list` に載る＝番頭と PO が場所として中を読める。ここを指定すると
   * `<worktreeBaseDir>/<projectTag>/<taskId>` に素の `git worktree` で作る。
   * リモートの無いテスト用リポジトリなど、gwq が置き場所を決められない場合の逃げ道。
   */
  worktreeBaseDir?: string;
  /**
   * Maximum number of concurrently-running agent sessions (physical quota, 層B).
   *
   * 数える相手は **Worker Pool に居る Kobo 由来の職人**（決定60：職人の真実は一箇所）。
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
   * Environment Pool の到達先（ADR-0013 決定60・61）。
   *
   * 既定は `BANTO_ENV_POOL_URL`、それも無ければ独立サービスの既定ポート。
   * **どこで動かすかは配置の問題**で、Kobo は URL を1つ知っていればよい（決定27b）。
   */
  environmentPoolUrl?: string;
  /**
   * Worker Pool の到達先（ADR-0013 決定60）。
   *
   * 既定は `BANTO_WORKER_POOL_URL`、それも無ければ番頭ホストに同居している既定の口。
   * Kobo は職人を自分で起こさない——`worker.delegate_toolkit` を呼ぶだけで、
   * pi の起動・台帳・モデルの解決はすべて Worker Pool の仕事。
   */
  workerPoolUrl?: string;
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

  /** Environment Pool（別プロセス）を呼ぶ口。台帳は持たない（決定60）。 */
  private readonly envClient: ModuleClient;

  /** Worker Pool（別プロセス）を呼ぶ口。職人の台帳もセッションも持たない（決定60）。 */
  private readonly workerClient: ModuleClient;

  /**
   * 職人のイベントをどこまで読んだか（`worker.events` の `afterEventId`）。
   *
   * **台帳ではない。** 起動のたびに 0 から読み直し、自分の帳簿に既に `agent_exited` が
   * あるものは飛ばす（D3：写しを永続化せず、帳簿から導く）。落ちている間に終わった職人も
   * これで拾える——Kobo が居ない間の出来事を取りこぼさないのが決定29c の要点。
   */
  private _workerCursor = 0;

  /** 職人のイベントを引く tick の再入防止。 */
  private _workerEventsRunning = false;

  /**
   * 依存ゲートの物理quota 用の**短命の写し**（決定36j と同じ扱い）。
   * 台帳ではない——プロセスが終われば消え、ゲートの tick の頭で取り直す（D3）。
   */
  private _envQuotaView: {
    perProfile: Map<string, number>;
    profileQuota: Map<string, number>;
  } = { perProfile: new Map(), profileQuota: new Map() };

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
   * S75f66b-5 E2E fix: 職人の起動は数百ミリ秒かかる。次の tick が先に走ると、同じ
   * 「ready のまま・まだ職人が居ない」タスクを2つの tick が見て二重に起こしてしまう。
   *
   * Fix: same pattern as _mergeQueueRunning — skip if already running.
   * Always reset in finally{} so a panicking inner call never permanently locks spawning.
   */
  private _autoSpawnRunning = false;

  /**
   * In-flight spawn map: deduplicates concurrent spawnTask() calls for the same task.
   *
   * 職人が Worker Pool の台帳に載るのは起動が終わったあとで、その間タスクは "ready" のまま
   * ——待っている間に別の呼び出し（auto-spawn の tick と明示の spawnTask）が来ると、
   * 1つのタスクに職人が2人つく。最初の呼び出しの Promise を共有して1人に保つ。
   *
   * Invariant: key is `${projectTag}/${taskId}`. Removed in finally{} of spawnTask().
   * D3: this is NOT persisted — it only exists for the lifetime of one spawnTask() call.
   */
  private readonly _inFlightSpawns: Map<string, Promise<SpawnedSession>> = new Map();

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


  private constructor(config: DaemonConfig) {
    this.config = config;
    this.log = EventLog.open(config.dataDir);
    this.store = StateStore.replay(this.log);
    this.index = EventIndex.build(this.log);
    this.registry = ProjectRegistry.open(config.dataDir);

    // ADR-0013 決定60: 検証環境の台帳は Environment Pool が持つ。Kobo は呼ぶ側になり、
    // 到達先を1つ知っているだけでよい（決定27b：呼び出しは当事者間で直接）
    this.envClient = createModuleClient({
      modules: {
        "environment-pool": {
          baseUrl:
            config.environmentPoolUrl ??
            process.env["BANTO_ENV_POOL_URL"] ??
            "http://127.0.0.1:4400/api/environment-pool",
        },
      },
    });

    // ADR-0013 決定60: 職人の台帳・セッション・**モデルの解決**は Worker Pool が持つ。
    // Kobo は「誰に何をさせるか」を渡すだけで、pi も provider も model も知らない（決定60a）
    this.workerClient = createModuleClient({
      modules: {
        "worker-pool": {
          baseUrl:
            config.workerPoolUrl ??
            process.env["BANTO_WORKER_POOL_URL"] ??
            "http://127.0.0.1:4100/api/worker-pool",
        },
      },
    });

    this.httpServer = createHttpServer(this);
    this.wsServer = new WsEventServer(this.httpServer, (projectTag) =>
      this.log.getEventsByProject(projectTag)
    );
    this.watcher = new TaskWatcher(this, config.watchIntervalMs);

    // GateEvaluator: implements spec-multi-project §3 three-condition gate.
    //
    // 物理quota（条件3）は **Environment Pool に聞いた短命の写し**で判定する
    // （ADR-0013 決定60。以前は Kobo が自分の EnvLedger を数えていた——台帳が2つあり
    // 番頭が立てた環境が対象外だった。inc-0027）。写しはゲートの tick の頭で取り直す。
    //
    // 上限そのものは能力側が持ち、超えた provision は拒否される（決定34f）。ここでの
    // 判定は**職人を起こす前に止める**ための手前側の砦で、無くても事故にはならない。
    const daemonRef = this;
    const envQuotaCheck: QuotaCheck = {
      check(task: import("@banto/core").TaskRecord): boolean {
        const profileName = typeof task["environment"] === "string" ? task["environment"] : undefined;
        if (!profileName) return true; // 環境が要らないタスクは素通し

        const max = daemonRef._envQuotaView.profileQuota.get(profileName);
        if (max === undefined) return true; // プロファイルに quota が無ければ制限しない

        const live = daemonRef._envQuotaView.perProfile.get(profileName) ?? 0;
        return live < max;
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
    // 物理quota の写しを**取り直してから**判定する（決定60）。環境の一覧は別プロセスに
    // 聞くので非同期になるが、ゲートの判定自体は同期のまま——tick の頭で取り直すことで
    // 「判定の直前に取り直した写し」を保つ（決定36j と同じ形）
    this.scheduler.registerJob("gate-reeval", async () => {
      await this.refreshEnvQuotaView();
      this.runGateReeval();
    });

    // Built-in job: auto-spawn (S75f66b-2, spec-daemon-core §6).
    // Enumerates ready tasks from derived state (D3: no separate bookkeeping) and
    // asks the Worker Pool for a worker for any that has none yet.
    // Physical quota (maxConcurrentSessions) is checked against the Worker Pool's live
    // workers first; when full, skip silently — no rejection event, re-evaluated on next
    // tick (I2-compliant: quota-skip is not an error; spawn failures go to recordTaskFailed).
    // disableAutoSpawn: test suites that test gate/quota logic can opt out of auto-spawn.
    if (!config.disableAutoSpawn) {
      this.scheduler.registerJob("auto-spawn", () => {
        void this.runAutoSpawn();
      });
    }

    // Built-in job: 職人に起きたことを引き取る（ADR-0013 決定60・決定29c）。
    // 以前は `driver.subscribe` で自分が起こしたプロセスの終了を直に見ていたが、職人を
    // 起こすのが Worker Pool になったので、**イベントログを追いかける**形に変わる。
    // `afterEventId` があるので、Kobo が落ちている間に終わった職人も取りこぼさない。
    this.scheduler.registerJob("worker-events", () => this.runWorkerEventsTick());

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

    // 期限の執行（TTL）と照合は **Environment Pool が持つ**（ADR-0013 決定60）。
    // 以前はここに tick があったが、台帳が2つあるため番頭が立てた環境は対象外だった
    // ——「作った者が片付ける」を能力側に寄せた（決定32e・inc-0027）。
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
      maxConcurrentSessions:
        config.maxConcurrentSessions ??
        // parseInt of a non-numeric env value yields NaN, and `size >= NaN` is
        // always false (quota silently unenforced) — fall back to the default.
        (Number.parseInt(process.env["BANTO_MAX_CONCURRENT_SESSIONS"] ?? "5", 10) || 5),
      disableAuditSpawn: config.disableAuditSpawn ?? false,
      disableAutoSpawn: config.disableAutoSpawn ?? false,
      ...(config.environmentPoolUrl !== undefined
        ? { environmentPoolUrl: config.environmentPoolUrl }
        : {}),
      ...(config.workerPoolUrl !== undefined ? { workerPoolUrl: config.workerPoolUrl } : {}),
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

  /**
   * Start listening. Returns a promise that resolves when the server is bound.
   *
   * **再起動時に職人を畳まない**（ADR-0013 決定60・63）。以前はここで spawn 台帳から
   * 孤児を引き取り、生きているプロセスを SIGTERM で落として task_failed にしていた。
   * 職人の面倒を見るのは Worker Pool の仕事になったので、Kobo は**帳簿に追いつくだけ**
   * ——`worker-events` の tick が、落ちている間に終わった職人を拾う。
   */
  async start(): Promise<void> {
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

    // 照合（台帳と実物の突き合わせ）は、職人も検証環境も**持ち主が回す**
    // （ADR-0013 決定60）。Kobo に照合の tick は無い。
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

  // ── 職人（Worker Pool 経由・ADR-0013 決定60）─────────────────────────────────
  //
  // **Kobo は職人を自分で起こさない。** 起動・台帳・セッションファイル・モデルの解決・
  // 生存確認・畳みは、すべて Worker Pool が持つ（決定29c：職人の真実は一箇所）。
  // 以前はここに SpawnLedger・PiRpcDriver の直呼び・孤児回収・tmux 窓があり、
  // **Kobo が起こした職人は番頭の worker.list にも職人ビューアにも出なかった**（inc-0027 と同型）。
  //
  // ここに残るのは統治の都合だけ：
  //   - 誰に何をさせるか（実装・監査・rework の指示文と等級）
  //   - 起きたことを自分の帳簿へ写す（agent_spawned / agent_exited / audit_started）
  //   - 済んだ職人を畳む（I3：起こした者が片付ける。番頭には畳めない・決定63）
  //
  // **モデル名は知らない**（決定60a）。渡すのは tier だけで、解決は Worker Pool。

  /** Worker Pool の Tool を呼ぶ。到達できなければ投げる（I2）。 */
  private async workerInvoke(
    tool: string,
    args: Record<string, unknown> = {}
  ): Promise<Record<string, unknown>> {
    const result = await this.workerClient.invoke("worker-pool", tool, args);
    return (result.details ?? {}) as Record<string, unknown>;
  }

  /**
   * いま Worker Pool に居る **Kobo 由来の**職人。
   *
   * D3: 数えるための写しを持たない。物理quota も「もう職人が居るか」も、毎回ここから導く
   * ——Kobo が落ちて戻ってきても、実態と食い違わない。
   */
  private async liveKoboWorkers(): Promise<WorkerView[]> {
    const details = await this.workerInvoke("worker.list", {
      includeClosed: false,
      // 既定のページは 20 件。物理quota（既定5）より十分に大きく取る
      limit: 200,
    });
    const workers = (details["workers"] ?? []) as WorkerView[];
    return workers.filter((w) => w.origin === KOBO_ORIGIN && w.alive);
  }

  /**
   * 指定の役目の職人が居れば畳む（起こす前・役目を終えたあと）。
   *
   * Worker Pool の台帳は projectTag + taskId で1人なので、前の職人が生きたまま同じ鍵で
   * 起こすと**台帳から溢れてプロセスだけが残る**。畳んでから起こす。
   *
   * I2: 畳めなかったことは記録に残すが、統治は止めない（安全弁が後で拾う）。
   */
  private async closeWorkerFor(projectTag: string, poolId: string): Promise<void> {
    let workers: WorkerView[];
    try {
      workers = await this.liveKoboWorkers();
    } catch (err) {
      process.stderr.write(
        `[banto-daemon] 職人の一覧を引けませんでした（${projectTag}/${poolId}）: ${String(err)}\n`
      );
      return;
    }
    for (const worker of workers) {
      if (worker.projectTag !== projectTag || worker.taskId !== poolId) continue;
      try {
        await this.workerInvoke("worker.close", { sessionId: worker.sessionId });
      } catch (err) {
        process.stderr.write(
          `[banto-daemon] 職人を畳めませんでした（${worker.sessionId}）: ${String(err)}\n`
        );
      }
    }
  }

  /**
   * 職人を1人起こす（`worker.delegate_toolkit`）。
   *
   * `driverOptions` を渡せる内部の口を使うのは、**Kobo が自分の拡張を載せる**ため
   * （banto-executor / banto-auditor が `report_phase` / `audit_report` を提供する。決定29e）。
   * 番頭にこの口は渡らない——LLM に任意のコードを載せさせないため。
   */
  private async delegateWorker(opts: {
    projectTag: string;
    taskId: string;
    role: WorkerRole;
    worktreePath: string;
    instruction: string;
    modelTier: ModelTier;
    extension: "banto-executor" | "banto-auditor";
  }): Promise<SpawnedSession> {
    const poolId = poolTaskId(opts.taskId, opts.role);
    // 同じ鍵の職人が残っていたら畳んでから起こす（台帳の鍵は1つ）
    await this.closeWorkerFor(opts.projectTag, poolId);

    const details = await this.workerInvoke("worker.delegate_toolkit", {
      taskId: poolId,
      projectTag: opts.projectTag,
      origin: KOBO_ORIGIN,
      worktreePath: opts.worktreePath,
      instruction: opts.instruction,
      modelTier: opts.modelTier,
      driverOptions: {
        // 職人が Kobo の口を叩くための到達先（拡張が環境変数で受け取る）
        daemonUrl: `http://localhost:${this.port}`,
        projectTag: opts.projectTag,
        extensionPaths: [
          new URL(`./pi-extension/${opts.extension}.ts`, import.meta.url).pathname,
        ],
      },
    });

    const sessionId = String(details["sessionId"] ?? "");
    // I2: 「起こした」と返ってきたのに誰なのか分からない状態を、成功として先へ進めない
    // ——sessionId が無ければ、以後この職人を見ることも畳むこともできなくなる
    if (sessionId.length === 0) {
      throw new Error(
        `Worker Pool が職人の識別子を返しませんでした（${opts.projectTag}/${poolId}）: ` +
          JSON.stringify(details)
      );
    }
    return {
      sessionId,
      pid: Number(details["pid"] ?? 0),
      sessionPath: String(details["sessionPath"] ?? ""),
      worktreePath: opts.worktreePath,
    };
  }

  /**
   * タスクのワークツリーを用意する（決定60・a6）。
   *
   * 既定では **gwq に作らせる**——置き場所は gwq の設定に従い、そのまま場所として
   * 番頭にも PO にも見える。`worktreeBaseDir` を明示した構成（リモートの無いテスト用
   * リポジトリなど）だけ、素の `git worktree` でそこに作る。
   *
   * 冪等：監査・rework は実装者と同じワークツリーを見る必要がある。
   */
  private async ensureWorktree(projectTag: string, taskId: string): Promise<string> {
    const repoPath = this.registry.list().find((p) => p.id === projectTag)?.repoPath ?? "";
    const base = this.config.worktreeBaseDir;
    if (base || repoPath.length === 0) {
      const worktreePath = path.join(
        base ?? path.join(this.config.dataDir, "worktrees"),
        projectTag,
        taskId
      );
      if (repoPath) await createWorktree(repoPath, worktreePath);
      return worktreePath;
    }
    const { path: worktreePath } = await addTaskWorktree({
      repoPath,
      branch: `task/${taskId}`,
    });
    return worktreePath;
  }

  /**
   * そのタスクのワークツリー（帳簿から引く。D3）。
   *
   * 置き場所を決めるのは gwq なので、**Kobo は組み立てられない**——起こしたときに
   * `agent_spawned.worktree` に残してあるものを読む。まだ職人を起こしていないタスクは
   * 明示の置き場（または既定）の見込みのパスを返す（マージキューの後始末が使う）。
   */
  private worktreeOf(projectTag: string, taskId: string): string {
    const events = this.index.getTaskHistory(taskId, projectTag);
    for (let i = events.length - 1; i >= 0; i--) {
      const ev = events[i]!;
      if (ev.type === "agent_spawned" && ev.worktree) return ev.worktree;
      if (ev.type === "audit_started" && ev.worktree) return ev.worktree;
    }
    return path.join(
      this.config.worktreeBaseDir ?? path.join(this.config.dataDir, "worktrees"),
      projectTag,
      taskId
    );
  }

  /**
   * 実装の職人を1人つける（タスクは "ready" であること）。
   *
   * Workflow:
   *   1. Validate the task is in "ready" state.
   *   2. ワークツリーを用意する（gwq、または明示の置き場）。
   *   3. Worker Pool に職人を起こしてもらう（指示・等級つき）。
   *   4. Append agent_spawned event — session path reference only (spec §2.1).
   *   5. Transition task → "planning" (state machine enforces the guard).
   *
   * I2: any failure (worktree, delegate) appends task_failed + task never transitions.
   */
  async spawnTask(projectTag: string, taskId: string): Promise<SpawnedSession> {
    // 0. In-flight deduplication: 起動には時間がかかり、その間タスクは "ready" のまま
    //    ——待っている間に来た2つ目の呼び出しは、同じ Promise に相乗りさせる
    const spawnKey = `${projectTag}/${taskId}`;
    const existing = this._inFlightSpawns.get(spawnKey);
    if (existing) return existing;

    const spawnPromise = this._spawnTaskBody(projectTag, taskId).finally(() => {
      this._inFlightSpawns.delete(spawnKey);
    });
    this._inFlightSpawns.set(spawnKey, spawnPromise);
    return spawnPromise;
  }

  // Inner implementation extracted to allow finally cleanup on all paths.
  private async _spawnTaskBody(projectTag: string, taskId: string): Promise<SpawnedSession> {
    // 1. Validate task state
    const task = this.store.getTask(taskId, projectTag);
    if (!task) throw new Error(`Task '${taskId}' not found in project '${projectTag}'`);
    if (task.status !== "ready") {
      throw new Error(
        `Task '${taskId}' must be in 'ready' state to spawn (current: ${task.status})`
      );
    }

    // 2. ワークツリー（無ければ作る）
    let worktreePath: string;
    try {
      worktreePath = await this.ensureWorktree(projectTag, taskId);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      this.recordTaskFailed(projectTag, taskId, `worktree creation failed: ${reason}`);
      throw err;
    }

    // 3. 職人を起こす。等級はタスクの `model_tier`（既定 standard）
    const modelTier = taskModelTier(task);
    let session: SpawnedSession;
    try {
      session = await this.delegateWorker({
        projectTag,
        taskId,
        role: "executor",
        worktreePath,
        instruction: buildExecutorInstruction(task, worktreePath),
        modelTier,
        extension: "banto-executor",
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      this.recordTaskFailed(projectTag, taskId, `spawn failed: ${reason}`);
      throw err;
    }

    // 4. Append agent_spawned event — session path reference ONLY (spec §2.1)
    const spawnedEvent = this.log.append({
      type: "agent_spawned",
      projectTag,
      taskId,
      pid: session.pid,
      sessionPath: session.sessionPath,
      worktree: worktreePath,
      modelTier,
      sessionId: session.sessionId,
    });
    this.applyAndBroadcast(spawnedEvent);

    // 5. Transition to "planning"
    this.transition(projectTag, taskId, "planning", "agent spawned");

    return session;
  }

  /**
   * 職人に起きたことを引き取る（決定29c・決定60）。
   *
   * `worker.events` を `afterEventId` で辿り、**自分が起こした職人の分だけ**を写す。
   * 起動時は 0 から読み直し、既に `agent_exited` を書いてあるセッションは飛ばす
   * （D3：どこまで読んだかを別に保存しない。帳簿から導く）。
   *
   * I2: Worker Pool へ届かないことを「何も起きていない」と混同しない——理由を残して
   *     次の tick に賭ける（写しを進めない）。
   */
  private async runWorkerEventsTick(): Promise<void> {
    if (this._workerEventsRunning) return;
    this._workerEventsRunning = true;
    try {
      // 1回の tick で辿るページ数の上限。溜まっていても次の tick で続きを読む
      for (let page = 0; page < 10; page++) {
        let events: WorkerEventView[];
        try {
          const details = await this.workerInvoke("worker.events", {
            afterEventId: this._workerCursor,
            origin: KOBO_ORIGIN,
            limit: 100,
          });
          events = (details["events"] ?? []) as WorkerEventView[];
        } catch (err) {
          process.stderr.write(
            `[banto-daemon] 職人のイベントを引けませんでした: ${String(err)}\n`
          );
          return;
        }
        if (events.length === 0) return;
        for (const event of events) {
          this.applyWorkerEvent(event);
          this._workerCursor = Math.max(this._workerCursor, event.id);
        }
        if (events.length < 100) return;
      }
    } finally {
      this._workerEventsRunning = false;
    }
  }

  /**
   * 職人の1件の出来事を、Kobo の帳簿とステートマシンへ写す。
   *
   * **意味を与えるのは起動元**（決定29d）。Worker Pool は中立な事実を並べるだけで、
   * 「監査人が判定を出さずに終わった＝失敗」という読みは Kobo の統治の話。
   */
  private applyWorkerEvent(event: WorkerEventView): void {
    // 終わった（exited）か畳まれた（closed）ものだけを見る。報告・質問は Kobo の
    // 経路（report_done / audit_report）に来るので、ここでは二重に読まない
    if (event.type !== "worker_exited" && event.type !== "worker_closed") return;

    const { taskId, role } = splitPoolTaskId(event.taskId);
    const projectTag = event.projectTag;
    const history = this.index.getTaskHistory(taskId, projectTag);

    // 自分が起こした職人か（帳簿に起動の記録があるか）
    const spawned = history.some(
      (e) => e.type === "agent_spawned" && e.sessionId === event.sessionId
    );
    if (!spawned) return;
    // 既に書いてあるものは飛ばす（起動時に 0 から読み直すので、必ず通る道）
    const already = history.some(
      (e) => e.type === "agent_exited" && e.sessionId === event.sessionId
    );
    if (already) return;

    const exitedEvent = this.log.append({
      type: "agent_exited",
      projectTag,
      taskId,
      pid: Number(event.data["pid"] ?? 0),
      exitCode: (event.data["exitCode"] ?? null) as number | null,
      signal: (event.data["signal"] ?? null) as string | null,
      sessionId: event.sessionId,
    });
    this.applyAndBroadcast(exitedEvent);

    // I2: 判定・報告を出さずに終わった職人を「まだ動いている」ことにしない。
    // 以前は spawn 台帳の照合 tick が pid の死を見て task_failed にしていた——
    // 職人を持たなくなっても、**止まったことに気づく責任は Kobo に残る**
    const current = this.store.getTask(taskId, projectTag);
    if (!current) return;
    if (role === "audit" && current.status === "auditing") {
      process.stderr.write(
        `[banto-daemon] 監査が判定を出さずに終わりました（${projectTag}/${taskId}）\n`
      );
      this.recordTaskFailed(projectTag, taskId, "audit_session_exited_without_verdict");
      return;
    }
    if (
      (role === "executor" || role === "rework") &&
      (current.status === "planning" || current.status === "implementing")
    ) {
      process.stderr.write(
        `[banto-daemon] 実装の職人が報告せずに終わりました（${projectTag}/${taskId}）\n`
      );
      this.recordTaskFailed(projectTag, taskId, "agent_exited_without_report");
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
   * Private helper used by spawnTask error paths and the worker-event tick.
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

    // 失敗したタスクの職人を畳む（I3：起こした者が片付ける）。
    // 番頭には畳めない（決定63）ので、放っておくと Worker Pool の安全弁（既定15分）まで
    // プロセスが残る。**畳むのは非同期**なので、他の後始末と同じく背景の仕事として追う
    this._trackBackground(
      (async () => {
        for (const role of ["executor", "audit", "rework"] as const) {
          await this.closeWorkerFor(projectTag, poolTaskId(taskId, role));
        }
      })()
    );

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
      // 物理quota の写しを取り直してから判定する（決定60）。**昇格は戻せない**ので、
      // 古い写しで「空いている」と読むと、上限が埋まっているタスクを ready にしてしまう
      this._trackBackground(
        this.refreshEnvQuotaView().then(() => {
          this.runGateReeval();
        })
      );

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

      // S9d7fdb-7 (AC-S9d7fdb-7-1, AC-S9d7fdb-7-2): Auto-provision env on review-ready→in-review.
      // When a task with an `environment` field enters in-review, provision its env automatically
      // so the PO gets something they can actually touch（決定59。tmux ペインは廃止した）.
      //
      // Design rules:
      //   D5: all orchestration logic here; HTTP layer is pure routing.
      //   I2: provision failure MUST NOT block the transition — it is surfaced as an event.
      //       The transition to in-review is already committed (D3); this hook is fire-and-forget.
      //   D3: we read task.environment from the state store (the event-derived record),
      //       not from disk directly — the event log is the single runtime truth.
      if (toStatus === "in-review") {
        // Fire-and-forget: tracked so Daemon.stop() drains before log.close() (D3/I2: no drops).
        this._trackBackground(new Promise<void>((resolve) => {
          setImmediate(() => void this._autoProvisionOnReview(projectTag, taskId).then(resolve, resolve));
        }));
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
   * `auditing` に入ったタスクに監査人を1人つける。
   *
   * S75f66b-3 (AC-S75f66b-3-1, AC-S75f66b-3-2):
   *   - 起こすのは Worker Pool（決定60）。載せる拡張は banto-auditor で、
   *     監査のシステムプロンプトとチェックリスト（skills/audit-*.md）は拡張が自分で読む
   *     （D2: 判断基準はテキスト、機構はコード）。
   *   - Emits audit_started event with session path reference (spec §2.1).
   *   - 等級は reasoning（spec §3.5：監査は一段上）。**モデル名は Kobo が知らない**（決定60a）。
   *
   * I2: 起こせなかったら task_failed にして止まる。
   */
  private async spawnAuditSession(projectTag: string, taskId: string): Promise<void> {
    const task = this.store.getTask(taskId, projectTag);
    if (!task) {
      process.stderr.write(
        `[banto-daemon] spawnAuditSession: task ${projectTag}/${taskId} not found\n`
      );
      return;
    }

    // 実装者と同じワークツリーを見る（帳簿から引く。組み立てない）
    const worktreePath = this.worktreeOf(projectTag, taskId);

    // 実装の職人はもう用済み（報告を出して auditing に入っている）。畳んでから監査を起こす
    // ——放っておくと安全弁の時間までプロセスが残る（I3）
    await this.closeWorkerFor(projectTag, poolTaskId(taskId, "executor"));
    await this.closeWorkerFor(projectTag, poolTaskId(taskId, "rework"));

    let session: SpawnedSession;
    try {
      session = await this.delegateWorker({
        projectTag,
        taskId,
        role: "audit",
        worktreePath,
        instruction: buildAuditInstruction(task, projectTag, taskId, worktreePath),
        modelTier: "reasoning",
        extension: "banto-auditor",
      });
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
      sessionPath: session.sessionPath,
      worktree: worktreePath,
    });
    this.applyAndBroadcast(auditStartedEvent);

    // Also emit agent_spawned so the session is in the ledgerless bookkeeping too
    // （どの職人を起こしたかは帳簿にだけ残る。ここから職人ビューアへ辿れる）
    const spawnedEvent = this.log.append({
      type: "agent_spawned",
      projectTag,
      taskId,
      pid: session.pid,
      sessionPath: session.sessionPath,
      worktree: worktreePath,
      modelTier: "reasoning",
      sessionId: session.sessionId,
    });
    this.applyAndBroadcast(spawnedEvent);
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
      // 監査人の役目は終わり。畳む（I3：起こした者が片付ける・決定63）
      this._trackBackground(this.closeWorkerFor(projectTag, poolTaskId(taskId, "audit")));
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
        // これ以上動かす職人は居ない。畳む（recordTaskFailed を通らない経路なのでここでも）
        this._trackBackground(
          (async () => {
            for (const role of ["executor", "audit", "rework"] as const) {
              await this.closeWorkerFor(projectTag, poolTaskId(taskId, role));
            }
          })()
        );
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
   * 監査に落ちたタスクへ、指摘を渡した実装の職人をもう1人つける。
   *
   * S75f66b-3 (AC-S75f66b-3-4): 1回目の不通過で `implementing` に戻り、監査の指摘を
   * **指示文に書き切って**新しい職人へ渡す（職人は記憶を持たない・D11）。
   *
   * **等級を一段上げる**（spec-daemon-core §3.5 の失敗駆動の昇格）。Kobo がするのは
   * 渡す tier の文字列を変えることだけで、どのモデルになるかは Worker Pool が決める（決定60a）。
   *
   * I2: 起こせなかったら task_failed にして止まる。
   */
  private async spawnReworkSession(
    projectTag: string,
    taskId: string,
    findings: string[]
  ): Promise<void> {
    const task = this.store.getTask(taskId, projectTag);
    if (!task) {
      process.stderr.write(
        `[banto-daemon] spawnReworkSession: task ${projectTag}/${taskId} not found\n`
      );
      return;
    }

    // 実装者と同じワークツリーで直す（作り直すと、直す対象が消える）
    const worktreePath = this.worktreeOf(projectTag, taskId);

    // 監査人はもう役目を終えている。畳んでから rework を起こす
    await this.closeWorkerFor(projectTag, poolTaskId(taskId, "audit"));

    // 落ちた回数だけ等級を上げる（1回目の不通過 → 一段上で直させる）
    const fails = this.countConsecutiveAuditFails(projectTag, taskId);
    const modelTier = escalateTier(taskModelTier(task), fails);

    let session: SpawnedSession;
    try {
      session = await this.delegateWorker({
        projectTag,
        taskId,
        role: "rework",
        worktreePath,
        instruction: buildExecutorInstruction(task, worktreePath, findings),
        modelTier,
        extension: "banto-executor",
      });
    } catch (err) {
      const reason = `rework session spawn failed: ${err instanceof Error ? err.message : String(err)}`;
      this.recordTaskFailed(projectTag, taskId, reason);
      return;
    }

    const spawnedEvent = this.log.append({
      type: "agent_spawned",
      projectTag,
      taskId,
      pid: session.pid,
      sessionPath: session.sessionPath,
      worktree: worktreePath,
      modelTier,
      sessionId: session.sessionId,
    });
    this.applyAndBroadcast(spawnedEvent);
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

  // ── 検証環境（Environment Pool 経由・ADR-0013 決定60）───────────────────────
  //
  // **Kobo は検証環境の台帳を持たない。** 台帳・TTL 執行・照合・sops の復号は
  // Environment Pool が持つ（決定60：台帳を持つ能力はモジュール経由。二重に持つと
  // 真実が割れる・D3。以前は同じ EnvLedger が両方で開かれていた——inc-0027）。
  //
  // ここに残るのは**統治の都合**だけ：
  //   - レビューに入ったら環境を立てる（`_autoProvisionOnReview`）
  //   - タスクが終わったら畳む（`_teardownTaskEnvs`）
  //   - 依存ゲートの物理quota（立てられないものを ready にしない）
  //
  // 呼び出しは当事者間で直接（決定27b）。Banto は経路に入らない。
  // I2: 到達できないことを「環境が無い」と混同しない——理由をイベントに残して止まる。

  /** Environment Pool の `env.*` を呼ぶ。到達できなければ投げる（I2）。 */
  private async envInvoke(
    tool: string,
    args: Record<string, unknown> = {}
  ): Promise<Record<string, unknown>> {
    const result = await this.envClient.invoke("environment-pool", tool, args);
    return (result.details ?? {}) as Record<string, unknown>;
  }

  /**
   * 立っている環境の一覧（Environment Pool の台帳が真実）。
   *
   * @param filter `projectTag` / `taskId` で絞る。`includeTornDown` で畳んだものも含む
   */
  async listEnvironments(
    filter: { projectTag?: string; taskId?: string; includeTornDown?: boolean } = {}
  ): Promise<EnvView[]> {
    const details = await this.envInvoke("env.list", filter);
    return (details["environments"] ?? []) as EnvView[];
  }

  /**
   * そのプロジェクトで使える検証プロファイル。
   *
   * D3: Kobo は写しを持たない。読むのは Environment Pool で、Kobo は聞くだけ
   * （プロファイルの解釈も上限の当てはめも能力側の仕事・決定34f）。
   */
  async getEnvironmentProfiles(
    projectTag: string
  ): Promise<{ usable: EnvProfileView[]; rejected: Array<{ name: string; reason: string }> }> {
    const proj = this.registry.get(projectTag);
    if (!proj) return { usable: [], rejected: [] };
    const details = await this.envInvoke("env.list_profiles", { repoPath: proj.repoPath });
    return {
      usable: (details["usable"] ?? []) as EnvProfileView[],
      rejected: (details["rejected"] ?? []) as Array<{ name: string; reason: string }>,
    };
  }

  /**
   * タスクの検証環境を1つ立てる。
   *
   * 立てるのは Environment Pool。Kobo が残すのは「どのタスクのために頼んだか」だけ
   * （台帳は持たない）。失敗は黙って握らず `env_provision_failed` に理由を残す（I2）。
   */
  async provisionEnv(
    projectTag: string,
    taskId: string,
    profileName: string
  ): Promise<{ ok: true; envId: string } | { ok: false; reason: string }> {
    const proj = this.registry.get(projectTag);
    if (!proj) {
      return { ok: false, reason: `project_not_found: ${projectTag}` };
    }

    let summary: EnvView & { driver?: string; healthcheck?: { ok: boolean; detail?: string } };
    try {
      summary = (await this.envInvoke("env.provision", {
        repoPath: proj.repoPath,
        profile: profileName,
        taskId,
        projectTag,
      })) as unknown as EnvView & {
        driver?: string;
        healthcheck?: { ok: boolean; detail?: string };
      };
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      const failed = this.log.append({
        type: "env_provision_failed",
        projectTag,
        taskId,
        profileName,
        reason,
      });
      this.applyAndBroadcast(failed);
      return { ok: false, reason };
    }

    const event = this.log.append({
      type: "env_provisioned",
      projectTag,
      taskId,
      envId: summary.envId,
      profileName: summary.profile ?? profileName,
      driver: summary.driver ?? "",
      healthcheck: summary.healthcheck ?? { ok: true },
    });
    this.applyAndBroadcast(event);
    return { ok: true, envId: summary.envId };
  }

  /**
   * 環境を1つ畳む。
   *
   * 畳むのは Environment Pool。**冪等**（既に畳んであっても成功する）なのは
   * Environment Pool 側の性質で、Kobo は結果を記録するだけ。
   */
  async teardownEnv(
    projectTag: string,
    taskId: string,
    envId: string,
    reason?: "ttl_expired" | "vanished"
  ): Promise<{ ok: boolean; reason?: string }> {
    try {
      await this.envInvoke("env.teardown", { envId });
    } catch (err) {
      // I2: 畳めなかったことを成功に見せない。残骸は Environment Pool の台帳に残る
      const detail = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[banto-daemon] env.teardown(${envId}) に失敗: ${detail}\n`);
      return { ok: false, reason: detail };
    }
    const event = this.log.append({
      type: "env_torn_down",
      projectTag,
      taskId,
      envId,
      ...(reason ? { reason } : {}),
    });
    this.applyAndBroadcast(event);
    return { ok: true };
  }

  // ── レビューに入ったら環境を立てる（S9d7fdb-7・決定59）─────────────────────

  /**
   * `in-review` に入ったタスクに `environment` があれば、その環境を立てる。
   *
   * 決定59：**PO の判断が要るものは、見るだけでなく触れる状態で差し出す。**
   * tmux ペインは廃止した（Kobo から tmux 依存を外す）——見る面はキャンバスの
   * ブラウザビュー／セッションビューアが担う。公開URLを判断待ちに添えるのは
   * epic-0010 の3段目。
   *
   * I2: provision の失敗は遷移を巻き戻さない。既に遷移は成立しており（D3）、
   *     失敗は `env_provision_failed` として見えるようにする。
   */
  private async _autoProvisionOnReview(projectTag: string, taskId: string): Promise<void> {
    try {
      const task = this.store.getTask(taskId, projectTag);
      if (!task) return;

      const profileName = typeof task["environment"] === "string" ? task["environment"] : undefined;
      if (!profileName) return;

      // 二重に立てない：既にこのタスクの環境が生きていれば何もしない
      // （再度 in-review に入ったとき、プロファイルに quota が無いと1つずつ漏れる）
      let live: EnvView[];
      try {
        live = await this.listEnvironments({ projectTag, taskId });
      } catch (err) {
        // I2: **到達できないことを黙ってログだけにしない。** ここで落ちると
        // provisionEnv まで届かず、番頭からは「レビューに入ったが環境が無い」理由が
        // 分からなくなる。頼めなかったことを記録として残す
        const reason = err instanceof Error ? err.message : String(err);
        const failed = this.log.append({
          type: "env_provision_failed",
          projectTag,
          taskId,
          profileName,
          reason,
        });
        this.applyAndBroadcast(failed);
        return;
      }
      if (live.length > 0) return;

      await this.provisionEnv(projectTag, taskId, profileName);
    } catch (err) {
      // I2: ここで落としても遷移は既に成立している。理由をログに出して続ける
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(
        `[banto-daemon] _autoProvisionOnReview(${projectTag}/${taskId}): ${msg}\n`
      );
    }
  }

  /**
   * タスクが終端状態（failed / superseded / closed）に入ったら、その環境を畳む。
   *
   * **作った者が片付ける**（I3：外部リソースの消し忘れは金銭的実害）。期限による
   * 強制の畳みは Environment Pool が持つが、タスクの終わりを知っているのは Kobo だけ。
   */
  private async _teardownTaskEnvs(projectTag: string, taskId: string): Promise<void> {
    try {
      const live = await this.listEnvironments({ projectTag, taskId });
      for (const env of live) {
        await this.teardownEnv(projectTag, taskId, env.envId);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[banto-daemon] _teardownTaskEnvs(${projectTag}/${taskId}): ${msg}\n`);
    }
  }

  // ── 依存ゲートの物理quota（決定36j と同じ「待たせない写し」）────────────────
  //
  // ゲートの判定は同期で回る（`GateEvaluator.check`）が、環境の一覧は別プロセスに
  // 聞くので非同期になる。そこで**ゲートの tick の頭で取り直した短命の写し**を使う。
  // 台帳ではない——プロセスが終われば消え、次の tick で必ず取り直す（D3）。
  //
  // 上限そのものは能力側（Environment Pool）が持ち、超えた provision は拒否される
  // （決定34f）。ここでの判定は**職人を起こす前に止める**ためのもので、二重の砦の
  // 手前側にあたる——無くても事故にはならないが、無いと無駄に職人が動く。

  /** ゲートの tick の頭で取り直す写し。空なら「まだ聞けていない」＝止めない。 */
  private async refreshEnvQuotaView(): Promise<void> {
    try {
      const live = await this.listEnvironments({});
      const perProfile = new Map<string, number>();
      for (const env of live) {
        perProfile.set(env.profile, (perProfile.get(env.profile) ?? 0) + 1);
      }

      const profileQuota = new Map<string, number>();
      for (const project of this.registry.list()) {
        const { usable } = await this.getEnvironmentProfiles(project.id);
        for (const profile of usable) {
          if (profile.quota?.max_instances !== undefined) {
            profileQuota.set(profile.name, profile.quota.max_instances);
          }
        }
      }
      this._envQuotaView = { perProfile, profileQuota };
    } catch (err) {
      // I2: 聞けなかったことを「空いている」とも「埋まっている」とも解釈しない。
      // 写しを更新せず、前回の値のまま次の tick に賭ける（黙って通さない・止めない）
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[banto-daemon] 検証環境の写しを取り直せませんでした: ${msg}\n`);
    }
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

      // 「いま何人動いているか」は Worker Pool に聞く（決定60：職人の真実は一箇所）。
      // I2: 聞けないときは起こさない——数えられないまま起こすと、上限が効かない
      let workers: WorkerView[];
      try {
        workers = await this.liveKoboWorkers();
      } catch (err) {
        process.stderr.write(
          `[banto-daemon] 職人の一覧を引けないので auto-spawn を見送ります: ${String(err)}\n`
        );
        return;
      }
      let live = workers.length;
      const busy = new Set(workers.map((w) => `${w.projectTag}/${w.taskId}`));

      // Check quota FIRST — if already at limit, skip the whole sweep.
      if (live >= maxSessions) {
        return;
      }

      // Enumerate ready tasks from derived state (D3: no extra flag).
      const readyTasks = this.store.getAllTasks().filter((t) => t.status === "ready");

      for (const task of readyTasks) {
        // Re-check quota each iteration — previous spawns in this loop count.
        if (live >= maxSessions) {
          break;
        }

        // 既に職人が付いているタスクは飛ばす（起動の途中で ready のまま見えるため）
        if (busy.has(`${task.projectTag}/${task.id}`)) {
          continue;
        }
        live++;

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

    try {
    await processMergeQueue(this.log, {
      dataDir: this.config.dataDir,
      // 置き場所を決めるのは gwq なので、**組み立てずに帳簿から引く**（決定60・a6）。
      // 職人が付いたことがないタスク（テストが手で作ったワークツリー）は既定の置き場
      getWorktreePath: (projectTag: string, taskId: string) =>
        this.worktreeOf(projectTag, taskId),
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

// ── 職人へ渡す指示（ADR-0013 決定60）───────────────────────────────────────────
//
// **職人は記憶を持たない**（D11）。前提・目的・完了条件は毎回ここに書き切る。
// 立場（実装者・監査人であること）と作法は pi 拡張が載せるので、ここに書くのは
// **このタスク固有のこと**だけ（D2: 判断基準はテキスト、機構はコード）。
//
// tmux は使わない（決定59）。職人の様子を覗くのはセッションビューア（決定18）で、
// Kobo から tmux 依存は消えている。

/** 受け入れ基準を読める形に並べる。 */
function formatAcceptance(task: TaskRecord): string[] {
  const raw = (task as Record<string, unknown>)["acceptance"];
  if (!Array.isArray(raw)) return ["- (基準未指定)"];
  const rows = (raw as Array<Record<string, unknown>>).map((a) => {
    const id = String(a["id"] ?? "");
    const text = String(a["text"] ?? "");
    const verify = a["verify"] ? ` （検証コマンド: \`${String(a["verify"])}\`）` : "";
    return `- [${id}] ${text}${verify}`;
  });
  return rows.length > 0 ? rows : ["- (基準未指定)"];
}

/** スコープ（変更してよいパス）を並べる。 */
function formatScope(task: TaskRecord): string[] {
  const scope = (task as Record<string, unknown>)["scope"] as Record<string, unknown> | undefined;
  const paths = Array.isArray(scope?.["paths"]) ? (scope["paths"] as unknown[]).map(String) : [];
  return paths.length > 0 ? paths.map((p) => `- ${p}`) : ["- (スコープ未指定)"];
}

/**
 * 実装（と rework）の職人への指示。
 *
 * **コミットまでが仕事**（決定62a）。コミットが無いとマージキューが持っていくものが無く、
 * 「実装したのに何も起きない」で止まる——ここを書き落とすと通しで壊れる。
 */
export function buildExecutorInstruction(
  task: TaskRecord,
  worktreePath: string,
  findings: string[] = []
): string {
  const taskId = task.id;
  const body = typeof task["body"] === "string" ? task["body"].trim() : "";
  const lines = [
    `## 実装タスク ${taskId}`,
    ``,
    `**タイトル**: ${String(task["title"] ?? taskId)}`,
    `**種別**: ${String(task["kind"] ?? "task")}`,
    `**作業ディレクトリ**: ${worktreePath}`,
    `**ブランチ**: task/${taskId}（このブランチにコミットする）`,
    ``,
    `**スコープ（変更してよいパス）**:`,
    ...formatScope(task),
    ``,
    `**受け入れ基準**:`,
    ...formatAcceptance(task),
  ];

  // 依頼そのもの（タスク定義の本文）。**ここが本題**で、上は契約
  if (body.length > 0) {
    lines.push(``, `## 依頼`, ``, body);
  }

  if (findings.length > 0) {
    lines.push(
      ``,
      `## 監査の指摘（前回の提出で見つかった問題）`,
      ``,
      `以下を解決してから report_done を呼んでください:`,
      ...findings.map((f) => `- ${f}`)
    );
  }

  lines.push(
    ``,
    `## 手順`,
    ``,
    `1. \`report_phase\` を phase="implementing" で呼び、着手を知らせる`,
    `2. 受け入れ基準を満たす実装を、**スコープ内のパスだけ**で行う`,
    `3. 検証コマンドがあれば自分で実行して、通ることを確かめる（I1：通ったつもりで出さない）`,
    `4. \`git add\` して \`task/${taskId}\` ブランチにコミットする`,
    `   （必要なら \`git config user.email\` / \`user.name\` を先に設定する）`,
    ``,
    `**コミットが無いとマージできません。** 変更を残さずに終えないでください。`,
    `5. \`report_done\` を summary つきで呼ぶ`,
    ``,
    `**重要**: 終わったら必ず \`report_done\` を呼んでください。呼ばないと監査へ進みません。`
  );
  return lines.join("\n");
}

/**
 * 監査人への指示。
 *
 * 監査の観点そのもの（チェックリスト）は拡張が `skills/audit-*.md` から載せる。
 * ここに書くのは**このタスクを見るために要る事実**——どこに何があり、何を満たすべきか。
 */
export function buildAuditInstruction(
  task: TaskRecord,
  projectTag: string,
  taskId: string,
  worktreePath: string
): string {
  return [
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
    ...formatScope(task),
    ``,
    `**受け入れ基準 (acceptance criteria)**:`,
    ...formatAcceptance(task),
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
}

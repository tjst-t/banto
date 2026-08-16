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
 *   - Scheduler (periodic tick jobs: gate re-evaluation, rotation, etc.)
 *
 * D3: state is derived from events, never written directly.
 * D5: all logic lives here; HTTP/WS layers are pure routing/transport.
 * I2: errors propagate; no silent swallowing.
 */

import * as http from "node:http";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  EventLog,
  StateStore,
  EventIndex,
  StateMachine,
  parseEnvProfiles as _parseEnvProfiles,
  // realign 第2便: 滞留と「何に対して」は帳簿から導出する（保存しない・D3）
  dwellMs,
  lastObservableChangeAt,
  stalledAlreadyRecorded,
  currentBlockedBy,
  contractVersionOf,
  DEFAULT_DWELL_WARN_MINUTES,
  promptAssetDigest,
  loadPromptAsset,
  VALID_TASK_KINDS,
} from "@banto/core";
import type {
  OrchestrationEvent,
  TaskStatus,
  TaskRecord,
  TransitionResult,
  SettingsSection,
} from "@banto/core";
import type { RoleAssignments, KoboRole } from "./kobo-settings.js";
import { ProjectRegistry } from "./project-registry.js";
import type { ProjectEntry } from "./project-registry.js";
import { WsEventServer } from "./ws-server.js";
import { createHttpServer } from "./http-server.js";
import { Scheduler } from "./scheduler.js";
import type { TickJob } from "./scheduler.js";
import { GateEvaluator, evaluatePendingGates, fileMatchesGlob } from "./gate-evaluator.js";
import type { QuotaCheck } from "./gate-evaluator.js";
import { addTaskWorktree, createWorktree } from "@banto/repo-manager";
import { processMergeQueue } from "./merge-queue.js";
// `getAcceptance` は第3便（自動着地の証拠）が使う。`readTaskDefinition` は main 側で
// 解消タスクへ検査コマンドを写すために入れたものだが、**第4便で解消タスクごと消えた**
// ——定義ファイルを読む経路も無くなったので、ここでは取らない
import { getAcceptance, type GateVerifyRunner } from "./merge-gate.js";
import {
  DEFAULT_VERIFY_PROFILE,
  autoLandBlockers,
  loadProjectConfig,
  resolveReviewStage,
  type ProjectConfig,
  type ReviewStage,
} from "./review-policy.js";
import {
  assignAcceptanceIds,
  contractFromRecord,
  contractPayload,
  nextTaskNumber,
  taskFilePath,
  writeTaskRecord,
  TASKS_DIR,
  type TaskContract,
  type TaskContractAmendment,
  type TaskContractInput,
} from "./task-record.js";
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
  /**
   * ドライバごとの設定。**Kobo はここを解釈しない**（決定60a）——例外は
   * 「人が触れる面を持つか」だけで、`profileIsTouchable` がその1点を見る（理由はそこに書いた）。
   */
  config?: Record<string, unknown>;
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

/**
 * いま働いている職人の識別子（帳簿の最後の `agent_spawned`）。
 *
 * 工房の帳簿はどこまで読んだかを持たないので、再起動すると過去の報告がもう一度流れる。
 * **いまの試行の分だけを読む**ための物差し（PO報告 2026-08-11）。
 */
function latestSpawnedSessionId(history: readonly OrchestrationEvent[]): string | undefined {
  for (let i = history.length - 1; i >= 0; i--) {
    const ev = history[i];
    if (ev?.type === "agent_spawned" && ev.sessionId) return ev.sessionId;
  }
  return undefined;
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

/**
 * 監査人を起こし直す上限（1回の auditing につき。PO報告 2026-08-07）。
 *
 * **判定を出さずに落ちるのは「判断」ではなく「事故」**なので、やり直させる。監査が
 * fail の判定を出したときは1回やり直させる（`countConsecutiveAuditFails`）のに、
 * 監査人が落ちたときは0回で failed にしていた——粘る回数が逆になっていた。
 *
 * 2 なのは、事故なら2回目で通ることが多く、通らないなら**中身の問題**（監査の指示が
 * 大きすぎる・文脈が入り切らない等）なので、回数を増やしても同じ壁に当たるため。
 */
const AUDIT_ATTEMPT_LIMIT = 2;

/**
 * コンフリクトで戻したことの印（第4便）。
 *
 * **新しいイベント型は足していない。** `state_transitioned` の任意フィールド `reason` に
 * この接頭辞で書き、数えるときはこれで拾う。帳簿の形は外に累積する one-way な選択で、
 * 増やすなら PO の判断が要る（D9）——`reason` で足りるなら足さない。
 *
 * 加えて機構の都合もある: `StateStore.applyEvent` は知らない type を見ると throw する
 * （I2: 版ずれを黙って無視しない）。新しい type を本番の帳簿に書いた後で巻き戻すと、
 * **古い版の Kobo が帳簿を再生できず起動できない**。
 */
const CONFLICT_RETRY_REASON = "rebase_conflict";

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

/**
 * 畳むときに**止まらなかった**職人（PO 裁定 2026-08-14）。
 *
 * 「止められませんでした」だけでは番頭は動けない——どのセッションが走り続けているかを
 * 名指しできて初めて、工房の口（`worker.close` / `worker.list`）で追える。
 */
export interface UnstoppedWorker {
  sessionId: string;
  error: string;
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
  /**
   * Port to listen on. Default: 4500.
   *
   * **3000 は使わない**（2026-08-07・inc-0032）。最も一般的な dev サーバの既定で、
   * **受け持つプロジェクトの検証がそこを使う**。実際に loamium のテストが
   * 「3000 に何も居ないこと」を確かめており、Kobo が居るせいで永久に落ちていた。
   * 他人のテストを走らせるのが仕事の機構が、いちばん混む番地に居てはいけない。
   */
  port: number;
  /**
   * 待ち受けるアドレス（ADR-0010 決定40・task-0061）。**既定は 127.0.0.1**。
   *
   * この口は**帳簿を書き換えられる**——状態遷移も監査判定も認証なしで受ける。番頭側を
   * 127.0.0.1 に閉じた隣で、無認証の口が全インターフェースに出ていた（`0.0.0.0`）。
   * 広げるのは明示のときだけで、そのときは起動ログに警告を出す（黙って広がらない）。
   * 外から使うなら前段（Caddy 等）で守る。`BANTO_DAEMON_BIND` で差し替えられる。
   */
  bindHost?: string;
  /** Root data directory (event log + registry). Default: ./data */
  dataDir: string;
  /**
   * 役割ごとの職人の当て方（設定画面が書く。PO裁定 2026-08-10）。
   *
   * 渡すと**次の起動でも効く**。渡さなければメモリだけに載る（試験はこちら）。
   */
  roleAssignmentsSection?: SettingsSection;
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
   * When true, do not register the serial merge-queue tick job.
   *
   * **試験のためだけの口**（`disableAuditSpawn` / `disableAutoSpawn` と同じ筋）。
   * マージキューは `approved` のタスクを毎 tick 拾い、rebase → マージ前ゲートまで進む。
   * その道は**プロジェクトの repoPath を実際に触る**——リポジトリが無ければ rebase 失敗
   * として扱われ、`work/tasks/` に衝突解決タスクを書き、origin を `paused` にする。
   * つまり「approved まで進めるだけ」の試験が、走らせる場所（そのパスに書けるか）で
   * 結果を変える。ゲート判定だけを見る試験はこれを切って器から独立させる。
   * Default: false（本番ではマージキューは常に回る）。
   */
  disableMergeQueue?: boolean;
  /**
   * Environment Pool の到達先（ADR-0013 決定60・61）。
   *
   * 既定は `BANTO_ENV_POOL_URL`、それも無ければ独立サービスの既定ポート。
   * **どこで動かすかは配置の問題**で、Kobo は URL を1つ知っていればよい（決定27b）。
   */
  environmentPoolUrl?: string;
  /**
   * 検証を回す場所の差し替え（task-0075）。**試験のためだけの口**。
   *
   * 省略時は `gateVerifyRunner()`＝Environment Pool 経由。本番でここを渡すと
   * 「ホストで検証する」に戻せてしまうので、**設定ファイルからは渡せない**
   * （コンストラクタ引数だけ）。マージキューの筋道を見る受け入れテストが、
   * docker を毎回立てずに済ませるために使う。
   */
  verifyRunner?: GateVerifyRunner;
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
   * 役割ごとの職人の当て方（実装／手直し／監査に、どの等級・どのモデルを当てるか）。
   *
   * **PO が決めるもので、Kobo は当てはめるだけ**（D5）。決定60a はモデル名を Kobo から
   * 遠ざけていたが、PO裁定 2026-08-10 で名指しの口が開いた——解決（provider・鍵・
   * tier→モデルの表）は Worker Pool のままで、ここが持つのは**渡す名前**だけ。
   */
  private _roleAssignments: RoleAssignments = {};

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
    // 役割ごとの当て方は、渡されていれば前回の設定を読み戻す（D3：真実はファイル1つ）
    const savedRoles = config.roleAssignmentsSection?.read()["roleAssignments"];
    if (savedRoles && typeof savedRoles === "object") {
      this._roleAssignments = savedRoles as RoleAssignments;
    }
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
    // disableMergeQueue: ゲート判定だけを見る試験は、repoPath を触るこの道を切れる。
    if (!config.disableMergeQueue) {
      this.scheduler.registerJob("merge-queue", () => this.runMergeQueueTick());
    }

    /**
     * **止まっているものを見つけて言う**（realign 第2便・rethink C-3 第1手）。
     *
     * 状態は「いつからその状態か」を答えられなかったので、何日詰まっていても誰も
     * 気づけなかった（実測 19.2h / 28.6h / 16.8h）。滞在時間は帳簿から導出できる
     * ——足りなかったのは、それを見て閾値と比べる者だけだった。
     */
    this.scheduler.registerJob("dwell-watch", () => {
      this.runDwellWatch();
    });

    // 期限の執行（TTL）と照合は **Environment Pool が持つ**（ADR-0013 決定60）。
    // 以前はここに tick があったが、台帳が2つあるため番頭が立てた環境は対象外だった
    // ——「作った者が片付ける」を能力側に寄せた（決定32e・inc-0027）。
  }

  static create(config: Partial<DaemonConfig> = {}): Daemon {
    const resolved: DaemonConfig = {
      port: config.port ?? parseInt(process.env["BANTO_PORT"] ?? "4500", 10),
      // 決定40: 既定は 127.0.0.1。広げるのは明示だけ（この口は帳簿を書き換えられる）
      bindHost: config.bindHost ?? process.env["BANTO_DAEMON_BIND"] ?? "127.0.0.1",
      dataDir: config.dataDir ?? process.env["BANTO_DATA_DIR"] ?? "./data",
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
      // 止血の口（inc-0063）: 先頭が詰まってマージキュー全体が止まったとき、
      // コードを触らずに（＝ユニット定義の1行で）この道だけ切れるようにする。
      // 他の設定と同じく引数が優先で、無ければ環境変数を見る。
      disableMergeQueue:
        config.disableMergeQueue ??
        ["1", "true"].includes(
          (process.env["BANTO_DISABLE_MERGE_QUEUE"] ?? "").trim().toLowerCase()
        ),
      ...(config.environmentPoolUrl !== undefined
        ? { environmentPoolUrl: config.environmentPoolUrl }
        : {}),
      ...(config.workerPoolUrl !== undefined ? { workerPoolUrl: config.workerPoolUrl } : {}),
      ...(config.roleAssignmentsSection !== undefined
        ? { roleAssignmentsSection: config.roleAssignmentsSection }
        : {}),
      ...(config.verifyRunner !== undefined ? { verifyRunner: config.verifyRunner } : {}),
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
    const bindHost = this.config.bindHost ?? "127.0.0.1";
    if (bindHost !== "127.0.0.1" && bindHost !== "localhost") {
      // 決定40: 黙って広い口を開けない。**Kobo は認証を持たない**——前段で守られて
      // いない経路から、状態遷移も監査判定も直接受ける
      process.stderr.write(
        `[banto-daemon] ${bindHost} で待ち受けます。**Kobo は認証を持ちません**——` +
          "前段（Caddy 等）で守られていない経路から、帳簿を書き換える口に直接届きます\n"
      );
    }

    await new Promise<void>((resolve, reject) => {
      this.httpServer.once("error", reject);
      this.httpServer.listen(this.config.port, bindHost, () => {
        process.stdout.write(
          `[banto-daemon] listening on ${bindHost}:${this.config.port} (dataDir=${this.config.dataDir})\n`
        );
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

    // 決定67: 上限と監査の関係を起動時に言う（設定の誤りが黙って効かない形にしない）
    this.warnAboutTierCeiling();

    // 照合（台帳と実物の突き合わせ）は、職人も検証環境も**持ち主が回す**
    // （ADR-0013 決定60）。Kobo に照合の tick は無い。
  }

  /** Stop the daemon gracefully. */
  async stop(): Promise<void> {
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

  // ── 制御の弁（PO 裁定 2026-08-13・inc-0063）─────────────────────────────────
  //
  // **載せる判断を可逆にする**ための3つの口。inc-0063 で、マージキューが空 rebase を
  // 「コンフリクト未解消」と読んで解消タスクを1分ごとに起票し続けたとき、番頭には
  // 止める手段が1つも無かった——外す口も、取り込みを止める口も、キューを止める口も。
  //
  // D5: 判断（何が動いているか・外していいか）はここに置く。Tool は受け渡しだけ。
  // D3: 状態の真実は projects.json（`ProjectRegistry`）1箇所。導出できる写しを持たない。

  /**
   * 受け持ちを外すのを止める状態＝**いま人か機械が手をかけているもの**（PO 裁定 2026-08-13）。
   *
   * `queued` や `review-ready` を入れていないのは、待っているだけのものまで塞ぐと、
   * 詰まったプロジェクトを降ろせなくなるため——ただし**数えて名前は出す**（下の警告）。
   */
  private static readonly UNREGISTER_BLOCKING_STATES: ReadonlySet<string> = new Set<TaskStatus>([
    "ready",
    "planning",
    "implementing",
    "auditing",
    "merging",
  ]);

  /** 外れずに残る（＝終端でない）状態。force で外すとき「何を置き去りにするか」に使う。 */
  private static readonly UNREGISTER_PENDING_STATES: ReadonlySet<string> = new Set<TaskStatus>([
    "queued",
    "review-ready",
    "in-review",
    "approved",
    "paused",
    "failed",
  ]);

  /** マージキューを回してよいプロジェクトか。外れているものは false。 */
  mergeQueueEnabledFor(projectTag: string): boolean {
    return this.registry.isEnabled(projectTag, "mergeQueue");
  }

  /**
   * **積む口の弁**が開いているか（第4便で意味が変わった）。
   *
   * もとは「watcher が `work/tasks/*.md` を読むか」だった。watcher を廃止したので、
   * 同じ弁を**積むこと自体**に付け替えている——さもないと、PO が「このプロジェクトへは
   * 積むな」と閉じた弁が watcher と一緒に消え、何も守らなくなる（実際、稼働中の台帳には
   * banto の弁が閉じたまま入っている）。台帳に保存済みの値はそのまま効く。
   */
  enqueueEnabledFor(projectTag: string): boolean {
    return this.registry.isEnabled(projectTag, "watch");
  }

  /** 弁を閉じた理由。積めなかったときにそのまま返す（黙って止まっているのが一番困る）。 */
  private enqueueStopReason(projectTag: string): string | undefined {
    return this.registry.list().find((p) => p.id === projectTag)?.watch?.reason;
  }

  /**
   * 受け持ちを外す。**帳簿は消さない**——外れるのは受け持ちだけで、タスクの記録と
   * イベントはそのまま残る（同じ id で登録し直せば繋がる）。
   *
   * I2: 動いているタスクがあるときは**黙って外さない**。何が動いているかを名指しして
   * 断り、`force: true` を明示したときだけ外す。
   */
  unregisterProject(
    id: string,
    opts: { reason: string; force?: boolean; by?: string }
  ):
    | { ok: true; entry: ProjectEntry; active: TaskRecord[]; pending: TaskRecord[] }
    | { ok: false; reason: string; active: TaskRecord[] } {
    if (!this.registry.has(id)) {
      const known = this.registry.list().map((p) => p.id).join(", ");
      return {
        ok: false,
        reason: `"${id}" は受け持っていません（既知: ${known || "(なし)"}）`,
        active: [],
      };
    }

    // 状態の真実は帳簿。読む前に取り直す（tick の途中で変わっている）
    this.refreshState();
    const tasks = this.store.getTasksByProject(id);
    const active = tasks.filter((t) => Daemon.UNREGISTER_BLOCKING_STATES.has(t.status));
    const pending = tasks.filter((t) => Daemon.UNREGISTER_PENDING_STATES.has(t.status));

    if (active.length > 0 && opts.force !== true) {
      // I2: 「外せませんでした」だけでは調べ直しになる。何が動いているかを名指しする
      const named = active.map((t) => `${t.id} [${t.status}]`).join(" / ");
      return {
        ok: false,
        reason:
          `${id} には動いているタスクが ${active.length} 件あります: ${named}。` +
          "職人や検証環境が付いたまま外すと、終わったことを誰も引き取れなくなります" +
          "——先に畳む（kobo.abandon）か、承知の上なら force: true を明示してください",
        active,
      };
    }

    const entry = this.registry.unregister(id)!;
    // 帳簿には残す。**外したこと自体が後から読めないと、消えた理由が誰にも分からない**
    this.log.append({
      type: "po_operation",
      projectTag: id,
      operation: "project_unregistered",
      payload: {
        repoPath: entry.repoPath,
        reason: opts.reason,
        by: opts.by ?? "banto",
        forced: opts.force === true,
        activeTaskIds: active.map((t) => t.id),
        pendingTaskIds: pending.map((t) => t.id),
      },
    });
    return { ok: true, entry, active, pending };
  }

  /**
   * 取り込み（watcher）／マージキューの弁を切り替える。
   *
   * 永続化は `ProjectRegistry` が同期で書き切る——**再起動したら消える設定では止血に
   * ならない**（この口が要る場面は、まさに Kobo を再起動できないときである）。
   */
  setProjectControl(
    id: string,
    which: "watch" | "mergeQueue",
    enabled: boolean,
    opts: { reason: string; by?: string }
  ): { ok: true; entry: ProjectEntry } | { ok: false; reason: string } {
    const entry = this.registry.setControl(id, which, enabled, opts.reason);
    if (!entry) {
      const known = this.registry.list().map((p) => p.id).join(", ");
      return {
        ok: false,
        reason: `"${id}" は受け持っていません（既知: ${known || "(なし)"}）`,
      };
    }
    this.log.append({
      type: "po_operation",
      projectTag: id,
      operation: which === "watch" ? "project_watch_set" : "project_merge_queue_set",
      payload: { enabled, reason: opts.reason, by: opts.by ?? "banto" },
    });
    return { ok: true, entry };
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

  // ── 入口（番頭が積む・ADR-0013 決定58、第4便で唯一の入口になった）─────────────

  /**
   * 仕事を積む（`kobo.enqueue` の実体）。**Kobo へ入る口はここだけ**（第4便）。
   *
   * 番頭は依頼の中身を渡すだけで、`task-NNNN` を決めない。Kobo が採番し、記録ファイル
   * （`work/tasks/task-NNNN.md`）を書き、`task_created` を出す——この順。
   *
   * **契約は引数から凍る**（決定62c）。ファイルを読み戻して契約を作る経路はもう無い
   * ので、あとから md を直しても契約は動かない。以前は「watcher が既存タスクを読み
   * 飛ばすこと」がその砦だったが、いまは**そもそも読まない**のが砦である。
   *
   * I2: 積めない理由（弁が閉じている・必須が欠けている・書けない・上限超え）を
   *     それぞれ返す。**ファイルが書けなかったら積まない**（PO 指示）。
   */
  enqueueTask(
    projectTag: string,
    input: TaskContractInput,
    options: { originRef: string; origin?: string }
  ):
    | { ok: true; taskId: string; path: string; status: string }
    | { ok: false; reason: string } {
    const project = this.registry.list().find((p) => p.id === projectTag);
    if (!project) {
      const known = this.registry.list().map((p) => p.id).join(", ");
      return {
        ok: false,
        reason: `Kobo は "${projectTag}" というプロジェクトを知りません。既知: ${known || "(なし)"}`,
      };
    }

    // **止めてある口へは積まない**（第4便）。理由をそのまま返す——「なぜ止まっているか」が
    // 分からないと、番頭は同じことを繰り返すか、勝手に開けにいく
    if (!this.enqueueEnabledFor(projectTag)) {
      const why = this.enqueueStopReason(projectTag) ?? "理由の記録がありません";
      return {
        ok: false,
        reason:
          `${projectTag} は積む口が止まっています: ${why}\n` +
          "開けてよいかは PO の判断です（kobo.set_watch で開けられますが、勝手に開けないこと）",
      };
    }

    const validated = this.validateContractInput(input);
    if (!validated.ok) return validated;

    // 決定67: 費用の上限は**積む時点で拒否**する。黙って下の等級へ丸めない
    const ceiling = this.projectConfig(projectTag).limits.maxModelTier;
    const requested = validated.contract.model_tier;
    if (ceiling && requested && TIER_ORDER.indexOf(requested) > TIER_ORDER.indexOf(ceiling)) {
      return {
        ok: false,
        reason:
          `model_tier: ${requested} を求めていますが、このプロジェクトの上限は ${ceiling} です` +
          "（meta/config.yaml の limits.max_model_tier）。等級を下げるか、上限を上げるかを" +
          "決めてから積んでください——黙って丸めません（決定67）",
      };
    }

    // 採番：記録ファイルの最大と帳簿の最大の両方を見る（PO 指示）
    let taskId: string;
    try {
      const ledgerIds = this.store
        .getAllTasks()
        .filter((t) => t.projectTag === projectTag)
        .map((t) => t.id);
      taskId = `task-${nextTaskNumber(path.join(project.repoPath, TASKS_DIR), ledgerIds)}`;
    } catch (err) {
      return { ok: false, reason: `採番できませんでした: ${String(err)}` };
    }

    // 記録を書く。**書けなかったら積まない**（PO 指示・I2）
    const written = writeTaskRecord(project.repoPath, taskId, validated.contract);
    if (!written.ok) return written;

    try {
      this.createTask(projectTag, taskId, validated.contract.title, {
        ...contractPayload(validated.contract),
        // 決定58: 宛先（積んだスレッド）と経緯。**Kobo は経緯を知らない**ので、
        // 積むときに受け取っておかないと、判断を求める札が「起きたこと」しか書けない
        ...(options.origin ? { origin: options.origin } : {}),
        originRef: options.originRef,
        enqueuedBy: options.origin ? "banto" : "api",
      });
    } catch (err) {
      // 記録は残す（消しにいかない）。番号は飛ぶが、飛んだ番号は次の採番が避ける
      return {
        ok: false,
        reason: `task_created failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    const result = this.transition(projectTag, taskId, "queued", "kobo.enqueue");
    if (!result.ok) return { ok: false, reason: `queued へ進められません: ${result.reason}` };

    return {
      ok: true,
      taskId,
      path: path.relative(project.repoPath, written.path),
      status: this.store.getTask(taskId, projectTag)?.status ?? "queued",
    };
  }

  /**
   * 積む前の検査（旧 `validateTaskFrontmatter` の役目を、**入力に対して**やる）。
   *
   * ファイルではなく引数を見るようになったので、検査も同期で返る——番頭は
   * 「積んだのに拒否イベントが後から出る」を待たなくてよい（`task_ingest_rejected` が
   * 出ていた非同期の拒否は、これで無くなる）。
   */
  private validateContractInput(
    input: TaskContractInput
  ): { ok: true; contract: TaskContract } | { ok: false; reason: string } {
    const problems: string[] = [];
    if (!input.title?.trim()) problems.push("title が要ります（1行）");
    if (!input.body?.trim()) problems.push("body が要ります（依頼の本文。職人へ届くのはこれ）");
    if (!VALID_TASK_KINDS.has(input.kind)) {
      problems.push(`kind が違います: "${input.kind}"（使えるのは ${[...VALID_TASK_KINDS].join(", ")}）`);
    }
    const paths = input.scope?.paths ?? [];
    if (!Array.isArray(paths) || paths.length === 0 || paths.some((p) => !p?.trim())) {
      problems.push("scope.paths に1つ以上のパターンが要ります（変えてよい場所）");
    }
    const acceptance = input.acceptance ?? [];
    if (!Array.isArray(acceptance) || acceptance.length === 0) {
      problems.push("acceptance に1つ以上の受け入れ条件が要ります");
    } else if (acceptance.some((a) => !a?.text?.trim())) {
      problems.push("acceptance の text が空のものがあります");
    }
    if (problems.length > 0) return { ok: false, reason: problems.join(" / ") };

    return {
      ok: true,
      contract: {
        title: input.title.trim(),
        kind: input.kind,
        body: input.body,
        scope: { paths: [...paths] },
        // **id は Kobo が振る**（番頭は書かない・第4便）
        acceptance: assignAcceptanceIds(acceptance),
        ...(input.parent !== undefined ? { parent: input.parent } : {}),
        ...(input.depends !== undefined ? { depends: [...input.depends] } : {}),
        ...(input.refs !== undefined ? { refs: [...input.refs] } : {}),
        ...(input.environment !== undefined ? { environment: input.environment } : {}),
        ...(input.governance !== undefined ? { governance: input.governance } : {}),
        ...(input.model_tier !== undefined ? { model_tier: input.model_tier } : {}),
        ...(input.hypothesis !== undefined ? { hypothesis: input.hypothesis } : {}),
        ...(input.review !== undefined ? { review: input.review } : {}),
      },
    };
  }

  /**
   * いま許されている同時実行数（決定67）。
   *
   * 層B設定（プロジェクトの `meta/config.yaml`）が絞っていればそれを採る。複数プロジェクトを
   * 受け持つので**いちばん厳しいものに合わせる**——1つでも絞っているなら、その意図を守る。
   */
  maxConcurrentSessions(): number {
    const koboDefault = this.config.maxConcurrentSessions ?? 5;
    let limit = koboDefault;
    for (const project of this.registry.list()) {
      try {
        const configured = this.projectConfig(project.id).limits.maxConcurrentSessions;
        if (typeof configured === "number" && configured >= 0) limit = Math.min(limit, configured);
      } catch (err) {
        // I2: 壊れた設定を黙って無視しない。ただし1つの設定で工場全体を止めない
        process.stderr.write(
          `[banto-daemon] ${project.id} の層B設定を読めません: ${String(err)}\n`
        );
      }
    }
    return limit;
  }

  /**
   * 上限と監査の関係を起動時に確かめる（決定67・task-0063 a4）。
   *
   * **監査は上限の対象外**（常に `reasoning`）。監査は費用のつまみではなく検査であり、
   * 上限で省ける形にすると「安くするために検査を外す」ができてしまう（決定57 が禁じた形）。
   * 上限が `reasoning` より下のときは、そのことを起動時に言う——黙って例外扱いしない。
   */
  private warnAboutTierCeiling(): void {
    for (const project of this.registry.list()) {
      let ceiling: string | undefined;
      try {
        ceiling = this.projectConfig(project.id).limits.maxModelTier;
      } catch (err) {
        process.stderr.write(
          `[banto-daemon] ${project.id} の層B設定を読めません: ${String(err)}\n`
        );
        continue;
      }
      if (ceiling && TIER_ORDER.indexOf(ceiling as ModelTier) < TIER_ORDER.indexOf("reasoning")) {
        process.stdout.write(
          `[banto-daemon] ${project.id}: 等級の上限は ${ceiling} です。` +
            "**監査は上限の対象外で常に reasoning で回ります**——監査は費用のつまみではなく" +
            "検査だからです（決定57・67）。上限が効くのは着手する仕事の等級と、失敗駆動の昇格です\n"
        );
      }
    }
  }

  /**
   * 契約の改訂を分類する（task-0082・決定64 改訂）。
   *
   * **危ないのは「変えること」ではなく「緩めること」。** 何を変えたかで、
   * ①誰が変えてよいか ②監査をやり直すか が変わる。
   *
   * - `verify` **だけ**：「どう確かめるか」の訂正。基準は動いていないので**監査は有効**。
   *   ゲートは元々毎回回るので、直した検証はそこで実際に走る
   * - `acceptance` の増減・`text` の変更：**何をもって完了とするか**が動く。監査は無効
   * - `scope.paths`：**エントリを取り除くのは番頭でよい**（触れる範囲が確実に減る）。
   *   **新しいパス文字列を足すのは PO**——範囲外の変更を事後に正当化できてしまう
   *
   * **glob の包含関係は文字列では解けない。** `src/narrow/**` は `src/**` より狭いが、
   * それを機械に判定させると必ずどこかで取り違える。**間違えてよい方向は「厳しすぎる」側**
   * なので、いまの一覧に無い文字列が1つでも増えたら PO に上げる。意味としては狭くても、
   * PO が見れば1秒で通る話であって、緩い側に倒して事故るより安い。
   */
  private classifyAmendment(
    current: TaskRecord,
    next: Record<string, unknown>,
    /**
     * 契約が `review` を名乗っていないときに、**いま効いている段**を答える（imp-0039）。
     *
     * **要るときにだけ読む。** 層B設定（`meta/config.yaml`）が壊れていれば
     * `reviewStageOf` は投げる——それは正しい（I2）が、`review` に触らない改訂まで
     * 巻き添えで止める理由は無い
     */
    currentReviewStage: () => ReviewStage
  ): {
    changes: string[];
    auditInvalidated: boolean;
    /** 緩める方向（PO の判断が要る）か */
    loosens: boolean;
  } {
    const changes: string[] = [];
    let auditInvalidated = false;
    let loosens = false;

    const curAcc = (current["acceptance"] as Array<Record<string, unknown>> | undefined) ?? [];
    const nextAcc = (next["acceptance"] as Array<Record<string, unknown>> | undefined) ?? [];
    const curById = new Map(curAcc.map((a) => [String(a["id"]), a]));
    const nextById = new Map(nextAcc.map((a) => [String(a["id"]), a]));

    for (const [id, a] of curById) {
      const b = nextById.get(id);
      if (!b) {
        // 受け入れ条件を消すのは、できていないものを通す方向
        changes.push(`受け入れ条件 ${id} を削除`);
        auditInvalidated = true;
        loosens = true;
        continue;
      }
      if (String(a["text"] ?? "") !== String(b["text"] ?? "")) {
        changes.push(`受け入れ条件 ${id} の基準を変更`);
        auditInvalidated = true;
        loosens = true; // 厳しくしたのか緩めたのかは機械では読めない。安全側に倒す
      }
      if (String(a["verify"] ?? "") !== String(b["verify"] ?? "")) {
        // **ここが本命**。基準は同じで、確かめ方だけ直す
        changes.push(
          `受け入れ条件 ${id} の検証コマンドを変更: ${String(a["verify"] ?? "(なし)")} → ${String(b["verify"] ?? "(なし)")}`
        );
      }
    }
    for (const [id] of nextById) {
      if (!curById.has(id)) {
        // 増やすのは厳しくする方向だが、**監査はそれを見ていない**
        changes.push(`受け入れ条件 ${id} を追加`);
        auditInvalidated = true;
      }
    }

    const curScope = ((current["scope"] as { paths?: string[] } | undefined)?.paths ?? []).slice();
    const nextScope = ((next["scope"] as { paths?: string[] } | undefined)?.paths ?? []).slice();
    if (JSON.stringify(curScope) !== JSON.stringify(nextScope)) {
      const widened = nextScope.some((p) => !this.scopePatternCovered(p, curScope));
      changes.push(`スコープを変更: [${curScope.join(", ")}] → [${nextScope.join(", ")}]`);
      auditInvalidated = true;
      if (widened) loosens = true;
    }

    for (const key of ["title", "body"]) {
      if (String(current[key] ?? "") !== String(next[key] ?? "")) {
        // 判断の材料であって監査の対象ではない
        changes.push(`${key === "title" ? "タイトル" : "本文"}を変更`);
      }
    }

    /**
     * **ここから3つは、渡せるのに効かなかった項目**（imp-0039・実機 dentaku task-0015）。
     * `amendTask` は契約へ重ねていたのに差分として数えていなかったので、中身が違っても
     * 「渡された中身と同じです」で断っていた——**断り文が嘘**だと、番頭は取次へ上げる
     * 判断ができない。「緩める方向なので PO の判断が要ります」まで届かせるのが要点。
     */
    const curPolicy = (current["review"] as { policy?: unknown } | undefined)?.policy;
    const nextPolicy = (next["review"] as { policy?: unknown } | undefined)?.policy;
    if (curPolicy !== nextPolicy) {
      changes.push(
        `レビュー方針を変更: ${curPolicy === undefined ? "(未指定)" : String(curPolicy)} → ` +
          `${nextPolicy === undefined ? "(未指定)" : String(nextPolicy)}`
      );
      // **監査は無効にしない**——誰が見るかが変わるだけで、何に対して監査したかは動かない
      if (
        this.reviewStrictness(nextPolicy, currentReviewStage) <
        this.reviewStrictness(curPolicy, currentReviewStage)
      ) {
        loosens = true; // 見る人が減る方向（po→banto→auto）は PO の判断
      }
    }

    const curEnv = current["environment"];
    const nextEnv = next["environment"];
    if (String(curEnv ?? "") !== String(nextEnv ?? "")) {
      // 「何を確かめるか」ではなく「**どこで**確かめるか」なので、検証コマンドの訂正と
      // 同じで番頭が通してよい。ただし**監査は無効**——前の監査は別の環境で取った証拠で、
      // その証拠がこの環境でも成り立つかは誰も見ていない（安全側に倒す・I2）
      changes.push(
        `検証環境を変更: ${curEnv === undefined ? "(既定)" : String(curEnv)} → ` +
          `${nextEnv === undefined ? "(既定)" : String(nextEnv)}`
      );
      auditInvalidated = true;
    }

    const curTier = current["model_tier"];
    const nextTier = next["model_tier"];
    if (String(curTier ?? "") !== String(nextTier ?? "")) {
      // 誰にやらせるかの話。基準も範囲も動かないので、緩めでも監査の無効化でもない
      changes.push(
        `モデルの段を変更: ${curTier === undefined ? "(既定)" : String(curTier)} → ` +
          `${nextTier === undefined ? "(既定)" : String(nextTier)}`
      );
    }

    return { changes, auditInvalidated, loosens };
  }

  /**
   * 改訂後のスコープの1本が、**いまのスコープのどれかに覆われている**か（task-0209）。
   *
   * 以前は「文字列がいまの一覧に無ければ広げた」と読んでいたので、
   * `["tests/acceptance/**"]` → `["tests/acceptance/foo.spec.ts"]` という
   * **明らかな絞り込み**まで「緩める方向」に落ちて番頭が通せなかった（実測・task-0203）。
   *
   * glob 同士の包含は一般には解けない。**機械で判断できないものは「覆われていない」**
   * ＝広げた＝PO の判断へ回す側に倒す（I2・安全側）。読めるのは次の3つだけ:
   *   1. 完全一致（これまでどおり）
   *   2. 改訂後がワイルドカードを含まない実パス → `fileMatchesGlob` にそのまま訊く
   *   3. 改訂後も glob のとき → いまのパターンが `<接頭辞>/**` 形の総取りで、
   *      改訂後のリテラル接頭辞がその接頭辞の下にあるときだけ覆われている扱い。
   *      （`fileMatchesGlob` は第1引数を**実パス**として読むので、`src/**` を
   *        `src/*` に照合させると `**` が `[^/]*` に食われて真になってしまう。
   *        glob を実パスのふりで渡してはいけない）
   */
  private scopePatternCovered(nextPattern: string, curScope: string[]): boolean {
    if (curScope.includes(nextPattern)) return true;

    const isGlob = (p: string): boolean => /[*?[\]{}]/.test(p);
    if (!isGlob(nextPattern)) {
      return curScope.some((cur) => fileMatchesGlob(nextPattern, cur));
    }

    // 改訂後もパターン。リテラル接頭辞（最初のワイルドカードより手前）は、
    // そのパターンに当たるどのファイルも必ず持っている
    const nextLiteralPrefix = nextPattern.slice(0, nextPattern.search(/[*?[\]{}]/));
    return curScope.some((cur) => {
      const m = /^([^*?[\]{}]*)\*\*$/.exec(cur);
      if (!m) return false; // 総取り以外は読めない → 覆われていない扱い
      const prefix = m[1]!;
      if (prefix !== "" && !prefix.endsWith("/")) return false; // `src/ba**` 等は別物
      return nextLiteralPrefix.startsWith(prefix);
    });
  }

  /**
   * レビューの段の厳しさ（決定57）: `po` > `banto` > `auto`。
   *
   * 名乗っていない値を「いちばん厳しい」で埋めない。既定が `auto` の契約へ `banto` を
   * 足すのは**厳しくする**向きなのに、それを「緩める方向です」と断るのは imp-0039 で
   * 直したのと同じ嘘になる——**いま効いている段**（層Bの既定・`governance` などの
   * 機械判定こみ）を答えにする。
   */
  private reviewStrictness(policy: unknown, effective: () => ReviewStage): number {
    const rank: Record<ReviewStage, number> = { auto: 1, banto: 2, po: 3 };
    if (policy === "auto" || policy === "banto" || policy === "po") return rank[policy];
    // 旧称 `manual` は `banto`（review-policy.ts の読み替えと同じ向き。ここだけ別の向きに
    // すると、帳簿に残る `manual` 宣言の扱いが2箇所で食い違う）
    if (policy === "manual") return rank.banto;
    return rank[effective()];
  }

  /**
   * 契約を改訂する（task-0082・**決定64 の改訂**・PO 裁定 2026-08-08）。
   *
   * **凍結をやめた。** 凍結は「何に対して監査したのか」を守るためのものだったが、
   * 間違いが直せないので運用が「新しいタスクを立てる」に逃げ、**経緯が別 id に
   * 分かれて追跡性がむしろ落ちていた**（実機の loamium task-0004 → 0005）。
   *
   * 代わりに3つを守る：
   *   1. **黙って起きない**——変えたい中身を**引数で**渡したときだけ動く
   *      （第4便：定義ファイルを読み戻す経路は無くなった。md は Kobo が書く記録で、
   *      番頭がそれを直しても何も起きない——書き手を2人にしない）
   *   2. **記録に残る**——変更前後・誰が・なぜが `task_contract_amended` に載り、
   *      記録ファイルも新しい契約で書き直される
   *   3. **依存するものが差し戻る**——基準が動いたら監査は無効になり implementing へ
   *
   * `changes` は**差分**（渡した項目だけが変わる）。`acceptance` を渡すときは
   * **全件を渡す**（id つき）——一部だけ渡すと消したのか触っていないのか読めない。
   *
   * I2: 緩める方向（スコープを広げる・基準を変える・条件を消す）は番頭では通らない。
   */
  amendTask(
    projectTag: string,
    taskId: string,
    changesInput: TaskContractAmendment,
    options: { reason: string; by: "banto" | "po" }
  ): { ok: true; changes: string[]; auditInvalidated: boolean } | { ok: false; reason: string } {
    const task = this.store.getTask(taskId, projectTag);
    if (!task) return { ok: false, reason: `${taskId} は ${projectTag} の工場にありません` };
    if (task.status === "closed" || task.status === "merged" || task.status === "superseded") {
      return { ok: false, reason: `${taskId} は ${task.status} なので、もう改訂できません` };
    }

    const project = this.registry.list().find((p) => p.id === projectTag);
    if (!project) return { ok: false, reason: `project_not_found: ${projectTag}` };

    // いまの契約（帳簿が真実・D3）に、渡された項目だけを重ねる
    const current = contractFromRecord(task);
    const amended: TaskContract = {
      ...current,
      ...(changesInput.title !== undefined ? { title: changesInput.title.trim() } : {}),
      ...(changesInput.body !== undefined ? { body: changesInput.body } : {}),
      ...(changesInput.scope !== undefined ? { scope: { paths: [...changesInput.scope.paths] } } : {}),
      ...(changesInput.acceptance !== undefined ? { acceptance: changesInput.acceptance.map((a) => ({ ...a })) } : {}),
      ...(changesInput.environment !== undefined ? { environment: changesInput.environment } : {}),
      ...(changesInput.model_tier !== undefined ? { model_tier: changesInput.model_tier } : {}),
      ...(changesInput.review !== undefined ? { review: changesInput.review } : {}),
    };

    if (amended.scope.paths.length === 0) {
      return { ok: false, reason: "scope.paths を空にはできません（変えてよい場所が無くなります）" };
    }
    if (amended.acceptance.length === 0) {
      return { ok: false, reason: "acceptance を空にはできません（完了の判定ができなくなります）" };
    }
    if (amended.acceptance.some((a) => !a.id?.trim() || !a.text?.trim())) {
      return { ok: false, reason: "acceptance の各項目には id と text が要ります（全件を渡してください）" };
    }

    // **`title` は payload に入らない**（`createTask` が別引数で受け、payload からは
    // 落とされる）。足さずに比べると、中身が同じでも毎回「タイトルを変更」が出る
    // ——実際に踏んだ。帳簿に嘘の改訂が残るところだった
    const next = { ...contractPayload(amended), title: amended.title };

    const { changes, auditInvalidated, loosens } = this.classifyAmendment(task, next, () =>
      this.reviewStageOf(projectTag, task)
    );
    // I2: 何も変わっていないのに「改訂した」と記録しない（帳簿が嘘になる）
    if (changes.length === 0) {
      return { ok: false, reason: `${taskId} は渡された中身と同じです（改訂するものがありません）` };
    }
    if (loosens && options.by !== "po") {
      return {
        ok: false,
        reason:
          `${taskId} の改訂は**緩める方向**なので PO の判断が要ります: ${changes.join(" / ")}。` +
          "番頭が通せるのは、検証コマンドの訂正・スコープからパスを取り除く・受け入れ条件を増やす方向だけです" +
          "（できていないものを通せてしまうため）——取次へ上げてください",
      };
    }

    // 記録ファイルを新しい契約で書き直す。**書けなければ改訂しない**——帳簿だけ動いて
    // 記録が古いまま残ると、あとから読む側が古い契約を見る（I2・第4便で Kobo が書き手）
    const rewritten = writeTaskRecord(project.repoPath, taskId, amended);
    if (!rewritten.ok) return rewritten;

    const event = this.log.append({
      type: "task_contract_amended",
      projectTag,
      taskId,
      amendedBy: options.by,
      reason: options.reason,
      changes,
      auditInvalidated,
      contract: next,
    });
    this.applyAndBroadcast(event);

    // **基準が動いたら監査は無効。** 通ってしまう前に implementing へ戻す。
    // 終端（failed）にいるものは動かさない——戻し方は `kobo.reopen` が決める
    const active = task.status !== "failed";
    if (auditInvalidated && active && task.status !== "implementing" && task.status !== "planning") {
      const back = this.transition(
        projectTag,
        taskId,
        "implementing",
        `contract_amended:${options.by}（基準が変わったので監査からやり直し）`
      );
      if (!back.ok) {
        // I2: 戻せないことを黙らせない。改訂は残っているので、状態と記録が食い違う
        process.stderr.write(
          `[banto-daemon] ${projectTag}/${taskId}: 契約を改訂しましたが implementing へ戻せませんでした: ${back.reason}\n`
        );
      }
    }

    return { ok: true, changes, auditInvalidated };
  }

  /**
   * **なぜ落ちたか**（task-0081）。番頭が直す前に読む材料。
   *
   * 落ちた理由の要約（`task_failed` の reason）だけでは直しようがない——
   * 「`verify_failed:a4(exit=1)`」から分かるのは番号だけで、**何が起きたかは
   * 検証のログにしか無い**。ここでログの在り処と末尾まで返す。
   *
   * D3: どこにも保存しない。イベントログとゲートのログから毎回導出する。
   * D10: 番頭に全文は渡さない（文脈が埋まる）。末尾だけ返し、全文はパスで示す。
   */
  failureDetail(
    projectTag: string,
    taskId: string,
    tailLines = 40
  ): {
    reason?: string;
    gateReasons: string[];
    logs: Array<{ acId: string; dir: string; tail: string }>;
    /** 落ちてから戻した回数（P6：同じところを何度も叩いていないか） */
    reopenCount: number;
  } {
    const events = this.getTaskEvents(projectTag, taskId);

    // 直近の task_failed（要約）
    let reason: string | undefined;
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i]!;
      if (e.type === "task_failed") { reason = e.reason; break; }
    }

    // 直近の落ちたマージ前ゲート（理由の内訳とログの在り処）
    let gateReasons: string[] = [];
    let logPaths: string[] = [];
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i]!;
      if (e.type === "merge_gate_evaluated" && e.passed === false) {
        gateReasons = e.reasons ?? [];
        logPaths = (e as { logPaths?: string[] }).logPaths ?? [];
        break;
      }
    }

    const logs = logPaths.map((dir) => {
      const acId = path.basename(dir);
      let tail = "";
      for (const name of ["stdout.txt", "stderr.txt"]) {
        try {
          const text = fs.readFileSync(path.join(dir, name), "utf-8").trimEnd();
          if (text) tail += (tail ? "\n" : "") + `--- ${name} ---\n` + lastLines(text, tailLines);
        } catch {
          // ログが消えている（保持期間切れ・別機械）。**無いことを黙らせない**
        }
      }
      return { acId, dir, tail: tail || "(ログが読めません)" };
    });

    // **落ちてから戻した回数**（D3: 導出。新しいイベント種を増やさない）。
    // P6「同じ試験に2回パッチを当てて定着しなかったら根本原因分析」は、これが無くて
    // 機械では発火できなかった（inc-0031 の残りの問い）
    const reopenCount = events.filter(
      (e) => e.type === "state_transitioned" && e.from === "failed"
    ).length;

    return { ...(reason ? { reason } : {}), gateReasons, logs, reopenCount };
  }

  /**
   * 落ちたタスクを**同じタスクのまま**動かし直す（task-0081・PO 要望 2026-08-08）。
   *
   * **タスクを切り直させない。** 落ちるたびに新しいタスクを立てる運用だと、同じ依頼が
   * task-0004 → task-0005 → … と増え、経緯が分断される（実機でそうなった）。
   *
   * どちらへ戻すかは**落ちた理由で変わる**ので、番頭が選ぶ：
   * - `rework`:   中身の問題。職人をもう一度起こして直させる（落ちた理由を渡す）
   * - `reverify`: 検証環境の問題。**中身は触らず**マージ前ゲートをもう一度回す
   *
   * I2: `reverify` は**監査を通った実績があるときだけ**許す。監査を飛ばして
   * マージ待ちに置けてしまうと、番頭の取り違えで未監査のものがマージされる。
   */
  async reopenTask(
    projectTag: string,
    taskId: string,
    options: { mode: "rework" | "reverify"; reason: string; by: string; origin?: string }
  ): Promise<{ ok: true; to: string } | { ok: false; reason: string }> {
    const task = this.store.getTask(taskId, projectTag);
    if (!task) return { ok: false, reason: `${taskId} は ${projectTag} の工場にありません` };
    if (task.status !== "failed") {
      return {
        ok: false,
        reason: `${taskId} は failed ではありません（いまは ${task.status}）。戻せるのは落ちたタスクだけです`,
      };
    }

    const to = options.mode === "rework" ? "implementing" : "approved";

    if (options.mode === "reverify") {
      /**
       * I2: 監査を飛ばさせない。**監査を通った実績**が要る。
       *
       * **「承認を通ったか」で見てはいけない**（imp-0029・実機 dentaku task-0001）。
       * レビューの既定が自動着地に反転して以降、監査に通ったタスクは
       * `auditing → merging（audit_passed:auto）` と直に進み、**approved を一度も通らない**。
       * `state_transitioned → approved` だけを条件にしていたので、
       * 「監査に通り、マージ前ゲートで検証環境の不備に当たって落ちた」——まさに
       * reverify のための状況——のタスクが断られ、中身を1行も直す必要が無いのに
       * rework で職人を起こすしかなかった。
       *
       * 守るのは「approve を通ったか」ではなく「**未監査のものをマージ待ちに置かない**」。
       * だから監査の合格そのもの（`audit_verdict` の pass）も実績として数える。
       */
      const events = this.getTaskEvents(projectTag, taskId);
      // 後ろから探すので、監査の合格と承認のうち**新しい方**が「実績が立った時点」になる
      let auditedAt = -1;
      for (let i = events.length - 1; i >= 0; i--) {
        const e = events[i]!;
        if (e.type === "audit_verdict" && e.verdict === "pass") { auditedAt = i; break; }
        if (e.type === "state_transitioned" && e.to === "approved") { auditedAt = i; break; }
      }
      if (auditedAt < 0) {
        return {
          ok: false,
          reason:
            `${taskId} は監査を通った実績が無いので「検証しなおし」はできません` +
            "（監査を飛ばしてマージ待ちに置くことになります）。中身から直すなら mode: \"rework\" を使ってください",
        };
      }
      // **実績のあとに基準が動いていたら、その実績はもう使えない**（task-0082）。
      // 契約を改訂できるようにした以上、「監査を通った実績」だけでは足りない
      // ——改訂で監査が無効になったあとに reverify を通すと、**変わった基準を誰も見ていない**
      const invalidatedAfter = events
        .slice(auditedAt)
        .some((e) => e.type === "task_contract_amended" && e.auditInvalidated);
      if (invalidatedAfter) {
        return {
          ok: false,
          reason:
            `${taskId} は監査のあとに**基準が変わっています**（契約の改訂で監査が無効になりました）。` +
            "変わった基準を誰も見ていない状態でマージ待ちに置けません——mode: \"rework\" で監査からやり直してください",
        };
      }
    }

    /**
     * **戻せと言った会話が、以後の宛先になる**（決定58 の延長・PO報告 2026-08-10）。
     *
     * 宛先はこれまで「積んだとき」にしか付かなかった。だが `work/tasks/*.md` から
     * 取り込まれたタスク（`watcher-ingest`）には宛先が無く、番頭が会話から戻しても
     * 付かないままで、知らせが**帳場へ流れ込んでいた**——task-0089 が実際にそうなった
     * （3回とも `origin: undefined` のまま失敗の知らせだけが帳場に積まれた）。
     *
     * 戻すのは番頭の明示的な行為で、そのとき番頭はどれかの会話に居る。**そこが宛先。**
     * 既に宛先があるときは書き換えない——最初に積んだ会話から奪わない。
     */
    if (options.origin && !this.originOfTask(projectTag, taskId)) {
      const amended = this.log.append({
        type: "task_contract_amended",
        projectTag,
        taskId,
        amendedBy: options.by === "po" ? "po" : "banto",
        reason: `宛先（origin）を ${options.origin} に定めました（${options.mode} で戻したため）`,
        changes: ["宛先（origin）"],
        // 契約は動かしていないので監査は無効化しない（reverify を塞がない）
        auditInvalidated: false,
        contract: { origin: options.origin },
      });
      // **積むだけでは手元の写しに効かない**（PO報告 2026-08-11）。この直後に起きる
      // rework の知らせが宛先を引くので、適用を飛ばすと**戻した会話にも届かない**
      // ——再起動して読み直すまで直らない、いちばん気づきにくい形になる
      this.applyAndBroadcast(amended);
    }

    /**
     * **なぜ戻したかが帳簿で読めること。** `reverify` の戻し先が `approved` なのは
     * マージキューが approved を拾うからであって、**誰かが承認したからではない**
     * ——言い分けないと、自動着地で approved を一度も通っていないタスクが、
     * 帳簿では「承認された」ように見えてしまう
     */
    const why =
      options.mode === "reverify"
        ? `reopened_by:${options.by}:reverify（監査の実績は据え置き、マージ前ゲートだけ回し直す：${options.reason}）`
        : `reopened_by:${options.by}:rework（中身から直す：${options.reason}）`;
    const result = this.transition(projectTag, taskId, to, why);
    if (!result.ok) return { ok: false, reason: `${to} へ戻せませんでした: ${result.reason}` };

    if (options.mode === "rework") {
      // 落ちた理由を職人へ渡す。**渡さないと同じ失敗を繰り返す**
      const detail = this.failureDetail(projectTag, taskId);
      const findings = [
        ...(detail.reason ? [`前回の失敗: ${detail.reason}`] : []),
        ...detail.gateReasons.map((r) => `マージ前ゲート: ${r}`),
        ...detail.logs
          .filter((l) => l.tail && l.tail !== "(ログが読めません)")
          .map((l) => `検証 ${l.acId} のログ末尾:\n${l.tail}`),
        `番頭からの指示: ${options.reason}`,
      ];
      // 監査のやり直しと同じ道を通す（職人の起こし方を2つ持たない）。
      //
      // **待つ。** 監査のやり直しは帳簿の handler の中なので投げっぱなしにするが、
      // ここは番頭が呼んだ道具——起こせたかどうかを返さないと、
      // 「戻しました」と言った直後に落ちていても番頭は気づけない（I2）。
      await this.spawnReworkSession(projectTag, taskId, findings, "前回どこで落ちたか");

      // 起こす途中で落ちていたら（`spawnReworkSession` が recordTaskFailed する）、
      // 成功に見せない
      const after = this.store.getTask(taskId, projectTag);
      if (after?.status !== "implementing") {
        return {
          ok: false,
          reason:
            `${taskId} を implementing へ戻しましたが、職人を起こせませんでした` +
            `（いまは ${after?.status ?? "不明"}）。kobo.task で理由を読んでください`,
        };
      }
    }

    return { ok: true, to };
  }

  /**
   * レビューで見て駄目だったものを、**契約を変えずに実装へ戻す**（段2・報告 A 表 11b）。
   *
   * **`kobo.reopen` との違いは入口**：reopen は `failed`（機械が落とした）から戻す道で、
   * こちらは `review-ready` / `in-review`（人・番頭が見て駄目だと決めた）から戻す道。
   * どちらも行き先は `implementing` で、職人の起こし方も同じ（道を2つ持たない）。
   *
   * **契約は動かさない。** スコープや受け入れ基準を変えたいなら `kobo.amend`、
   * 依頼そのものを別物にするなら `kobo.supersede` の領分で、ここは「同じ契約のまま
   * 次の試行を起こす」だけ——だから監査は無効化しないし `task_contract_amended` も積まない。
   *
   * **`po` 段のタスクも番頭が戻せる。** 決定57 が番頭に禁じているのは*通す*ことで、
   * 差し戻しは厳しい方向へ倒す判断だから緩みが出ない（approveTask の `po` 判定と非対称なのは
   * 意図的。緩い方へは倒れない・review-policy.ts の原則と同じ向き）。
   */
  async sendBackTask(
    projectTag: string,
    taskId: string,
    options: { reason: string; by: "banto" | "po"; origin?: string; via?: string }
  ): Promise<{ ok: true; to: string } | { ok: false; reason: string }> {
    const task = this.store.getTask(taskId, projectTag);
    if (!task) return { ok: false, reason: `${taskId} は ${projectTag} の工場にありません` };
    if (task.status !== "review-ready" && task.status !== "in-review") {
      return {
        ok: false,
        reason:
          `${taskId} はレビュー待ちではありません（いまは ${task.status}）。` +
          "差し戻せるのは判断待ちのものだけです——落ちたものは kobo.reopen で戻してください",
      };
    }

    // 宛先の扱いは `reopenTask` と同じ（決定58 の延長）。戻せと言った会話が以後の宛先になる
    if (options.origin && !this.originOfTask(projectTag, taskId)) {
      const amended = this.log.append({
        type: "task_contract_amended",
        projectTag,
        taskId,
        amendedBy: options.by,
        reason: `宛先（origin）を ${options.origin} に定めました（差し戻したため）`,
        changes: ["宛先（origin）"],
        // 契約は動かしていない（宛先は契約ではない）ので監査は無効化しない
        auditInvalidated: false,
        contract: { origin: options.origin },
      });
      this.applyAndBroadcast(amended);
    }

    const result = this.transition(
      projectTag,
      taskId,
      "implementing",
      // 決定113: PO の判断なら**どこから来た意思表示か**も帳簿に残す（承認と同じ扱い）
      `sent_back_by:${options.by}${options.via ? `@${options.via}` : ""}（${options.reason}）`
    );
    if (!result.ok) return { ok: false, reason: `implementing へ戻せませんでした: ${result.reason}` };

    // **理由をそのまま職人へ渡す**（渡さないと同じものが上がってくる）。
    // 監査のやり直し・reopen と同じ道を通す——職人の起こし方を3つ持たない
    await this.spawnReworkSession(
      projectTag,
      taskId,
      [`レビューで差し戻されました: ${options.reason}`],
      "レビューでの指摘"
    );

    // 起こす途中で落ちていたら（`spawnReworkSession` が recordTaskFailed する）、成功に見せない（I2）
    const after = this.store.getTask(taskId, projectTag);
    if (after?.status !== "implementing") {
      return {
        ok: false,
        reason:
          `${taskId} を implementing へ戻しましたが、職人を起こせませんでした` +
          `（いまは ${after?.status ?? "不明"}）。kobo.task で理由を読んでください`,
      };
    }

    return { ok: true, to: "implementing" };
  }

  /**
   * どうしようもないものを畳む（task-0081・PO 要望 2026-08-08、**PO 裁定 2026-08-14 で拡張**）。
   *
   * 当初は `failed` 専用だった。畳めば既定の一覧（prop-0001）から外れるので
   * 「まだ見る必要がある」ふりをしなくなる、というのが元の狙いである。
   *
   * **実運用で宙に浮くのは failed ではなかった。** 実機の工場には queued 10本・paused 3本・
   * review-ready 1本が二度と動かないまま凍り、番頭には畳む手段が無かった（PO 裁定 2026-08-14）。
   * いまは**どの状態からでも**畳める。断るのは `closed` / `superseded` ——もう畳んであるもの
   * だけで、そのときは**いまの状態を名指しで**返す（I2：黙って成功を返さない）。
   *
   * **記録は消えない**——`state_transitioned.from` に畳む前の状態が載り、理由も残る。
   *
   * **稼働中の職人を置き去りにしない。** implementing / auditing のタスクには職人が
   * ぶら下がっていることがある。畳むなら止める——止まらなかったときは握り潰さず、
   * 返り値と帳簿（`po_operation:task_abandoned`）に**どのセッションが止まらなかったか**を
   * 名指しで残す。畳むこと自体は成立させる（止められないからといって凍らせない）。
   */
  async abandonTask(
    projectTag: string,
    taskId: string,
    options: { reason: string; by: string }
  ): Promise<
    | { ok: true; from: TaskStatus; stoppedSessions: string[]; unstoppedSessions: UnstoppedWorker[] }
    | { ok: false; reason: string }
  > {
    const task = this.store.getTask(taskId, projectTag);
    if (!task) return { ok: false, reason: `${taskId} は ${projectTag} の工場にありません` };
    const from = task.status as TaskStatus;
    if (from === "closed") {
      return { ok: false, reason: `${taskId} は既に畳んであります（いまは closed）` };
    }
    if (from === "superseded") {
      return {
        ok: false,
        reason:
          `${taskId} は既に置き換えて降ろしてあります（いまは superseded）。` +
          "畳み直す必要はありません",
      };
    }

    // **止める前に閉じる。** 職人を起こしている最中に畳まれることがあり、そのとき
    // `keepWorkerIfStillWanted` は「畳んだ後の状態」を読んで遅れて生まれた職人を始末する
    // ——先に閉じておかないと、その拾い直しが効かない（task-0072 の取りこぼしと同じ形）
    const result = this.transition(
      projectTag,
      taskId,
      "closed",
      `abandoned_by:${options.by}（${from} から畳みました: ${options.reason}）`,
      { abandon: true }
    );
    if (!result.ok) return { ok: false, reason: `畳めませんでした: ${result.reason}` };

    const workers = await this.closeWorkersForAbandon(projectTag, taskId);

    // 帳簿に「誰が・なぜ・どこから畳んだか」と、**止まらなかった職人**を残す（I2）。
    // 状態そのものは上の `state_transitioned` が持つ（D3）——ここは経緯の付帯情報
    this.applyAndBroadcast(
      this.log.append({
        type: "po_operation",
        projectTag,
        operation: "task_abandoned",
        taskId,
        payload: {
          from,
          by: options.by,
          reason: options.reason,
          stoppedSessions: workers.stopped,
          unstoppedSessions: workers.unstopped,
        },
      })
    );

    return {
      ok: true,
      from,
      stoppedSessions: workers.stopped,
      unstoppedSessions: workers.unstopped,
    };
  }

  /**
   * 畳むタスクにぶら下がっている職人を止める。
   *
   * **止めに行く相手は帳簿から引く**（D3）。`agent_spawned` があって `agent_exited` が
   * 無いセッションが「まだ居るはず」の職人——工房に毎回聞きに行かないのは、職人を
   * 一度も起こしていないタスク（queued で凍ったものなど）まで工房への往復を払わせない
   * ため、そして**工房が居ないときに「止められなかった」と嘘を言わない**ため。
   *
   * I2: 止まらなかったものは名前を返す。呼び出し側が返り値と帳簿に残す。
   */
  private async closeWorkersForAbandon(
    projectTag: string,
    taskId: string
  ): Promise<{ stopped: string[]; unstopped: UnstoppedWorker[] }> {
    const stopped: string[] = [];
    const unstopped: UnstoppedWorker[] = [];

    const history = this.index.getTaskHistory(taskId, projectTag);
    const spawned: string[] = [];
    const exited = new Set<string>();
    for (const ev of history) {
      if (ev.type === "agent_spawned" && ev.sessionId && !spawned.includes(ev.sessionId)) {
        spawned.push(ev.sessionId);
      }
      if (ev.type === "agent_exited" && ev.sessionId) exited.add(ev.sessionId);
    }
    const live = spawned.filter((sessionId) => !exited.has(sessionId));

    for (const sessionId of live) {
      try {
        await this.workerInvoke("worker.close", { sessionId });
        stopped.push(sessionId);
      } catch (err) {
        // I2: 止められなかったことを「止めた」に丸めない。工房の安全弁が後で拾うとしても、
        // **いま誰が走り続けているか**は番頭に見えていなければならない
        unstopped.push({ sessionId, error: String(err) });
        process.stderr.write(
          `[banto-daemon] ${projectTag}/${taskId} を畳みましたが職人が止まりません（${sessionId}）: ${String(err)}\n`
        );
      }
    }

    return { stopped, unstopped };
  }

  /**
   * **工場の外で決着したものを畳む**（realign 第2便・imp-0019 の4番）。
   *
   * これを足した当初、`abandonTask` は failed にしか効かなかった。queued / paused /
   * review-ready のまま「中身が別の経路で main に入った」ものを帳簿の上で畳む手段が無く、
   * 番頭が実際にここで詰まった——2026-08-13 の棚卸しの判定を、帳簿へ書き戻せなかった。
   *
   * **その穴は塞がった**（PO 裁定 2026-08-14 で `abandonTask` は横断遷移になった）が、
   * **口は分けたまま**にしてある。違いは畳める範囲ではなく**帳簿に何を書くか**——
   * こちらは「失敗ではない・外で決着した」、`abandonTask` は「諦めた」。混ぜると
   * 「どれだけ捨てたか」と「どれだけ工場の外で片付いたか」を別々に数えられなくなる。
   *
   * **failed とは区別する。** 失敗ではないので `failed` を経由させない。
   * `closed` へ直に落とし、`task_settled_outside` に「どう決着したか・なぜそう
   * 言えるのか・どこで止まっていたか」を残す（→ `StateMachine.settleOutside`）。
   *
   * 畳んだあとは終端の後始末（職人・検証環境を畳む）に乗せる——**起こした者が
   * 片付ける**（I3）。乗せないと、降ろしたつもりのタスクの職人が動き続ける。
   */
  settleTaskOutside(
    projectTag: string,
    taskId: string,
    options: {
      reason: string;
      by: string;
      outcome: "landed_elsewhere" | "no_longer_needed" | "handled_directly";
    }
  ): { ok: true; from: string } | { ok: false; reason: string } {
    const task = this.store.getTask(taskId, projectTag);
    if (!task) return { ok: false, reason: `${taskId} は ${projectTag} の工場にありません` };

    const from = task.status as TaskStatus;
    const result = StateMachine.settleOutside(
      this.log,
      taskId,
      { currentStatus: from, by: options.by, outcome: options.outcome, reason: options.reason },
      projectTag
    );
    if (!result.ok) {
      // I2: 畳めなかったことを成功に見せない。**どこへ行けばよいかまで言う**
      // ——道具が断るだけだと、番頭はまた同じ口を叩く（第1便で同じ形を踏んだ）
      this.refreshState();
      const hint =
        from === "failed"
          ? "落ちたまま諦めるなら kobo.abandon（失敗ではないと言うのがこの口の役目です）"
          : from === "merging"
            ? "着地の最中です。降ろすなら kobo.supersede"
            : `${from} からは畳めません`;
      return { ok: false, reason: `${taskId} を畳めませんでした: ${hint}` };
    }

    this.refreshState();
    const events = this.log.readAllEvents();
    if (events.length > 0) this.wsServer.broadcast(events[events.length - 1]!);

    // I3: 終端に入ったら、起こしてあるものを畳む（`recordTaskFailed` と同じ後始末）
    this._trackBackground(
      (async () => {
        for (const role of ["executor", "audit", "rework"] as const) {
          await this.closeWorkerFor(projectTag, poolTaskId(taskId, role));
        }
      })()
    );

    return { ok: true, from };
  }

  /**
   * そのタスクが**いまの状態にいる長さ**（ms）。分からなければ `undefined`。
   *
   * D3: 保存しない。呼ばれるたびに帳簿から導出する（`dwellMs`）——保存すると、
   * 状態を動かす経路すべてで更新し忘れが起き、静かに古い数字が出る。
   */
  dwellOf(projectTag: string, taskId: string): number | undefined {
    return dwellMs(this.getTaskEvents(projectTag, taskId), projectTag, taskId);
  }

  /**
   * **止まっているものを見つけて帳簿に刻む**（realign 第2便・rethink C-3 第1手）。
   *
   * 状態ごとの閾値（層B設定 `limits.dwell_warn_minutes`、既定
   * `DEFAULT_DWELL_WARN_MINUTES`）を超えたら `task_stalled` を積む。
   *
   * **同じ状態のあいだ二度は鳴らない**（`stalledAlreadyRecorded`）。鳴った印は
   * どこにも持たない——帳簿がそれを持っている（D3）。印を手元に持つと再起動で
   * 消え、起動のたびに溜まっている分が全部鳴り直す。
   *
   * D3: 滞在時間は保存しない。ここで積むのは「閾値を超えた」という判定の事実と、
   * そのときの実測値だけ——閾値を後から変えても、当時の判断が読める。
   *
   * `now` を受けるのは、**試験が時計を渡せるようにするため**（I1：19時間待って
   * 確かめる、はできない）。tick からは既定のいまで呼ばれる。
   */
  runDwellWatch(now: number = Date.now()): void {
    for (const project of this.registry.list()) {
      const projectTag = project.id;

      /**
       * 閾値は**プロジェクトの持ち物**（決定66）。読めないものを既定に落とさない
       * ——設定を書いたのに効いていない状態を隠す（I2）ので、読めなければ見送る。
       */
      let configured: Partial<Record<string, number>>;
      try {
        configured = this.projectConfig(projectTag).limits.dwellWarnMinutes ?? {};
      } catch (err) {
        process.stderr.write(
          `[banto-daemon] ${projectTag}: 滞留の閾値を読めません（見送ります）: ${String(err)}\n`
        );
        continue;
      }

      const events = this.getProjectEvents(projectTag);
      for (const task of this.store.getTasksByProject(projectTag)) {
        const status = task.status as TaskStatus;
        const minutes = configured[status] ?? DEFAULT_DWELL_WARN_MINUTES[status];
        // 見張らない状態（通り過ぎるだけの ready / merging 等）は閾値を持たない
        if (minutes === undefined) continue;

        const dwelt = dwellMs(events, projectTag, task.id, now);
        if (dwelt === undefined) continue;
        const thresholdMs = minutes * 60_000;
        if (dwelt < thresholdMs) continue;
        if (stalledAlreadyRecorded(events, projectTag, task.id)) continue;

        const event = this.log.append({
          type: "task_stalled",
          projectTag,
          taskId: task.id,
          status,
          dwellMs: dwelt,
          thresholdMs,
          blockedBy: currentBlockedBy(events, projectTag, task.id),
          lastChangeAt:
            lastObservableChangeAt(events, projectTag, task.id) ?? new Date(now).toISOString(),
        });
        this.applyAndBroadcast(event);
      }
    }
  }

  /**
   * そのタスクのレビューの段（決定57・66）。
   *
   * 判定表はプロジェクトのリポジトリにある（`meta/config.yaml`）。**読めなければ止まる**
   * ——設定を書いたのに効いていない状態を、緩い方（`banto`）へ倒して隠さない（I2）。
   */
  reviewStageOf(projectTag: string, task: TaskRecord): ReviewStage {
    return resolveReviewStage(task, this.projectConfig(projectTag));
  }

  /**
   * プロジェクトの層B設定。**毎回読む**（D3：写しを持たない）。
   *
   * 設定ファイルは PO が git で直すもので、書き換えたら次の判定から効いてほしい。
   * 読めないときは投げる——I2 のとおり「無い」と「壊れている」を混同しない。
   */
  /** 場所を指定して層B設定を読む（まだ受け持っていないリポジトリにも使える）。 */
  projectConfigAt(repoPath: string): ProjectConfig {
    return loadProjectConfig(repoPath);
  }

  projectConfig(projectTag: string): ProjectConfig {
    const project = this.registry.list().find((p) => p.id === projectTag);
    if (!project) return { verify: { profile: DEFAULT_VERIFY_PROFILE }, review: { poRequiredPaths: [] }, limits: {} };
    return loadProjectConfig(project.repoPath);
  }

  /**
   * レビューを通す（`kobo.approve` の実体・決定57）。
   *
   * **番頭が通しても関所は飛ばない。** ここがするのは `approved` まで進めることだけで、
   * その後マージキューがマージ前ゲート（スコープ違反の検査と検証コマンド）を回す。
   *
   * `po` と判定されたタスクは番頭には通せない（I2：黙って通さず、理由を返す）。
   * **これは経路ではなく名乗りで断っている**——`by` が誰かだけを見る。「番頭（LLM）の
   * Tool からは `by: "po"` を渡せない」ことは呼ぶ側で担保する（ADR-0023 決定113）。
   *
   * `by: "po"` のときは `via`（どの画面のどの操作から来たか）を要る形にしている
   * ——合言葉をやめた代わりに、監査可能性を記録で担保するため（決定113）。
   */
  approveTask(
    projectTag: string,
    taskId: string,
    options: { by: "banto"; note?: string } | { by: "po"; note?: string; via: string }
  ): { ok: true; status: string } | { ok: false; reason: string } {
    const task = this.store.getTask(taskId, projectTag);
    if (!task) return { ok: false, reason: `task_not_found: ${projectTag}/${taskId}` };

    const stage = this.reviewStageOf(projectTag, task);
    if (stage === "po" && options.by !== "po") {
      return {
        ok: false,
        reason:
          `${taskId} は PO の判断が要ります（${task["governance"] === true ? "統治コード" : "PO 必須の面に触る"}）。` +
          "番頭は通せません——取次へ上げてください（決定57）",
      };
    }
    if (task.status !== "review-ready" && task.status !== "in-review") {
      return {
        ok: false,
        reason: `いまの状態は ${task.status} で、レビュー待ちではありません`,
      };
    }

    // review-ready → in-review → approved。**判断したことを帳簿に残す**（誰が・何を見て）
    if (task.status === "review-ready") {
      const opened = this.transition(projectTag, taskId, "in-review", `review_opened:${options.by}`);
      if (!opened.ok) return { ok: false, reason: opened.reason ?? "in-review へ進められません" };
    }
    const approved = this.log.append({
      type: "task_approved",
      projectTag,
      taskId,
      approvedBy: options.by,
      ...(options.note ? { note: options.note } : {}),
      // 決定113: PO が通したときは**どこから来た意思表示か**を帳簿に残す
      ...("via" in options && options.via ? { via: options.via } : {}),
    });
    this.applyAndBroadcast(approved);

    const result = this.transition(projectTag, taskId, "approved", `approved_by:${options.by}`);
    if (!result.ok) return { ok: false, reason: result.reason ?? "approved へ進められません" };
    return { ok: true, status: this.store.getTask(taskId, projectTag)?.status ?? "approved" };
  }

  /**
   * そのタスクの**触れる場所**（決定59）。判断待ちの札に添えるためのもの。
   *
   * D3: 別に持たない。`env_provisioned` / `env_torn_down` を突き合わせて、いま生きている
   * 公開URLだけを返す——畳んだ環境の URL を札に載せると、開いて初めて壊れていると分かる。
   */
  reviewEnvUrl(projectTag: string, taskId: string): string | undefined {
    const history = this.index.getTaskHistory(taskId, projectTag);
    const live = new Map<string, string>();
    for (const event of history) {
      if (event.type === "env_provisioned" && event.url) live.set(event.envId, event.url);
      if (event.type === "env_torn_down") live.delete(event.envId);
    }
    return [...live.values()].pop();
  }

  /**
   * いま着手できる仕事（task-0001。spec-daemon-core §6）。
   *
   * **判定の真実を一箇所に保つ**（D3）。番頭の `kobo.list`・CLI の `kobo ready`・
   * 自動着手の tick・（将来の）ボードの Next は、**すべてこの1つの導出**を見る
   * ——別々に数え始めると、画面と実際の着手がずれる。
   *
   * `ready` はゲート（依存・スコープ重複・物理quota）を通ったものだけが載る状態なので、
   * ここは状態を読むだけでよい。ゲートの判定そのものは `GateEvaluator` にある。
   */
  readyTasks(projectTag?: string): TaskRecord[] {
    const tasks = projectTag
      ? this.store.getTasksByProject(projectTag)
      : this.store.getAllTasks();
    return tasks.filter((task) => task.status === "ready");
  }

  /**
   * そのタスクを積んだ宛先（決定58）。積まれ方によっては無い（PO がファイルを置いた等）。
   *
   * D3: 別に持たない。取り込み時に契約と一緒に固めた値を読む。
   */
  originOfTask(projectTag: string, taskId: string): string | undefined {
    const task = this.store.getTask(taskId, projectTag);
    const origin = task?.["origin"];
    return typeof origin === "string" && origin.length > 0 ? origin : undefined;
  }

  /** 最後に振られたイベントID。ここを起点に読むと重複なく続けられる。 */
  get lastEventId(): number {
    const all = this.log.readAllEvents();
    return all.length > 0 ? (all[all.length - 1]!.eventId ?? 0) : 0;
  }

  /**
   * イベントを古い順に読む（`kobo.events` の実体）。
   *
   * `origin` で絞れるのが要点——番頭ホストは**自分のスレッドが積んだタスクの分だけ**を
   * 拾って会話へ返す（決定58。職人の `worker.events` と同じ形）。
   */
  readEvents(
    filter: { afterEventId?: number; projectTag?: string; origin?: string; limit?: number } = {}
  ): OrchestrationEvent[] {
    const after = filter.afterEventId ?? 0;
    const limit = Math.max(1, filter.limit ?? 100);
    const found: OrchestrationEvent[] = [];
    for (const event of this.log.readAllEvents()) {
      if ((event.eventId ?? 0) <= after) continue;
      if (filter.projectTag && event.projectTag !== filter.projectTag) continue;
      if (filter.origin) {
        const taskId = "taskId" in event ? (event.taskId as string | undefined) : undefined;
        if (!taskId) continue;
        if (this.originOfTask(event.projectTag, taskId) !== filter.origin) continue;
      }
      found.push(event);
      if (found.length >= limit) break;
    }
    return found;
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
   * 起こした職人が**まだ要るか**を確かめ、要らなければその場で畳む（task-0072）。
   *
   * **起こすのは非同期**で、`closeWorkerFor` と `worker.delegate_toolkit` の HTTP 往復を
   * 挟む。その間にタスクが先へ進む（あるいは失敗して終端に着く）ことがあり、そうなると
   * **出来上がった職人を誰も畳まない**——終端に着いたときの後始末は「いま居る職人」を
   * 畳むので、まだ生まれていなかった職人は取りこぼす。
   *
   * 実際に起きていた：2回目の監査不通過でタスクが failed になったあと、1回目の不通過で
   * 頼んでいた rework の職人が**遅れて生まれ**、工房の安全弁（既定15分）まで走り続けていた。
   * 混んでいるときだけ出るので、受け入れテストでは「まれに落ちる」という形で見えていた。
   *
   * I3: 放っておくと外で走り続ける。**気づけない壊れ方**なので、機構で塞ぐ。
   *
   * @returns まだ要るなら true。畳んだなら false（呼び出し側は帳簿に書かずに戻る）
   */
  private async keepWorkerIfStillWanted(opts: {
    projectTag: string;
    taskId: string;
    role: WorkerRole;
    sessionId: string;
    /** この状態のどれかなら、その職人はまだ要る。 */
    wantedIn: readonly string[];
  }): Promise<boolean> {
    const { projectTag, taskId, role, sessionId, wantedIn } = opts;
    // 起こしている間に帳簿が進んでいる。**読み直す**（起こす前の写しで判断しない）
    this.refreshState();
    const status = this.store.getTask(taskId, projectTag)?.status;
    if (status !== undefined && wantedIn.includes(status)) return true;

    process.stderr.write(
      `[banto-daemon] ${projectTag}/${taskId} は ${role} を起こしている間に ` +
        `${status ?? "(消えた)"} へ移りました（${wantedIn.join(" / ")} のはず）。` +
        `生まれたばかりの職人を畳みます（${sessionId}）\n`
    );
    try {
      await this.workerInvoke("worker.close", { sessionId });
    } catch (err) {
      // I2: 畳めなかったことは残す。工房の安全弁が後で拾う
      process.stderr.write(
        `[banto-daemon] 遅れて生まれた職人を畳めませんでした（${sessionId}）: ${String(err)}\n`
      );
    }
    return false;
  }

  /**
   * 職人を1人起こす（`worker.delegate_toolkit`）。
   *
   * `driverOptions` を渡せる内部の口を使うのは、**Kobo が自分の拡張を載せる**ため
   * （banto-executor / banto-auditor が `report_phase` / `audit_report` を提供する。決定29e）。
   * 番頭にこの口は渡らない——LLM に任意のコードを載せさせないため。
   */
  /** いまの役割ごとの当て方（設定画面が読む）。 */
  roleAssignments(): RoleAssignments {
    return { ...this._roleAssignments };
  }

  /**
   * 役割ごとの当て方を差し替える（決定41：設定画面から）。**次に起こす職人から**効く。
   * 動いている職人はそのまま——途中でモデルが変わる方が分かりにくい。
   */
  setRoleAssignments(next: RoleAssignments): void {
    this._roleAssignments = { ...next };
    this.config.roleAssignmentsSection?.write({
      ...(this.config.roleAssignmentsSection.read() ?? {}),
      roleAssignments: this._roleAssignments,
    });
  }

  /**
   * 名指しに使える、Worker Pool が持っているモデル（届かなければ空）。
   *
   * 設定画面はこれで**選ばせる**。工場がモデルの表を持つのではなく、そのつど数え上げて
   * もらう——「LLM・モデル」で職人に許したものが増減しても、工場は何も知らないで済む。
   */
  async selectableModels(): Promise<Array<{ name: string; label: string }>> {
    try {
      const details = await this.workerInvoke("worker.models", {});
      const models = (details["models"] ?? []) as Array<{
        name?: unknown;
        label?: unknown;
        runtimeTitle?: unknown;
      }>;
      return models
        .map((m) => ({
          name: String(m.name ?? ""),
          label: `${m.runtimeTitle ? `${String(m.runtimeTitle)}: ` : ""}${String(m.label ?? m.name ?? "")}`,
        }))
        .filter((m) => m.name.length > 0);
    } catch {
      // I2 の例外: 届かないことを「選べるものが無い」と混同しない。画面は自由入力に落ちる
      return [];
    }
  }

  /** 名指しの照合に使う、Worker Pool が持っているモデル名（届かなければ空）。 */
  async selectableModelNames(): Promise<string[]> {
    try {
      const models = await this.selectableModels();
      return models.map((m) => m.name);
    } catch {
      // I2 の例外: 照合できないことを「知らない名前」と混同しない。工房が落ちている
      // だけのときに設定を保存できなくなる方が困る——確かめられなければ通す
      return [];
    }
  }

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

    /**
     * PO がこの役割に当てたもの（設定画面。PO裁定 2026-08-10）。
     *
     * 名指しがあれば等級より優先する——「監査は opus で」と決めたのに、昇格や
     * タスクの `model_tier` で別のモデルに化けるなら、決めた意味が無い。
     */
    const assigned = this._roleAssignments[opts.role as KoboRole] ?? {};
    const modelTier = assigned.tier ?? opts.modelTier;
    if (assigned.tier || assigned.model) {
      process.stdout.write(
        `[banto-daemon] ${opts.projectTag}/${opts.taskId}: ${opts.role} は設定の当て方で起こします` +
          `（${assigned.model ? `モデル ${assigned.model}` : `等級 ${modelTier}`}）\n`
      );
    }

    const details = await this.workerInvoke("worker.delegate_toolkit", {
      taskId: poolId,
      projectTag: opts.projectTag,
      origin: KOBO_ORIGIN,
      worktreePath: opts.worktreePath,
      instruction: opts.instruction,
      modelTier,
      ...(assigned.model ? { model: assigned.model } : {}),
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
   * 既定では **repo-manager の並び**（`layout.ts`）に作る——そのまま場所として番頭にも
   * PO にも見える。`worktreeBaseDir` を明示した構成だけ、素の `git worktree` でそこに作る。
   *
   * **リモートの有無に依らない**（PO裁定 2026-08-11）。以前は `gwq` に作らせていて、
   * `gwq` は置き場を `git remote get-url origin` から組み立てるため、**まだ push して
   * いないリポジトリではタスクが1本も回らなかった**（ひらがなの task-0001 / 0002）。
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
   * 置き場所を決めるのは repo-manager の並びなので、**Kobo は組み立てない**——起こした
   * ときに `agent_spawned.worktree` に残してあるものを読む。まだ職人を起こしていない
   * タスクは明示の置き場（または既定）の見込みのパスを返す（マージキューの後始末が使う）。
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
   * そのタスクのワークツリー。**無ければ用意する**（PO報告 2026-08-11）。
   *
   * `worktreeOf` は帳簿を引くだけなので、**一度も職人を起こせていないタスク**では
   * 見込みのパスが返る——そこは存在しない。監査も rework もそれを `cwd` に渡すので、
   * `spawn ENOENT` で落ちる。実際、ワークツリー作成に失敗して failed になった
   * hiragana/task-0002 は、直しても同じところで落ち続けた（P6：同じ場所で落ち続けるなら
   * 直し方ではなく前提を疑う）。
   *
   * 用意は冪等なので、既にあるものは作り直さない（実装者と同じ場所を見る）。
   */
  private async worktreeFor(projectTag: string, taskId: string): Promise<string> {
    const events = this.index.getTaskHistory(taskId, projectTag);
    for (let i = events.length - 1; i >= 0; i--) {
      const ev = events[i]!;
      if (ev.type === "agent_spawned" && ev.worktree) return ev.worktree;
      if (ev.type === "audit_started" && ev.worktree) return ev.worktree;
    }
    return this.ensureWorktree(projectTag, taskId);
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

    // task-0072: 起こしている間にタスクが先へ進んでいたら、生まれたての職人を畳んで戻る。
    // ここは `ready` のはず——終端へ着いていると次の `planning` への遷移が弾かれ、
    // **職人だけが宙に浮く**（帳簿には載るのに、誰も面倒を見ない）
    if (
      !(await this.keepWorkerIfStillWanted({
        projectTag,
        taskId,
        role: "executor",
        sessionId: session.sessionId,
        wantedIn: ["ready"],
      }))
    ) {
      throw new Error(
        `Task '${taskId}' left 'ready' while the worker was starting; the worker was closed`
      );
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
   * 職人が聞いてきた／答えが届いた（PO報告 2026-08-11）。
   *
   * **聞かれたら止める。** 待っているのはタスクそのものなので、状態を `paused` にして
   * 理由に質問文を置く——`kobo-notice.ts` が paused を「止まって待っています」として
   * **積んだ会話へ**返すので、番頭が読んで `worker.steer` で答えられる。
   *
   * **答えが届いたら元へ戻す。** `StateMachine.pause` は止まる前の状態を控えている
   * （`suspended_from`）ので、そこへ戻せばよい——実装の途中だったのか監査の途中だったのかを
   * ここで推測しない（D3）。
   *
   * I2: 自分が起こした職人でなければ触らない。他人の職人の質問でタスクを止めない。
   */
  private applyWorkerQuestion(event: WorkerEventView): void {
    const { taskId } = splitPoolTaskId(event.taskId);
    const projectTag = event.projectTag;
    const history = this.index.getTaskHistory(taskId, projectTag);
    const spawned = history.some(
      (e) => e.type === "agent_spawned" && e.sessionId === event.sessionId
    );
    if (!spawned) return;
    const current = this.store.getTask(taskId, projectTag);
    if (!current) return;

    if (event.type === "worker_asked") {
      // 既に止まっているなら重ねない（同じ職人が続けて聞くことはある）
      if (current.status === "paused") return;
      const question = String(event.data["question"] ?? "").trim();
      const result = StateMachine.pause(
        this.log,
        taskId,
        current.status as TaskStatus,
        projectTag,
        `職人が聞いています: ${question || "（質問文が記録されていません）"}\n` +
          `答えるには worker.steer（sessionId: ${event.sessionId}）。` +
          "答えると職人は待ちを解いて動き出し、このタスクも元の状態へ戻ります"
      );
      // I2: 止められなかったことを黙って成功にしない（終端の状態などで起きる）
      if (!result.ok) {
        process.stderr.write(
          `[banto-daemon] ${projectTag}/${taskId} を止められませんでした（職人の質問）: ${result.reason}\n`
        );
        return;
      }
      this.refreshState();
      this.broadcastLastEvent();
      return;
    }

    // 答えが届いた＝待ちが解けた。**止まる前の状態へ戻す**
    if (current.status !== "paused") return;
    // どこから止まったかは帳簿にある（`task_paused.suspended_from`）。推測しない（D3）
    const suspendedFrom = [...history]
      .reverse()
      .find((e): e is Extract<OrchestrationEvent, { type: "task_paused" }> => e.type === "task_paused")
      ?.suspended_from;
    if (!suspendedFrom) {
      // I2: 戻り先が分からないまま適当な状態へ動かさない。止まったままにして知らせる
      process.stderr.write(
        `[banto-daemon] ${projectTag}/${taskId} の戻り先が帳簿にありません（止まったままにします）\n`
      );
      return;
    }
    const resumed = StateMachine.resume(this.log, taskId, "paused", suspendedFrom, projectTag);
    if (!resumed.ok) {
      process.stderr.write(
        `[banto-daemon] ${projectTag}/${taskId} を戻せませんでした（答えが届いた後）: ${resumed.reason}\n`
      );
      return;
    }
    this.refreshState();
    this.broadcastLastEvent();
  }

  /**
   * 職人が「終わった」と言ってきた（PO報告 2026-08-11）。
   *
   * **`done` が立っているときだけ動かす。** 途中経過の報告（`done: false`）で監査へ
   * 回すと、書きかけを検証させることになる。
   *
   * **実装役だけ。** 監査人の報告は判定ではない——自由文から pass / fail を推測すると、
   * 落ちるべきものが通る。判定の口（`audit_report`）を持たないランタイムで動いている
   * ことは**それ自体が異常**なので、下の I2 の通り理由を添えて止める。
   *
   * I2: 自分が起こした職人でなければ触らない。既に先へ進んでいるものも動かさない（冪等）。
   */
  private applyWorkerReport(event: WorkerEventView): void {
    const { taskId, role } = splitPoolTaskId(event.taskId);
    const projectTag = event.projectTag;
    const history = this.index.getTaskHistory(taskId, projectTag);
    const spawned = history.some(
      (e) => e.type === "agent_spawned" && e.sessionId === event.sessionId
    );
    if (!spawned) return;
    if (event.data["done"] !== true) return; // 途中経過は状態を動かさない
    /**
     * **いま働いている職人の報告だけを読む**（実測 2026-08-11）。
     *
     * 工房の帳簿はどこまで読んだかを別に持たない（D3：起動時は 0 から読み直す）ので、
     * 再起動すると**過去の報告がもう一度流れてくる**。同じタスクを戻して（rework）
     * 起こし直していると、その古い報告がいまの試行に当たってしまう——実際、前の監査人の
     * 「判定の口が無い」報告が、口を載せ直したあとの試行を落とした。
     *
     * いまの職人かどうかは帳簿の**最後の `agent_spawned`** で決まる。過去の分は読み捨てる。
     */
    if (event.sessionId !== latestSpawnedSessionId(history)) return;
    const current = this.store.getTask(taskId, projectTag);
    if (!current) return;

    const summary = String(event.data["summary"] ?? "").trim();

    if (role === "audit") {
      /**
       * 監査人が**判定の口を使わずに**「終わった」と言ってきた。
       *
       * 自由文から通す／通さないを決めない（決定57 の一次受けは判定表であって作文ではない）。
       * 黙って待つと安全弁の時間まで止まるので、**その場で理由を出して止める**——
       * 監査の口が載っていないランタイムで監査を回している、という機構の問題だから。
       */
      if (current.status !== "auditing") return;
      process.stderr.write(
        `[banto-daemon] ${projectTag}/${taskId}: 監査人が判定を出さずに報告しました` +
          "（このランタイムに audit_report が載っていません）\n"
      );
      this.recordTaskFailed(
        projectTag,
        taskId,
        "audit_reported_without_verdict: 監査人が判定の口（audit_report）を使わずに報告しました。" +
          "このランタイムには監査の口が載っていません" +
          (summary ? `。監査人の言い分: ${summary}` : "")
      );
      return;
    }

    // 実装役（executor / rework）。**まだ実装中のときだけ**監査へ回す
    if (current.status !== "implementing" && current.status !== "planning") return;
    /**
     * **段を飛ばさない。** `planning → auditing` は工程として通らない（ステートマシン）。
     * pi の職人は `report_phase("implementing")` を通って進むが、その口を持たない
     * ランタイムの職人は planning のまま終える——ここで1段進めてから監査へ回す。
     * 「実装していた」ことは職人の報告そのものが示している。
     */
    if (current.status === "planning") {
      const stepped = this.transition(
        projectTag,
        taskId,
        "implementing",
        `職人の報告（${role}）で実装中と分かりました`
      );
      if (!stepped.ok) {
        process.stderr.write(
          `[banto-daemon] ${projectTag}/${taskId} を implementing へ進められませんでした: ${stepped.reason}\n`
        );
        return;
      }
    }
    const result = this.transition(
      projectTag,
      taskId,
      "auditing",
      `職人の報告（${role}）: ${summary || "（要約が記録されていません）"}`
    );
    if (!result.ok) {
      process.stderr.write(
        `[banto-daemon] ${projectTag}/${taskId} を監査へ回せませんでした: ${result.reason}\n`
      );
    }
  }

  /** 帳簿の末尾を配る（`refreshState` の直後に使う。既存の経路と同じ形）。 */
  private broadcastLastEvent(): void {
    const all = this.log.readAllEvents();
    if (all.length > 0) this.wsServer.broadcast(all[all.length - 1]!);
  }

  /**
   * 職人の1件の出来事を、Kobo の帳簿とステートマシンへ写す。
   *
   * **意味を与えるのは起動元**（決定29d）。Worker Pool は中立な事実を並べるだけで、
   * 「監査人が判定を出さずに終わった＝失敗」という読みは Kobo の統治の話。
   */
  private applyWorkerEvent(event: WorkerEventView): void {
    /**
     * **職人の質問を宙に消さない**（PO報告 2026-08-11）。
     *
     * `worker_asked` を誰も読んでいなかった。番頭ホスト側の知らせは
     * 「番頭が起こした職人の分だけ」で弾かれ（決定29）、Kobo はここで exited / closed
     * しか見ていなかった——**Kobo が起こした職人の質問は、どこにも出ないまま消えていた。**
     * 職人は答えを待って止まり、やがて時間切れで終わり、`agent_exited_without_report`
     * として failed になる。banto/task-0091 のセッションログにその形がそのまま残っている
     * （「質問を投げて待っています」で止まったまま、33分後に failed）。
     *
     * 待っていることは**タスクの状態そのもの**なので、`paused` にする——止まった理由が
     * 質問文になり、既存の知らせの道（`kobo-notice.ts` の paused）で**積んだ会話へ**返る。
     * 番頭は `worker.steer` で答え、答えが届いたら（`worker_answered`）元の状態へ戻す。
     */
    if (event.type === "worker_asked" || event.type === "worker_answered") {
      this.applyWorkerQuestion(event);
      return;
    }
    /**
     * **「終わった」を工房の経路からも受ける**（PO報告 2026-08-11）。
     *
     * ここは「報告は Kobo の経路（`report_done`）に来る」という前提で書かれていた。
     * その前提は **pi の職人にしか当てはまらない**——`report_done` は pi 拡張
     * （`pi-extension/banto-executor.ts`）が載せる口で、`extensionPaths` は pi の言葉。
     * Claude Code の職人にはその口が無く、汎用の `worker.report` で工房へ報告する。
     *
     * 結果、**Claude Code で動く職人のタスクは 1本も先へ進まなかった**：実装を終えて
     * コミットまでしているのに Kobo は `implementing` のまま、やがて職人が終わって
     * `agent_exited_without_report` で failed になる。hiragana の task-0001 / 0002 が
     * まさにこれで、工房の帳簿には `worker_reported { done: true }` が残っている。
     *
     * **意味を与えるのは起動元**（決定29d）なので、ここで受けるのが筋——ランタイムに
     * 依らず同じ形になる。二重にはならない：`report_done` を通った職人は既に auditing
     * へ移っており、下の遷移は planning / implementing のときしか起こさない。
     */
    if (event.type === "worker_reported") {
      this.applyWorkerReport(event);
      return;
    }
    /**
     * **喋り終わった時点で先へ進める**（PO要望 2026-08-11）。
     *
     * 以前は「明示の報告」か「安全弁の時間切れ（既定15分）」しか完了を知る道が無かった。
     * 出力が終わればその場で分かるのだから、待つ理由が無い——ランタイムがターンの
     * 終わりを積むようになったので、Kobo はそれを読む。
     *
     * **答え待ちは終わりではない**（`waiting`）。質問して止まっている職人を「終わった」
     * として監査へ回すと、書きかけを検証させることになる。
     */
    if (event.type === "worker_turn_ended") {
      if (event.data["waiting"] === true) return;
      // 報告があったならそちらで進んでいる（`applyWorkerReport`）。ここは無報告の埋め合わせ
      this.applyWorkerReport({
        ...event,
        data: {
          done: true,
          summary: String(event.data["text"] ?? "").trim() || "（発話なしで手を止めました）",
        },
      });
      return;
    }
    // 終わった（exited）か畳まれた（closed）ものだけを見る
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
      // **判定を出さずに落ちたのは「判断」ではなく「事故」**（PO報告 2026-08-07）。
      // 監査が fail の判定を出したときは1回やり直させる（countConsecutiveAuditFails）のに、
      // 監査人が落ちたときは0回で failed にしていた——**逆**である。落ちた側こそ、
      // もう一度起こせば通ることが多い（モデルの一時的な失敗・プロセスの事故）。
      // **いま動いている監査人の分だけ数える。** 置き換えられた古い監査人の終了も
      // ここへ来る（同じ taskId で起こし直すと、工房が前の1人を畳む）——それで数えると
      // 1回の事故で2人起こしてしまう。実際そうなった（試験で捕まえた）
      if (event.sessionId !== latestSpawnedSessionId(history)) return;
      const attempts = this.countAuditAttempts(projectTag, taskId);
      if (attempts < AUDIT_ATTEMPT_LIMIT) {
        process.stderr.write(
          `[banto-daemon] 監査が判定を出さずに終わりました（${projectTag}/${taskId}）。` +
            `${attempts}/${AUDIT_ATTEMPT_LIMIT} 回目——もう一度起こします\n`
        );
        // 状態は auditing のまま。**もう一度 audit_started が積まれる**ので、
        // 何回試したかは帳簿から数えられる（新しいイベント種を増やさない）
        this._trackBackground(
          new Promise<void>((resolve) => {
            setImmediate(() =>
              void this.spawnAuditSession(projectTag, taskId).then(resolve, resolve)
            );
          })
        );
        return;
      }
      process.stderr.write(
        `[banto-daemon] 監査が ${attempts} 回とも判定を出さずに終わりました（${projectTag}/${taskId}）\n`
      );
      // I2: 何回試したのかを理由に残す。「1回で諦めた」と「粘って駄目だった」は別の話
      this.recordTaskFailed(
        projectTag,
        taskId,
        `audit_session_exited_without_verdict (${attempts}回試行)`
      );
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
    reason?: string,
    /**
     * `abandon: true` のときだけ `closed` を**横断の遷移**として扱う（PO 裁定 2026-08-14）。
     *
     * 旗を要るようにしているのは、遷移表の `closed` を素通しにしないため——HTTP の
     * `/transition` も機構の tick もこの口を通るので、素通しにすると「どの状態からでも
     * 誰でも閉じられる」になる。畳むのは番頭の判断の口（`kobo.abandon`）だけ。
     */
    opts?: { abandon?: boolean }
  ): TransitionResult {
    const task = this.store.getTask(taskId, projectTag);
    if (!task) return { ok: false, reason: "task_not_found" };

    const fromStatus = task.status as TaskStatus;
    const toStatus = to as TaskStatus;

    // Cross-cutting transitions: failed and superseded are reachable from any non-terminal state.
    // Route through StateMachine.fail() / StateMachine.supersede() instead of the transition table.
    let result: TransitionResult;
    if (toStatus === "closed" && opts?.abandon === true) {
      result = StateMachine.abandon(
        this.log,
        taskId,
        { currentStatus: fromStatus, reason: reason ?? "abandoned" },
        projectTag
      );
    } else if (toStatus === "failed") {
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
      // 決定59: **判断が付いた瞬間に畳む。** 終端（failed/closed/superseded）に加えて、
      // レビューを抜けたとき（approved）も畳む——判断待ちの間だけ生かすのが決定59 の
      // 「環境の寿命は判断に紐づける」。放置された札の分は TTL が落とす
      //
      // **差し戻しも「判断が付いた」である**（段2・11c）。レビューから implementing へ
      // 戻ったとき、触るための環境はもう要らない——ここを入れないと、環境の寿命が
      // 「判断」ではなく TTL 任せになる（決定59 が守りたかったものが緩む）
      const TERMINAL_STATES = new Set(["failed", "closed", "superseded", "approved"]);
      const sentBack =
        (fromStatus === "review-ready" || fromStatus === "in-review") && toStatus === "implementing";
      if (TERMINAL_STATES.has(toStatus) || sentBack) {
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

      // S9d7fdb-7 (AC-S9d7fdb-7-1, AC-S9d7fdb-7-2): Auto-provision env on entering review-ready.
      // 監査を通ったタスクが判断待ちに入ったら、その環境を自動で立てる
      // ——PO が見るだけでなく触れる状態で差し出すため（決定59。tmux ペインは廃止した）。
      //
      // **発火点は `review-ready`**（段11c-3・報告 A-6 (4)）。以前は `in-review` だったが、
      // `approveTask` が review-ready → in-review → approved を**同じ同期呼び出しで**進めるため、
      // in-review の滞在時間は実測で中央値 0.01 秒・最大 0.03 秒しかなく、`setImmediate` で
      // 走り出す頃には必ず approved に着いていた——立てた直後に必ず畳まれ、**PO が触れる時間が
      // 存在しなかった**（実測 `env_provisioned` 0 件）。判断待ちの時間はすべて review-ready で
      // 過ごされる。**畳む側（判断が付いたら畳む）は変えていない。**
      //
      // Design rules:
      //   D5: all orchestration logic here; HTTP layer is pure routing.
      //   I2: provision failure MUST NOT block the transition — it is surfaced as an event.
      //       The transition is already committed (D3); this hook is fire-and-forget.
      //   D3: we read the task record from the state store (the event-derived record),
      //       not from disk directly — the event log is the single runtime truth.
      if (toStatus === "review-ready") {
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

    // 実装者と同じワークツリーを見る（帳簿から引く。無ければ用意する）
    const worktreePath = await this.worktreeFor(projectTag, taskId);

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

    // task-0072: 起こしている間にタスクが先へ進んでいたら、生まれたての職人を畳んで戻る。
    // **audit_started を積む前に**確かめる——積むと `countAuditAttempts` が数えてしまい、
    // 誰も使っていない職人の分だけ、やり直しの回数が減る
    if (
      !(await this.keepWorkerIfStillWanted({
        projectTag,
        taskId,
        role: "audit",
        sessionId: session.sessionId,
        wantedIn: ["auditing"],
      }))
    ) {
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

    /**
     * **何に対して監査したのか**を、判定と同じイベントに刻む（realign 第2便・段1）。
     *
     * 契約の版は**帳簿から導出する**（`contractVersionOf`）——新しい版番号は持たない。
     * 決定64 改訂で「凍結ではなく版で答える」と決めており、その版を既に
     * `task_created` / `task_contract_amended` の並びが表している。別に数えると
     * 二重管理になり、食い違ったときどちらが正か決められない（D3）。
     *
     * 基準の版はチェックリストの中身の指紋。**監査人に届いている中身**の指紋である
     * ことが要点で、届けているのは `buildAuditInstruction`（両方の職人経路に載る）。
     *
     * I2: 指紋が作れないこと（資産が無い）を判定の失敗にはしない——判定そのものは
     * 既に出ている。刻めなかったことを標準エラーに出し、**項目は付けない**
     * （分からないものを埋めると、証拠が嘘になる）。
     */
    const contractVersion = contractVersionOf(this.getTaskEvents(projectTag, taskId), projectTag, taskId);
    let checklistVersion: string | undefined;
    try {
      checklistVersion = promptAssetDigest("audit-checklist");
    } catch (err) {
      process.stderr.write(
        `[banto-daemon] ${projectTag}/${taskId}: 監査基準の版を刻めませんでした: ${String(err)}\n`
      );
    }

    // Record the verdict event first (D3: event is the truth).
    const verdictEvent = this.log.append({
      type: "audit_verdict",
      projectTag,
      taskId,
      verdict,
      findings,
      ...(contractVersion !== undefined ? { contractVersion } : {}),
      ...(checklistVersion !== undefined ? { checklistVersion } : {}),
    });
    this.applyAndBroadcast(verdictEvent);

    if (verdict === "pass") {
      // レビューは3段（決定57）。`auto` だけが人も番頭も見ずにマージへ進む。
      // **`po` は機械的に判定される**ので、タスクが auto を名乗っていても統治コードや
      // PO 必須の面に触るなら止まる——緩い方へは倒れない
      const stage = this.reviewStageOf(projectTag, task);

      /**
       * **証拠の無いものは自動着地させない**（realign 第3便・PO 裁定 2026-08-14）。
       *
       * `auto` は「人を通さなくてよい」という宣言でしかなく、**通してよい根拠**は別に要る。
       * 刻み（どの契約に・どの基準で監査したか）と、ゲートが回すべき検査が契約にあること。
       * どちらかを欠けば `banto` へ落として人の目を通す——**緩い方へは倒れない**。
       *
       * タスクが `auto` を名乗っていても同じに見る。検査ゼロの契約はゲートが素通りするので、
       * 宣言の有無に関わらず「何も確かめずに着地した」が起きる。
       *
       * I2: 落とした理由を遷移の `reason` に書き切る。帳簿だけを見て原因が分かること。
       */
      const blockers =
        stage === "auto"
          ? autoLandBlockers({
              ...(contractVersion !== undefined ? { contractVersion } : {}),
              ...(checklistVersion !== undefined ? { checklistVersion } : {}),
              acceptance: getAcceptance(task),
            })
          : [];
      const landed = stage === "auto" && blockers.length === 0;
      const targetStatus = landed ? "merging" : "review-ready";
      const reason = landed
        ? "audit_passed:auto"
        : blockers.length > 0
          ? `audit_passed:auto→banto（自動着地の条件を満たさない: ${blockers.join("; ")}）`
          : `audit_passed:${stage}`;

      this.transition(projectTag, taskId, targetStatus, reason);
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
    findings: string[],
    /** 指摘の見出し。監査のやり直しと、落ちたタスクの立て直しで言葉が違う（task-0081） */
    findingsHeading?: string
  ): Promise<void> {
    const task = this.store.getTask(taskId, projectTag);
    if (!task) {
      process.stderr.write(
        `[banto-daemon] spawnReworkSession: task ${projectTag}/${taskId} not found\n`
      );
      return;
    }

    // 実装者と同じワークツリーで直す（作り直すと、直す対象が消える）。
    // 一度も起こせていないタスクはここで初めて用意される（PO報告 2026-08-11）
    const worktreePath = await this.worktreeFor(projectTag, taskId);

    // 監査人はもう役目を終えている。畳んでから rework を起こす
    await this.closeWorkerFor(projectTag, poolTaskId(taskId, "audit"));

    // 落ちた回数だけ等級を上げる（1回目の不通過 → 一段上で直させる）。
    // **昇格も上限に掛かる**（決定67）——上限を超える分は上げない。ここで拒否にしないのは、
    // 積む時点では上限内だったタスクを途中で止めることになるため。据え置いたことは記録に残す
    const fails = this.countConsecutiveAuditFails(projectTag, taskId);
    const wanted = escalateTier(taskModelTier(task), fails);
    const ceiling = this.projectConfig(projectTag).limits.maxModelTier;
    const modelTier =
      ceiling && TIER_ORDER.indexOf(wanted) > TIER_ORDER.indexOf(ceiling) ? ceiling : wanted;
    if (modelTier !== wanted) {
      process.stdout.write(
        `[banto-daemon] ${projectTag}/${taskId}: 昇格 ${wanted} は上限 ${ceiling} を超えるので ` +
          `${modelTier} に据え置きます（決定67）\n`
      );
    }

    let session: SpawnedSession;
    try {
      session = await this.delegateWorker({
        projectTag,
        taskId,
        role: "rework",
        worktreePath,
        instruction: buildExecutorInstruction(task, worktreePath, findings, findingsHeading),
        modelTier,
        extension: "banto-executor",
      });
    } catch (err) {
      const reason = `rework session spawn failed: ${err instanceof Error ? err.message : String(err)}`;
      this.recordTaskFailed(projectTag, taskId, reason);
      return;
    }

    // task-0072: 起こしている間にタスクが先へ進んでいたら、生まれたての職人を畳んで戻る
    if (
      !(await this.keepWorkerIfStillWanted({
        projectTag,
        taskId,
        role: "rework",
        sessionId: session.sessionId,
        wantedIn: ["implementing"],
      }))
    ) {
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
  /**
   * いまの auditing の回で、監査人を何回起こしたか（PO報告 2026-08-07）。
   *
   * **新しいイベント種を増やさずに数える。** 監査を起こすたびに `audit_started` が積まれる
   * ので、直近の「→ auditing」の遷移から後ろを数えれば試行回数になる。イベントログの形は
   * 外に累積する副作用（D9 は one-way として D1 に戻す）なので、既にあるもので足りるなら
   * 増やさない。
   *
   * `implementing → auditing`（やり直し後の再監査）で数え直すのが要点——別の回の事故を
   * 持ち越すと、2回目の監査が1回も試されずに failed になる。
   */
  /**
   * いま動いている監査人の sessionId（帳簿から引く）。
   *
   * `spawnAuditSession` は `audit_started` の直後に `agent_spawned` を積むので、
   * **最後の `audit_started` より後の `agent_spawned`** がいまの監査人。
   * 置き換えられた古い監査人と区別するために要る。
   */
  private currentAuditSessionId(projectTag: string, taskId: string): string | undefined {
    const events = this.index.getTaskHistory(taskId, projectTag);
    for (let i = events.length - 1; i >= 0; i--) {
      const ev = events[i];
      if (ev?.type === "agent_spawned" && ev.sessionId) return ev.sessionId;
      // agent_spawned に出会う前に audit_started まで戻ったなら、まだ起き切っていない
      if (ev?.type === "audit_started") return undefined;
    }
    return undefined;
  }

  private countAuditAttempts(projectTag: string, taskId: string): number {
    const events = this.index.getTaskHistory(taskId, projectTag);
    let attempts = 0;
    for (let i = events.length - 1; i >= 0; i--) {
      const ev = events[i];
      if (ev?.type === "audit_started") attempts++;
      // この回の始まりまで来たら止める（前の回の試行を持ち越さない）
      if (ev?.type === "state_transitioned" && ev.to === "auditing") break;
    }
    return attempts;
  }

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
    return this.environmentProfilesAt(proj.repoPath);
  }

  /**
   * 場所を指定してプロファイルを引く（まだ受け持っていないリポジトリにも使える）。
   *
   * **Kobo はプロファイルの定義ファイルを自分で読まない**（決定60a・task-0076）。
   * プロファイルの意味は検証環境の持ち物で、読み方を2箇所に置くと**同じ定義に2つの解釈**が
   * できる——「Kobo は使えると言うのに立たない」が起きる。
   * 受け持たせるときの検査（task-0076）もここを通す。
   */
  async environmentProfilesAt(
    repoPath: string
  ): Promise<{ usable: EnvProfileView[]; rejected: Array<{ name: string; reason: string }> }> {
    const details = await this.envInvoke("env.list_profiles", { repoPath });
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
  /**
   * マージ前ゲートが検証を回す場所（task-0075・PO裁定 2026-08-07）。
   *
   * **Kobo はホストで検証を走らせない。** 受け持つプロジェクトのテストは、そのプロジェクトが
   * 宣言した検証環境の中で回す——ホストで走らせると、ホストの状態（入っている道具・空いて
   * いるポート）が検証結果に混ざる。実際に混ざった（inc-0032）。
   *
   * レビュー用の環境（`provisionEnv`）とは別物：**公開しない**（人は触らない）し、
   * 帳簿にも載せない（ゲートの中で立てて畳む一時のもの。台帳は Environment Pool が持つ）。
   */
  gateVerifyRunner(): GateVerifyRunner {
    return {
      provision: async (opts) => {
        const details = await this.envInvoke("env.provision", {
          repoPath: opts.repoPath,
          profile: opts.profile,
          workdir: opts.workdir,
          taskId: opts.taskId,
          projectTag: opts.projectTag,
        });
        const envId = details["envId"];
        // I2: envId が無いのに成功扱いにすると、畳む先を失う
        if (typeof envId !== "string") {
          throw new Error(`env.provision が envId を返しませんでした（profile: ${opts.profile}）`);
        }
        // 段1: **どの環境で検査したか**を証拠に刻むための指紋。返らないなら刻まない
        // ——Kobo は環境の中身を知らないので、ここで作り直すことはしない（決定60a）
        const digest = details["profileDigest"];
        return {
          envId,
          ...(typeof digest === "string" ? { profileDigest: digest } : {}),
        };
      },
      run: async (opts) => {
        const details = await this.envInvoke("env.run", {
          envId: opts.envId,
          cmd: opts.cmd,
          timeoutMs: opts.timeoutMs,
          // ゲートのログへ写す分。畳むと環境の中身は消えるので、判断の材料は手元に残す
          logTailLines: 200,
        });
        return {
          exit: typeof details["exit"] === "number" ? (details["exit"] as number) : 1,
          ...(typeof details["logPath"] === "string" ? { logPath: details["logPath"] as string } : {}),
          ...(typeof details["logTail"] === "string" ? { logTail: details["logTail"] as string } : {}),
        };
      },
      teardown: async (envId) => {
        await this.envInvoke("env.teardown", { envId });
      },
    };
  }

  /**
   * @param options.workdir **どこを映すか**（段11c-2・報告 A-6 (3)）。タスクのワークツリーを
   *   渡す。渡さないとドライバ側で `repoPath`（＝ main のチェックアウト）に落ちるので、
   *   **ブランチの変更が1つも映っていない画面を PO に触らせる**ことになる
   *   ——ゲートの経路（`gateVerifyRunner`）は最初から渡していて、ここだけ欠けていた
   */
  async provisionEnv(
    projectTag: string,
    taskId: string,
    profileName: string,
    options: { forReview?: boolean; workdir?: string } = {}
  ): Promise<{ ok: true; envId: string; url?: string } | { ok: false; reason: string }> {
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
        // 段11c-2: 立てる場所はタスクのワークツリー（＝ブランチ）。無指定は main を映す
        ...(options.workdir ? { workdir: options.workdir } : {}),
        // 決定59: **触れる状態で差し出す**。ポート番号は知らなくてよい——「人が触る」という
        // 意図だけを渡し、どのポートかは Environment Pool がプロファイルから決める（決定60a）
        ...(options.forReview ? { exposeProfilePort: true } : {}),
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
      // 決定59: 触れる場所を帳簿に残す。判断待ちの札はここから URL を取る
      ...(summary.url ? { url: summary.url } : {}),
    });
    this.applyAndBroadcast(event);
    return { ok: true, envId: summary.envId, ...(summary.url ? { url: summary.url } : {}) };
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

  // ── 判断待ちに入ったら環境を立てる（S9d7fdb-7・決定59）─────────────────────

  /**
   * 判断待ちのあいだ立てる環境のプロファイル名。**立てないなら `undefined`**（段11c・段B）。
   *
   * 順に見る。**上ほど具体的**：
   *   1. タスクの `environment`（そのタスクだけの事情。書いてあれば従う）
   *   2. 層B設定の `review.env_profile`（プロジェクトが名指しした「人が触る環境」）
   *   3. 層B設定の `verify.profile` ——ただし**触れる面を持つときだけ**
   *
   * 3で条件を付けるのは、**触れない環境を毎回立てても費用しか掛からない**から。
   * banto の `verify.profile` は `test`（docker・`setup: npm ci`・ポート無し）で、
   * そのまま流用すると「毎回 docker が立つが PO は触れない」になる——決定59 が
   * 果たしたいのは「触って決められる」ことなので、それなら立てない方がよい。
   *
   * **立てなかったことは帳簿に残す**（I2）。番頭が読んで「`review.env_profile` を
   * 設定してください」と分かる形にする——黙って何も起きないのが、11c が6日間
   * 動いていなかったときの姿そのものだった。
   */
  private async reviewEnvProfile(
    projectTag: string,
    task: TaskRecord
  ): Promise<string | undefined> {
    const declared = typeof task["environment"] === "string" ? task["environment"] : undefined;
    if (declared) return declared;

    const config = this.projectConfig(projectTag);
    if (config.review.envProfile) return config.review.envProfile;

    const candidate = config.verify.profile;
    const notProvisioned = (reason: string): undefined => {
      const event = this.log.append({
        type: "env_provision_failed",
        projectTag,
        taskId: task.id,
        profileName: candidate,
        reason: `立てていません: ${reason}`,
      });
      this.applyAndBroadcast(event);
      return undefined;
    };

    if (!candidate) return notProvisioned("使えるプロファイルが決められません");
    let touchable: boolean;
    try {
      touchable = await this.profileIsTouchable(projectTag, candidate);
    } catch (err) {
      // I2: 「聞けなかった」を「触れない」と混同しない。理由をそのまま残す
      return notProvisioned(
        `プロファイルを Environment Pool に聞けませんでした: ${err instanceof Error ? err.message : String(err)}`
      );
    }
    if (!touchable) {
      return notProvisioned(
        `検証用のプロファイル "${candidate}" は人が触れる面（config.port）を持ちません。` +
          "触れない環境を立てても判断の役に立たないので立てていません" +
          "——触らせたいなら meta/config.yaml に review.env_profile を書いてください"
      );
    }
    return candidate;
  }

  /**
   * そのプロファイルは**人が触れる面を持つか**。
   *
   * **プロファイルの定義ファイルは読まない**（決定60a）。Environment Pool に聞いた答えの中を見る。
   * ここだけが `config` を覗く例外で、見るのは**ポートが在るかどうか**だけ——番号は読まない
   * （どのポートを公開するかは Environment Pool が決める・`exposeProfilePort`）。
   * 判定式は Environment Pool の公開判定（`pool.ts` の `exposeProfilePort` 分岐）と同じにしてある
   * ——ここがずれると「Kobo は触れると言うのに URL が出ない」が起きる。
   */
  private async profileIsTouchable(projectTag: string, profileName: string): Promise<boolean> {
    const { usable } = await this.getEnvironmentProfiles(projectTag);
    const found = usable.find((p) => p.name === profileName);
    const configured = found?.config?.["port"];
    if (configured === undefined) return false;
    const port = typeof configured === "number" ? configured : Number(configured);
    return Number.isFinite(port) && port > 0;
  }

  /**
   * `review-ready` に入ったタスクの環境を立てる。
   *
   * 決定59：**PO の判断が要るものは、見るだけでなく触れる状態で差し出す。**
   * tmux ペインは廃止した（Kobo から tmux 依存を外す）——見る面はキャンバスの
   * ブラウザビュー／セッションビューアが担う。
   *
   * 段11c で3つ直した（報告 A-6。それまで実測 `env_provisioned` は 0 件だった）：
   *   1. **宣言が無ければプロジェクトの既定へ落ちる。** `environment` を書いたタスクは
   *      70 本中 0 本で、書けと促すものも無かった——入口が実質塞がっていた
   *   2. **タスクのワークツリーを渡す。** 渡さないと立つのは main のチェックアウト
   *   3. **発火点は `review-ready`**（呼び出し側のコメント参照）
   *
   * I2: provision の失敗は遷移を巻き戻さない。既に遷移は成立しており（D3）、
   *     失敗（および**立てなかったこと**）は `env_provision_failed` として見えるようにする。
   */
  private async _autoProvisionOnReview(projectTag: string, taskId: string): Promise<void> {
    try {
      const task = this.store.getTask(taskId, projectTag);
      if (!task) return;

      const profileName = await this.reviewEnvProfile(projectTag, task);
      if (!profileName) return;

      /**
       * 段11c-2: **映すのはブランチ。** 帳簿から引いたワークツリーを渡す。
       *
       * 見つからない・消えているときは**立てない**（I2：fail-closed）。ここで黙って
       * `workdir` 無しで頼むと、Environment Pool → ドライバの `workdir ?? repoPath` で
       * main のチェックアウトが立ち、**変更が1つも映っていない画面を PO が承認する**。
       * 「環境が無い」は気づけるが、「中身が違う環境が在る」は開いても気づけない。
       */
      const workdir = this.worktreeOf(projectTag, taskId);
      if (!fs.existsSync(workdir)) {
        const failed = this.log.append({
          type: "env_provision_failed",
          projectTag,
          taskId,
          profileName,
          reason:
            `タスクのワークツリーが見つかりません（${workdir}）。` +
            "ブランチを映さない環境（main のチェックアウト）を判断の材料に差し出さないため、立てません",
        });
        this.applyAndBroadcast(failed);
        return;
      }

      // 二重に立てない：既にこのタスクの環境が生きていれば何もしない
      // （再度 review-ready に入ったとき、プロファイルに quota が無いと1つずつ漏れる）
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

      // 決定59: レビューのための環境は**触れる状態**で差し出す（公開URLつき）。
      // 段11c-2: 映すのはタスクのワークツリー（＝ブランチ）
      await this.provisionEnv(projectTag, taskId, profileName, { forReview: true, workdir });

      // task-0072: **立てている間にレビューが終わっていたら畳む。** 職人で踏んだのと
      // 同じ形——終端に着いたときの後始末は「いま立っている環境」を畳むので、まだ
      // 立ち上がっていなかったものを取りこぼす。環境は期限で必ず畳まれるとはいえ、
      // 最長24時間は外で動く（I3：消し忘れは金銭的実害）。
      //
      // 段11c-3: 判定は**判断待ちのあいだか**（review-ready / in-review）で見る。
      // `in-review` だけを見ていると、番頭が開いた（review-ready → in-review）だけで
      // 立てたばかりの環境を畳んでしまう——畳む条件そのものは変えていない（判断が付いたら畳む）
      this.refreshState();
      const after = this.store.getTask(taskId, projectTag)?.status;
      if (after !== "review-ready" && after !== "in-review") {
        process.stderr.write(
          `[banto-daemon] ${projectTag}/${taskId} は環境を立てている間に ` +
            `${after ?? "(消えた)"} へ移りました。立てたばかりの環境を畳みます\n`
        );
        await this._teardownTaskEnvs(projectTag, taskId);
      }
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
      // 上限は層B設定（プロジェクト）＞ Kobo の既定。**低い方を採る**——プロジェクトが
      // 絞っているのに Kobo の既定で回すと、設定した意味が無い（決定67）
      const maxSessions = this.maxConcurrentSessions();

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
      // **受け持っていないプロジェクトの職人は起こさない**（PO 裁定 2026-08-13）。
      // タスクの記録は帳簿に残り続けるので、ここで絞らないと「外したのに職人が起きる」
      const readyTasks = this.store
        .getAllTasks()
        .filter((t) => t.status === "ready" && this.registry.has(t.projectTag));

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
      // 非常停止の弁（PO 裁定 2026-08-13・inc-0063）。閉じている＝rebase も自動起票も
      // 状態遷移も回さない。受け持ちを外したプロジェクトもここで false になる
      isProjectEnabled: (projectTag: string) => this.mergeQueueEnabledFor(projectTag),
      // task-0071: 検証コマンドの制限時間は層B設定（`meta/config.yaml`）。
      // 読めなければゲートの既定に任せる——1つの設定でマージキュー全体を止めない（I2）
      // task-0075: 検証は検証環境の中で回す。**ホストへは落とさない**
      verifyRunner: this.config.verifyRunner ?? this.gateVerifyRunner(),
      getVerifyProfile: (projectTag: string) => {
        try {
          return this.projectConfig(projectTag).verify.profile;
        } catch {
          // 設定が壊れているなら既定で試す。壊れていること自体は他の経路が言う
          return DEFAULT_VERIFY_PROFILE;
        }
      },
      getVerifyTimeoutMs: (projectTag: string) => {
        try {
          const minutes = this.projectConfig(projectTag).limits.verifyTimeoutMinutes;
          return typeof minutes === "number" ? minutes * 60_000 : undefined;
        } catch (err) {
          process.stderr.write(
            `[banto-daemon] ${projectTag} の層B設定を読めません: ${String(err)}\n`
          );
          return undefined;
        }
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
   * rebase がコンフリクトしたときの扱い（第4便で**起票をやめた**）。
   *
   * ## 何が変わったか
   *
   * 以前は `kind: conflict` の**新しいタスクを機構が起票**し、origin を paused にして
   * 待たせていた。第4便でこれをやめた——**機構は契約を作らない**（PO 指示 4-2）。
   * 衝突の解消は「別の仕事」ではなく、**同じ契約の次の試行**として扱う。
   *
   * ## いまの扱い
   *
   *   1. `merging → implementing` へ戻す（監査もマージ前ゲートも元の契約でやり直しになる）
   *   2. 衝突したファイルと rebase の出力を指摘として渡し、職人をもう1人起こす
   *      （監査落ちの rework と同じ機構。ワークツリーは残っているのでその場で解ける）
   *   3. **2回目の衝突で failed**。同じところを何度も叩かない（監査の
   *      `audit_failed_twice` と同じ形。番頭が `kobo.reopen` / `kobo.abandon` で裁く）
   *
   * ## なぜ起票より良いか
   *
   * 解消タスクの受け入れ基準は「衝突が解消されている」だけで、**元の受け入れ基準を
   * 誰も見ないまま main に入る**穴があった。同じタスクに戻せば元の契約で審査される。
   * `origin`（依頼元の会話）も元タスクのものがそのまま効く。
   *
   * D3: 試行回数は帳簿から導出する（`state_transitioned.reason`）。印のファイルは作らない。
   * I2: 戻せない・起こせないことを黙らせない。
   */
  private async handleRebaseConflict(
    originTaskId: string,
    originProjectTag: string,
    error: Error,
    conflictedFiles: string[]
  ): Promise<void> {
    // processMergeQueue から呼ばれるので普通は届かないが、止める判定はここにも置く
    if (!this.mergeQueueEnabledFor(originProjectTag)) return;

    this.refreshState();
    const task = this.store.getTask(originTaskId, originProjectTag);
    if (!task) {
      process.stderr.write(
        `[banto-daemon] handleRebaseConflict: origin task ${originProjectTag}/${originTaskId} not found\n`
      );
      return;
    }
    // 既に戻してある（tick が同じ衝突をもう一度見た）なら何もしない
    if (task.status !== "merging") return;

    const attempts = this.countConflictRetries(originProjectTag, originTaskId);
    const files =
      conflictedFiles.length > 0
        ? conflictedFiles.map((f) => `\`${f}\``).join(" / ")
        : "(git status からは特定できず)";

    if (attempts >= 1) {
      // 2回目。**同じところを叩き続けない**（P6・監査の二度落ちと同じ扱い）
      StateMachine.fail(
        this.log,
        originTaskId,
        {
          currentStatus: "merging",
          reason:
            `rebase_conflict_twice: ${files} が2回続けて衝突しました。` +
            "自動の解き直しでは通らないので止めます（kobo.task で理由を読み、" +
            "kobo.reopen か kobo.abandon で決めてください）",
        },
        originProjectTag
      );
      this.refreshState();
      this.broadcastLatest();
      this._trackBackground(
        (async () => {
          for (const role of ["executor", "audit", "rework"] as const) {
            await this.closeWorkerFor(originProjectTag, poolTaskId(originTaskId, role));
          }
        })()
      );
      return;
    }

    // 1回目。同じ契約のまま implementing へ戻し、衝突の中身を渡して起こし直す
    const back = this.transition(
      originProjectTag,
      originTaskId,
      "implementing",
      `${CONFLICT_RETRY_REASON}: ${files}`
    );
    if (!back.ok) {
      // I2: 戻せなかったことを黙らせない。merging に残ると毎 tick 叩き続ける
      process.stderr.write(
        `[banto-daemon] handleRebaseConflict: ${originProjectTag}/${originTaskId} を implementing へ戻せません: ${back.reason}\n`
      );
      this.log.append({
        type: "tick_job_failed",
        projectTag: "daemon",
        jobName: "merge-queue",
        error: `rebase conflict retry failed for ${originProjectTag}/${originTaskId}: ${back.reason}`,
      });
      return;
    }

    process.stdout.write(
      `[banto-daemon] rebase conflict: ${originProjectTag}/${originTaskId} を implementing へ戻します（${files}）\n`
    );

    const findings = [
      `\`main\` へ rebase したところ、${files} が衝突しました。`,
      "**同じタスクの続き**です。契約（スコープ・受け入れ基準）は変わっていません。",
      `作業ブランチ \`task/${originTaskId}\` を \`main\` の最新に合わせ、両方の変更意図を` +
        "統合したうえで、元の受け入れ基準がすべて成立することを確かめてください。",
      "",
      "git の出力（抜粋）:",
      error.message.slice(0, 2000),
    ];

    this.refreshState();
    this.broadcastLatest();
    await this.spawnReworkSession(originProjectTag, originTaskId, findings, "どこが衝突したか");
  }

  /**
   * このタスクが**コンフリクトで戻された回数**を帳簿から導出する（D3：数えて持たない）。
   *
   * 印は `state_transitioned(→implementing, reason: rebase_conflict…)` そのもの。
   * **新しいイベント型は足していない**——帳簿の形は外に累積する one-way な選択なので、
   * 増やすなら PO の判断が要る（D9）。既存の任意フィールド `reason` で足りる。
   *
   * 数えるのは**最後に merging へ進んで以降**……ではなく通算にしている：一度
   * 衝突して直したタスクが再び衝突するなら、それは「機械が解けない衝突」であり、
   * 通算2回で止めるのが P6（同じところを何度も叩かない）に合う。
   */
  private countConflictRetries(projectTag: string, taskId: string): number {
    return this.getTaskEvents(projectTag, taskId).filter(
      (ev) =>
        ev.type === "state_transitioned" &&
        ev.to === "implementing" &&
        typeof ev.reason === "string" &&
        ev.reason.startsWith(CONFLICT_RETRY_REASON)
    ).length;
  }

  /** 直近の1件を WS へ流す（状態を見ている側に届かないと「動いていない」に見える）。 */
  private broadcastLatest(): void {
    const allEvents = this.log.readAllEvents();
    if (allEvents.length > 0) {
      this.wsServer.broadcast(allEvents[allEvents.length - 1]!);
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
/** 末尾 n 行だけ取る。切ったことは黙らせない（I2）。 */
function lastLines(text: string, n: number): string {
  const lines = text.split("\n");
  if (lines.length <= n) return text;
  return [`（先頭 ${lines.length - n} 行は省略）`, ...lines.slice(-n)].join("\n");
}

export function buildExecutorInstruction(
  task: TaskRecord,
  worktreePath: string,
  findings: string[] = [],
  /** 指摘の見出し（既定は監査の指摘）。落ちたタスクの立て直しでは言葉を変える（task-0081） */
  findingsHeading = "監査の指摘（前回の提出で見つかった問題）"
): string {
  /**
   * **役の説明を指示文に載せる**（realign 第2便・(P)）。
   *
   * 載せる前は `skills/executor-system.md` を渡していたのが pi 拡張の
   * `before_agent_start`（`pi-extension/banto-executor.ts`）だけだった。それは
   * `driverOptions.extensionPaths`＝**pi の言葉**で、Claude Agent SDK のドライバは
   * 読まない——実運用の職人はほぼ全てその経路なので、**役の説明は届いていなかった**。
   * SDK 経路の職人が受け取っていたのは Worker Pool の汎用プロンプトだけで、
   * **「不可逆な変更を独断でしない」（D1）がプロンプトから丸ごと落ちていた。**
   *
   * 直し方は監査チェックリストと同じ——**Kobo が指示文に載せる**。driver 側の
   * システムプロンプトに足す形は採らない：経路ごとに別の場所へ載せると、次に経路が
   * 増えたときまた落ちる。**どちらの役を起こすかを知っているのは最初から Kobo** である。
   *
   * **pi 経路では二重に届く。これは意図的に許している。** `before_agent_start` は
   * そのままにしてある——重複して届くのは無害だが、片方が届かないのは害だからである。
   * **「二重だから」と拡張側を消さないこと**：消すと pi 経路だけ役の説明を失う。
   *
   * I2: 読めなければ投げる。役の説明を持たない職人を黙って動かさない
   * ——第2便でチェックリストが誰にも届いていなかったのは、黙って落ちていたからである。
   */
  const roleAsset = loadPromptAsset("executor-system");
  const taskId = task.id;
  const body = typeof task["body"] === "string" ? task["body"].trim() : "";
  const lines = [
    `## あなたの役`,
    ``,
    roleAsset,
    ``,
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
      `## ${findingsHeading}`,
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
 * **役の説明も観点も、ここから渡す**（realign 第2便）。以前は拡張が
 * `skills/audit-*.md` を載せていたが、それは pi 経路にしか効かなかった。
 * ここに書くのはそれに加えて**このタスクを見るために要る事実**
 * ——どこに何があり、何を満たすべきか。
 */
export function buildAuditInstruction(
  task: TaskRecord,
  projectTag: string,
  taskId: string,
  worktreePath: string
): string {
  /**
   * **監査チェックリストを指示文に載せる**（realign 第2便・段1）。
   *
   * 載せる前は、チェックリストを渡していたのは pi 拡張の `before_agent_start`
   * （`pi-extension/banto-auditor.ts`）だけだった。**それは `driverOptions.extensionPaths`
   * 経由＝pi の言葉**で、Claude Agent SDK の職人はそれを読まない
   * （`claude-agent/tool-offload.ts` に同じ形の記録がある）。実運用の監査人はほぼ全て
   * SDK 経路なので、**基準は監査人に一度も届いていなかった**。
   *
   * 届いていない基準の指紋を `audit_verdict.checklistVersion` に刻むと、
   * それは証拠ではなく嘘になる。だから**Kobo が渡す**——ここに置けば経路に依らない。
   *
   * **役の説明（`audit-system`）も同じ場所から渡す**（realign 第2便・(P)）。
   * こちらも pi 拡張の `before_agent_start` だけに載っており、SDK 経路の監査人には
   * 届いていなかった。**チェックリストと役の説明が別々の場所から来る状態にしない**
   * ——片方だけ経路を移すと、次に読む人がどちらが正なのか判断できない。
   *
   * **pi 経路では二重に届く。これは意図的に許している。** 拡張側の
   * `before_agent_start` はそのままにしてある——重複して届くのは無害だが、片方が
   * 届かないのは害だからである。**「二重だから」と拡張側を消さないこと。**
   *
   * I2: 読めなければ投げる。基準や役を持たない監査を、黙って始めさせない。
   */
  const roleAsset = loadPromptAsset("audit-system");
  const checklist = loadPromptAsset("audit-checklist");
  return [
    `## あなたの役`,
    ``,
    roleAsset,
    ``,
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
    ``,
    `## 監査チェックリスト`,
    ``,
    checklist,
  ].join("\n");
}

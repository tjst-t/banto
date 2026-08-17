/**
 * Worker Pool の中核 — 職人（worker）の起動・監視・停止・ライブアタッチ・報告の受け口。
 * ADR-0010 決定23・27c・29。
 *
 * **Kobo に依存しない。** ここにあるのは実行能力だけで、統治（依存ゲート・quota・
 * マージキュー）は Kobo に残る。Banto も Kobo も、この能力の利用者になる。
 *
 * D3: 稼働中の職人の一覧は、起動時に作った台帳・プロセスの生存確認・イベントログから導く。
 *     「動いているつもり」の内部状態を別に持たない。
 * D5: 誰にどの仕事をさせるかの判断はここに無い。言われた通り起動・停止する。
 *     職人の報告の**意味**も解釈しない——Kobo はステートマシンへ、番頭は会話へ、
 *     それぞれの起動元が自分で写す（決定29d）。
 * D6: 依存は node 標準と @banto/core の型のみ。
 * I2: 起動失敗・不在の職人への操作は黙って成功にせずエラーにする。
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type {
  DriverEvent,
  RuntimeDriver,
  SessionHandle,
  SettingsSection,
  SpawnOptions,
} from "@banto/core";
import {
  BackendRegistry,
  DEFAULT_ASSUMED_RESOURCES,
  WORKER_TIERS,
  type BackendView,
  type ResourceEstimate,
  type RuntimeRegistration,
  type WorkerTier,
} from "./backends.js";
import {
  WorkerEventLog,
  type WorkerEvent,
  type WorkerEventFilter,
  type WorkerEventHandler,
} from "./event-log.js";
import {
  CLAUDE_AGENT_DRIVER_ID as CLAUDE_AGENT_RUNTIME,
  CLAUDE_KNOWN_MODELS,
  isClaudeModelName,
} from "./claude-agent/naming.js";
import {
  toolOffloadExtensionPath,
  webToolsExtensionPath,
  workerReportExtensionPath,
  workKeepExtensionPath,
} from "./extension.js";
import {
  KEEP_PRUNE_LOG,
  listKeepBranches,
  pruneKeepBranches,
  resolveGitCommonDir,
  resolveKeepMaxAgeMs,
  sanitizeRefPart,
  type KeepBranchInfo,
  type KeepPruneResult,
} from "./work-keep.js";
import { WORKER_REPORT_TOOL_NAMES } from "./pi-extension/worker-report.js";
import { WEB_TOOL_NAMES } from "./pi-extension/web-tools.js";
import { SpawnLedger, isProcessAlive, killOrphanProcess, type LedgerEntry } from "./spawn-ledger.js";
import {
  probeChildPids,
  type ChildPidProbeOptions,
  type ChildProcessRecord,
} from "./child-pids.js";
import {
  WorkerCgroups,
  formatBytes,
  type CgroupUsage,
  type IsolationMode,
  type IsolationStatus,
  type WorkerBag,
} from "./worker-cgroup.js";

/**
 * 職人の既定のシステムプロンプト（立場の伝達）。やることは instruction で渡す。
 *
 * D11: 職人は記憶を持たない。だから「前に話した件」は通じず、必要な文脈は毎回
 *      指示に書かれている前提で動く——そのことを職人自身にも伝えておく。
 *
 * **本文は英語、報告は WORKER_RESPONSE_LANGUAGE。** 職人は番頭と違って任意のモデルで
 * 動かす前提なので、指示追従が崩れにくいほうを採る（CLAUDE.md: LLMプロバイダ層はプラガブル）。
 * 呼び名は "caller" で揃える——商家の比喩（番頭・職人）はモデル依存だし、同じ拡張で
 * 後から足される WORKER_REPORT_PROMPT も同じ相手を指すので、名前が2つあると読み手が迷う。
 */
const WORKER_RESPONSE_LANGUAGE = "Japanese";

export const WORKER_SYSTEM_PROMPT = [
  "You are a worker in banto: an agent that carries out one assigned piece of work.",
  "A higher-level agent started you and sends you your instruction. It is referred to below as the caller.",
  "You have no memory across conversations. You cannot see earlier exchanges or previous work, so assume every piece of context you need is written in the instruction you were given.",
  "If something you need is missing from the instruction, report that instead of guessing at it and proceeding.",
  "When the work is done, report briefly: what you did, what you verified, and what concerns remain.",
  `Write your reports and questions in ${WORKER_RESPONSE_LANGUAGE}.`,
].join("\n");

/**
 * 職人の状態。
 *
 * `exited` は2つの経路で分かる：ドライバのイベント（終了した瞬間）と、台帳の pid の
 * 生存確認（後から見ても分かる）。前者だけだと Worker Pool を再起動したときに取りこぼし、
 * 後者だけだと「終了した瞬間」を捉えられないので、両方を使う。
 *
 * `waiting` は決定29(b)。質問して答えを待っている職人は**生きているが止まっている**。
 * `alive` だけでは「動いている」と区別がつかず、待ちっぱなしが溜まっても気づけない。
 *
 * `idle` は**喋り終わって手が空いている**（PO要望 2026-08-11）。生きてはいるが出力は
 * 止まっている。以前は `running` と区別が付かず、起動元は明示の報告か時間切れを待つ
 * しかなかった——見れば分かるようにする。
 */
export type WorkerState = "running" | "idle" | "waiting" | "exited" | "closed";

/**
 * 職人を畳んだ理由（決定30e）。
 *
 * `idle` が多いなら、それは番頭が職人の面倒を見ていない兆候として読める——
 * 安全弁が主機構になっていないかを、あとから確かめられるようにしておく。
 */
export type CloseReason =
  /** 番頭が成果を確かめて良しとした（本筋） */
  | "done"
  /** 何もしていない時間が続いたので安全弁が働いた */
  | "idle"
  /** 作業中でも強制的に止めた */
  | "stopped";

/** 終了の内訳。イベントでしか分からない部分。 */
export interface WorkerExitDetail {
  exitCode: number | null;
  signal: string | null;
  at: string;
}

/** 稼働中（または台帳に残っている）1人の職人。 */
export interface WorkerInfo {
  /** 利用者の名前空間。Worker Pool は複数の利用者（Banto・Kobo・複数プロジェクト）に仕える。 */
  projectTag: string;
  taskId: string;
  /** この職人を起こしたのは誰か（決定29の宛先）。projectTag とは別。 */
  origin: string;
  /** node のホストの pid。実処理を抱える子は `childProcesses` の方（inc-0066）。 */
  pid: number;
  /**
   * この職人が cgroup で隔離されているか（inc-0066 第2段）。
   *
   * `none` は「隔離せずに動いている」という**宣言**。番頭がここを見て気づけるように
   * 1本ごとに載せる——工房全体の設定を別途調べないと分からない形にはしない。
   */
  isolation?: IsolationMode;
  /**
   * 袋（cgroup）から読み取った使い切りの記録（inc-0066）。
   *
   * 生きている職人では畳むまで未定義。終わった職人では `memory.peak` と
   * `memory.events` が入り、**上限に当たって殺されたのかどうか**がここで分かる。
   */
  memory?: CgroupUsage;
  /**
   * ホストの下でランタイムが起こした実プロセス（inc-0066）。
   *
   * 起動直後に走査するので、起こした直後は未定義。突き止められなかったときは
   * `error` 付きで入る（空を「子が居ない」と読ませない・I2）。
   */
  childProcesses?: ChildProcessRecord;
  sessionId: string;
  sessionPath: string;
  worktree: string;
  /** プロセスがまだ生きているか。ドライバのイベントと台帳のpidの生存確認から導く（D3）。 */
  alive: boolean;
  state: WorkerState;
  /** どのランタイムで起こしたか（`pi-rpc` / `claude-agent-sdk` …）。steer・wake の宛先。 */
  runtime: string;
  /** 起こしたときに指定したモデル（指定があったときだけ）。 */
  model?: string;
  spawnedAt: string;
  /** 終了していれば、その内訳（分かる場合）。 */
  exit?: WorkerExitDetail;
  /** 答えを待っている質問（state が waiting のとき）。 */
  question?: string;
  /** 畳んだ理由（state が closed のとき）。 */
  closeReason?: CloseReason;
  /** 畳んだ時刻（state が closed のとき）。 */
  closedAt?: string;
}

/**
 * 名指しできるモデルを数え上げるための、登録の最小の形（LLM Registry の一部）。
 *
 * 型で縛らず形だけで受けるのは、Worker Pool を登録の実装に縛らないため（D6）。
 */
/**
 * 役の台帳のうち、工房が要る分だけ（`ModelLedger` の部分形）。
 *
 * 型で縛らず形だけで受けるのは、工房を核の実装に縛らないため（`WorkerModelCatalog` と同じ）。
 */
export interface WorkerRoleLedger {
  role(role: string): { default?: { backend: string; provider: string; model: string } } | undefined;
  defaultTier(): string | undefined;
  exists(): boolean;
}

export interface WorkerModelCatalog {
  models(): Array<{ providerId: string; id: string; name: string; tier: string; policy: readonly string[] }>;
  /**
   * 割り当てが無いときに、その等級で実際に選ばれるもの（分かるなら）。
   *
   * 画面に「指定しなければこれになります」を出すために要る——**指定なしの行が
   * 何になるか分からない**まま選ばせると、PO は結局起こしてみるまで確かめられない。
   */
  resolveForWorker?(tier?: string): { model: { provider: string; id: string } } | undefined;
}

/** 名指しできるモデル1件（`worker.models` が返す形）。 */
export interface SelectableModel {
  /** `worker.delegate` の `model` にそのまま書ける名前。 */
  name: string;
  /** 画面や工場に出す表示名。 */
  label: string;
  /** どのランタイムで動くか。 */
  runtime: string;
  /** そのランタイムの表示名（画面が「どのバックエンドのモデルか」を出すため）。 */
  runtimeTitle?: string;
  /** 登録が持っている等級（分かるときだけ）。 */
  tier?: string;
}

export interface WorkerPoolOptions {
  /** 職人を起動する既定のランタイム。既定は pi（PiRpcDriver）だが差し替え可能。 */
  driver: RuntimeDriver;
  /** ランタイムの識別子。台帳に残し、どのランタイムで起こした職人か分かるようにする。 */
  driverId?: string;
  /** 既定のランタイムの見せ方（表示名・状態・等級の解き方）。省略すると識別子だけ。 */
  driverRegistration?: Omit<RuntimeRegistration, "driver">;
  /**
   * 選べるランタイムの一覧（`driver` は既定として自動で入る）。
   *
   * 番頭は `worker.delegate` の `runtime` で選ぶ。**混在させて構わない**——
   * 職人1人ごとにランタイムが決まり、台帳に残るので、追加の指示（steer）や
   * 起こし直し（wake）は起こしたときと同じランタイムへ届く。
   */
  runtimes?: Record<string, RuntimeDriver | RuntimeRegistration>;
  /**
   * ランタイムごとの想定消費リソース（task-0253）。鍵は `driverId` / `runtimes` の識別子。
   *
   * 登録側（`driverRegistration` / `runtimes` の各エントリ）が `assumedResources` を明示して
   * いなければ、この値（無ければ {@link DEFAULT_ASSUMED_RESOURCES}）を自動登録分に当てる。
   * 本番値は bin が環境変数から決めて渡す（Pi 300 MiB / Claude 1200 MiB）。
   */
  assumedResources?: Record<string, ResourceEstimate>;
  /**
   * 名指しできるモデルを一覧するための登録（`worker.models`）。
   *
   * **解決には使わない**——tier からモデルを解く役はランタイム側（pi のドライバ）が
   * 持っている（決定60a）。ここに要るのは「画面と工場に選ばせる名前」だけ。
   */
  catalog?: WorkerModelCatalog;
  /**
   * **役の台帳**（ADR-0021 決定101）。等級 → モデルの割り当てはここが持つ。
   * **読むだけ**（決定101d）——書くのは番頭ホスト。
   */
  modelLedger?: WorkerRoleLedger;
  /**
   * バックエンドと等級ごとの割り当ての保存先（設定画面が書く）。
   * 渡さなければメモリだけ——次の起動では既定に戻る。
   */
  settingsSection?: SettingsSection;
  /** 台帳・セッションファイル・イベントログの置き場所。 */
  dataDir: string;
  /** projectTag を省略して呼ばれたときの既定。 */
  defaultProjectTag?: string;
  /** origin を省略して呼ばれたときの既定（決定29の宛先）。 */
  defaultOrigin?: string;
  /**
   * 職人が報告・質問のために叩く、この Worker Pool の到達先（決定29e）。
   *
   * 渡すと、起こす職人に `worker.report` / `worker.ask` の拡張が自動で載る。
   * 渡さない場合、職人は報告経路を持たない——**報告先が無いのに報告を促さない**ため、
   * 作法のプロンプトも載らない（拡張ごと渡らない）。
   */
  reportUrl?: string;
  /**
   * 何もしていない職人を閉じるまでの時間（決定30b の**安全弁**）。
   *
   * 主たる契機は番頭が畳むこと。これはその取りこぼしを拾うためのもので、
   * 短くして主機構にしてはいけない——「放っておけば消える」に寄りかかると、
   * 番頭が職人の面倒を見なくなる。0 以下を渡すと安全弁を切る。
   */
  idleTimeoutMs?: number;
  /** 安全弁の点検間隔。既定は idleTimeoutMs の1/4。 */
  idleCheckMs?: number;
  /**
   * 同時に走ってよい職人の本数の上限（task-0216）。
   *
   * **上限を持つのは工房自身**（ADR-0010 決定23）。Kobo にも同時実行数の上限はあるが、
   * それは Kobo が回すセッションの数であって、**番頭が直に起こす職人は数えていない**。
   * Kobo 側に一本化すると「Kobo 無しでも職人へ委譲できる」が壊れる。
   *
   * 0 以下を渡すと上限を切る（試験・単発の道具立て用）。既定は
   * {@link DEFAULT_MAX_CONCURRENT_WORKERS}。
   */
  maxConcurrentWorkers?: number;
  /**
   * 監査・判定のために空けておく席の数（task-0223）。
   *
   * 実装（`executor`）は「上限 − ここ」までしか取れない。**省略時は 0（取り置かない）
   * ＝task-0216 のままの早い者勝ち**——工房自身（このクラス）は `process.env` を
   * 一切読まない。環境変数 {@link AUDIT_RESERVED_ENV}（既定
   * {@link DEFAULT_AUDIT_RESERVED_WORKERS}）を読んで解決するのは呼び出し側（`bin.ts` の
   * `resolveAuditReservedWorkers`）の仕事——既定を工房側に埋めると、既定値を渡さずに
   * 立てる task-0216 の試験が黙って壊れるため、ここでは分けてある。
   *
   * 上限（`maxConcurrentWorkers`）以上を渡すと**実装が1本も起こせなくなる**ので、
   * その組み合わせは受け取らずに投げる（I2：黙って直さない・黙って落とさない）。
   */
  auditReservedWorkers?: number;
  /**
   * 職人の下の実プロセスを突き止める走査の加減（inc-0066）。
   *
   * 既定は「する」。`false` にすると走査しない——子を持たないランタイムしか使わないと
   * 分かっている場合や、試験で余計なイベントを増やしたくない場合に切る。
   */
  childPidProbe?: boolean | ChildPidProbeOptions;
  /**
   * 職人1本ごとの cgroup 隔離（inc-0066 第2段）。
   *
   * **既定は「隔離しない」。** 隔離は本物の cgroup を書き換える操作なので、
   * 工房の入口（`bin.ts serve`）が明示的に能力判定した結果だけを受け取る
   * ——渡されなければ判定そのものを走らせない。試験・開発機・コンテナで
   * 勝手に本番の cgroup を触りに行くことを、型の側で不可能にしておくため。
   */
  cgroups?: WorkerCgroups;
}

/** 一覧のページの既定の大きさ。 */
export const DEFAULT_PAGE_SIZE = 20;

/** 安全弁の既定。番頭が畳むより十分に長くとる（決定30b）。 */
export const DEFAULT_IDLE_TIMEOUT_MS = 15 * 60 * 1000;

/**
 * 同時に走ってよい職人の本数の既定（task-0216）。
 *
 * **なぜ栓が要るか**：2026-08-16 に 9 本が同時に走り、`banto-worker-pool.service`
 * （工房全体）が1日で少なくとも7回 OOM で揺れた。職人1本には 2 GiB の子 cgroup が
 * 貼られていて（`memory.oom.group`）、当たるとその職人の袋ごと全プロセスが死ぬ。
 * 巻き添えで「中身は無罪なのに落ちた」タスクが7本出ている。
 *
 * **どちらの考え方で 6 を選んだか（数字だけ置かないための記録）**：
 *
 *   (A) 最悪値で置く：`上限本数 × 職人1本の cgroup 上限（2 GiB）≦ 工房の MemoryMax
 *       （実測 7〜8 GiB）`。理屈としては正しいが、これだと **3〜4 本**で頭打ちになる。
 *       Kobo だけで 5 本（`limits.max_concurrent_sessions` の既定）走るので、工場が
 *       自分の上限に届く前に工房が断ることになり、**栓ではなく仕事を止める道具**になる。
 *   (B) 実測値で置く（**こちらを採った**）：平常時の職人1本は **0.23〜0.56 GiB**。
 *       6 本なら平常時 6 × 0.56 ≒ **3.4 GiB**。重いのが 2 本同時に上限（2 GiB）へ
 *       張り付いても `2×2 + 4×0.56 ≒ 6.2 GiB` で、工房の 7 GiB に収まる。
 *
 * **6 の内訳（task-0223 で書き直した）**：置いた当初の内訳は「Kobo の 5 本 ＋ 番頭が直に
 * 起こす 1 本」だったが、その数え方には**役の区別が無い**。実装の職人が 6 本で埋めると
 * 監査の職人が起きられず、タスクが `auditing` から永久に出られなくなる（2026-08-16 に
 * 「監査が起動できない」で3回落ちている）。いまの内訳は
 * **「実装 4 本 ＋ 監査・判定のために空けておく 2 本」**（{@link DEFAULT_AUDIT_RESERVED_WORKERS}）。
 * 実装の取り分は 5 から 4 へ減るが、**判定が永久に待つ**より、実装が1本待つ方が安い
 * ——判定が進まなければ、その 4 本が作ったものは1つも着地しない。
 *
 * 6 そのものは動かさない。事故のあった 9 本より確実に下にある値で、上げるかどうかは
 * メモリの実測（上記 (B)）から別に判断する。
 *
 * (B) を採った以上、**これは最悪値の保証ではない**——6 本全部が 2 GiB へ張り付けば
 * 12 GiB で、やはり工房は落ちる。そこまでの守りは職人1本ごとの cgroup（2 GiB）が受け持ち、
 * ここが受け持つのは「常識的な混み方で工房を殺さない」ところまでである。
 * 機械を替える・`MemoryMax` を変えるときは `BANTO_WORKER_MAX_CONCURRENT` で動かす。
 */
export const DEFAULT_MAX_CONCURRENT_WORKERS = 6;

/**
 * **同時本数の上限で断った**ことの合印（{@link TIER_UNASSIGNED_CODE} と同じ流儀）。
 *
 * モジュール間の呼び出しは失敗を文字列にして返すので、構造を渡す口が無い。日本語の
 * 言い回しで見分けると文言を直した日に黙って壊れるため、契約として輸出した合印で見分ける。
 */
export const WORKER_LIMIT_CODE = "BANTO_WORKER_LIMIT";

/** 上限を変える環境変数の名前（断りの文面と設定画面が同じ名前を指すため）。 */
export const MAX_CONCURRENT_ENV = "BANTO_WORKER_MAX_CONCURRENT";

/**
 * 環境変数から同時本数の上限を読む（`bin.ts` が使う）。
 *
 * 読む場所は `bin.ts` の流儀（`BANTO_WORKER_IDLE_MS` などと同じ入口）だが、**読み方は
 * ここに置く**——上限の意味を知っているのは工房の側で、入口は組み立てるだけだから（D5）。
 *
 * I2: 読めない値を黙って既定に落とさない。落とすと「変えたつもりで効いていない」が
 * 例外にならず、上限が無いつもりのまま走り出す（それが inc の形そのもの）。
 *
 * @param env 読み元（試験は偽の環境を渡す）
 * @returns 本数。0 は「上限なし」
 */
export function resolveMaxConcurrentWorkers(
  env: Record<string, string | undefined> = process.env
): number {
  const raw = env[MAX_CONCURRENT_ENV];
  if (raw === undefined || raw.trim() === "") return DEFAULT_MAX_CONCURRENT_WORKERS;
  const parsed = Number(raw.trim());
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(
      `${MAX_CONCURRENT_ENV} を読み取れません: "${raw}"（0以上の整数。0 で上限なし。既定 ${DEFAULT_MAX_CONCURRENT_WORKERS}）`
    );
  }
  return parsed;
}

/**
 * 席の配分で使う役（task-0223）。**この2つで足りる。**
 *
 * 起動元（Kobo）はもっと細かい役を持っている（`executor` / `audit` / `rework`）が、
 * 工房が知る必要があるのは「作る側か、判定する側か」だけ——増やすと、役が増えるたびに
 * 工房の席の配分表を書き直すことになる。手直し（rework）は作る側なので `executor`。
 */
export const WORKER_SEAT_ROLES = ["executor", "auditor"] as const;

/** {@link WORKER_SEAT_ROLES} の型。 */
export type WorkerSeatRole = (typeof WORKER_SEAT_ROLES)[number];

/**
 * 役を渡されなかった依頼の扱い（task-0223）。
 *
 * 番頭が `worker.delegate` で直に起こす職人も**実装側として数える**——数えないと、
 * 番頭が起こした分だけ監査の席が黙って食われる。「役を渡さない＝制限しない」にすると、
 * 役を渡す呼び出し側だけが損をする（そして皆が役を渡さなくなる）。
 */
export const DEFAULT_WORKER_SEAT_ROLE: WorkerSeatRole = "executor";

/** 断りの文面・一覧に出す役の呼び名（読むのは番頭＝人と同じ日本語の側）。 */
function seatRoleLabel(role: WorkerSeatRole): string {
  return role === "auditor" ? "監査・判定" : "実装";
}

/** 値が席の役として読めれば返す。読めなければ既定（実装側）。 */
function asSeatRole(value: unknown): WorkerSeatRole {
  return typeof value === "string" && (WORKER_SEAT_ROLES as readonly string[]).includes(value)
    ? (value as WorkerSeatRole)
    : DEFAULT_WORKER_SEAT_ROLE;
}

/**
 * 監査・判定のために空けておく席の数の既定（task-0223）。
 *
 * **なぜ席を取り置くか**：task-0216 の栓は完全な早い者勝ちで、誰の依頼かを見ていない。
 * 実装の職人が上限まで埋めると監査の職人が起こせず、タスクは `auditing` から出られない
 * ——レビューにも着地にも進めないまま、実装だけが席を取り続ける。上限がある限り、
 * 早い者勝ちのままではこれが**恒常化する**（一時的な混雑ではない）。
 *
 * **なぜ 2 か**：Kobo は1つのタスクにつき監査を1本立てる。同時に判定へ入るタスクが
 * 2つあっても詰まらないのが 2 本で、既定の上限 6 に対して実装の取り分は 4 本残る。
 * 1 だと「監査中に別のタスクが監査へ入る」だけで待ちになり、3 以上にすると実装が
 * 3 本まで落ちて、今度は作る側が慢性的に断られる。
 *
 * これは**上限を増やす仕掛けではない**。合計は {@link DEFAULT_MAX_CONCURRENT_WORKERS}
 * のままで、その内訳を決めるだけ——監査だからといって上限を超えては起こさない。
 */
export const DEFAULT_AUDIT_RESERVED_WORKERS = 2;

/** 予約席の数を変える環境変数の名前（{@link MAX_CONCURRENT_ENV} と同じ流儀）。 */
export const AUDIT_RESERVED_ENV = "BANTO_WORKER_AUDIT_RESERVED";

/**
 * 環境変数から予約席の数を読む。
 *
 * I2: {@link resolveMaxConcurrentWorkers} と同じく、**読めない値を黙って既定に落とさない**。
 * 落とすと「監査の席を空けたつもりで空いていない」が例外にならず、上限だけが効いた状態
 * ——つまり task-0223 以前に戻ったまま走り出す。
 *
 * @param env 読み元（試験は偽の環境を渡す）
 * @returns 席数。0 は「取り置かない」（＝task-0216 のままの早い者勝ち）
 */
export function resolveAuditReservedWorkers(
  env: Record<string, string | undefined> = process.env
): number {
  const raw = env[AUDIT_RESERVED_ENV];
  if (raw === undefined || raw.trim() === "") return DEFAULT_AUDIT_RESERVED_WORKERS;
  const parsed = Number(raw.trim());
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(
      `${AUDIT_RESERVED_ENV} を読み取れません: "${raw}"（0以上の整数。0 で取り置かない。既定 ${DEFAULT_AUDIT_RESERVED_WORKERS}）`
    );
  }
  return parsed;
}

/** いま走っている職人1本分（同時本数の数え上げに出る形）。 */
export interface ConcurrencySlot {
  taskId: string;
  projectTag: string;
  /** 起動中でまだ台帳に載っていない枠は未定義（`starting` が立つ）。 */
  sessionId?: string;
  spawnedAt: string;
  /** 起こしている最中（spawn が返る前）の枠か。 */
  starting?: boolean;
  /** どちらの枠で座っているか（task-0223）。役を渡さずに起こされた分は `executor`。 */
  role: WorkerSeatRole;
}

/**
 * 同時に走っている職人の本数と上限（覗き窓と断りの文面の元・task-0216）。
 *
 * D3: 本数は保存しない。台帳と pid の生存から**毎回導く**——数え間違いが上限を
 * 無意味にするので、別の場所に数を持たせない。
 */
export interface ConcurrencyStatus {
  /** いま走っている本数（起こしている最中の枠を含む）。 */
  running: number;
  /** 上限。0 なら上限なし。 */
  limit: number;
  /** 誰が・いつから走っているか（起動順）。 */
  slots: ConcurrencySlot[];
  /** 上限を変える環境変数の名前。 */
  env: string;
  /**
   * 役ごとの内訳（task-0223）。`running` と同じく毎回数え直す（D3）。
   */
  byRole: Record<WorkerSeatRole, number>;
  /** 監査・判定のために空けてある席の数。0 なら取り置かない。 */
  auditReserved: number;
  /**
   * 実装（`executor`）が取れる本数＝`limit - auditReserved`。
   *
   * `limit` が 0（上限なし）のときは 0 で、その場合は**上限なしの意味**
   * ——上限が無いのに取り置く席は無い。
   */
  executorLimit: number;
  /** 予約席を変える環境変数の名前。 */
  reservedEnv: string;
}

/**
 * **等級に割り当てが無くて断った**ことの合印（ADR-0021 決定104）。
 *
 * 決定104 は「候補が無いときは取次へ一通積む」だが、**工房は取次を知らない**
 * （決定27：ブローカーにしない）。積むのは番頭ホストで、こちらは断った理由を
 * 見分けられる形で渡すだけ。
 *
 * **なぜ文言に埋めるか**：モジュール間の呼び出し（`createModuleClient.invoke`）は
 * 失敗を文字列にして返す（`module-invocation.ts:216-223`）ので、構造を渡す口が無い。
 * 日本語の言い回しで見分けると、文言を直した日に黙って積まれなくなる——だから
 * **契約として輸出した合印**で見分ける。
 */
export const TIER_UNASSIGNED_CODE = "BANTO_TIER_UNASSIGNED";

/** 断りの文言から等級を読む。合印が無ければ `undefined`（＝別の失敗）。 */
export function tierFromUnassignedError(message: string): WorkerTier | undefined {
  const found = new RegExp(`${TIER_UNASSIGNED_CODE}:(\\w+)`).exec(message);
  const tier = found?.[1];
  return tier && (WORKER_TIERS as readonly string[]).includes(tier)
    ? (tier as WorkerTier)
    : undefined;
}

/** 職人に仕事を投げるときの指定。SpawnOptions より上位の、呼び出し側に優しい形。 */
export interface DelegateInput {
  /** 利用者の名前空間（省略時は defaultProjectTag）。 */
  projectTag?: string;
  /**
   * 起動元＝報告の宛先（省略時は defaultOrigin）。決定29。
   * Kobo・番頭・将来のモジュールがそれぞれ職人を起こすため、誰が起こしたかを持つ。
   */
  origin?: string;
  /** 何の仕事か。台帳・ログの識別子になる。 */
  taskId: string;
  /**
   * どちらの枠で席を取るか（task-0223）。省略時は {@link DEFAULT_WORKER_SEAT_ROLE}＝実装側。
   *
   * 実装は「上限 − 予約席」まで、監査・判定は上限まで取れる。**役は起動元しか知らない**
   * ので、工房は言われたとおりに数えるだけ（D5）——嘘をつかれれば監査の席は埋まるが、
   * 起動元は決定的コードのモジュールであり、ここで疑うと誰も席を取れなくなる。
   */
  role?: WorkerSeatRole;
  /** 作業させるディレクトリ（worktree 等）。 */
  worktreePath: string;
  /** 職人に渡す指示。spawn 後に inject で送られる（これが無いと職人は何もしない）。 */
  instruction: string;
  /** 職人の立場を伝えるシステムプロンプト。省略時は WORKER_SYSTEM_PROMPT。 */
  systemPrompt?: string;
  /**
   * 畳んだ職人を起こし直すときに指定する、元のセッションファイル（決定30d）。
   * 渡すと元の会話が復元され、番頭が前提を書き直さずに済む。
   */
  resumeSessionPath?: string;
  /**
   * 使わせるTool名（許可リスト）。省略時はランタイムの既定（pi なら read/bash/edit/write/
   * grep/find/ls の全部）。
   *
   * 「調べるだけ」を頼むなら `["read","grep","find","ls"]` のように絞る——絞らない限り
   * 職人は worktree を書き換えられるし任意のコマンドも打てる（imp-0004）。
   * 報告経路（`worker.report`/`worker.ask`）はここに書かなくても自動で残る。
   */
  tools?: string[];
  /**
   * 外を読む口（`web.fetch` / `web.search`）を渡すか。既定は渡さない（PO裁定 2026-07-30、imp-0005）。
   *
   * 渡さなければ拡張ごと載らない＝Tool が存在しない。ただし**遮断の機構ではない**：
   * `bash` を持った職人は curl で外へ出られる。本当に外を断つなら `tools` から bash を外す。
   */
  network?: boolean;
  modelTier?: SpawnOptions["modelTier"];
  /**
   * どのランタイムで起こすか（`pi` / `claude-code` など。省略時は既定のランタイム）。
   *
   * ランタイムごとに得意も費用も違うので、選ぶのは頼む側（番頭）の判断
   * ——ここでは言われたとおりに起こすだけ（D5）。
   */
  runtime?: string;
  /**
   * 使うモデルの名指し（`opus` / `claude-opus-5` など）。`modelTier` より優先する。
   *
   * 等級（tier）はランタイム中立な言い方で、名指しはランタイム固有。番頭が
   * 「この仕事は Claude Code の opus で」と決められるようにするための口（PO要望 2026-08-10）。
   */
  model?: string;
  driverOptions?: Record<string, unknown>;
}

/**
 * 番頭が書きそうな呼び名 → ランタイムの識別子。
 *
 * 識別子（`pi-rpc` / `claude-agent-sdk`）は仕組みの名前で、番頭が覚えるものではない。
 * 「claude で」「pi で」で通るようにしておく——通らなければ、番頭は毎回綴りを当てにいく。
 */
const RUNTIME_ALIASES: Readonly<Record<string, string>> = {
  pi: "pi-rpc",
  "pi-rpc": "pi-rpc",
  claude: "claude-agent-sdk",
  "claude-code": "claude-agent-sdk",
  "claude-agent-sdk": "claude-agent-sdk",
};

export class WorkerPool {
  private readonly driver: RuntimeDriver;
  private readonly driverId: string;
  /** 選べるランタイム。既定のものも入っている（識別子 → 登録）。 */
  private readonly runtimes = new Map<string, RuntimeRegistration>();
  /** バックエンドの入切と、等級ごとのモデルの割り当て（設定画面が書く）。 */
  private readonly backendRegistry: BackendRegistry;
  /** 名指しできるモデルを数え上げるための登録（解決には使わない）。 */
  private readonly catalog: WorkerModelCatalog | undefined;
  private readonly modelLedger: WorkerRoleLedger | undefined;
  private readonly dataDir: string;
  private readonly defaultProjectTag: string;
  private readonly defaultOrigin: string;
  private readonly reportUrl: string | undefined;
  /** いま畳んでいる最中の職人（`worker_exited` に「予期していた」と印を付けるため）。 */
  private readonly closing = new Set<string>();

  private readonly ledger: SpawnLedger;
  private readonly log: WorkerEventLog;
  /** 子プロセスの走査（inc-0066）。false なら走査しない。 */
  private readonly childPidProbe: ChildPidProbeOptions | false;
  /** 工房を終うときに、走らせっぱなしの走査へ打ち切りを伝える。 */
  private readonly probesAborter = new AbortController();
  /** 職人1本ごとの隔離（inc-0066 第2段）。渡されなければ「隔離しない」。 */
  private readonly cgroups: WorkerCgroups;
  /**
   * いま面倒を見ている袋（sessionId → 袋と、読み終えた使い切りの記録）。
   *
   * **袋の在り処の真実は cgroupfs と台帳**（D3）。ここはそれを引くための索引で、
   * 記録（`usage`）だけは袋を消す前に読んだ一度きりの値なので持ち越す。
   */
  private readonly bags = new Map<
    string,
    { bag: WorkerBag; usage?: CgroupUsage; retired?: boolean }
  >();
  private readonly unsubscribeDriver: () => void;
  private idleTimeoutMs = DEFAULT_IDLE_TIMEOUT_MS;
  private idleSweeper: NodeJS.Timeout | undefined;
  /** 同時本数の上限（task-0216）。0 なら上限なし。 */
  private maxConcurrentWorkers = DEFAULT_MAX_CONCURRENT_WORKERS;
  /** 監査・判定のために空けてある席の数（task-0223）。0 なら取り置かない。 */
  private auditReservedWorkers = 0;
  /**
   * 席に座っている職人の役（sessionId → 役・task-0223）。
   *
   * **台帳には持たない。** 役を足すと台帳の形（保存する構造）が変わり、古い台帳を読む
   * 経路まで巻き込む（D1）。役が要るのは「いま何本走っているか」を数える瞬間だけなので、
   * 起こした事実（`worker_started` イベント）から引いて、ここに覚えておく。
   * 覚えが無ければ実装側として数える——工房を立て直した直後（`resume`）がそれで、
   * **多く数える側へ倒す**のが監査の席を守る向き。
   */
  private readonly seatRoles = new Map<string, WorkerSeatRole>();
  /**
   * 起こしている最中の枠（token → 誰を・いつから）。
   *
   * **台帳に載るのは spawn が返ったあと**なので、数えるのが台帳だけだと、同時に頼まれた
   * 2本が**どちらも「まだ 0 本」を見て**通り抜ける。上限は事故を防ぐ栓なので、混んでいる
   * ときに限って効かないのでは意味がない——枠は数える前に取り、決着したら必ず返す。
   */
  private readonly starting = new Map<
    number,
    { taskId: string; projectTag: string; at: string; role: WorkerSeatRole }
  >();
  private startingSeq = 0;
  /** 前に取り置きを掃除した時刻（0 は「まだ一度もしていない」）。 */
  private lastKeepPruneAt = 0;

  constructor(options: WorkerPoolOptions) {
    this.modelLedger = options.modelLedger;
    this.driver = options.driver;
    this.driverId = options.driverId ?? "pi-rpc";
    this.catalog = options.catalog;
    this.runtimes.set(this.driverId, {
      driver: this.driver,
      title: "pi",
      // task-0253: リソース量を積む。登録側が明示していなければ `assumedResources` の
      // 既定（または WorkerPoolOptions の受け皿）を当てる。判定（タスクC）が読む段で
      // 0・undefined のままにならないように。
      assumedResources: this.fallbackResources(this.driverId, options),
      ...(options.driverRegistration ?? {}),
    });
    for (const [id, entry] of Object.entries(options.runtimes ?? {})) {
      // ドライバだけ渡す旧い形も受ける（既存の呼び出しを壊さない）
      this.runtimes.set(
        id,
        "driver" in entry
          ? {
              // 完全な登録（RuntimeRegistration）。assumedResources が無ければ受け皿を当てる
              // （task-0253）——判定（タスクC）が読む段で undefined のまま立たせない。
              ...entry,
              assumedResources:
                entry.assumedResources ?? this.fallbackResources(id, options),
            }
          : { driver: entry as RuntimeDriver, assumedResources: this.fallbackResources(id, options) }
      );
    }
    this.backendRegistry = new BackendRegistry(
      this.runtimes,
      this.driverId,
      options.settingsSection
    );
    this.dataDir = options.dataDir;
    this.defaultProjectTag = options.defaultProjectTag ?? "default";
    this.defaultOrigin = options.defaultOrigin ?? "unknown";
    this.reportUrl = options.reportUrl;
    fs.mkdirSync(path.join(this.dataDir, "sessions"), { recursive: true });

    const { ledger, corruptionError } = SpawnLedger.open(this.dataDir);
    // I2: 壊れた台帳を黙って空扱いにすると、生きている職人を見失って二重起動する
    if (corruptionError) {
      throw new Error(`Worker Pool ledger is corrupt: ${corruptionError}`);
    }
    this.ledger = ledger;

    // 決定29c: 職人の真実は Worker Pool に一箇所。起動元はここを購読する
    const { log, corruptionError: logError } = WorkerEventLog.open(this.dataDir);
    // I2: 読めなかった行があったことを黙って飲まない。ただしログは追記専用で、
    //     読めた分は使える——台帳と違い、欠けても二重起動のような実害には直結しない
    if (logError) console.error(`[worker-pool] ${logError}`);
    this.log = log;

    // task-0027: ドライバのライフサイクルイベントを購読する。これが無いと職人が終わった
    // 瞬間に誰も気づけず、覗きに行くまで分からない。**すべてのランタイムを購読する**
    // ——1つでも漏らすと、そのランタイムで起こした職人だけ終了が記録されない
    const unsubscribes = [...this.runtimes.values()].map((reg) =>
      reg.driver.subscribe((event) => this.handleDriverEvent(event))
    );
    this.unsubscribeDriver = () => {
      for (const off of unsubscribes) off();
    };

    // inc-0066: 職人の下の実プロセスを台帳へ載せる。既定は「する」
    const probe = options.childPidProbe ?? true;
    this.childPidProbe = probe === false ? false : probe === true ? {} : probe;

    /**
     * inc-0066 第2段：職人1本ごとの隔離。**運転モードは起動時に1回決めて動かさない**。
     *
     * 隔離できないこと自体は許す（開発機・コンテナでも工房は立つ）。許さないのは
     * 「知らないうちに隔離なしで回っていた」で、そのために3箇所へ出す:
     * ここ（起動ログ）・台帳の各行（`isolation`）・`worker.list`（番頭の目）。
     */
    this.cgroups = options.cgroups ?? WorkerCgroups.disabled("工房の設定で有効にされていません");
    console.error(`[worker-pool] ${this.cgroups.describe()}`);
    // 決定44 の復帰と対の掃除。落ちる前に生きていた職人の袋は残す（keep）
    if (this.cgroups.enabled) {
      for (const entry of this.ledger.list()) {
        if (entry.cgroupDir) {
          this.bags.set(entry.sessionId, {
            bag: { dir: entry.cgroupDir, procsFile: path.join(entry.cgroupDir, "cgroup.procs") },
          });
        }
      }
      const swept = this.cgroups.sweep([...this.bags.values()].map((b) => b.bag.dir));
      if (swept.removed.length > 0) {
        console.error(`[worker-pool] 前回の袋を片付けました: ${swept.removed.join(", ")}`);
      }
      // I2: 台帳のどの職人のものでもないのに中身が生きている袋は、孤児が居る証拠。消さずに晒す
      for (const left of swept.alive) {
        console.error(
          `[worker-pool] ⚠ 台帳に無い袋が生きています: ${left.name}（pid ${left.pids.join(",")}）`
        );
      }
    }

    // 決定30b: 安全弁。主たる契機は番頭が畳むことで、これは取りこぼしを拾うだけ
    this.setIdleTimeout(options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS, options.idleCheckMs);
    // task-0216: 同時本数の栓。上限を持つのは工房自身（決定23）
    this.maxConcurrentWorkers = Math.max(
      0,
      Math.floor(options.maxConcurrentWorkers ?? DEFAULT_MAX_CONCURRENT_WORKERS)
    );
    // task-0223: 上限の内訳。判定のための席を早い者勝ちから守る
    this.auditReservedWorkers = Math.max(0, Math.floor(options.auditReservedWorkers ?? 0));
    if (this.maxConcurrentWorkers > 0 && this.auditReservedWorkers >= this.maxConcurrentWorkers) {
      // I2: 黙って直さない。この組み合わせは「実装が1本も起こせない工房」で、
      //     起きてから断りの文面で気づくのでは遅い
      throw new Error(
        `${AUDIT_RESERVED_ENV}（${this.auditReservedWorkers}）が同時本数の上限（${this.maxConcurrentWorkers}）以上です。` +
          "これでは実装の職人を1本も起こせません。予約席は上限より小さくしてください。"
      );
    }
  }

  /**
   * task-0253: ランタイムの想定消費リソースの受け皿を決める（D5: 判定は無い。引きを読むだけ）。
   *
   * 登録側が明示し、`WorkerPoolOptions.assumedResources` に無い id には
   * {@link DEFAULT_ASSUMED_RESOURCES} を当てる——判定（タスクC）が読む段で undefined の
   * まま立つことを防ぐため。bin は本番値（Pi 300 / Claude 1200）を環境変数から渡す。
   */
  private fallbackResources(
    id: string,
    options: WorkerPoolOptions
  ): ResourceEstimate {
    return options.assumedResources?.[id] ?? DEFAULT_ASSUMED_RESOURCES;
  }

  /**
   * いま走っている職人の本数と上限（task-0216）。
   *
   * D3: 数は持たない。**台帳と pid の生存**から毎回導き、起こしている最中の枠を足す。
   * 数えるのは生きている職人だけ——畳んだ・落ちた・安全弁で畳まれた分は自然に減る。
   */
  concurrency(): ConcurrencyStatus {
    const live = this.list({ includeClosed: false })
      .filter((w) => w.alive)
      .map(
        (w): ConcurrencySlot => ({
          taskId: w.taskId,
          projectTag: w.projectTag,
          sessionId: w.sessionId,
          spawnedAt: w.spawnedAt,
          role: this.seatRoleOf(w.sessionId),
        })
      );
    const starting = [...this.starting.values()].map(
      (s): ConcurrencySlot => ({
        taskId: s.taskId,
        projectTag: s.projectTag,
        spawnedAt: s.at,
        starting: true,
        role: s.role,
      })
    );
    const slots = [...live, ...starting].sort((a, b) => a.spawnedAt.localeCompare(b.spawnedAt));
    const byRole: Record<WorkerSeatRole, number> = { executor: 0, auditor: 0 };
    for (const slot of slots) byRole[slot.role] += 1;
    return {
      running: slots.length,
      limit: this.maxConcurrentWorkers,
      slots,
      env: MAX_CONCURRENT_ENV,
      byRole,
      auditReserved: this.auditReservedWorkers,
      executorLimit: this.executorLimit(),
      reservedEnv: AUDIT_RESERVED_ENV,
    };
  }

  /**
   * 実装が取れる本数（上限 − 予約席）。上限なし（0）のときは 0＝上限なしのまま。
   *
   * D3: 保存しない。上限と予約席から毎回導く——2つの数から導ける値を3つ目として
   * 持つと、片方だけ変えた日に食い違う。
   */
  private executorLimit(): number {
    if (this.maxConcurrentWorkers <= 0) return 0;
    return Math.max(0, this.maxConcurrentWorkers - this.auditReservedWorkers);
  }

  /**
   * 席に座っている職人の役（task-0223）。覚えが無ければ起こした事実から引き直す。
   *
   * 引けなければ実装側（{@link DEFAULT_WORKER_SEAT_ROLE}）。工房を立て直した直後は
   * 覚えもイベントも辿れないことがあり、そのときは**実装として多めに数える**
   * ——監査の席を守る向きに倒す。
   */
  private seatRoleOf(sessionId: string): WorkerSeatRole {
    const known = this.seatRoles.get(sessionId);
    if (known) return known;
    const started = this.log.last({ sessionId, type: "worker_started" });
    const role = asSeatRole(started?.data["role"]);
    this.seatRoles.set(sessionId, role);
    return role;
  }

  /** いまの同時本数の上限（設定画面・覗き窓に見せる）。0 なら上限なし。 */
  currentMaxConcurrentWorkers(): number {
    return this.maxConcurrentWorkers;
  }

  /** いまの安全弁の時間（設定画面に見せる）。 */
  currentIdleTimeoutMs(): number {
    return this.idleTimeoutMs;
  }

  /**
   * 安全弁の時間を差し替える（決定41：設定画面から）。**その場で効く。**
   *
   * 0 以下で安全弁を切る。決定30b のとおり主たる契機は番頭が畳むことなので、
   * 切っても仕組みとしては成り立つ——ただし番頭が畳み忘れた職人は残り続ける。
   */
  setIdleTimeout(ms: number, checkMs?: number): void {
    if (this.idleSweeper) {
      clearInterval(this.idleSweeper);
      this.idleSweeper = undefined;
    }
    this.idleTimeoutMs = ms;
    if (this.idleTimeoutMs > 0) {
      const every = checkMs ?? Math.max(1000, Math.floor(this.idleTimeoutMs / 4));
      this.idleSweeper = setInterval(() => void this.sweepIdle(), every);
      // 安全弁がプロセスの終了を妨げないようにする（番頭を終うときに引き留めない）
      this.idleSweeper.unref?.();
    }
  }

  /** 購読を解除する。プロセスを終うときに呼ぶ。 */
  dispose(): void {
    this.unsubscribeDriver();
    this.log.clearSubscribers();
    if (this.idleSweeper) clearInterval(this.idleSweeper);
    // 走らせっぱなしの子プロセス走査を打ち切る（終うのを待たせない・inc-0066）
    this.probesAborter.abort();
  }

  // ── 起動元への報告経路（決定29） ─────────────────────────────────────────────

  /**
   * 職人のイベントを購読する。戻り値で解除。
   *
   * `origin` で絞れば、起動元は**自分が起こした職人の分だけ**を受け取れる（決定29）。
   * `afterEventId` を渡すと、溜まっている分を配ってから以後を流す——起動元が落ちていた
   * 間の報告を取りこぼさないため。
   */
  subscribe(
    handler: WorkerEventHandler,
    options: WorkerEventFilter & { afterEventId?: number } = {}
  ): () => void {
    return this.log.subscribe(handler, options);
  }

  /** `afterEventId` より後のイベントを取る（購読していない側が後から追いつく口）。 */
  events(afterEventId = 0, filter?: WorkerEventFilter, limit?: number): WorkerEvent[] {
    return this.log.since(afterEventId, filter, limit);
  }

  /** 最後に振られたイベントID。ここを起点に購読すると重複なく続けられる。 */
  get lastEventId(): number {
    return this.log.lastEventId;
  }

  /**
   * 職人からの報告を受ける（主張）。
   *
   * **これは完了判定ではない。** 決定29(a)：職人の完了報告は「検証へ回す合図」であって、
   * 成果が良いことの証明ではない。Worker Pool は内容を解釈せず、主張としてログに積むだけ
   * （D5）——受け取った起動元が自分で確かめる（I1）。
   */
  report(sessionId: string, summary: string, data: Record<string, unknown> = {}): WorkerEvent {
    const worker = this.requireWorker(sessionId);
    return this.log.append({
      type: "worker_reported",
      origin: worker.origin,
      projectTag: worker.projectTag,
      taskId: worker.taskId,
      sessionId: worker.sessionId,
      data: { summary, ...data },
    });
  }

  /**
   * **職人が喋り終わった**（PO要望 2026-08-11）。
   *
   * これまで起動元が「終わった」を知る道は2つしか無かった：職人が明示的に報告するか、
   * 手が止まったまま**安全弁の時間切れ**（既定15分）を待つか。だが**出力が終わった時点で
   * 終わったことは分かる**——ランタイムはターンの終わりを知っている。それを事実として
   * 積み、起動元へすぐ渡す。
   *
   * **意味は起動元が与える**（決定29d）。ここは中立な事実だけ：
   *   - `text`     そのターンの最後の発話（報告が無いときの手がかり）
   *   - `reported` そのターンで報告か質問をしたか
   *   - `waiting`  答え待ちで止まっているか（**終わったのではない**）
   *   - `settled`  **そのターンで、手が止まったことが起動元へ既に伝わっているか**
   *
   * `settled` が要るのは、起動元が「もう一度知らせるべきか」を決められるようにするため
   * （PO指摘 2026-08-11）。ターンの終わり方は4つあり、必要な扱いが違う：
   *
   * | そのターンで職人がしたこと | 起動元に届いているもの        | 改めて知らせるか |
   * |---------------------------|------------------------------|-----------------|
   * | 何も言わずに終えた        | 安全弁の代理報告（auto）      | 不要（二重になる）|
   * | 質問した                  | 質問（「待っています」と書く）| 不要             |
   * | 完了を報告した（done）    | 完了の報告                    | 不要             |
   * | **進捗だけ報告した**      | 「着手しました」だけ          | **要る**         |
   *
   * 4つ目が抜けていた——起動元は work in progress と読むが、実際は手が空いている。
   * **判定は工房が持つ**（職人やランタイムの自己申告より、台帳が確か）。
   */
  turnEnded(
    sessionId: string,
    info: { text?: string; reported?: boolean; waiting?: boolean } = {}
  ): WorkerEvent {
    const worker = this.requireWorker(sessionId);
    const waiting = info.waiting === true || worker.question !== undefined;
    return this.log.append({
      type: "worker_turn_ended",
      origin: worker.origin,
      projectTag: worker.projectTag,
      taskId: worker.taskId,
      sessionId: worker.sessionId,
      data: {
        ...(info.text !== undefined ? { text: info.text } : {}),
        reported: info.reported === true,
        // 答え待ちの判定は**工房が持つ**（職人の自己申告より台帳が確か）
        waiting,
        settled: waiting || this.toldCallerItStopped(sessionId),
      },
    });
  }

  /**
   * **このターンで、手が止まったことが起動元へ既に伝わっているか。**
   *
   * 見るのは前のターンの終わりから今までの分だけ——それ以前の完了報告は、いま終わった
   * ターンとは別の話（`steer` で続きをやらせた場合、前のターンの「完了」は効かない）。
   */
  private toldCallerItStopped(sessionId: string): boolean {
    const events = this.log.since(0, { sessionId });
    let from = 0;
    for (let i = events.length - 1; i >= 0; i--) {
      if (events[i]!.type === "worker_turn_ended") {
        from = i + 1;
        break;
      }
    }
    return events
      .slice(from)
      .some((e) => e.type === "worker_reported" && e.data["done"] === true);
  }

  /**
   * 職人からの質問を受ける。この職人は答えが来るまで `waiting` になる（決定29b）。
   */
  ask(sessionId: string, question: string, data: Record<string, unknown> = {}): WorkerEvent {
    const worker = this.requireWorker(sessionId);
    return this.log.append({
      type: "worker_asked",
      origin: worker.origin,
      projectTag: worker.projectTag,
      taskId: worker.taskId,
      sessionId: worker.sessionId,
      data: { question, ...data },
    });
  }

  private handleDriverEvent(event: DriverEvent): void {
    if (event.type !== "process_exited") return;

    const entry = this.ledger.list().find((e) => e.sessionId === event.sessionId);
    // 台帳に無い＝既に stop で片付けた職人。stop の時点で worker_stopped を積んである
    if (!entry) return;

    /**
     * **袋の記録は、消す前のいま読む**（inc-0066 第2段）。
     *
     * 上限に当たって殺された職人は `oom_kill` が1以上で返り、それが `worker_exited` に
     * 載って番頭へ届く——「なぜか落ちた」で終わらせないための一本道。
     * 殺して片付ける方は待たない（イベントを積むのを遅らせない）。
     */
    const memory = this.takeUsage(event.sessionId);
    void this.retireBag(event.sessionId).catch((err: unknown) => {
      console.error(`[worker-pool] 袋の後始末が異常終了しました: ${String(err)}`);
    });

    this.log.append({
      type: "worker_exited",
      origin: entry.origin ?? this.defaultOrigin,
      projectTag: entry.projectTag,
      taskId: entry.taskId,
      sessionId: event.sessionId,
      data: {
        pid: event.pid,
        exitCode: event.exitCode,
        signal: event.signal,
        /**
         * **予期していた終わりか**（PO要望 2026-08-11）。
         *
         * 起動元が畳んだ結果として死んだのなら、それは起動元が自分でやったこと——
         * 改めて知らせる意味がない。**事実は消さない**（D3・I1：いつ死んだかは記録に残す）。
         * 知らせるかどうかを決められるように、印だけ添える（意味は起動元が与える・決定29d）。
         */
        ...(this.closing.has(event.sessionId) ? { expected: true } : {}),
        // inc-0066 第2段: どれだけ抱えて終わったか。上限に当たっていればそれも
        ...(memory ? { memory } : {}),
      },
    });
  }

  /**
   * 職人を起動して仕事を渡す。
   *
   * **spawn だけでは職人は動かない。** `RuntimeDriver` の契約では spawn がセッションを
   * 起こすところまでで、実際に働かせるには inject で prompt を送る必要がある
   * （Kobo の監査経路も spawn 後に inject している）。これを忘れると、職人は起動した
   * まま何もせず「固まっている」ように見える——実際にその不具合を踏んだ。
   *
   * I2: 起動に失敗したら台帳に書かず、理由を添えて投げる。指示の送信に失敗した場合は、
   *     起こしただけの職人を放置しないよう止めてから投げる。
   */
  /**
   * 職人をどう隔離しているか（inc-0066 第2段）。番頭から見える形にするための口。
   *
   * `worker.list` はこれを見て、隔離していないときに警告を1行足す（3点セットの3つ目）。
   */
  isolationStatus(): IsolationStatus {
    return this.cgroups.status;
  }

  /** 選べるランタイムの識別子（番頭へのエラー文と Tool の説明に出す）。 */
  availableRuntimes(): string[] {
    return [...this.runtimes.keys()];
  }

  /** 既定のランタイムの識別子。 */
  get defaultRuntime(): string {
    return this.backendRegistry.defaultBackend();
  }

  /**
   * 名指しできるモデルの一覧（`worker.delegate` の `model` に書ける名前）。
   *
   * **番頭と工場が「何と書けばよいか」を当てにいかないための口。** pi のモデルは登録から
   * （採用しているものだけ）、Claude Code は別名から。ここで数え上げるだけで、
   * どれを使うかは頼む側が決める（D5）。
   */
  selectableModels(): SelectableModel[] {
    const models: SelectableModel[] = [];
    // バックエンドが自分で持っているモデル（Claude Code の別名など）。
    // 切ってあるバックエンドのものは並べない——選べないものを選ばせない
    for (const [id, reg] of this.runtimes) {
      if (!this.backendRegistry.isEnabled(id)) continue;
      for (const m of reg.models?.() ?? []) {
        models.push({ name: m.name, label: m.label, runtime: id, runtimeTitle: reg.title ?? id });
      }
    }
    // pi のモデルは LLM Registry から。**採用しているものだけ**（PO裁定 2026-08-04）
    // ——「LLM・モデル」で職人に許したものが、そのままここに並ぶ
    if (this.backendRegistry.isEnabled(this.driverId)) {
      const piTitle = this.runtimes.get(this.driverId)?.title ?? this.driverId;
      for (const m of this.catalog?.models() ?? []) {
        if (!m.policy.includes("worker")) continue;
        models.push({
          name: `${m.providerId}/${m.id}`,
          label: `${m.name}（${m.providerId}）`,
          runtime: this.driverId,
          runtimeTitle: piTitle,
          tier: m.tier,
        });
      }
    }
    return models;
  }

  /**
   * 割り当てが無い等級で、いま実際に選ばれるモデル（分かるものだけ）。
   *
   * I1: 分からないものは入れない——「たぶんこれ」を出すと、確かめた事実と混ざる。
   */
  fallbackModels(): {
    backend: string;
    backendTitle: string;
    models: Partial<Record<WorkerTier, string>>;
  } {
    const id = this.backendRegistry.defaultBackend();
    const reg = this.runtimes.get(id);
    const models: Partial<Record<WorkerTier, string>> = {};
    for (const tier of WORKER_TIERS) {
      // **答えるのは既定のバックエンド自身**。工房が代表して答えると、既定を
      // 切り替えたときに画面が嘘をつく（pi の第一候補を出したまま Claude Code で動く）
      const resolved = reg?.resolveTier?.(tier);
      if (resolved) models[tier] = resolved;
    }
    return { backend: id, backendTitle: reg?.title ?? id, models };
  }

  /** バックエンドの一覧（設定画面が描く）。 */
  backends(): BackendView[] {
    const counts = new Map<string, number>();
    for (const m of this.selectableModels()) {
      counts.set(m.runtime, (counts.get(m.runtime) ?? 0) + 1);
    }
    return this.backendRegistry.list((id) => counts.get(id) ?? 0);
  }

  /** バックエンドを入れる／切る／既定にする。 */
  setBackend(id: string, next: { enabled?: boolean; makeDefault?: boolean }): void {
    const resolved = RUNTIME_ALIASES[id.toLowerCase()] ?? id;
    this.backendRegistry.setBackend(resolved, next);
  }

  /** 等級ごとのモデルの割り当て（職人の既定）。 */
  tierAssignments(): { defaultTier: WorkerTier | undefined; assignments: Partial<Record<WorkerTier, string>> } {
    return {
      defaultTier: this.backendRegistry.defaultTier(),
      assignments: this.backendRegistry.assignments(),
    };
  }

  /**
   * 等級にモデルを当てる（空で解除）。
   *
   * I2: 選べないモデルを当てさせない——**保存できたのに職人が起きない**のが一番遠い失敗。
   */
  setTierAssignment(tier: WorkerTier, model: string | undefined): void {
    if (model && model.trim().length > 0) {
      const known = this.selectableModels().map((m) => m.name);
      if (!known.includes(model.trim())) {
        throw new Error(
          `知らないモデルです: ${model}\n選べるのは: ${known.join(", ") || "(なし)"}`
        );
      }
    }
    this.backendRegistry.setAssignment(tier, model);
  }

  /**
   * **いま実際に効いている既定の等級**（核の台帳 → 工房の既定 の順）。
   * 起動ログと画面がこれを言う——「言っていることと走るもの」を食い違わせない。
   */
  resolvedDefaultTier(): WorkerTier | undefined {
    return (this.modelLedger?.defaultTier() ?? this.backendRegistry.defaultTier()) as
      | WorkerTier
      | undefined;
  }

  /** **いま実際に効いている既定のモデル**（名指しが無いときに選ばれるもの）。 */
  resolvedDefaultModel(): string | undefined {
    return this.assignedFromLedger(this.resolvedDefaultTier())?.model;
  }

  /**
   * **いま実際に効いている等級ごとの割り当て**（核の台帳）。画面はこれを映す
   * ——工房に残っている値を出すと、消したはずの設定が生きているように見える。
   */
  resolvedAssignments(): Partial<Record<WorkerTier, string>> {
    const out: Partial<Record<WorkerTier, string>> = {};
    for (const tier of WORKER_TIERS) {
      const found = this.assignedFromLedger(tier);
      if (found) out[tier] = found.model;
    }
    return out;
  }

  /**
   * **もう読まれない工房の割り当て**（ADR-0021 段2）。
   *
   * 台帳へ移した後も設定ファイルには残る。黙って無視すると「画面で直したのに変わらない」
   * が再発するので、起動時に名指しする（I2）。
   */
  staleTierAssignments(): string[] {
    if (!this.modelLedger?.exists()) return [];
    return Object.entries(this.backendRegistry.assignments())
      .filter(([, model]) => model && model.trim().length > 0)
      .map(([tier, model]) => `${tier}=${String(model)}`);
  }

  /** 職人の既定の等級。 */
  setDefaultTier(tier: WorkerTier): void {
    if (!WORKER_TIERS.includes(tier)) {
      throw new Error(`知らない等級です: ${tier}（${WORKER_TIERS.join(" / ")}）`);
    }
    this.backendRegistry.setDefaultTier(tier);
  }

  /**
   * 等級に当たっているモデル（核の台帳）。**バックエンドまで一緒に返す**——
   * 同じ `opus` が pi 経由でも Claude Code 経由でも指せるので、名前だけでは決まらない
   * （決定100a：id 空間は `RUNTIME_ALIASES` で揃える）。
   *
   * 台帳がまだ無いうちは、従来どおり工房の割り当てへ落ちる（入れ替えの窓）。
   */
  private assignedFromLedger(
    tier: WorkerTier | undefined
  ): { runtime?: string; model: string } | undefined {
    if (!tier) return undefined;
    if (!this.modelLedger?.exists()) {
      const legacy = this.backendRegistry.assignedModel(tier);
      return legacy ? { model: legacy } : undefined;
    }
    const bound = this.modelLedger.role(`worker.${tier}`)?.default;
    if (!bound) return undefined;
    /**
     * **名前の形はバックエンドで違う**。pi は `provider/model`（登録を引くため両方要る）、
     * Claude Code は別名だけ（`provider` を見ない）。台帳は3成分で持っているので、
     * ここで一覧と同じ綴りに直す——`planModel` が引く `selectableModels()` の `name` と
     * 揃っていないと「知らないモデル」で落ちる。
     */
    const name =
      bound.backend === CLAUDE_AGENT_RUNTIME ? bound.model : `${bound.provider}/${bound.model}`;
    return { runtime: bound.backend, model: name };
  }

  /**
   * 名前からランタイムを引く。
   *
   * I2: 知らない名前を黙って既定に落とさない。「claude で頼んだのに pi で動いていた」は、
   *     出来上がりを見ても気づけない類の食い違いになる。
   */
  private driverFor(runtime?: string): { id: string; driver: RuntimeDriver } {
    const id = runtime
      ? (RUNTIME_ALIASES[runtime.toLowerCase()] ?? runtime)
      : this.backendRegistry.defaultBackend();
    const reg = this.runtimes.get(id);
    if (!reg) {
      throw new Error(
        `Unknown runtime "${runtime ?? id}". 使えるのは: ${this.availableRuntimes().join(", ")}`
      );
    }
    // I2: 切ってあるバックエンドで黙って起こさない（設定と実際を食い違わせない）
    if (!this.backendRegistry.isEnabled(id)) {
      throw new Error(`バックエンド "${id}" は設定で切ってあります（職人は起こせません）。`);
    }
    return { id, driver: reg.driver };
  }

  /**
   * 名指しされたモデルから、動かすランタイムを言い当てる。
   *
   * **番頭や工場に「どのランタイムか」を併記させないため。** モデルを変えるたびに
   * 2か所を直させると、片方だけ直った指定（claude のモデル名で pi を起こす）が通ってしまう。
   *
   * 見分けは名前の形だけ（D5：判断ではなく写し）：
   *   - `opus` / `sonnet` / `haiku` / `claude-…` → Claude Code
   *   - `provider/model` → pi（provider と model に割って渡す。pi は両方揃わないと効かない）
   */
  private planModel(
    runtimeHint: string | undefined,
    model: string | undefined
  ): { runtime: string | undefined; driverOptions: Record<string, unknown> } {
    const named = model?.trim();
    if (!named) return { runtime: runtimeHint, driverOptions: {} };

    /**
     * **そのモデルがどのバックエンドのものかは一覧が知っている**（D3：名前→ランタイムの
     * 真実は1つ）。ここを既定のバックエンド任せにすると、既定を Claude Code にした人が
     * 等級に pi のモデルを当てた瞬間、`provider/model` が Claude Code へ流れる
     * ——Claude は `provider` を見ないので、存在しないモデル名で起こそうとする（実機で確認）。
     */
    const known = this.selectableModels().find((m) => m.name === named);
    // I2: 名指しとランタイムが食い違うなら黙って片方を勝たせない。どちらが違うのか分からなくなる
    if (known && runtimeHint) {
      const hinted = RUNTIME_ALIASES[runtimeHint.toLowerCase()] ?? runtimeHint;
      if (hinted !== known.runtime) {
        throw new Error(
          `モデル "${named}" は ${known.runtimeTitle ?? known.runtime} のものです` +
            `（runtime: ${runtimeHint} と食い違っています）。どちらかに揃えてください。`
        );
      }
    }

    if (isClaudeModelName(named)) {
      return {
        runtime: runtimeHint ?? known?.runtime ?? CLAUDE_AGENT_RUNTIME,
        driverOptions: { model: named },
      };
    }
    const slash = named.indexOf("/");
    if (slash > 0) {
      return {
        // `provider/model` は登録（LLM Registry）のモデル＝登録を読むランタイムのもの。
        // 既定のバックエンドに落とすと、上のコメントの取り違えが起きる
        runtime: runtimeHint ?? known?.runtime ?? this.driverId,
        driverOptions: { provider: named.slice(0, slash), model: named.slice(slash + 1) },
      };
    }
    // I2: pi は provider と model が揃わないとモデル指定が効かない。片方だけ渡して
    //     「指定したのに既定のモデルで動いていた」を作らない——ここで断る
    throw new Error(
      `モデルの指定 "${named}" は使えません。pi のモデルは "provider/model"（例 opencode-go/deepseek-v4-flash）、` +
        "Claude Code は opus / sonnet / haiku などの名前で指定してください。"
    );
  }

  /**
   * 職人を1本起こす。
   *
   * **同時本数の栓はここ**（task-0216・決定23）。上限に達していたら、待たせずに断る
   * ——待ち行列を作ると「受理したが動いていない職人」が生まれ、覗き窓に**待ち状態**を
   * 足すことになる（D3：状態の真実は一箇所）。
   */
  async delegate(input: DelegateInput): Promise<WorkerInfo> {
    const token = await this.reserveSlot(
      input.taskId,
      input.projectTag ?? this.defaultProjectTag,
      input.role ?? DEFAULT_WORKER_SEAT_ROLE
    );
    try {
      return await this.spawnWorker(input);
    } finally {
      // 起きても・断られても・転んでも枠を返す。返し忘れると上限が目減りしていく
      this.starting.delete(token);
    }
  }

  /**
   * 同時本数の枠を1つ取る。取れなければ**次の手が選べる断り方で**投げる（task-0216）。
   *
   * 「上限です」だけでは番頭は何を畳めばいいのか分からない。いま何本走っていて、上限が
   * 何本で、**それぞれ誰が・いつから走っているか**を文面に載せる——番頭はこれを読んで
   * 畳む相手（`worker.close`）を選べる。
   *
   * **断る前に席を作る**（task-0221）。安全弁（`sweepIdle`）は `idleTimeoutMs / 4` ごとの
   * 点検でしか回らないので、「15分以上触られていない職人が席を占めているのに次が断られる」
   * 窓が構造的に開く。満杯と分かった**そのときだけ**掃いて、空いたら通す。空かなければ
   * 従来どおり断る——待ち行列は作らない（task-0216・D3）。
   * 満杯でないときに掃かないのは、普段の `delegate` を重くしないため。
   */
  private async reserveSlot(
    taskId: string,
    projectTag: string,
    role: WorkerSeatRole
  ): Promise<number> {
    let status = this.concurrency();
    if (this.isFull(status, role)) {
      // 安全弁が切ってある（idleTimeoutMs <= 0）ときは sweepIdle が 0 を返して何もしない
      await this.sweepIdle();
      status = this.concurrency();
    }
    if (this.isFull(status, role)) {
      const now = Date.now();
      const lines = status.slots.map((s) => {
        const started = Date.parse(s.spawnedAt);
        const minutes = Number.isFinite(started)
          ? `${Math.max(0, Math.round((now - started) / 60_000))}分前から`
          : "起動時刻不明";
        const where = s.starting ? "起動中" : `sessionId=${s.sessionId ?? "不明"}`;
        return `  - [${seatRoleLabel(s.role)}] ${s.taskId} [${s.projectTag}] ${s.spawnedAt}（${minutes}） ${where}`;
      });
      this.recordDecline(taskId, projectTag, role, status);
      throw new Error(
        `${WORKER_LIMIT_CODE}:${this.declineTally(status, role)}\n` +
          `${this.declineHeadline(status, role)}` +
          `そのため "${taskId}" は起こしませんでした。**待たせていません**（待ち行列は作りません）。\n` +
          "いま走っている職人:\n" +
          `${lines.join("\n")}\n` +
          "終わったもの・止まっているものを `worker.close` で畳んでから頼み直してください。\n" +
          `上限がある理由は、職人1本ごとに 2 GiB の袋（cgroup）が貼られていて、` +
          `本数が増えると工房全体が上限に当たり、**無関係な職人まで巻き添えで殺される**ためです。\n` +
          `上限を変えるには工房の ${MAX_CONCURRENT_ENV}（既定 ${DEFAULT_MAX_CONCURRENT_WORKERS}）を、` +
          `監査用に空けてある席を変えるには ${AUDIT_RESERVED_ENV}（既定 ${DEFAULT_AUDIT_RESERVED_WORKERS}）を変えて立て直します。`
      );
    }
    const token = ++this.startingSeq;
    this.starting.set(token, { taskId, projectTag, at: new Date().toISOString(), role });
    return token;
  }

  /**
   * 満杯か。上限 0 は「上限なし」（試験・単発の道具立て）。
   *
   * **どちらの枠で見るかが役で変わる**（task-0223）。実装は「上限 − 予約席」で頭打ちに
   * なるが、合計の上限も同時に効く——監査が予約席以上に走っているとき、実装の数が
   * 取り分に届いていなくても合計は超えられない。
   */
  private isFull(status: ConcurrencyStatus, role: WorkerSeatRole): boolean {
    if (status.limit <= 0) return false;
    if (status.running >= status.limit) return true;
    return role === "executor" && status.byRole.executor >= status.executorLimit;
  }

  /** 合印に載せる「いま／上限」。どちらの枠で断ったかで数え方が変わる。 */
  private declineTally(status: ConcurrencyStatus, role: WorkerSeatRole): string {
    return this.declinedByExecutorFrame(status, role)
      ? `${status.byRole.executor}/${status.executorLimit}`
      : `${status.running}/${status.limit}`;
  }

  /**
   * 実装の枠で断ったか（合計の上限で断ったか、ではなく）。
   *
   * **予約席が 0 なら枠は1つしかない**ので、常に合計の上限で断ったことにする
   * ——枠が1つしかないのに「実装の枠が埋まっています」と言うと、番頭は空いていない
   * 監査の席を探しにいく。
   */
  private declinedByExecutorFrame(status: ConcurrencyStatus, role: WorkerSeatRole): boolean {
    return (
      status.auditReserved > 0 &&
      role === "executor" &&
      status.byRole.executor >= status.executorLimit
    );
  }

  /**
   * 断りの1行目（task-0223）。**どちらの枠で断ったか**を先に言う。
   *
   * 「上限です」だけだと、番頭は「実装をもう1本頼めるのか、監査なら通るのか」を
   * 読み取れない。次の手（実装を畳む／監査は頼んでよい）が選べる形にする。
   */
  private declineHeadline(status: ConcurrencyStatus, role: WorkerSeatRole): string {
    if (this.declinedByExecutorFrame(status, role)) {
      return (
        `実装の枠が埋まっています（${status.byRole.executor}/${status.executorLimit}。` +
        `監査・判定用に ${status.auditReserved} 席空けてあります）。` +
        `合計は ${status.running}/${status.limit} 本です。監査の依頼（role: auditor）ならまだ通ります。`
      );
    }
    return (
      `${role === "auditor" ? "監査・判定の枠を含めて" : ""}` +
      `同時に走れる職人は ${status.limit} 本までで、いま ${status.running} 本走っています` +
      `（内訳: 実装 ${status.byRole.executor} 本 / 監査・判定 ${status.byRole.auditor} 本）。`
    );
  }

  /**
   * 断ったことを工房の記録に残す（task-0221）。
   *
   * 例外を投げるだけだと、呼び出し側がその文言を捨てた時点で「なぜ遅いのか」が
   * 誰にも読めなくなる。**黙って断らない。** イベントログには積まない——断りには
   * sessionId が無く（`WorkerEvent.sessionId` は必須）、新しい状態も足さないため、
   * `sweepIdle` の失敗と同じ流儀のログ行で残す。
   */
  private recordDecline(
    taskId: string,
    projectTag: string,
    role: WorkerSeatRole,
    status: ConcurrencyStatus
  ): void {
    console.error(
      `[worker-pool] declined ${taskId} [${projectTag}] (${role}) at ${new Date().toISOString()}: ` +
        `${WORKER_LIMIT_CODE}:${this.declineTally(status, role)}` +
        `（同時に走れる職人は ${status.limit} 本までで、いま ${status.running} 本走っています` +
        `。内訳: 実装 ${status.byRole.executor}/${status.executorLimit} 本、監査・判定 ${status.byRole.auditor} 本）`
    );
  }

  private async spawnWorker(input: DelegateInput): Promise<WorkerInfo> {
    const projectTag = input.projectTag ?? this.defaultProjectTag;
    const origin = input.origin ?? this.defaultOrigin;
    // task-0223: 席を取ったときと同じ役で数え続ける（`reserveSlot` と同じ既定）
    const seatRole = input.role ?? DEFAULT_WORKER_SEAT_ROLE;
    /**
     * 使うモデルを決める順番（PO要望 2026-08-10 で**ここに一本化**）:
     *
     *   1. 名指し（番頭・工場が「このモデルで」と決めた）
     *   2. 設定画面で等級に当てたモデル（職人の既定）
     *   3. どちらも無ければランタイムに任せる（pi は LLM Registry、Claude Code は別名）
     *
     * 以前は 2 が pi のドライバ（LLM Registry の tier→pick）と Claude のドライバに
     * 分かれていた。分かれていると、**Claude のモデルは「LLM・モデル」の画面に並べられず**、
     * 職人の既定をひとつの表で見られない。
     */
    /**
     * **既定は核の台帳、上書きは呼び出し側**（ADR-0021 決定99a）。
     *
     * 等級の既定も割り当ても核が持つ（`model-roles.json`）。工房が自分の
     * `tierAssignments` を持っていた頃は、**同じ問いに2箇所が答えて食い違っていた**
     * ——しかも LLM 画面の側は読まれず、選び直しても何も変わらなかった。
     *
     * `input.model`（番頭・Kobo の名指し）が最優先なのは変わらない。
     */
    const tier = (input.modelTier ??
      this.modelLedger?.defaultTier() ??
      this.backendRegistry.defaultTier()) as WorkerTier | undefined;
    const assigned = this.assignedFromLedger(tier);
    const chosenModel = input.model ?? assigned?.model;
    /**
     * **等級に割り当てが無いなら、黙ってランタイム既定へ落ちない**（ADR-0021 決定104）。
     *
     * ここを素通りさせると `planModel(runtime, undefined)` がランタイム任せになり、
     * pi のドライバは**起動時の写し**（`defaultProvider` / `defaultModel`）で走る。
     * 決定104 が止めたかったのはまさにこれ——「安いつもりが一番高いモデル」も
     * 「画面で選んだのと違うモデル」も、例外にならないので誰も気づけない。
     *
     * **帰結を承知で断る**：その職人は起きない（工場が止まる場面が出る）。
     * 取次へ積むのは**番頭ホスト側**——工房は取次を知らない（決定27：ブローカーにしない）
     * ので、合印（`TIER_UNASSIGNED_CODE`）だけを文言に載せて渡す。
     *
     * 名指し（`input.model`）があるときは通す（決定99a：上書きの経路は最優先）。
     * 台帳がまだ無い間（入れ替えの窓）も従来どおり通す——断る根拠が読めていない。
     */
    if (!chosenModel && tier && this.modelLedger?.exists()) {
      throw new Error(
        `${TIER_UNASSIGNED_CODE}:${tier}\n` +
          `等級「${tier}」にモデルが割り当てられていないので、職人を起こしませんでした。\n` +
          "**別のモデルへ勝手に落としません**（ADR-0021 決定104）——設定の「役ごとのモデル」で" +
          `${tier} にモデルを当てるか、頼むときに model を名指ししてください。`
      );
    }
    /**
     * **名指しがあるときは、等級に当たっているバックエンドを引き継がない**（決定99a）。
     *
     * `assigned` は等級の割り当て＝モデルとバックエンドの組。名指し（`input.model`）が
     * 上書きするのはモデルだけなので、ランタイムだけ等級側が残ると必ず食い違う——
     * 監査を `opus` に当てた途端、等級 reasoning に当たっている pi が残って
     * 「モデル opus は Claude Code のものです（runtime: pi と食い違っています）」で
     * spawn が全部落ちた（実測 2026-08-17。Kobo の audit が連続 failed）。
     *
     * ランタイムは名前から決まる（`planModel` の但し書き）ので、名指しのときは名前に従う。
     * 呼び出し側が `runtime` を明記したときだけ、これまでどおり食い違いを見て断る。
     */
    const inheritedRuntime = input.model ? undefined : assigned?.runtime;
    const planned = this.planModel(input.runtime ?? inheritedRuntime, chosenModel);
    const runtime = this.driverFor(planned.runtime);
    const sessionPath = path.join(
      this.dataDir,
      "sessions",
      `${projectTag}-${input.taskId}-${Date.now()}.jsonl`
    );

    // 決定30d: 起こし直しは同じセッションの再開が既定。元の会話が戻るので、
    // 番頭が前提を書き直さずに済む
    const resume = input.resumeSessionPath
      ? { resumeSessionPath: input.resumeSessionPath }
      : {};

    // 職人に載せる拡張を組み立てる。呼び出し側が自分の拡張を渡していても潰さない
    // ——職人は起動元のドメイン Tool と Worker Pool の汎用 Tool の両方を持ちうる
    // （Kobo の report_done と worker.report は層が違う）
    const extensionPaths: unknown[] = [
      ...(Array.isArray(input.driverOptions?.["extensionPaths"])
        ? (input.driverOptions["extensionPaths"] as unknown[])
        : []),
    ];
    // task-0090: 長いツール結果の退避は**全職人に載せる**。載っていない職人だけが
    // 「長い結果の直後に応答が返らない」穴に落ちる（task-0089 で3回連続）。
    // 先頭に置くのは、後続の拡張が見る結果を先に小さくしておくため
    extensionPaths.unshift(toolOffloadExtensionPath());
    // work-keep: 作業の取り置きも**全職人に載せる**。職人が落ちても・無報告で終わっても、
    // そこまでの成果が名前つきの枝に残る。守るのは職人の作法ではなく機構なので、
    // 報告先や network の有無で載せ分けない
    extensionPaths.push(workKeepExtensionPath());
    // 決定29e: 報告先があるときだけ報告経路を載せる
    if (this.reportUrl) extensionPaths.push(workerReportExtensionPath());
    // imp-0005: 外を読む口は許したときだけ。載せなければ Tool 自体が存在しない
    if (input.network) extensionPaths.push(webToolsExtensionPath());

    /**
     * **職人1本ごとの袋を、起こす前に作る**（inc-0066 第2段）。
     *
     * 作れなかったら**その職人を起こさない**（fail closed・PO 裁定）。隔離なしで起こすと
     * 1本の暴走が機械全体を巻き込む——番頭は職人を1本起こせない方が、VM を落とすよりましである。
     * 工房が「隔離しない」運転モードのときは袋そのものが無いので、ここは undefined を返す。
     */
    let bag: WorkerBag | undefined;
    try {
      bag = this.cgroups.createBag(projectTag, input.taskId);
    } catch (err) {
      throw new Error(
        `職人の隔離（cgroup）を作れなかったため "${input.taskId}" を起こしませんでした: ${String(err)}。` +
          `隔離なしで起こすと1本の暴走が機械全体を巻き込みます（inc-0066）`
      );
    }

    const driverOptions = {
      ...input.driverOptions,
      ...resume,
      /**
       * 袋の名簿。**子が自分で自分の pid を書いてから働き始める**ための宛先。
       *
       * 親が spawn の後に書く形だと、書く前に子が孫（`claude` CLI）を起こす競合が残る。
       * 子が自分で入れば、以後その子孫は自動的に同じ袋の中で生まれる（cgroup v2 の継承）。
       */
      ...(bag ? { cgroupProcs: bag.procsFile } : {}),
      ...(this.reportUrl ? { projectTag, workerPoolUrl: this.reportUrl } : {}),
      ...(extensionPaths.length > 0 ? { extensionPaths } : {}),
      // ランタイムが自分で解釈する分（pi は拡張で外の口を足し、Claude Code は
      // 既定の道具立てから外す）。どちらも「許したときだけ渡す」は同じ（imp-0005）
      ...(input.network !== undefined ? { network: input.network } : {}),
      // モデルの名指しは、ランタイムが受け取れる形に割ってから渡す（pi は provider+model）
      ...planned.driverOptions,
    };

    let handle: SessionHandle;
    try {
      handle = await runtime.driver.spawn({
        taskId: input.taskId,
        worktreePath: input.worktreePath,
        sessionPath,
        // 立場（職人であること）はシステムプロンプト、やることは下の inject で渡す
        systemPrompt: input.systemPrompt ?? WORKER_SYSTEM_PROMPT,
        tools: this.resolveTools(input.tools, input.network ?? false),
        ...(tier ? { modelTier: tier } : {}),
        ...(driverOptions ? { driverOptions } : {}),
      });
    } catch (err) {
      await this.discardBag(bag);
      throw new Error(`Failed to start worker for "${input.taskId}": ${String(err)}`);
    }

    /**
     * **袋に入ったことを確かめる**（inc-0066 第2段）。子が自分で入っているはずなので
     * ここは押さえだが、二重に書いても no-op なので確実な方を採る。
     *
     * 入っていなければ隔離が無いのと同じなので、**起こしたばかりの職人を畳んで失敗を返す**
     * （fail closed）。「書いたつもり」で素通りさせない。
     */
    if (bag) {
      try {
        this.cgroups.join(bag, handle.pid);
      } catch (err) {
        await runtime.driver.kill(handle.sessionId).catch(() => undefined);
        await this.discardBag(bag);
        throw new Error(
          `職人 "${input.taskId}" を隔離（cgroup）に入れられなかったので畳みました: ${String(err)}。` +
            `隔離なしで働かせると1本の暴走が機械全体を巻き込みます（inc-0066）`
        );
      }
      this.bags.set(handle.sessionId, { bag });
    }

    // spawn は起こすだけ。ここで指示を送らないと職人は何もしない
    try {
      await runtime.driver.inject(handle.sessionId, input.instruction);
    } catch (err) {
      // I2: 起こしただけの職人を放置しない。止めてから失敗を伝える
      await runtime.driver.kill(handle.sessionId).catch(() => undefined);
      await this.retireBag(handle.sessionId);
      this.bags.delete(handle.sessionId);
      throw new Error(
        `Started a worker for "${input.taskId}" but failed to deliver the instruction: ${String(err)}`
      );
    }

    const spawnedAt = new Date().toISOString();
    this.ledger.add({
      projectTag,
      taskId: input.taskId,
      origin,
      pid: handle.pid,
      sessionId: handle.sessionId,
      sessionPath: handle.sessionPath,
      worktree: input.worktreePath,
      driverId: runtime.id,
      spawnedAt,
      // inc-0066 第2段: 隔離できていないことが台帳から分かるようにする（3点セットの2つ目）
      isolation: this.cgroups.status.mode,
      ...(bag ? { cgroupDir: bag.dir } : {}),
    });
    // 台帳に載った瞬間から、この職人は役つきで数えられる（`concurrency` が引く）
    this.seatRoles.set(handle.sessionId, seatRole);

    this.log.append({
      type: "worker_started",
      origin,
      projectTag,
      taskId: input.taskId,
      sessionId: handle.sessionId,
      data: {
        pid: handle.pid,
        worktree: input.worktreePath,
        // 決定30c: 履歴をイベントログだけで完結させる。台帳は畳んだ時点で消えるので、
        // ここに無いと閉じた職人のセッションを読めなくなる
        sessionPath: handle.sessionPath,
        instruction: input.instruction,
        // 何を渡して起こしたかを残す。起こし直し（wake）がここから引き継ぐので、
        // 記録が無いと「調べさせるために web を渡した職人」が web を失って戻ってくる
        ...(input.tools && input.tools.length > 0 ? { tools: input.tools } : {}),
        ...(input.network ? { network: true } : {}),
        ...(input.resumeSessionPath ? { resumedFrom: input.resumeSessionPath } : {}),
        // どのランタイムのどのモデルで起こしたか。**台帳が消えたあとも要る**——
        // 畳んだ職人を起こし直すとき、ここが無いと別のランタイムで起きてしまう（決定30c）
        runtime: runtime.id,
        ...(chosenModel ? { model: chosenModel } : {}),
        ...(input.modelTier ? { modelTier: input.modelTier } : {}),
        // task-0223: どちらの枠で席を取ったか。台帳には持たない（形を変えない）ので、
        // 立て直したあとに役を引き直せるのはここだけ
        role: seatRole,
        // inc-0066 第2段: どう隔離して起こしたか。台帳が消えたあとも履歴から引ける（決定30c）
        isolation: this.cgroups.status.mode,
        ...(bag
          ? { cgroupDir: bag.dir, memoryMax: this.cgroups.status.memoryMax }
          : { isolationReason: this.cgroups.status.reason ?? "理由不明" }),
      },
    });

    /**
     * **職人の下の実プロセスを突き止めて台帳へ載せる**（inc-0066）。待たない。
     *
     * 子（`claude` CLI 等）が起きるのは指示を渡したあとなので、その場では分からない。
     * かといって待てば委譲が数秒遅くなるうえ、走査が失敗したら職人が起きなくなる
     * ——記録のために仕事を止めるのは本末転倒なので、放して走らせる。
     */
    void this.recordChildProcesses({
      projectTag,
      taskId: input.taskId,
      origin,
      sessionId: handle.sessionId,
      pid: handle.pid,
    }).catch((err: unknown) => {
      // 受け手の居ない reject で工房ごと落とさない（claude-agent-driver の spawn error と同じ轍）
      console.error(`[worker-pool] 子プロセスの走査が異常終了しました: ${String(err)}`);
    });

    // work-keep: 期限を過ぎた取り置きを始末する。**職人を起こす場面に繋ぐ**のは、
    // 取り置きが増えるのがここだから——増える口と減る口を同じところに置けば、
    // 「掃除の仕組みはあるが誰も呼ばない」にならない
    this.pruneKeepsIfDue(input.worktreePath);

    return {
      projectTag,
      taskId: input.taskId,
      origin,
      pid: handle.pid,
      sessionId: handle.sessionId,
      sessionPath: handle.sessionPath,
      worktree: input.worktreePath,
      alive: true,
      state: "running",
      runtime: runtime.id,
      ...(chosenModel ? { model: chosenModel } : {}),
      spawnedAt,
    };
  }

  /**
   * 委譲時に職人へ渡す Tool 名を組み立てる（imp-0004）。
   *
   * 省略時は空配列＝ランタイムの既定のまま。絞るときは**報告経路の Tool を必ず足す**
   * ——pi の許可リストは拡張の Tool にも効くので、番頭が `["read","grep"]` のつもりで
   * 絞ると `worker.report` / `worker.ask` まで消え、職人は報告も質問もできないのに
   * 誰もそれに気づけない（決定29の経路が黙って切れる）。
   *
   * 報告先が無い（reportUrl 未設定）ときは拡張自体が載らないので、足すものも無い。
   * 外を読む口（imp-0005）も同じ理由で、許したときだけ足す。
   */
  /**
   * 起こした職人の下で動いている実プロセスを突き止め、台帳とイベントログへ残す（inc-0066）。
   *
   * **なぜ2箇所に書くか。** 台帳は畳んだ時点で消えるので、事故のあとに「あの職人は何を
   * 抱えていたか」を引けるのはイベントログだけになる（決定30c と同じ理由）。逆に、
   * いま動いている職人を pid から逆引きするには台帳が要る。用途が違うので両方に置く。
   *
   * **止めない・投げない。** ここは記録のためだけの処理で、失敗しても職人は働いている。
   * ただし黙らない——理由は `error` として両方に残す（I2）。
   */
  private async recordChildProcesses(args: {
    projectTag: string;
    taskId: string;
    origin: string;
    sessionId: string;
    pid: number;
  }): Promise<void> {
    if (this.childPidProbe === false) return;
    let found: ChildProcessRecord;
    try {
      found = await probeChildPids(args.pid, {
        ...this.childPidProbe,
        signal: this.probesAborter.signal,
      });
    } catch (err) {
      found = {
        at: new Date().toISOString(),
        children: [],
        error: `子プロセスの走査に失敗しました: ${String(err)}`,
      };
    }

    // 走査のあいだに畳まれていれば載せ先が無い。イベントの方には必ず残る
    const entry = this.ledger.get(args.projectTag, args.taskId);
    if (entry && entry.sessionId === args.sessionId) {
      try {
        this.ledger.update(args.projectTag, args.taskId, { childProcesses: found });
      } catch (err) {
        console.error(
          `[worker-pool] 子プロセスの pid を台帳へ書けませんでした (${args.sessionId}): ${String(err)}`
        );
      }
    }

    try {
      this.log.append({
        type: "worker_child_pids",
        origin: args.origin,
        projectTag: args.projectTag,
        taskId: args.taskId,
        sessionId: args.sessionId,
        data: {
          // ホストの pid も一緒に置く。イベント単体で親子の対応が読めるように
          pid: args.pid,
          at: found.at,
          children: found.children,
          ...(found.error ? { error: found.error } : {}),
          ...(found.truncated ? { truncated: true } : {}),
        },
      });
    } catch (err) {
      console.error(
        `[worker-pool] 子プロセスの pid を記録できませんでした (${args.sessionId}): ${String(err)}`
      );
    }

    // I2: 突き止められなかったことは、次の事故で効いてくる。その場で見えるようにもしておく
    if (found.error) {
      console.error(`[worker-pool] ${args.taskId} (${args.sessionId}): ${found.error}`);
    }
  }

  /**
   * 起こす前に作った袋を、起こせなかったので捨てる（inc-0066 第2段）。
   *
   * まだ誰も入っていないはずだが、`spawn` が途中まで進んでいた場合に備えて殺してから消す。
   */
  private async discardBag(bag: WorkerBag | undefined): Promise<void> {
    if (!bag) return;
    this.cgroups.killAll(bag);
    const removed = await this.cgroups.remove(bag);
    if (!removed.ok) {
      console.error(`[worker-pool] 使わなかった袋を片付けられませんでした: ${bag.dir}（${removed.error}）`);
    }
  }

  /**
   * 職人の袋を畳む（inc-0066 第2段）。**記録を読んでから殺し、消す。**
   *
   * 順序が要点:
   *
   * 1. `memory.peak` / `memory.events` を読む——**`rmdir` すると二度と読めない。**
   *    2026-08-14 の事故で「11GB を抱えていたのは誰か」が分からなかったことへの直接の答え
   * 2. `cgroup.kill` で袋の中を全部殺す——相手の協力に依存しない。node ホストが
   *    先に死んで取り残された `claude` CLI も、その下の bash も、ここで確実に死ぬ
   * 3. 空いた袋を `rmdir`
   *
   * 冪等。プロセスが自分で死んだとき（`process_exited`）と、番頭が畳んだとき（`close`）の
   * 両方から呼ばれ、後から呼んだ方は1回目に読んだ記録をそのまま受け取る。
   */
  private async retireBag(sessionId: string): Promise<CgroupUsage | undefined> {
    const held = this.bags.get(sessionId);
    if (!held) return undefined;
    const usage = this.takeUsage(sessionId);
    if (held.retired) return usage; // 既に畳んである
    held.retired = true;

    this.cgroups.killAll(held.bag);
    const removed = await this.cgroups.remove(held.bag);
    if (!removed.ok) {
      console.error(`[worker-pool] 袋を片付けられませんでした: ${held.bag.dir}（${removed.error}）`);
    }
    if (usage?.oomKilled) {
      // I2: 「なぜか落ちた」で終わらせない。番頭が読む前に、まず機械のログへ残す
      console.error(
        `[worker-pool] ⚠ 職人 ${sessionId} は上限（${formatBytes(this.cgroups.status.memoryMax)}）に当たり` +
          `袋の中で kill されました（peak ${usage.peakBytes !== undefined ? formatBytes(usage.peakBytes) : "不明"}）`
      );
    }
    return usage;
  }

  /**
   * 袋が消える前に使い切りの記録を読み取り、覚えておく（inc-0066 第2段）。
   *
   * **同期でなければならない。** 記録を載せる先は `worker_exited` で、それを積むのは
   * ドライバのイベントを受ける同期の経路（`handleDriverEvent`）。非同期にすると
   * 「イベントには載っていないが、あとで分かった」という時間差が生まれ、
   * 事故のあとに履歴だけを読む番頭がその差に気づけない。
   */
  private takeUsage(sessionId: string): CgroupUsage | undefined {
    const held = this.bags.get(sessionId);
    if (!held) return undefined;
    if (!held.usage) held.usage = this.cgroups.usage(held.bag);
    return held.usage;
  }

  private resolveTools(requested: string[] | undefined, network = false): string[] {
    if (!requested || requested.length === 0) return [];
    const merged = [...requested];
    const keep = [
      ...(this.reportUrl ? WORKER_REPORT_TOOL_NAMES : []),
      ...(network ? WEB_TOOL_NAMES : []),
    ];
    for (const name of keep) {
      if (!merged.includes(name)) merged.push(name);
    }
    return merged;
  }

  /**
   * 職人の一覧。
   *
   * D3: すべて導出する。生死は pid、終了の内訳・待ち・畳んだ理由はイベントログ。
   * 決定30c: **畳んだ職人も消えない。** 台帳（生きているプロセスの帳簿）からは外れるが、
   * イベントログから履歴として組み立てる。既定では履歴も含める——「さっき頼んだ仕事が
   * どうなったか」を見るのに、生きている職人だけでは足りないため。
   */
  list(options: { projectTag?: string; includeClosed?: boolean; query?: string } = {}): WorkerInfo[] {
    const { projectTag, includeClosed = true, query } = options;
    const live = this.ledger
      .list()
      .filter((entry) => projectTag === undefined || entry.projectTag === projectTag)
      .map((entry) => this.describe(entry.sessionId, entry))
      .filter((w): w is WorkerInfo => w !== undefined);

    if (!includeClosed) return live;

    const liveIds = new Set(live.map((w) => w.sessionId));
    const closed = this.closedSessionIds()
      .filter((sessionId) => !liveIds.has(sessionId))
      .map((sessionId) => this.describe(sessionId))
      .filter((w): w is WorkerInfo => w !== undefined)
      .filter((w) => projectTag === undefined || w.projectTag === projectTag);

    // 新しいものが後ろに来るよう、起動順に並べる
    const all = [...live, ...closed].sort((a, b) => a.spawnedAt.localeCompare(b.spawnedAt));
    return query ? all.filter((w) => this.matchesQuery(w, query)) : all;
  }

  /**
   * 検索の当たり判定。空白で区切った語をすべて含むもの（AND）。
   *
   * 探す先には**起動時の指示**も含める。「READMEを書かせたやつ」のように、taskId を
   * 覚えていなくても何をさせたかで辿れるようにするため。セッションの本文までは見ない
   * ——ファイルを開いて回ることになり、一覧の応答としては重い。
   */
  private matchesQuery(worker: WorkerInfo, query: string): boolean {
    const started = this.log.last({ sessionId: worker.sessionId, type: "worker_started" });
    const haystack = [
      worker.taskId,
      worker.projectTag,
      worker.origin,
      worker.sessionId,
      worker.worktree,
      worker.state,
      worker.closeReason ?? "",
      String(started?.data["instruction"] ?? ""),
    ]
      .join("\n")
      .toLowerCase();
    return query
      .toLowerCase()
      .split(/\s+/)
      .filter((term) => term.length > 0)
      .every((term) => haystack.includes(term));
  }

  /**
   * 絞り込み＋ページ送り（提案 2026-07-30-worker-list-pagination の A案）。
   *
   * **新しいものから返す。** 溜まった履歴を辿る用途なので、直近が先頭に来る方が使いやすい
   * （古い順に全部見たいときは `list`）。
   *
   * `total` は配列の長さなので、返すのに追加の走査は要らない——提案が挙げていた
   * 「総件数の計算負荷」は、一覧が既にメモリ上にあるこの実装では発生しない。
   */
  find(
    options: {
      projectTag?: string;
      includeClosed?: boolean;
      query?: string;
      limit?: number;
      offset?: number;
    } = {}
  ): { workers: WorkerInfo[]; total: number; closedTotal: number; limit: number; offset: number } {
    const { limit = DEFAULT_PAGE_SIZE, offset = 0, ...filter } = options;
    const matched = this.list(filter).reverse();
    // 「畳んだ分を隠している」ことを呼び出し側が言えるように、絞り込み後の畳んだ数も返す
    const closedTotal = this.list({ ...filter, includeClosed: true }).filter(
      (w) => w.state === "closed"
    ).length;

    const from = Math.max(0, offset);
    return {
      workers: matched.slice(from, from + Math.max(1, limit)),
      total: matched.length,
      closedTotal,
      limit,
      offset: from,
    };
  }

  /** 畳まれた職人の sessionId（起動順）。 */
  private closedSessionIds(): string[] {
    const ids: string[] = [];
    for (const event of this.log.since(0, { type: "worker_closed" })) {
      if (!ids.includes(event.sessionId)) ids.push(event.sessionId);
    }
    return ids;
  }

  /**
   * 1人分の姿を組み立てる。台帳に居ればそこから、居なければイベントログから。
   *
   * 台帳が無くても組み立てられるのが要点（決定30c）。畳んだ職人のセッションを
   * 後から読めるよう、起動イベントに sessionPath を載せてある。
   */
  private describe(sessionId: string, entry?: LedgerEntry): WorkerInfo | undefined {
    const started = this.log.last({ sessionId, type: "worker_started" });
    /**
     * **最後に起動してから先のイベントだけを見る。**
     *
     * pi は再開すると同じ sessionId を返すため、起こし直した職人には前回の
     * `worker_closed` や質問がそのまま残っている。それを見てしまうと、動いている職人が
     * 「畳んだまま」に見える（実プロセスで確認して見つけた）。
     */
    const sinceStart = started?.id ?? 0;
    const latest = (type: WorkerEvent["type"]): WorkerEvent | undefined => {
      const found = this.log.since(sinceStart, { sessionId, type });
      return found[found.length - 1];
    };
    const base = entry
      ? {
          projectTag: entry.projectTag,
          taskId: entry.taskId,
          origin: entry.origin ?? this.defaultOrigin,
          pid: entry.pid,
          sessionPath: entry.sessionPath,
          worktree: entry.worktree,
          spawnedAt: entry.spawnedAt,
        }
      : started
        ? {
            projectTag: started.projectTag,
            taskId: started.taskId,
            origin: started.origin,
            pid: Number(started.data["pid"] ?? 0),
            sessionPath: String(started.data["sessionPath"] ?? ""),
            worktree: String(started.data["worktree"] ?? ""),
            spawnedAt: started.at,
          }
        : undefined;
    // I2: 起動イベントも台帳も無い sessionId は組み立てられない。空の姿を作らない
    if (!base) return undefined;

    const closedEvent = latest("worker_closed");
    const exited = latest("worker_exited");
    const exit = exited
      ? {
          exitCode: (exited.data["exitCode"] ?? null) as number | null,
          signal: (exited.data["signal"] ?? null) as string | null,
          at: exited.at,
        }
      : undefined;

    // 決定29b: 質問して答えが来ていない職人は waiting。生きているが止まっている
    const asked = latest("worker_asked");
    const answered = latest("worker_answered");
    const pending = asked && (!answered || answered.id < asked.id) ? asked : undefined;

    // 喋り終わったあと、まだ何も渡していないなら手が空いている（PO要望 2026-08-11）
    const ended = latest("worker_turn_ended");
    const woken = latest("worker_answered");
    const idle = ended !== undefined && (!woken || woken.id < ended.id);

    const alive = entry !== undefined && closedEvent === undefined && isProcessAlive(base.pid);
    const state: WorkerState = closedEvent
      ? "closed"
      : !alive
        ? "exited"
        : pending
          ? "waiting"
          : idle
            ? "idle"
            : "running";

    // どのランタイムで起こしたか。台帳が先（生きている職人の帳簿）、消えていれば起動イベント。
    // どちらにも無い＝ランタイムを1つしか持たなかった頃の記録なので、既定に寄せる
    const runtime =
      entry?.driverId ??
      (typeof started?.data["runtime"] === "string" ? (started.data["runtime"] as string) : this.driverId);
    const model = typeof started?.data["model"] === "string" ? (started.data["model"] as string) : undefined;

    /**
     * 職人の下の実プロセス（inc-0066）。台帳が先——生きている職人の帳簿だから。
     * 畳んで台帳から消えた職人は、起動時に積んだイベントから組み直す（決定30c）。
     */
    const childProcesses = entry?.childProcesses ?? childProcessesFromEvent(latest("worker_child_pids"));

    /**
     * 隔離（inc-0066 第2段）。台帳が先で、畳んだ職人は起動時のイベントから読む（決定30c）
     * ——「あの職人は隔離されていたのか」は、事故のあとに必ず問われる。
     */
    const isolation: IsolationMode | undefined =
      entry?.isolation ??
      (started?.data["isolation"] === "cgroup" || started?.data["isolation"] === "none"
        ? (started.data["isolation"] as IsolationMode)
        : undefined);
    /** 使い切りの記録。終わった職人にだけ在る（畳んだときと死んだときの両方に載る）。 */
    const memory = usageFromEvent(closedEvent) ?? usageFromEvent(exited);

    return {
      ...base,
      ...(childProcesses ? { childProcesses } : {}),
      ...(isolation ? { isolation } : {}),
      ...(memory ? { memory } : {}),
      sessionId,
      alive,
      state,
      runtime,
      ...(model ? { model } : {}),
      ...(exit ? { exit } : {}),
      ...(alive && pending ? { question: String(pending.data["question"] ?? "") } : {}),
      ...(closedEvent
        ? {
            closeReason: (closedEvent.data["reason"] ?? "stopped") as CloseReason,
            closedAt: closedEvent.at,
          }
        : {}),
    };
  }

  /** sessionId で1人引く。 */
  get(sessionId: string): WorkerInfo | undefined {
    return this.list().find((w) => w.sessionId === sessionId);
  }

  /**
   * projectTag と taskId で引く。
   *
   * 職人自身は自分の sessionId を知らない——sessionId はランタイムが起動後に決めるため、
   * 子プロセスへ環境変数で渡せない。代わりに職人は `BANTO_PROJECT` / `BANTO_TASK_ID` を
   * 持っているので、報告経路ではこの組で引く（台帳のキーと同じ組で一意）。
   */
  getByTask(projectTag: string, taskId: string): WorkerInfo | undefined {
    // 畳んだ職人と同じ taskId で起こし直すことがあるので、生きている方を優先して探す
    const found = this.list().filter((w) => w.projectTag === projectTag && w.taskId === taskId);
    return found.find((w) => w.state !== "closed") ?? found[found.length - 1];
  }

  /**
   * 稼働中の職人に追加の指示を渡す。質問への答えもこれで返す（決定29b）。
   * I2: 台帳に無い・既に終わっている職人への指示はエラーにする。
   */
  async steer(sessionId: string, message: string): Promise<void> {
    const worker = this.requireWorker(sessionId);
    if (!worker.alive) {
      throw new Error(`Worker "${sessionId}" has already exited (pid ${worker.pid}).`);
    }
    // 起こしたときと同じランタイムへ届ける（混在していても迷子にしない）
    await this.driverFor(worker.runtime).driver.inject(sessionId, message);
    // 待っていた職人はこれで動き出す。答えたことを事実として積む（waiting が解ける）
    this.log.append({
      type: "worker_answered",
      origin: worker.origin,
      projectTag: worker.projectTag,
      taskId: worker.taskId,
      sessionId,
      data: { message, ...(worker.question !== undefined ? { question: worker.question } : {}) },
    });
  }

  /**
   * 職人を畳む（決定30）。既に終わっていても成功扱い（冪等）。
   *
   * **主たる契機は番頭の判断**（決定30a）。報告を受けて成果を確かめ、良ければここで畳む。
   * 報告そのものは閉じる合図ではない——決定29(a) を崩さない。
   *
   * 畳んでも消えない（決定30c）。台帳（生きているプロセスの帳簿）からは外れるが、
   * イベントログには残るので、履歴として見られるし同じセッションで起こし直せる。
   */
  async close(sessionId: string, reason: CloseReason = "done"): Promise<void> {
    const worker = this.requireWorker(sessionId);
    if (worker.state === "closed") return;

    /**
     * **これから畳む、と先に印を立てる**（PO要望 2026-08-11）。
     *
     * `kill` するとドライバから `process_exited` が飛び、`worker_exited` が積まれる
     * ——**`worker_closed` より先に**。起動元から見ると「自分で畳んだのに、そのあと
     * 『プロセスが終了しました』と知らされる」ことになり、無駄な一通が必ず並ぶ
     * （実測：356人中315人がこの形）。印を見て「予期していた終わり」と分かるようにする。
     */
    this.closing.add(sessionId);
    await this.driverFor(worker.runtime).driver.kill(sessionId);
    /**
     * **袋ごと畳む**（inc-0066 第2段）。記録を読んでから `cgroup.kill` で全部殺し、消す。
     *
     * ドライバの `kill` は「標準入力に `abort` を書く」＝相手の協力に依存する経路で、
     * 暴走した職人には効かない。台帳の pid への念押しも**単一 pid にしか届かず**、
     * node ホストを殺したあとに残った `claude` CLI は PID 1 に引き取られて孤児になる
     * ——2026-08-14 に「台帳は2件、claude は9本」を作った経路そのもの。袋なら取りこぼさない。
     */
    const memory = await this.retireBag(sessionId);
    this.bags.delete(sessionId);
    // ドライバが取りこぼしたプロセスが残ることがあるので、台帳の pid でも念押しする
    if (isProcessAlive(worker.pid)) await killOrphanProcess(worker.pid);
    this.ledger.remove(worker.projectTag, worker.taskId);
    // 畳んだ職人の役は覚えておかない（数えるのは走っている職人だけ・D3）
    this.seatRoles.delete(sessionId);
    this.log.append({
      type: "worker_closed",
      origin: worker.origin,
      projectTag: worker.projectTag,
      taskId: worker.taskId,
      sessionId,
      data: {
        reason,
        pid: worker.pid,
        // 質問に答えないまま畳んだ場合、それが履歴に残るようにしておく
        ...(worker.question !== undefined ? { unansweredQuestion: worker.question } : {}),
        // inc-0066 第2段: 袋が消える前に読んだ使い切りの記録（畳んだ職人の分もここに残る）
        ...(memory ? { memory } : {}),
      },
    });
    // 畳み終わった。印は落とす（同じ id で起こし直したときに残っていると誤判定する）
    this.closing.delete(sessionId);
  }

  /**
   * 職人を強制的に止める。作業中でも止まる。
   * 仕事が済んだので畳むときは `close` を使う——理由が分かれていないと、履歴が
   * 「なぜ終わったのか」に答えられない（決定30e）。
   */
  async stop(sessionId: string): Promise<void> {
    await this.close(sessionId, "stopped");
  }

  /**
   * 動いていない職人を起こし直す（決定30d）。元のセッションを再開するので会話が戻る。
   *
   * 対象は**プロセスが居ないもの**——畳んだ職人（closed）と、ホストごと落ちた職人
   * （exited）の両方。以前は closed だけを受けていたが、それだと「ホスト再起動後に
   * 生きていた職人を戻す」ができず、復帰処理が closed を起こす側に倒れていた（inc-0019）。
   *
   * 生きている職人（running / waiting）は対象外。指示を足したいだけなら steer を使う。
   *
   * D11 と矛盾しない：D11 が禁じているのは**隠れ状態**であって文脈の保存ではない。
   * セッションファイルは外から読める記録で、再開しても再現可能・監査可能は保たれる。
   */
  async wake(sessionId: string, instruction: string): Promise<WorkerInfo> {
    const past = this.get(sessionId);
    if (!past) {
      throw new Error(`Unknown worker "${sessionId}". 履歴に無い職人は起こし直せません。`);
    }
    if (past.state === "running" || past.state === "waiting") {
      throw new Error(
        `Worker "${sessionId}" はまだ動いています（${past.state}）。指示を足すなら steer を使ってください。`
      );
    }
    // 起こす前の道具立てを引き継ぐ。ここを落とすと、絞って起こした職人が起こし直しで
    // 全部の道具を持って戻り、web を渡した職人は web を失う——どちらも黙って起きる
    const started = this.log.last({ sessionId, type: "worker_started" });
    const tools = started?.data["tools"];
    const model = started?.data["model"];
    const modelTier = started?.data["modelTier"];
    return this.delegate({
      projectTag: past.projectTag,
      origin: past.origin,
      taskId: past.taskId,
      worktreePath: past.worktree,
      instruction,
      resumeSessionPath: past.sessionPath,
      // task-0223: 起こし直しでも同じ枠。落とすと、監査の職人が実装の枠で起き直って
      // 「監査だけ復帰できない」が混雑時に出る
      role: asSeatRole(started?.data["role"]),
      ...(Array.isArray(tools) ? { tools: tools as string[] } : {}),
      ...(started?.data["network"] === true ? { network: true } : {}),
      // **同じランタイム・同じモデルで起こし直す。** ここを落とすと、Claude Code で
      // 進めていた仕事が pi で目を覚まし、会話の再開にも失敗する（セッションの形が違う）
      runtime: past.runtime,
      ...(typeof model === "string" ? { model } : {}),
      ...(typeof modelTier === "string"
        ? { modelTier: modelTier as DelegateInput["modelTier"] }
        : {}),
    });
  }

  /**
   * 何もしていない職人を畳む（決定30b の**安全弁**）。
   *
   * 最終活動時刻は、セッションJSONL の更新時刻とイベントの時刻から導く（D3）——
   * pi はメッセージのたびにセッションを書くので、別に「最終活動」を持たなくてよい。
   *
   * 質問待ちの職人も対象にする。答えてもらえないまま放置された職人はプロセスとして
   * 残り続けるため。畳む前の質問は `unansweredQuestion` として履歴に残るので、
   * 「番頭が答えなかった」ことは隠れない。
   *
   * @returns 畳んだ数
   */
  async sweepIdle(now = Date.now()): Promise<number> {
    if (this.idleTimeoutMs <= 0) return 0;
    let closed = 0;
    for (const worker of this.list()) {
      if (worker.state === "closed") continue;
      if (now - this.lastActivityAt(worker) < this.idleTimeoutMs) continue;
      try {
        await this.close(worker.sessionId, "idle");
        closed++;
      } catch (err) {
        // I2 の例外: 1人の失敗で残りの掃除を止めない。ただし黙らせない
        console.error(`[worker-pool] failed to close idle worker ${worker.sessionId}: ${String(err)}`);
      }
    }
    return closed;
  }

  /** 最終活動時刻（ミリ秒）。セッションファイルの更新とイベントの新しい方を採る。 */
  private lastActivityAt(worker: WorkerInfo): number {
    let latest = Date.parse(worker.spawnedAt);
    const event = this.log.last({ sessionId: worker.sessionId });
    if (event) latest = Math.max(latest, Date.parse(event.at));
    try {
      latest = Math.max(latest, fs.statSync(worker.sessionPath).mtimeMs);
    } catch {
      // セッションファイルがまだ無い／消えた場合はイベント側だけで判断する
    }
    return latest;
  }

  /**
   * 職人の出力を読む（ライブアタッチのデータ側。決定18のセッションビューアの実体）。
   *
   * セッションJSONLの末尾から指定行を返す。プロセスに割り込まないので、
   * 稼働中でも安全に覗ける。
   *
   * @param tailLines 末尾から何行返すか
   */
  attach(sessionId: string, tailLines = 200): { lines: string[]; truncated: boolean } {
    const worker = this.requireWorker(sessionId);
    // I2: 「まだ何も書かれていない」と「どこにあるか分からない」を混同しない。
    //     後者を空で返すと、画面には「出力がありません」と出て原因に辿り着けない
    if (worker.sessionPath.length === 0) {
      throw new Error(
        `Worker "${sessionId}" のセッションの在り処が記録されていません。` +
          "決定30c より前に起こされた職人の可能性があります。"
      );
    }
    if (!fs.existsSync(worker.sessionPath)) {
      throw new Error(
        `Worker "${sessionId}" のセッションファイルが見つかりません: ${worker.sessionPath}`
      );
    }
    const all = fs
      .readFileSync(worker.sessionPath, "utf-8")
      .split("\n")
      .filter((l) => l.trim().length > 0);
    const lines = all.slice(-tailLines);
    return { lines, truncated: all.length > lines.length };
  }

  // ── 取り置き（work-keep）を見つける・始末する ─────────────────────────────

  /**
   * このリポジトリに残っている取り置きを数え上げる。
   *
   * **どのリポジトリを見るかは、職人の作業場所から決める。** 取り置きは共有の `.git` 側に
   * 出来るので、そのリポジトリのワークツリーが1つでも残っていれば全部見える。
   * `repoPath` を渡せばそこだけを見る（畳んだ職人しか居ないときの逃げ道）。
   *
   * **返りは `lastKeptAt` の降順＝先頭が最新。リポジトリを跨いでもそう。**
   * `listKeepBranches` の並べ替えはリポジトリ1本の中でしか効かないので、連結しただけでは
   * 「それぞれの中では降順、全体では走査した順」になる。番頭の知らせは**先頭だけを読んで**
   * 在り処を案内するため、崩れると**いちばん古い枝を案内する**——`f56c43e` で一度直した
   * のと同じ間違いを、多プロジェクト構成で開け直すことになる。
   */
  keeps(
    filter: { projectTag?: string; taskId?: string; repoPath?: string } = {}
  ): KeepBranchInfo[] {
    // 同じ枝を2度返さないのは `keepRepos` の受け持ち（`.git` ごとに1回しか見に行かない）
    const found = this.keepRepos(filter.repoPath).flatMap((repo) =>
      listKeepBranches(repo, filter)
    );
    // 連結したあとに**全体で**並べ直す（`listKeepBranches` と同じ向き・同じ比べ方）
    found.sort((a, b) => b.lastKeptAt.localeCompare(a.lastKeptAt));
    return found;
  }

  /**
   * 期限を過ぎた取り置きを消す。
   *
   * **まだ動いている職人の枝は守る**（`protect`）。期限（既定30日）と定期取り置き（2分）の
   * 差からそこに達することは普通は無いが、時計が狂ったときのために機構としても塞ぐ。
   */
  pruneKeeps(
    options: { repoPath?: string; maxAgeMs?: number; dryRun?: boolean; now?: number } = {}
  ): KeepPruneResult[] {
    const maxAgeMs = options.maxAgeMs ?? resolveKeepMaxAgeMs(process.env);
    const live = new Set(
      this.list({ includeClosed: false })
        .filter((worker) => worker.alive)
        .map((worker) => `${sanitizeRefPart(worker.projectTag)}/${sanitizeRefPart(worker.taskId)}`)
    );
    const results: KeepPruneResult[] = [];
    for (const repo of this.keepRepos(options.repoPath)) {
      results.push(
        pruneKeepBranches({
          repo,
          maxAgeMs,
          ...(options.now !== undefined ? { now: options.now } : {}),
          ...(options.dryRun !== undefined ? { dryRun: options.dryRun } : {}),
          protect: (info) => live.has(`${info.projectTag}/${info.taskId}`),
          record: (entry) => this.recordKeepPrune(entry),
        })
      );
    }
    return results;
  }

  /**
   * 掃除の間隔。ここを短くしても消える枝は増えない（消えるのは期限を過ぎたものだけ）ので、
   * 見に行く回数を抑える方に倒してある。
   */
  private static readonly KEEP_PRUNE_EVERY_MS = 6 * 60 * 60 * 1000;

  /** 前に掃除してから間が空いていれば掃除する。**職人を起こす道を止めない**（I2 の例外）。 */
  private pruneKeepsIfDue(worktreePath: string, now = Date.now()): void {
    if (now - this.lastKeepPruneAt < WorkerPool.KEEP_PRUNE_EVERY_MS) return;
    this.lastKeepPruneAt = now;
    try {
      this.pruneKeeps({ repoPath: worktreePath, now });
    } catch (err) {
      // 掃除の失敗で職人が起きないのは本末転倒。ただし黙らせない
      console.error(`[worker-pool] work-keep の掃除に失敗: ${String(err)}`);
    }
  }

  /** 掃除の記録（消す前に書く）。読めるところに残さないと「黙って消えた」になる。 */
  private recordKeepPrune(entry: Record<string, unknown>): void {
    try {
      fs.appendFileSync(path.join(this.dataDir, KEEP_PRUNE_LOG), JSON.stringify(entry) + "\n", "utf-8");
    } catch (err) {
      console.error(`[worker-pool] work-keep の掃除の記録に失敗: ${String(err)}`);
    }
    if (entry["event"] === "keep_prune_planned") {
      console.error(`[worker-pool] work-keep: 期限切れの取り置きを ${String(entry["count"])} 本消します`);
    }
  }

  /** 走査するリポジトリ（同じ `.git` を共有するワークツリーは1つに畳む）。 */
  private keepRepos(repoPath?: string): string[] {
    const candidates = repoPath
      ? [repoPath]
      : [...new Set(this.list({ includeClosed: true }).map((worker) => worker.worktree))];
    const repos: string[] = [];
    const seen = new Set<string>();
    for (const candidate of candidates) {
      if (candidate.length === 0 || !fs.existsSync(candidate)) continue;
      const common = resolveGitCommonDir(candidate);
      if (!common || seen.has(common)) continue;
      seen.add(common);
      repos.push(candidate);
    }
    return repos;
  }

  /** 終了済みの職人を台帳から片付ける。返り値は片付けた数。 */
  reap(): number {
    const dead = this.list({ includeClosed: false }).filter((w) => !w.alive);
    for (const worker of dead) this.ledger.remove(worker.projectTag, worker.taskId);
    return dead.length;
  }

  private requireWorker(sessionId: string): WorkerInfo {
    const worker = this.get(sessionId);
    if (!worker) {
      const known = this.list().map((w) => w.sessionId).join(", ");
      throw new Error(`Unknown worker "${sessionId}". Running: ${known || "(none)"}`);
    }
    return worker;
  }
}

/**
 * `worker_child_pids` イベントから子プロセスの記録を組み直す（inc-0066）。
 *
 * 台帳から消えた職人（畳んだ・片付けた）でも、事故のあとに pid から辿れるようにするため。
 * イベントの `data` は Worker Pool が解釈しない生の入れ物（D5）なので、ここで形を確かめる。
 */
/**
 * `worker_exited` / `worker_closed` に載せた袋の記録を読み戻す（inc-0066 第2段）。
 *
 * イベントの `data` は Worker Pool が解釈しない生の入れ物（D5）なので、ここで形を確かめる。
 */
function usageFromEvent(event: WorkerEvent | undefined): CgroupUsage | undefined {
  const raw = event?.data["memory"];
  if (!raw || typeof raw !== "object") return undefined;
  const m = raw as Record<string, unknown>;
  const peak = typeof m["peakBytes"] === "number" ? m["peakBytes"] : undefined;
  const events =
    m["events"] && typeof m["events"] === "object"
      ? (m["events"] as Record<string, number>)
      : undefined;
  return {
    ...(peak !== undefined ? { peakBytes: peak } : {}),
    ...(events ? { events } : {}),
    hitLimit: m["hitLimit"] === true,
    oomKilled: m["oomKilled"] === true,
    ...(typeof m["error"] === "string" ? { error: m["error"] } : {}),
  };
}

function childProcessesFromEvent(event: WorkerEvent | undefined): ChildProcessRecord | undefined {
  if (!event) return undefined;
  const children = Array.isArray(event.data["children"])
    ? (event.data["children"] as ChildProcessRecord["children"])
    : [];
  const at = typeof event.data["at"] === "string" ? (event.data["at"] as string) : event.at;
  const error = typeof event.data["error"] === "string" ? (event.data["error"] as string) : undefined;
  return {
    at,
    children,
    ...(error ? { error } : {}),
    ...(event.data["truncated"] === true ? { truncated: true } : {}),
  };
}

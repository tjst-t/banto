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
import type { DriverEvent, RuntimeDriver, SessionHandle, SpawnOptions } from "@banto/core";
import {
  WorkerEventLog,
  type WorkerEvent,
  type WorkerEventFilter,
  type WorkerEventHandler,
} from "./event-log.js";
import { workerReportExtensionPath } from "./extension.js";
import { SpawnLedger, isProcessAlive, killOrphanProcess, type LedgerEntry } from "./spawn-ledger.js";

/**
 * 職人の既定のシステムプロンプト（立場の伝達）。やることは instruction で渡す。
 *
 * D11: 職人は記憶を持たない。だから「前に話した件」は通じず、必要な文脈は毎回
 *      指示に書かれている前提で動く——そのことを職人自身にも伝えておく。
 */
export const WORKER_SYSTEM_PROMPT = [
  "あなたは banto の職人（worker）です。番頭から渡された指示を実行します。",
  "あなたは記憶を持ちません。判断に必要な文脈は、渡された指示にすべて書かれている前提で動いてください。",
  "指示に無い前提を推測して進めるより、足りない情報があればその旨を報告してください。",
  "作業が終わったら、何をしたか・確認した結果・残っている懸念を簡潔に報告してください。",
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
 */
export type WorkerState = "running" | "waiting" | "exited" | "closed";

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
  pid: number;
  sessionId: string;
  sessionPath: string;
  worktree: string;
  /** プロセスがまだ生きているか。ドライバのイベントと台帳のpidの生存確認から導く（D3）。 */
  alive: boolean;
  state: WorkerState;
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

export interface WorkerPoolOptions {
  /** 職人を起動するランタイム。既定は pi（PiRpcDriver）だが差し替え可能。 */
  driver: RuntimeDriver;
  /** ランタイムの識別子。台帳に残し、どのランタイムで起こした職人か分かるようにする。 */
  driverId?: string;
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
}

/** 安全弁の既定。番頭が畳むより十分に長くとる（決定30b）。 */
export const DEFAULT_IDLE_TIMEOUT_MS = 15 * 60 * 1000;

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
  /** 使わせるTool名。省略時はランタイムの既定。 */
  tools?: string[];
  modelTier?: SpawnOptions["modelTier"];
  driverOptions?: Record<string, unknown>;
}

export class WorkerPool {
  private readonly driver: RuntimeDriver;
  private readonly driverId: string;
  private readonly dataDir: string;
  private readonly defaultProjectTag: string;
  private readonly defaultOrigin: string;
  private readonly reportUrl: string | undefined;
  private readonly ledger: SpawnLedger;
  private readonly log: WorkerEventLog;
  private readonly unsubscribeDriver: () => void;
  private readonly idleTimeoutMs: number;
  private readonly idleSweeper: NodeJS.Timeout | undefined;

  constructor(options: WorkerPoolOptions) {
    this.driver = options.driver;
    this.driverId = options.driverId ?? "pi-rpc";
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
    // 瞬間に誰も気づけず、覗きに行くまで分からない
    this.unsubscribeDriver = this.driver.subscribe((event) => this.handleDriverEvent(event));

    // 決定30b: 安全弁。主たる契機は番頭が畳むことで、これは取りこぼしを拾うだけ
    this.idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    if (this.idleTimeoutMs > 0) {
      const every = options.idleCheckMs ?? Math.max(1000, Math.floor(this.idleTimeoutMs / 4));
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

    this.log.append({
      type: "worker_exited",
      origin: entry.origin ?? this.defaultOrigin,
      projectTag: entry.projectTag,
      taskId: entry.taskId,
      sessionId: event.sessionId,
      data: { pid: event.pid, exitCode: event.exitCode, signal: event.signal },
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
  async delegate(input: DelegateInput): Promise<WorkerInfo> {
    const projectTag = input.projectTag ?? this.defaultProjectTag;
    const origin = input.origin ?? this.defaultOrigin;
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

    // 決定29e: 報告先があるときだけ、職人に報告経路（拡張）を載せる。
    // 呼び出し側が自分の拡張を渡していても潰さない——職人は起動元のドメイン Tool と
    // Worker Pool の汎用 Tool の両方を持ちうる（Kobo の report_done と worker.report は層が違う）
    const driverOptions = this.reportUrl
      ? {
          ...input.driverOptions,
          ...resume,
          projectTag,
          workerPoolUrl: this.reportUrl,
          extensionPaths: [
            ...(Array.isArray(input.driverOptions?.["extensionPaths"])
              ? (input.driverOptions["extensionPaths"] as unknown[])
              : []),
            workerReportExtensionPath(),
          ],
        }
      : { ...input.driverOptions, ...resume };

    let handle: SessionHandle;
    try {
      handle = await this.driver.spawn({
        taskId: input.taskId,
        worktreePath: input.worktreePath,
        sessionPath,
        // 立場（職人であること）はシステムプロンプト、やることは下の inject で渡す
        systemPrompt: input.systemPrompt ?? WORKER_SYSTEM_PROMPT,
        tools: input.tools ?? [],
        ...(input.modelTier ? { modelTier: input.modelTier } : {}),
        ...(driverOptions ? { driverOptions } : {}),
      });
    } catch (err) {
      throw new Error(`Failed to start worker for "${input.taskId}": ${String(err)}`);
    }

    // spawn は起こすだけ。ここで指示を送らないと職人は何もしない
    try {
      await this.driver.inject(handle.sessionId, input.instruction);
    } catch (err) {
      // I2: 起こしただけの職人を放置しない。止めてから失敗を伝える
      await this.driver.kill(handle.sessionId).catch(() => undefined);
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
      driverId: this.driverId,
      spawnedAt,
    });

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
        ...(input.resumeSessionPath ? { resumedFrom: input.resumeSessionPath } : {}),
      },
    });

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
      spawnedAt,
    };
  }

  /**
   * 職人の一覧。
   *
   * D3: すべて導出する。生死は pid、終了の内訳・待ち・畳んだ理由はイベントログ。
   * 決定30c: **畳んだ職人も消えない。** 台帳（生きているプロセスの帳簿）からは外れるが、
   * イベントログから履歴として組み立てる。既定では履歴も含める——「さっき頼んだ仕事が
   * どうなったか」を見るのに、生きている職人だけでは足りないため。
   */
  list(options: { projectTag?: string; includeClosed?: boolean } = {}): WorkerInfo[] {
    const { projectTag, includeClosed = true } = options;
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
    return [...live, ...closed].sort((a, b) => a.spawnedAt.localeCompare(b.spawnedAt));
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

    const alive = entry !== undefined && closedEvent === undefined && isProcessAlive(base.pid);
    const state: WorkerState = closedEvent
      ? "closed"
      : !alive
        ? "exited"
        : pending
          ? "waiting"
          : "running";

    return {
      ...base,
      sessionId,
      alive,
      state,
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
    await this.driver.inject(sessionId, message);
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

    await this.driver.kill(sessionId);
    // ドライバが取りこぼしたプロセスが残ることがあるので、台帳の pid でも念押しする
    if (isProcessAlive(worker.pid)) await killOrphanProcess(worker.pid);
    this.ledger.remove(worker.projectTag, worker.taskId);
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
      },
    });
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
   * 畳んだ職人を起こし直す（決定30d）。元のセッションを再開するので会話が戻る。
   *
   * D11 と矛盾しない：D11 が禁じているのは**隠れ状態**であって文脈の保存ではない。
   * セッションファイルは外から読める記録で、再開しても再現可能・監査可能は保たれる。
   */
  async wake(sessionId: string, instruction: string): Promise<WorkerInfo> {
    const past = this.get(sessionId);
    if (!past) {
      throw new Error(`Unknown worker "${sessionId}". 履歴に無い職人は起こし直せません。`);
    }
    if (past.state !== "closed") {
      throw new Error(
        `Worker "${sessionId}" はまだ畳まれていません（${past.state}）。指示を足すなら steer を使ってください。`
      );
    }
    return this.delegate({
      projectTag: past.projectTag,
      origin: past.origin,
      taskId: past.taskId,
      worktreePath: past.worktree,
      instruction,
      resumeSessionPath: past.sessionPath,
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

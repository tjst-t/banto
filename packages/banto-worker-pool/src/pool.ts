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
import { SpawnLedger, isProcessAlive, killOrphanProcess } from "./spawn-ledger.js";

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
export type WorkerState = "running" | "waiting" | "exited";

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
  /** 作業させるディレクトリ（worktree 等）。 */
  worktreePath: string;
  /** 職人に渡す指示。spawn 後に inject で送られる（これが無いと職人は何もしない）。 */
  instruction: string;
  /** 職人の立場を伝えるシステムプロンプト。省略時は WORKER_SYSTEM_PROMPT。 */
  systemPrompt?: string;
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
  }

  /** 購読を解除する。プロセスを終うときに呼ぶ。 */
  dispose(): void {
    this.unsubscribeDriver();
    this.log.clearSubscribers();
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

    // 決定29e: 報告先があるときだけ、職人に報告経路（拡張）を載せる。
    // 呼び出し側が自分の拡張を渡していても潰さない——職人は起動元のドメイン Tool と
    // Worker Pool の汎用 Tool の両方を持ちうる（Kobo の report_done と worker.report は層が違う）
    const driverOptions = this.reportUrl
      ? {
          ...input.driverOptions,
          projectTag,
          workerPoolUrl: this.reportUrl,
          extensionPaths: [
            ...(Array.isArray(input.driverOptions?.["extensionPaths"])
              ? (input.driverOptions["extensionPaths"] as unknown[])
              : []),
            workerReportExtensionPath(),
          ],
        }
      : input.driverOptions;

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
      data: { pid: handle.pid, worktree: input.worktreePath, instruction: input.instruction },
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
   * 台帳にある職人を、生存確認つきで返す（D3：導出する。別の状態を持たない）。
   *
   * 状態はすべて導出：生死は pid、終了の内訳と待ちはイベントログ。
   */
  list(projectTag?: string): WorkerInfo[] {
    return this.ledger
      .list()
      .filter((entry) => projectTag === undefined || entry.projectTag === projectTag)
      .map((entry) => {
        const alive = isProcessAlive(entry.pid);
        const sessionId = entry.sessionId;
        const exited = this.log.last({ sessionId, type: "worker_exited" });
        const exit = exited
          ? {
              exitCode: (exited.data["exitCode"] ?? null) as number | null,
              signal: (exited.data["signal"] ?? null) as string | null,
              at: exited.at,
            }
          : undefined;

        // 決定29b: 質問して答えが来ていない職人は waiting。生きているが止まっている
        const asked = this.log.last({ sessionId, type: "worker_asked" });
        const answered = this.log.last({ sessionId, type: "worker_answered" });
        const pending = asked && (!answered || answered.id < asked.id) ? asked : undefined;

        return {
          projectTag: entry.projectTag,
          taskId: entry.taskId,
          origin: entry.origin ?? this.defaultOrigin,
          pid: entry.pid,
          sessionId,
          sessionPath: entry.sessionPath,
          worktree: entry.worktree,
          alive,
          state: (!alive ? "exited" : pending ? "waiting" : "running") as WorkerState,
          spawnedAt: entry.spawnedAt,
          ...(exit ? { exit } : {}),
          ...(alive && pending ? { question: String(pending.data["question"] ?? "") } : {}),
        };
      });
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
    return this.list().find((w) => w.projectTag === projectTag && w.taskId === taskId);
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
   * 職人を止める。既に終わっていても成功扱い（冪等）。
   */
  async stop(sessionId: string): Promise<void> {
    const worker = this.requireWorker(sessionId);
    await this.driver.kill(sessionId);
    // ドライバが取りこぼしたプロセスが残ることがあるので、台帳の pid でも念押しする
    if (isProcessAlive(worker.pid)) await killOrphanProcess(worker.pid);
    this.ledger.remove(worker.projectTag, worker.taskId);
    this.log.append({
      type: "worker_stopped",
      origin: worker.origin,
      projectTag: worker.projectTag,
      taskId: worker.taskId,
      sessionId,
      data: { pid: worker.pid },
    });
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
    if (!fs.existsSync(worker.sessionPath)) {
      // I2: まだ何も書かれていない状態と、ファイルを見失った状態を混同しない
      return { lines: [], truncated: false };
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
    const dead = this.list().filter((w) => !w.alive);
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

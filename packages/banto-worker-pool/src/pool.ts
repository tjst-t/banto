/**
 * Worker Pool の中核 — 職人（worker）の起動・監視・停止・ライブアタッチ。
 * ADR-0010 決定23・27c。
 *
 * **Kobo に依存しない。** ここにあるのは実行能力だけで、統治（依存ゲート・quota・
 * マージキュー）は Kobo に残る。Banto も Kobo も、この能力の利用者になる。
 *
 * D3: 稼働中の職人の一覧は、起動時に作った台帳とプロセスの生存確認から導く。
 *     「動いているつもり」の内部状態を別に持たない。
 * D5: 誰にどの仕事をさせるかの判断はここに無い。言われた通り起動・停止する。
 * D6: 依存は node 標準と @banto/core の型のみ。
 * I2: 起動失敗・不在の職人への操作は黙って成功にせずエラーにする。
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { DriverEvent, RuntimeDriver, SessionHandle, SpawnOptions } from "@banto/core";
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
 */
export type WorkerState = "running" | "exited";

/** 終了の内訳。イベントでしか分からない部分。 */
export interface WorkerExitDetail {
  exitCode: number | null;
  signal: string | null;
  at: string;
}

/** 職人が終わったときの知らせ。 */
export interface WorkerExit {
  projectTag: string;
  taskId: string;
  sessionId: string;
  pid: number;
  exitCode: number | null;
  signal: string | null;
  at: string;
}

/** 稼働中（または台帳に残っている）1人の職人。 */
export interface WorkerInfo {
  /** 利用者の名前空間。Worker Pool は複数の利用者（Banto・Kobo・複数プロジェクト）に仕える。 */
  projectTag: string;
  taskId: string;
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
}

export interface WorkerPoolOptions {
  /** 職人を起動するランタイム。既定は pi（PiRpcDriver）だが差し替え可能。 */
  driver: RuntimeDriver;
  /** ランタイムの識別子。台帳に残し、どのランタイムで起こした職人か分かるようにする。 */
  driverId?: string;
  /** 台帳・セッションファイルの置き場所。 */
  dataDir: string;
  /** projectTag を省略して呼ばれたときの既定。 */
  defaultProjectTag?: string;
}

/** 職人の終了を受け取るハンドラ。 */
export type WorkerExitHandler = (exit: WorkerExit) => void;

/** 職人に仕事を投げるときの指定。SpawnOptions より上位の、呼び出し側に優しい形。 */
export interface DelegateInput {
  /** 利用者の名前空間（省略時は defaultProjectTag）。 */
  projectTag?: string;
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
  private readonly ledger: SpawnLedger;
  private readonly unsubscribeDriver: () => void;
  private readonly exitHandlers = new Set<WorkerExitHandler>();
  /**
   * ドライバから受けた終了の内訳。sessionId で引く。
   *
   * D3: 「終了したかどうか」の真実は台帳の pid の生存確認で導く。ここに持つのは
   *     イベントでしか分からない追加情報（終了コード・シグナル・時刻）だけで、
   *     生死の判定をこの表に依存させない——Worker Pool を再起動すると消えるため。
   */
  private readonly exits = new Map<string, WorkerExitDetail>();

  constructor(options: WorkerPoolOptions) {
    this.driver = options.driver;
    this.driverId = options.driverId ?? "pi-rpc";
    this.dataDir = options.dataDir;
    this.defaultProjectTag = options.defaultProjectTag ?? "default";
    fs.mkdirSync(path.join(this.dataDir, "sessions"), { recursive: true });
    const { ledger, corruptionError } = SpawnLedger.open(this.dataDir);
    // I2: 壊れた台帳を黙って空扱いにすると、生きている職人を見失って二重起動する
    if (corruptionError) {
      throw new Error(`Worker Pool ledger is corrupt: ${corruptionError}`);
    }
    this.ledger = ledger;

    // task-0027: ドライバのライフサイクルイベントを購読する。これが無いと職人が終わった
    // 瞬間に誰も気づけず、覗きに行くまで分からない（決定29のイベントログの土台にもなる）
    this.unsubscribeDriver = this.driver.subscribe((event) => this.handleDriverEvent(event));
  }

  /** 購読を解除する。プロセスを終うときに呼ぶ。 */
  dispose(): void {
    this.unsubscribeDriver();
    this.exitHandlers.clear();
  }

  /**
   * 職人が終わったときに呼ばれる。戻り値で購読解除。
   *
   * ここで渡すのは**事実**（プロセスが終わった）だけで、成果の良し悪しは含まない。
   * 職人自身の完了報告（主張）は別経路で、決定29(a) のとおり分けて扱う。
   */
  onExit(handler: WorkerExitHandler): () => void {
    this.exitHandlers.add(handler);
    return () => this.exitHandlers.delete(handler);
  }

  private handleDriverEvent(event: DriverEvent): void {
    if (event.type !== "process_exited") return;

    const entry = this.ledger.list().find((e) => e.sessionId === event.sessionId);
    // 台帳に無い＝既に stop で片付けた職人。知らせる相手もいないので無視する
    if (!entry) return;

    const exit: WorkerExitDetail = {
      exitCode: event.exitCode,
      signal: event.signal,
      at: new Date().toISOString(),
    };
    this.exits.set(event.sessionId, exit);

    const notice: WorkerExit = {
      projectTag: entry.projectTag,
      taskId: entry.taskId,
      sessionId: event.sessionId,
      pid: event.pid,
      exitCode: event.exitCode,
      signal: event.signal,
      at: exit.at,
    };
    for (const handler of this.exitHandlers) {
      try {
        handler(notice);
      } catch {
        // I2 の例外: 購読側の失敗で Worker Pool を止めない。ただし握りつぶす範囲は
        // 「1つのハンドラの失敗が他のハンドラと本体に波及しないこと」に限る
      }
    }
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
    const sessionPath = path.join(
      this.dataDir,
      "sessions",
      `${projectTag}-${input.taskId}-${Date.now()}.jsonl`
    );

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
        ...(input.driverOptions ? { driverOptions: input.driverOptions } : {}),
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
      pid: handle.pid,
      sessionId: handle.sessionId,
      sessionPath: handle.sessionPath,
      worktree: input.worktreePath,
      driverId: this.driverId,
      spawnedAt,
    });

    return {
      projectTag,
      taskId: input.taskId,
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
   */
  list(projectTag?: string): WorkerInfo[] {
    return this.ledger
      .list()
      .filter((entry) => projectTag === undefined || entry.projectTag === projectTag)
      .map((entry) => {
        const alive = isProcessAlive(entry.pid);
        const exit = this.exits.get(entry.sessionId);
        return {
          projectTag: entry.projectTag,
          taskId: entry.taskId,
          pid: entry.pid,
          sessionId: entry.sessionId,
          sessionPath: entry.sessionPath,
          worktree: entry.worktree,
          alive,
          state: (alive ? "running" : "exited") as WorkerState,
          spawnedAt: entry.spawnedAt,
          ...(exit ? { exit } : {}),
        };
      });
  }

  /** sessionId で1人引く。 */
  get(sessionId: string): WorkerInfo | undefined {
    return this.list().find((w) => w.sessionId === sessionId);
  }

  /**
   * 稼働中の職人に追加の指示を渡す。
   * I2: 台帳に無い・既に終わっている職人への指示はエラーにする。
   */
  async steer(sessionId: string, message: string): Promise<void> {
    const worker = this.requireWorker(sessionId);
    if (!worker.alive) {
      throw new Error(`Worker "${sessionId}" has already exited (pid ${worker.pid}).`);
    }
    await this.driver.inject(sessionId, message);
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
    this.exits.delete(worker.sessionId);
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
    for (const worker of dead) {
      this.ledger.remove(worker.projectTag, worker.taskId);
      this.exits.delete(worker.sessionId);
    }
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

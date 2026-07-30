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
import type { RuntimeDriver, SessionHandle, SpawnOptions } from "@banto/core";
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

/** 稼働中（または台帳に残っている）1人の職人。 */
export interface WorkerInfo {
  /** 利用者の名前空間。Worker Pool は複数の利用者（Banto・Kobo・複数プロジェクト）に仕える。 */
  projectTag: string;
  taskId: string;
  pid: number;
  sessionId: string;
  sessionPath: string;
  worktree: string;
  /** プロセスがまだ生きているか。台帳とOSの生存確認から導く（D3）。 */
  alive: boolean;
  spawnedAt: string;
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
      .map((entry) => ({
        projectTag: entry.projectTag,
        taskId: entry.taskId,
        pid: entry.pid,
        sessionId: entry.sessionId,
        sessionPath: entry.sessionPath,
        worktree: entry.worktree,
        alive: isProcessAlive(entry.pid),
        spawnedAt: entry.spawnedAt,
      }));
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

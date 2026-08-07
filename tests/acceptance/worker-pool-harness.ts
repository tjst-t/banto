/**
 * Kobo の受け入れテスト用に、**本物の Worker Pool を独立サービスとして**立てる小道具
 * （task-0060・ADR-0013 決定60）。
 *
 * Kobo はもう職人を自分で起こさない。だからテストも「偽ドライバを Kobo に差し込む」形は
 * 取れない——**差し替えるのはランタイム（pi の代わり）であって、Worker Pool ではない**。
 * 偽物にするのを1段深くすることで、決定27b の呼び出し経路（HTTP・Tool 契約・台帳・
 * イベントログ）がテストのたびに実際に通る。
 *
 * `.spec.ts` ではないのでテストランナーからは実行されない（`npm test` は *.spec.ts のみ）。
 */

import * as childProcess from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type {
  DriverEvent,
  DriverEventHandler,
  RuntimeDriver,
  SessionHandle,
  SpawnOptions,
} from "../../packages/banto-core/src/index.js";
import { WorkerPool } from "../../packages/banto-worker-pool/src/pool.js";
import { WorkerPoolService } from "../../packages/banto-worker-pool/src/service.js";
import {
  createWorkerModuleTools,
  createWorkerTools,
} from "../../packages/banto-worker-pool/src/worker-tools.js";

export interface WorkerPoolHarness {
  pool: WorkerPool;
  service: WorkerPoolService;
  /** Kobo に渡す到達先（`workerPoolUrl`）。 */
  url: string;
  /** 起こされた職人（テストが中身を確かめるため）。 */
  close(): Promise<void>;
}

/**
 * Worker Pool を1つ立てる。
 *
 * @param driver 職人を起こすランタイム（テストでは偽のドライバ）
 */
export async function startWorkerPool(driver: RuntimeDriver): Promise<WorkerPoolHarness> {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "kobo-worker-pool-"));
  const pool = new WorkerPool({
    driver,
    dataDir,
    defaultProjectTag: "kobo",
    defaultOrigin: "kobo",
    // 安全弁は切る。テストの最中に職人が勝手に畳まれると、見たいものが消える
    idleTimeoutMs: 0,
  });
  const service = await WorkerPoolService.start({
    tools: [...createWorkerTools(pool), ...createWorkerModuleTools(pool)],
    port: 0,
  });
  return {
    pool,
    service,
    url: service.baseUrl,
    async close() {
      for (const worker of pool.list({ includeClosed: false })) {
        await pool.close(worker.sessionId, "stopped").catch(() => undefined);
      }
      pool.dispose();
      await service.close();
      fs.rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

/** 偽ドライバが起こした「職人」1人分の記録。 */
export interface FakeSession {
  sessionId: string;
  taskId: string;
  worktreePath: string;
  systemPrompt: string;
  modelTier: string | undefined;
  driverOptions: Record<string, unknown>;
  /** spawn 後に届いた指示（`inject`）。1通目が起動時の instruction。 */
  injected: string[];
  alive: boolean;
}

/**
 * pi の代わりに使う偽のランタイム。
 *
 * **プロセスは本物**（`sleep`）を起こす。Worker Pool は pid の生存で職人の生死を見るので、
 * 偽の pid を返すと「起こした瞬間に死んでいる職人」になり、検査したい経路が通らない
 * ——**自分の pid を返してはいけない**（Worker Pool が畳むときに自分が SIGTERM を受ける）。
 *
 * 本物の pi を起こす検査は `pi-rpc-*.spec.ts` と e2e が受け持つ。ここで確かめたいのは
 * 「Kobo が誰に何をどう渡したか」なので、渡されたものを覚えておく形にしてある。
 */
export class FakeRuntimeDriver implements RuntimeDriver {
  readonly sessions: FakeSession[] = [];
  private readonly handlers = new Set<DriverEventHandler>();
  private readonly processes = new Map<string, number>();
  private counter = 0;

  /**
   * 起こすのにかかる時間（ms）。既定 0。
   *
   * task-0072: 職人が生まれるまでの間にタスクが先へ進む競りを、**時間ではなく仕掛けで**
   * 再現するための口。混んでいるときだけ出る壊れ方なので、これが無いと検体にならない。
   */
  spawnDelayMs = 0;

  async spawn(opts: SpawnOptions): Promise<SessionHandle> {
    if (this.spawnDelayMs > 0) {
      await new Promise((r) => setTimeout(r, this.spawnDelayMs));
    }
    this.counter += 1;
    const sessionId = `fake-${this.counter}`;
    const sessionPath = path.join(opts.worktreePath, `.fake-session-${this.counter}.jsonl`);
    const proc = childProcess.spawn("sleep", ["120"], { stdio: "ignore", detached: true });
    proc.unref();
    const pid = proc.pid;
    if (!pid) throw new Error("FakeRuntimeDriver: sleep を起こせませんでした");
    this.processes.set(sessionId, pid);
    proc.once("exit", (code, signal) => {
      const session = this.sessions.find((s) => s.sessionId === sessionId);
      if (session) session.alive = false;
      this.emit({ type: "process_exited", sessionId, pid, exitCode: code, signal });
    });

    this.sessions.push({
      sessionId,
      taskId: opts.taskId,
      worktreePath: opts.worktreePath,
      systemPrompt: opts.systemPrompt ?? "",
      modelTier: opts.modelTier,
      driverOptions: (opts.driverOptions ?? {}) as Record<string, unknown>,
      injected: [],
      alive: true,
    });
    // セッションファイルはライブアタッチの経路が触るので実体を作っておく
    fs.mkdirSync(path.dirname(sessionPath), { recursive: true });
    fs.writeFileSync(sessionPath, "", "utf-8");
    return { pid, sessionId, sessionPath };
  }

  async inject(sessionId: string, message: string): Promise<void> {
    const session = this.find(sessionId);
    session.injected.push(message);
  }

  async kill(sessionId: string): Promise<void> {
    const pid = this.processes.get(sessionId);
    if (pid === undefined) return;
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // 既に終わっている
    }
  }

  subscribe(handler: DriverEventHandler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  /**
   * 職人が落ちた（あるいは自分で終わった）ことにする。
   *
   * 実プロセスを落とすので、Worker Pool から見ても本当に居なくなる——
   * 「イベントだけ流して台帳では生きている」という、実物では起きない状態を作らない。
   */
  exit(sessionId: string, exitCode: number | null = 0, signal: string | null = null): void {
    const session = this.find(sessionId);
    session.alive = false;
    const pid = this.processes.get(sessionId) ?? 0;
    try {
      if (pid > 0) process.kill(pid, "SIGKILL");
    } catch {
      // 既に終わっている
    }
    this.emit({ type: "process_exited", sessionId, pid, exitCode, signal });
  }

  /** 直近に起こされた職人（テストの読みやすさのため）。 */
  last(): FakeSession {
    const session = this.sessions[this.sessions.length - 1];
    if (!session) throw new Error("まだ職人が1人も起こされていません");
    return session;
  }

  /** Worker Pool 側の taskId で引く（`task-0001:audit` など）。 */
  byTaskId(taskId: string): FakeSession | undefined {
    return [...this.sessions].reverse().find((s) => s.taskId === taskId);
  }

  private find(sessionId: string): FakeSession {
    const session = this.sessions.find((s) => s.sessionId === sessionId);
    if (!session) throw new Error(`unknown fake session: ${sessionId}`);
    return session;
  }

  private emit(event: DriverEvent): void {
    for (const handler of this.handlers) handler(event);
  }
}

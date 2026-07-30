/**
 * Worker Pool（職人ランタイム）— ADR-0010 決定23・27c。
 *
 * **Kobo から独立したモジュール。** Kobo のサブシステムではなく、Kobo が無くても単体で
 * 成立する。Banto も Kobo も、それぞれこのモジュールのクライアントになる。
 *
 * Banto から見た位置づけは「必須の組み込みモジュール」（決定27c）——常に同梱されるが、
 * 機構としては他のモジュールと対等。無いと番頭は職人へ委譲できず D10 が満たせない。
 */

export {
  PiRpcDriver,
  createWorktree,
  removeWorktree,
  type PiRpcDriverOptions,
} from "./pi-rpc-driver.js";
export {
  SpawnLedger,
  isProcessAlive,
  killOrphanProcess,
  type LedgerEntry,
} from "./spawn-ledger.js";
export { WorkerPool, type WorkerPoolOptions, type WorkerInfo, type DelegateInput } from "./pool.js";
export { createWorkerTools } from "./worker-tools.js";
export {
  createWorkerPoolModule,
  workerPoolSkillsDir,
  WORKER_POOL_BASE_URL,
} from "./module.js";
export {
  WorkerPoolService,
  WORKER_POOL_DEFAULT_PORT,
  type WorkerPoolServiceOptions,
} from "./service.js";

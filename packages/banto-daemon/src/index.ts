/**
 * banto-daemon: HTTP API + WebSocket orchestration daemon.
 *
 * Entry point: starts the daemon when run directly.
 * Also exports Daemon for use in tests.
 *
 * Configuration (environment variables or command line):
 *   BANTO_PORT     - HTTP port (default: 4500)
 *   BANTO_DATA_DIR - data directory for event log + registry (default: ./data)
 */

export { Daemon } from "./daemon.js";
export type { DaemonConfig } from "./daemon.js";
export { ProjectRegistry } from "./project-registry.js";
export type { ProjectEntry } from "./project-registry.js";
export { Scheduler } from "./scheduler.js";
export type { TickJob } from "./scheduler.js";
export { KOBO_ORIGIN } from "./daemon.js";
// 決定25・27b: Kobo をモジュールとして番頭ホストへ登録するための定義（task-0064）。
// **実装ではなく契約と到達先**を渡す——Kobo は独立プロセスで、Tool は HTTP 越しに呼ばれる
export {
  createKoboModule,
  createKoboProxyTools,
  defaultKoboUrl,
  koboSkillsDir,
  KOBO_MODULE_NAME,
} from "./kobo-module.js";
export { createKoboTools, taskFilePath, readTaskDefinition } from "./kobo-tools.js";
export { KOBO_MODULE_PATH } from "./http-server.js";
export {
  loadProjectConfig,
  resolveReviewStage,
  PROJECT_CONFIG_PATH,
  DEFAULT_REVIEW_STAGE,
  type ProjectConfig,
  type ReviewStage,
} from "./review-policy.js";
export type { SpawnedSession } from "./daemon.js";
// 決定36h: ワークツリーの作成・削除は repo-manager に寄せた。状態を持たない導出なので
// ライブラリ参照でよい（決定60 の判断基準：台帳を持つ能力だけがモジュール経由）
export { addTaskWorktree, createWorktree, removeWorktree } from "@banto/repo-manager";

// 職人は **Worker Pool** が、検証環境は **Environment Pool** が持つ（ADR-0013 決定60・61）。
// Kobo はどちらも「呼ぶ側」なので、実装も型も再輸出しない——ここから輸出していると
// 「Kobo が持っているもの」に見え、また誰かが Kobo 経由で使い始める

// MergeGate — pre-merge checks (scope violation + verify command execution)
export {
  checkScopeViolations,
  runMergeGate,
} from "./merge-gate.js";
export type {
  ScopeCheckInput,
  ScopeCheckResult,
  VerifyResult,
  MergeGateResult,
  MergeGateOptions,
} from "./merge-gate.js";

// MergeQueue — serial merge processor (S75f66b-5, spec-daemon-core §4.1)
export { deriveQueue, processMergeQueue } from "./merge-queue.js";
export type {
  MergeQueueEntry,
  MergeProcessorOptions,
} from "./merge-queue.js";

// Start daemon when executed directly (not when imported as a module)
// Detect direct execution: argv[1] ends with this file's path.
const _argv1 = process.argv[1] ?? "";
const isMain =
  _argv1.endsWith("/banto-daemon/src/index.ts") ||
  _argv1.endsWith("/banto-daemon/dist/index.js");

if (isMain) {
  const { Daemon: DaemonClass } = await import("./daemon.js");
  const daemon = DaemonClass.create();
  await daemon.start();

  // Graceful shutdown on SIGTERM/SIGINT (systemd sends SIGTERM)
  const shutdown = async () => {
    process.stdout.write("[banto-daemon] shutting down...\n");
    await daemon.stop();
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

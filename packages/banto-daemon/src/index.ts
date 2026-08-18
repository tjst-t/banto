/**
 * banto-daemon: HTTP API + WebSocket orchestration daemon.
 *
 * Entry point: starts the daemon when run directly.
 * Also exports Daemon for use in tests.
 *
 * Configuration (environment variables or command line):
 *   BANTO_PORT     - HTTP port (default: 4500)
 *   BANTO_DATA_DIR - data directory for event log + registry (default: ./data)
 *
 * かつてあった BANTO_PO_TOKEN は廃止した（ADR-0023 決定113）。PO 専用の承認口を
 * 分けるのは合言葉ではなく経路で、出どころは `task_approved.via` に残る。
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
export { createKoboTools } from "./kobo-tools.js";
export { taskFilePath } from "./task-record.js";
// 決定41: 工場も設定画面に区画を出す（役割ごとの職人の当て方。PO裁定 2026-08-10）
export {
  createKoboSettings,
  KOBO_ROLES,
  type KoboRole,
  type RoleAssignment,
  type RoleAssignments,
  type RoleAssignmentStore,
} from "./kobo-settings.js";
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
  isFullSuiteCommand,
} from "./merge-gate.js";
export type {
  ScopeCheckInput,
  ScopeCheckResult,
  VerifyResult,
  MergeGateResult,
  MergeGateOptions,
} from "./merge-gate.js";

// タスクの記録ファイル（`work/tasks/task-NNNN.md`）——第4便で Kobo が書き手になった。
// 採番・書き出し・読み戻しの確認は試験から直に叩けるようにする
export {
  nextTaskNumber,
  assignAcceptanceIds,
  renderTaskRecord,
  checkWritable,
  verifyRoundTrip,
  writeTaskRecord,
  contractPayload,
  contractFromRecord,
  extractTaskBody,
  TASKS_DIR,
} from "./task-record.js";
export type { TaskContractInput, TaskContract, TaskContractAmendment } from "./task-record.js";

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
  const { createFileSettingsSection } = await import("@banto/core");
  const nodePath = await import("node:path");
  // 決定41: 設定画面で決めた役割ごとの当て方は、**次の起動でも効く**。
  // 置き場は工場のデータ置き場（帳簿と同じ場所。借りる相手が居ない独立プロセスなので）
  const dataDir = process.env["BANTO_DATA_DIR"] ?? "./data";
  const daemon = DaemonClass.create({
    roleAssignmentsSection: createFileSettingsSection(
      nodePath.join(dataDir, "kobo-settings.json")
    ),
  });
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

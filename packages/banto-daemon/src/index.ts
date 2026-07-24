/**
 * banto-daemon: HTTP API + WebSocket orchestration daemon.
 *
 * Entry point: starts the daemon when run directly.
 * Also exports Daemon for use in tests.
 *
 * Configuration (environment variables or command line):
 *   BANTO_PORT     - HTTP port (default: 3000)
 *   BANTO_DATA_DIR - data directory for event log + registry (default: ./data)
 */

export { Daemon } from "./daemon.js";
export type { DaemonConfig } from "./daemon.js";
export { ProjectRegistry } from "./project-registry.js";
export type { ProjectEntry } from "./project-registry.js";
export { Scheduler } from "./scheduler.js";
export type { TickJob } from "./scheduler.js";
export { PiRpcDriver, createWorktree, removeWorktree } from "./pi-rpc-driver.js";
export type { PiRpcDriverOptions } from "./pi-rpc-driver.js";
export { SpawnLedger, isProcessAlive, killOrphanProcess } from "./spawn-ledger.js";
export type { LedgerEntry } from "./spawn-ledger.js";

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

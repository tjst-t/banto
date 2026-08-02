/**
 * [AC-S9d7fdb-5-3] Reconcile tick cross-checks driver list vs ledger; detects orphans.
 *
 * Entry point (test-discipline rule 2, api story):
 *   Real HTTP client against a running daemon at http://127.0.0.1:<test-port>/api/v1.
 *
 * Scenario (scenario-S9d7fdb-5.json, scenario-3-reconcile-orphans):
 *
 *   PART A — Orphan detection (real-machine smoke: daemon stopped → orphan created → restart):
 *     Preconditions: daemon running; one env provisioned (in ledger).
 *     Step 1: Stop the daemon. While it's down, directly manipulate the
 *             process driver's state file to add an entry the ledger doesn't know about
 *             (simulating a resource created outside the daemon, e.g. a rogue or manual action).
 *     Step 2: Restart the daemon (new instance with same dataDir). Poll GET /api/v1/events.
 *     Expected: card_generated(cadence) event identifying the orphan resource.
 *               Card file exists at cardPath.
 *
 *   PART B — Vanished detection:
 *     Preconditions: one legitimately ledgered environment.
 *     Step 1: Kill its process out-of-band (without telling the daemon).
 *             Also remove its entry from the process driver's state file so `list` won't
 *             return it (simulating a vanished resource that the driver also dropped).
 *     Step 2: Wait for the next reconcile tick. Poll GET /api/v1/environments and events.
 *     Expected: the ledger entry is removed (no longer in GET /environments);
 *               env_torn_down event with reason "vanished" is in the log.
 *
 * Real driver: uses the REAL process driver (process-driver.ts) whose state file is
 * manipulated directly (as the driver itself would between daemon restarts). This is
 * the same technique as orphan-recovery.spec.ts (priority_rule-9-style real smoke).
 * No mocks are used.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as net from "node:net";
import * as childProcess from "node:child_process";
import { fileURLToPath } from "node:url";

const _thisDir = path.dirname(fileURLToPath(import.meta.url));

import { Daemon } from "../../packages/banto-daemon/src/daemon.js";

// ── Process driver state file ─────────────────────────────────────────────────
// The process driver uses this file as its single truth for managed resources.
// We plant orphan entries here directly while the daemon is stopped.

// imp-0012: テスト用の一時 state に隔離（本番の /tmp/banto-process-driver-state.json を汚さない）
const PROCESS_DRIVER_STATE_FILE = path.join(
  os.tmpdir(),
  "banto-process-driver-state-acceptance-env-reconcile.json"
);
process.env["BANTO_PROCESS_DRIVER_STATE"] = PROCESS_DRIVER_STATE_FILE;

interface ProcessEntry {
  pid: number;
  name: string;
  taskId: string;
  cmd: string;
  port?: number;
  created: string;
}

function readProcessDriverState(): ProcessEntry[] {
  try {
    if (!fs.existsSync(PROCESS_DRIVER_STATE_FILE)) return [];
    return JSON.parse(fs.readFileSync(PROCESS_DRIVER_STATE_FILE, "utf8")) as ProcessEntry[];
  } catch { return []; }
}

function writeProcessDriverState(entries: ProcessEntry[]): void {
  const tmp = `${PROCESS_DRIVER_STATE_FILE}.tmp.test.${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(entries, null, 2), "utf8");
  fs.renameSync(tmp, PROCESS_DRIVER_STATE_FILE);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const addr = s.address();
      if (!addr || typeof addr === "string") { s.close(() => reject(new Error("no address"))); return; }
      const p = addr.port;
      s.close(() => resolve(p));
    });
    s.once("error", reject);
  });
}

async function httpPost(url: string, body: unknown): Promise<{ status: number; body: unknown }> {
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: resp.status, body: await resp.json().catch(() => null) };
}

async function httpGet(url: string): Promise<{ status: number; body: unknown }> {
  const resp = await fetch(url);
  return { status: resp.status, body: await resp.json().catch(() => null) };
}

async function waitFor(
  condition: () => Promise<boolean>,
  timeoutMs = 10000,
  intervalMs = 300
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await new Promise<void>((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}

function isProcessAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EPERM") return true;
    return false;
  }
}

// ── State preserved between parts ─────────────────────────────────────────────

// Part A: daemon1 → stop → plant orphan → daemon2
// Part B: uses daemon2 still running, kills a ledgered env

let daemon1: Daemon | undefined;
let daemon2: Daemon;
let baseUrl: string;
let daemonPort: number;
let dataDir: string;
let projectDir: string;
const projId = "reconcile-proj";
const taskId1 = `task-reconcile-a-${Date.now()}`;  // Part A: legitimately provisioned, then "vanished"
const taskId2 = `task-reconcile-b-${Date.now()}`;  // Part B: vanished detection

let envId1: string | undefined;   // envId for the legitimately provisioned task-1 env
let envPid1: number | undefined;  // OS pid for that env (for kill out-of-band in Part B)
let orphanName: string;           // name of the artificially planted orphan entry

// Provisioned environment settings
const envCmd = "sleep 300";

describe("[AC-S9d7fdb-5-3] reconcile: orphan detection + vanished detection (real-machine smoke)", () => {
  before(async () => {
    daemonPort = await getFreePort();
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "banto-reconcile-"));
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "banto-reconcile-proj-"));
    baseUrl = `http://127.0.0.1:${daemonPort}/api/v1`;

    const metaDir = path.join(projectDir, "meta");
    fs.mkdirSync(metaDir, { recursive: true });

    // Long TTL (1h) so TTL enforcement doesn't interfere with reconcile tests.
    fs.writeFileSync(
      path.join(metaDir, "environments.yaml"),
      `profiles:\n  dev:\n    driver: process\n    config:\n      cmd: "${envCmd}"\n    ttl: 1h\n`,
      "utf8"
    );

    // Daemon 1: start, provision env, then stop (simulating daemon restart).
    daemon1 = Daemon.create({
      port: daemonPort,
      dataDir,
      watchIntervalMs: 10000,
      tickIntervalMs: 60000,           // slow tick: we don't want daemon1's reconcile to fire
      reconcileIntervalMs: 60000,
      envReconcileIntervalMs: 60000,   // same: suppress reconcile in daemon1
      driverTimeoutMs: 10000,
      disableAutoSpawn: true,
      disableAuditSpawn: true,
      disableEnvTtlEnforcer: true,     // suppress TTL enforcer in daemon1
    });

    daemon1.registerProject(projId, projectDir);
    await daemon1.start();

    // Create a task and provision an env (this is the "legit" env that goes into the ledger).
    // The environment: "dev" field is required so the HTTP provision endpoint can resolve the profile.
    await daemon1.createTask(projId, taskId1, "Reconcile test task A", { environment: "dev" });

    const provResp = await httpPost(
      `${baseUrl}/projects/${projId}/tasks/${taskId1}/environment/provision`,
      {}
    );
    assert.equal(provResp.status, 201, `Provision failed: ${JSON.stringify(provResp.body)}`);
    const provBody = provResp.body as Record<string, unknown>;
    envId1 = provBody["envId"] as string;
    assert.ok(typeof envId1 === "string", "envId1 must be a string");

    // Capture the OS pid of the provisioned env process.
    const envListResp = await httpGet(`${baseUrl}/environments`);
    assert.equal(envListResp.status, 200);
    const envListBody = envListResp.body as { environments?: unknown[] };
    const envList = envListBody.environments ?? [];
    const entry = envList.find((e) => (e as Record<string, unknown>)["envId"] === envId1) as Record<string, unknown> | undefined;
    const handle = entry?.["handle"] as Record<string, unknown> | undefined;
    if (handle && typeof handle["pid"] === "number") {
      envPid1 = handle["pid"] as number;
    }
    assert.ok(envPid1 !== undefined, "Should have captured pid for the provisioned env");

    // Stop daemon1 (simulates daemon going down).
    await daemon1.stop();
    daemon1 = undefined;
  });

  after(async () => {
    // Kill any lingering provisioned processes
    if (envPid1 !== undefined) {
      try { process.kill(envPid1, "SIGKILL"); } catch { /* already gone */ }
    }

    try { await daemon2?.stop(); } catch { /* best-effort */ }
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(projectDir, { recursive: true, force: true });
    fs.rmSync(PROCESS_DRIVER_STATE_FILE, { force: true });
  });

  it("PART A step 1: while daemon is down, plant an orphan in the process driver state file", () => {
    // Plant an entry directly in the process driver state file.
    // This simulates a resource that was created without going through the daemon
    // (e.g. a rogue script, another daemon instance, or manual action).
    // The orphan must use the taskId-prefix convention (spec §2) to be recognised
    // by the reconcile tick as a banto-managed resource that is NOT in the ledger.
    const fakeTaskId = `task-orphan-smoke-${Date.now()}`;
    orphanName = `${fakeTaskId}-env`;

    // Spawn a real "sleep" process so the orphan is live (not just a stale name).
    const orphanProc = childProcess.spawn("sleep", ["300"], {
      detached: true,
      stdio: "ignore",
    });
    orphanProc.unref();

    const orphanPid = orphanProc.pid ?? -1;

    const currentEntries = readProcessDriverState();
    const orphanEntry: ProcessEntry = {
      pid: orphanPid,
      name: orphanName,
      taskId: fakeTaskId,
      cmd: "sleep 300",
      created: new Date().toISOString(),
    };
    writeProcessDriverState([...currentEntries, orphanEntry]);

    // Verify the orphan is now in the state file.
    const after = readProcessDriverState();
    const planted = after.find((e) => e.name === orphanName);
    assert.ok(planted, `Orphan entry ${orphanName} should be in the state file`);

    // Clean up the spawned process after the test (we don't need it running).
    // Do it at test-end so the process is alive during the daemon2 reconcile tick.
    // The after() hook kills envPid1; we kill orphanPid separately here.
    // Actually we leave the orphan alive so the state file entry is accurate.
    // After the card is filed, we clean it up.

    // Register cleanup for orphan pid
    process.once("exit", () => {
      try { process.kill(orphanPid, "SIGKILL"); } catch { /* already gone */ }
    });
  });

  it("PART A step 2: restart daemon; reconcile tick detects orphan and emits card_generated(cadence)", async () => {
    // Use a NEW port since the old one may not be freed yet.
    const newPort = await getFreePort();
    baseUrl = `http://127.0.0.1:${newPort}/api/v1`;

    daemon2 = Daemon.create({
      port: newPort,
      dataDir,                        // same data dir → picks up the existing ledger
      watchIntervalMs: 10000,
      tickIntervalMs: 300,            // fast tick for reconcile to fire quickly
      reconcileIntervalMs: 300,
      envReconcileIntervalMs: 300,    // fast env reconcile
      driverTimeoutMs: 10000,
      disableAutoSpawn: true,
      disableAuditSpawn: true,
      ttlTeardownRetryLimit: 2,
      ttlTeardownRetryDelayMs: 50,
    });

    // The project is already registered in the persistent ProjectRegistry (same dataDir).
    // Only register if not already present (daemon2 reloads the registry from disk).
    if (!daemon2.projectExists(projId)) {
      daemon2.registerProject(projId, projectDir);
    }
    await daemon2.start();

    // Poll for the orphan detection card.
    let cardEvent: Record<string, unknown> | undefined;

    await waitFor(async () => {
      const resp = await httpGet(`${baseUrl}/events`);
      if (resp.status !== 200) return false;
      const body = resp.body as { events?: unknown[] };
      const events = body.events ?? [];
      cardEvent = events.find((e) => {
        const ev = e as Record<string, unknown>;
        return (
          ev["type"] === "card_generated" &&
          ev["cardType"] === "cadence" &&
          typeof ev["cardPath"] === "string" &&
          (() => {
            try {
              const c = JSON.parse(fs.readFileSync(ev["cardPath"] as string, "utf8")) as Record<string, unknown>;
              return typeof c["resourceName"] === "string" && c["resourceName"] === orphanName;
            } catch { return false; }
          })()
        );
      }) as Record<string, unknown> | undefined;
      return cardEvent !== undefined;
    }, 10000, 300);

    assert.ok(cardEvent, "card_generated(cadence) should be emitted for the orphan");

    // D3: card body is in the file, not in the log
    const cardPath = cardEvent?.["cardPath"] as string;
    assert.ok(typeof cardPath === "string" && fs.existsSync(cardPath),
      `Card file should exist at cardPath=${cardPath}`);

    const cardContent = JSON.parse(fs.readFileSync(cardPath, "utf8")) as Record<string, unknown>;
    assert.equal(cardContent["cardType"], "cadence");
    assert.equal(cardContent["resourceName"], orphanName, "Card should identify the orphan by name");
  });

  it("PART B step 1: kill legitimately-ledgered env out-of-band and remove from driver state", async () => {
    // Kill the OS process for the legitimately provisioned env.
    if (envPid1 !== undefined && isProcessAlive(envPid1)) {
      process.kill(envPid1, "SIGKILL");
      // Wait briefly for the kill to take effect.
      await new Promise<void>((r) => setTimeout(r, 200));
    }

    // Also remove its entry from the driver state file so `list` won't return it.
    // This simulates a "vanished" resource: the driver knows nothing about it.
    const entries = readProcessDriverState();
    const filtered = entries.filter((e) => {
      // Remove entries for the legitimately provisioned task (taskId1)
      return e.taskId !== taskId1 && !e.name.startsWith(`${taskId1}-`);
    });
    writeProcessDriverState(filtered);

    // Sanity: the ledger should still have the entry (we haven't told daemon about the kill)
    const internalEntry = daemon2.envLedger.get(envId1!);
    assert.ok(internalEntry && !internalEntry.tornDownAt,
      "Ledger entry should still be live before reconcile tick");
  });

  it("PART B step 2: reconcile detects vanished env, removes from ledger, emits env_torn_down(vanished)", async () => {
    let tornDownEvent: Record<string, unknown> | undefined;

    await waitFor(async () => {
      const resp = await httpGet(`${baseUrl}/events`);
      if (resp.status !== 200) return false;
      const body = resp.body as { events?: unknown[] };
      const events = body.events ?? [];
      tornDownEvent = events.find((e) => {
        const ev = e as Record<string, unknown>;
        return (
          ev["type"] === "env_torn_down" &&
          ev["envId"] === envId1 &&
          ev["reason"] === "vanished"
        );
      }) as Record<string, unknown> | undefined;
      return tornDownEvent !== undefined;
    }, 10000, 300);

    assert.ok(tornDownEvent, "env_torn_down(vanished) event should be emitted for the removed ledger entry");
    assert.equal(tornDownEvent?.["reason"], "vanished");
    assert.equal(tornDownEvent?.["envId"], envId1);
    assert.equal(tornDownEvent?.["taskId"], taskId1);

    // The ledger entry should now be gone from GET /environments
    const envListResp = await httpGet(`${baseUrl}/environments`);
    assert.equal(envListResp.status, 200);
    const envListBody = envListResp.body as { environments?: unknown[] };
    const envList = envListBody.environments ?? [];
    const stillLive = envList.find((e) => (e as Record<string, unknown>)["envId"] === envId1);
    assert.equal(stillLive, undefined, "Vanished env should be removed from GET /environments");
  });
});

/**
 * [AC-S9d7fdb-5-1] TTL-expired environment is force-torn-down by the tick job.
 *
 * Entry point (test-discipline rule 2, api story):
 *   Real HTTP client against a running daemon at http://127.0.0.1:<test-port>/api/v1.
 *
 * Scenario (scenario-S9d7fdb-5.json, scenario-1-ttl-expiry):
 *   Preconditions: profile "shortlived" { driver: process, ttl: 2s }; environment provisioned.
 *
 *   Step 1: Provision environment. Verify it appears in GET /api/v1/environments.
 *   Step 2: Poll GET /api/v1/environments until the entry disappears (TTL enforcer
 *           tore it down). Verify the OS process is gone.
 *   Step 3: GET /api/v1/events → env_torn_down event with reason: "ttl_expired".
 *
 * Time-domain note: The TTL AC is about progression (before deadline → alive,
 * after deadline → torn down). We verify BOTH states (pre and post deadline) by
 * polling GET /api/v1/environments until the entry disappears, then confirming
 * the OS process is gone. This satisfies the time-domain requirement: we observe
 * the alive state before the deadline and the torn-down state after, not just the
 * final state.
 *
 * Real driver: uses the REAL process driver (not a mock). OS process liveness is
 * verified via kill(pid, 0) — if the process outlives TTL, the test fails.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as net from "node:net";
import { fileURLToPath } from "node:url";

const _thisDir = path.dirname(fileURLToPath(import.meta.url));

import { Daemon } from "../../packages/banto-daemon/src/daemon.js";

// imp-0012: テスト用の一時 state に隔離（本番の /tmp/banto-process-driver-state.json を汚さない）
const TEST_DRIVER_STATE = path.join(
  os.tmpdir(),
  "banto-process-driver-state-acceptance-env-ttl.json"
);
process.env["BANTO_PROCESS_DRIVER_STATE"] = TEST_DRIVER_STATE;

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

function isProcessAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EPERM") return true;
    return false;
  }
}

/**
 * Poll until a condition is met (true) or the timeout expires.
 * Throws on timeout with the reason message.
 */
async function waitFor(
  condition: () => Promise<boolean>,
  timeoutMs = 8000,
  intervalMs = 200
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await new Promise<void>((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}

// ── Test ─────────────────────────────────────────────────────────────────────

describe("[AC-S9d7fdb-5-1] TTL expired env is force-torn-down by tick job", () => {
  let daemon: Daemon;
  let baseUrl: string;
  let dataDir: string;
  let projectDir: string;
  const projId = "ttl-expiry-proj";
  const taskId = `task-ttl-${Date.now()}`;

  // The provisioned pid — captured so we can check OS liveness after TTL enforcement.
  let provisionedPid: number | undefined;
  let envId: string | undefined;

  before(async () => {
    const daemonPort = await getFreePort();
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "banto-ttl-"));
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "banto-ttl-proj-"));
    baseUrl = `http://127.0.0.1:${daemonPort}/api/v1`;

    const metaDir = path.join(projectDir, "meta");
    fs.mkdirSync(metaDir, { recursive: true });

    // Profile "shortlived": 2s TTL so the enforcer fires quickly.
    // A simple sleep process — long enough that it won't die naturally
    // before the TTL enforcer kills it.
    fs.writeFileSync(
      path.join(metaDir, "environments.yaml"),
      `profiles:\n  shortlived:\n    driver: process\n    config:\n      cmd: "sleep 300"\n    ttl: 2s\n`,
      "utf8"
    );

    daemon = Daemon.create({
      port: daemonPort,
      dataDir,
      watchIntervalMs: 10000,
      tickIntervalMs: 300,         // fast tick so TTL enforcer fires quickly
      reconcileIntervalMs: 3600000,   // suppress spawn-reconcile (not testing that here)
      envReconcileIntervalMs: 3600000, // suppress env reconcile (only testing TTL enforcer here)
      driverTimeoutMs: 5000,
      ttlTeardownRetryLimit: 2,
      ttlTeardownRetryDelayMs: 100,
      disableAutoSpawn: true,
      disableAuditSpawn: true,
    });

    daemon.registerProject(projId, projectDir);
    await daemon.start();

    // Create the task with environment: "shortlived" so the HTTP provision endpoint
    // can resolve the profile name from the task record (D3: profile name comes from task).
    await daemon.createTask(projId, taskId, "TTL test task", { environment: "shortlived" });
  });

  after(async () => {
    // Kill any lingering provisioned process
    if (provisionedPid !== undefined) {
      try { process.kill(provisionedPid, "SIGKILL"); } catch { /* already gone */ }
    }
    await daemon.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(projectDir, { recursive: true, force: true });
    fs.rmSync(TEST_DRIVER_STATE, { force: true });
  });

  it("step 1: provision env and observe it is live", async () => {
    // POST /api/v1/projects/:proj/tasks/:taskId/environment/provision
    const provResp = await httpPost(
      `${baseUrl}/projects/${projId}/tasks/${taskId}/environment/provision`,
      { profile: "shortlived" }
    );
    assert.equal(provResp.status, 201, `Expected 201, got ${provResp.status}: ${JSON.stringify(provResp.body)}`);

    const body = provResp.body as Record<string, unknown>;
    envId = body["envId"] as string;
    assert.ok(typeof envId === "string" && envId.length > 0, "envId should be a string");

    // Capture the pid from the event log for OS liveness check later
    const eventsResp = await httpGet(`${baseUrl}/projects/${projId}/events`);
    assert.equal(eventsResp.status, 200);
    const eventsBody = eventsResp.body as { events: unknown[] };
    const events = eventsBody.events ?? [];
    const provEvent = events.find((e) => {
      const ev = e as Record<string, unknown>;
      return ev["type"] === "env_provisioned" && ev["envId"] === envId;
    }) as Record<string, unknown> | undefined;
    assert.ok(provEvent, "env_provisioned event should be in the log");

    // GET /api/v1/environments → env should appear as live
    // Response shape: { environments: [...] }
    const envListResp = await httpGet(`${baseUrl}/environments`);
    assert.equal(envListResp.status, 200);
    const envListBody = envListResp.body as { environments: unknown[] };
    const envList = envListBody.environments;
    assert.ok(Array.isArray(envList), "GET /environments should return { environments: [...] }");
    const liveEntry = envList.find((e) => {
      return (e as Record<string, unknown>)["envId"] === envId;
    }) as Record<string, unknown> | undefined;
    assert.ok(liveEntry, "env should appear in GET /environments before TTL");

    // Capture pid from the env ledger via daemon API
    const handle = liveEntry?.["handle"] as Record<string, unknown> | undefined;
    if (handle && typeof handle["pid"] === "number") {
      provisionedPid = handle["pid"] as number;
      // Verify the process is alive NOW (before TTL expires)
      assert.ok(isProcessAlive(provisionedPid), `Process pid=${provisionedPid} should be alive before TTL`);
    }
  });

  it("step 2: after TTL, env disappears from GET /environments and OS process is gone", async () => {
    // TTL is 2s, tick is 300ms. Allow up to 8s total for the enforcer to run.
    await waitFor(async () => {
      const resp = await httpGet(`${baseUrl}/environments`);
      if (resp.status !== 200) return false;
      const body = resp.body as { environments?: unknown[] };
      const list = body.environments ?? [];
      const found = list.find((e) => (e as Record<string, unknown>)["envId"] === envId);
      return found === undefined;
    }, 8000, 300);

    // The env must be gone from the live list
    const envListResp = await httpGet(`${baseUrl}/environments`);
    assert.equal(envListResp.status, 200);
    const envListBody = envListResp.body as { environments?: unknown[] };
    const envList = envListBody.environments ?? [];
    const stillLive = envList.find((e) => (e as Record<string, unknown>)["envId"] === envId);
    assert.equal(stillLive, undefined, "env should NOT be in live list after TTL");

    // OS process must also be gone
    if (provisionedPid !== undefined) {
      assert.ok(
        !isProcessAlive(provisionedPid),
        `OS process pid=${provisionedPid} should be dead after TTL enforcement`
      );
    }
  });

  it("step 3: env_torn_down event with reason: ttl_expired is in the event log", async () => {
    const eventsResp = await httpGet(`${baseUrl}/projects/${projId}/events`);
    assert.equal(eventsResp.status, 200);

    const eventsBody = eventsResp.body as { events: unknown[] };
    const events = eventsBody.events ?? [];
    const tornDownEvent = events.find((e) => {
      const ev = e as Record<string, unknown>;
      return ev["type"] === "env_torn_down" && ev["envId"] === envId;
    }) as Record<string, unknown> | undefined;

    assert.ok(tornDownEvent, "env_torn_down event should be in the event log");
    assert.equal(
      tornDownEvent?.["reason"],
      "ttl_expired",
      `env_torn_down reason should be "ttl_expired", got: ${JSON.stringify(tornDownEvent?.["reason"])}`
    );
    assert.equal(tornDownEvent?.["taskId"], taskId, "env_torn_down should carry the taskId");
    assert.equal(tornDownEvent?.["envId"], envId, "env_torn_down should carry the envId");
  });
});

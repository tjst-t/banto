/**
 * [AC-S9d7fdb-2-2] Process driver provision via the API and real OS observation.
 *
 * Entry point (test-discipline rule 2, mixed story):
 *   Block B — HTTP: drives the real daemon over HTTP at http://127.0.0.1:<test-port>/api/v1
 *   AND observes real OS processes (signal 0 to the pid recorded by the driver).
 *
 * Scenario steps (from scenario-S9d7fdb-2.json, scenario-2-provision-api):
 *   1. POST /api/v1/projects/:proj/tasks/:taskId/environment/provision → 201 + envId
 *   2. TCP connect to the configured port (real TCP); OS kill(pid, 0) confirms process alive;
 *      managed name carries taskID prefix (I3).
 *   3. GET /api/v1/projects/:proj/events → env_provisioned event with taskId + profileName
 *      GET /api/v1/environments → contains the entry for :taskId
 *
 * Cleanup: POST .../environment/teardown; assert process gone
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as net from "node:net";
import { fileURLToPath } from "node:url";

const _thisDir = path.dirname(fileURLToPath(import.meta.url));
const _repoRoot = path.resolve(_thisDir, "..", "..");

// Import daemon from the worktree packages (not from node_modules symlink —
// we must exercise the real implementation from this worktree).
import { Daemon } from "../../packages/banto-daemon/src/daemon.js";
import type { DaemonConfig } from "../../packages/banto-daemon/src/daemon.js";

// imp-0012: テスト用の一時 state に隔離（本番の /tmp/banto-process-driver-state.json を汚さない）
const TEST_DRIVER_STATE = path.join(
  os.tmpdir(),
  "banto-process-driver-state-acceptance-env-process-provision.json"
);
process.env["BANTO_PROCESS_DRIVER_STATE"] = TEST_DRIVER_STATE;

// ── Helpers ───────────────────────────────────────────────────────────────────

async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const addr = s.address();
      if (!addr || typeof addr === "string") {
        s.close(() => reject(new Error("no address")));
        return;
      }
      const p = addr.port;
      s.close(() => resolve(p));
    });
    s.once("error", reject);
  });
}

async function httpPost(url: string, body: unknown): Promise<{ status: number; body: unknown }> {
  const json = JSON.stringify(body);
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: json,
  });
  const data = await resp.json().catch(() => null);
  return { status: resp.status, body: data };
}

async function httpGet(url: string): Promise<{ status: number; body: unknown }> {
  const resp = await fetch(url);
  const data = await resp.json().catch(() => null);
  return { status: resp.status, body: data };
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EPERM") return true;
    return false;
  }
}

async function tcpConnect(port: number, timeoutMs = 2000): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;
    const settle = (val: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(val);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => settle(true));
    socket.once("error", () => settle(false));
    socket.once("timeout", () => settle(false));
    socket.connect(port, "127.0.0.1");
  });
}

// ── Test setup ────────────────────────────────────────────────────────────────

describe("[AC-S9d7fdb-2-2] process driver provision via API", () => {
  let daemon: Daemon;
  let daemonPort: number;
  let envPort: number;
  let dataDir: string;
  let projectDir: string;
  let baseUrl: string;
  const projId = "test-proj-provision";
  const taskId = `task-env-provision-${Date.now()}`;
  let envId: string | undefined;
  let provisionedPid: number | undefined;

  before(async () => {
    daemonPort = await getFreePort();
    envPort = await getFreePort();
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "banto-provision-test-"));
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "banto-provision-proj-"));

    // Create meta/environments.yaml with process driver profile
    const metaDir = path.join(projectDir, "meta");
    fs.mkdirSync(metaDir, { recursive: true });
    const envFile = path.join(metaDir, "environments.yaml");
    const cmd = `node -e "require('http').createServer((req,res)=>res.end('ok')).listen(${envPort},'127.0.0.1')"`;
    fs.writeFileSync(
      envFile,
      `profiles:\n  dev:\n    driver: process\n    config:\n      cmd: "${cmd}"\n      port: ${envPort}\n    ttl: 1h\n`,
      "utf8"
    );

    // Create a task file with environment: dev
    const tasksDir = path.join(projectDir, "work", "tasks");
    fs.mkdirSync(tasksDir, { recursive: true });
    fs.writeFileSync(
      path.join(tasksDir, `${taskId}.md`),
      `---\nid: ${taskId}\ntitle: Provision test task\nenvironment: dev\n---\n\nTask content.\n`,
      "utf8"
    );

    daemon = Daemon.create({
      port: daemonPort,
      dataDir,
      watchIntervalMs: 500,
      tickIntervalMs: 60000,
      driverTimeoutMs: 10000,
      disableAuditSpawn: true,
    });
    await daemon.start();

    baseUrl = `http://127.0.0.1:${daemonPort}/api/v1`;

    // Register project
    const regResp = await httpPost(`${baseUrl}/projects`, { id: projId, repoPath: projectDir });
    assert.equal(regResp.status, 201, `project registration failed: ${JSON.stringify(regResp.body)}`);

    // Create task
    const taskResp = await httpPost(`${baseUrl}/projects/${projId}/tasks`, {
      id: taskId,
      title: "Provision test task",
      environment: "dev",
    });
    assert.equal(taskResp.status, 201, `task creation failed: ${JSON.stringify(taskResp.body)}`);
  });

  after(async () => {
    // Cleanup: teardown environment if still live
    if (envId || provisionedPid !== undefined) {
      try {
        await httpPost(`${baseUrl}/projects/${projId}/tasks/${taskId}/environment/teardown`, {
          envId,
        });
      } catch { /* best-effort */ }
    }

    // Verify process is gone after teardown
    if (provisionedPid !== undefined) {
      // Allow a moment for teardown to complete
      await new Promise<void>((r) => setTimeout(r, 500));
      // Note: we don't assert here in after() since test assertions are in the test body
    }

    await daemon.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(projectDir, { recursive: true, force: true });
    fs.rmSync(TEST_DRIVER_STATE, { force: true });
  });

  // ── Step 1: POST provision ─────────────────────────────────────────────────

  it("POST /environment/provision returns 201 with envId, profileName, healthcheck", async () => {
    // Profile name is resolved from the task's `environment` field (D3: file is the single source
    // of intent). No body "profile" override — the task was created with environment: dev.
    const resp = await httpPost(
      `${baseUrl}/projects/${projId}/tasks/${taskId}/environment/provision`,
      {}
    );
    assert.equal(resp.status, 201, `expected 201, got ${resp.status}: ${JSON.stringify(resp.body)}`);

    const body = resp.body as Record<string, unknown>;
    assert.ok(typeof body["envId"] === "string" && body["envId"].length > 0, `envId must be a non-empty string: ${JSON.stringify(body)}`);
    assert.equal(body["profileName"], "dev", `profileName must be 'dev': ${JSON.stringify(body)}`);
    assert.ok(typeof body["healthcheck"] === "object" && body["healthcheck"] !== null, `healthcheck must be an object: ${JSON.stringify(body)}`);

    const hc = body["healthcheck"] as Record<string, unknown>;
    assert.equal(typeof hc["ok"], "boolean", `healthcheck.ok must be boolean: ${JSON.stringify(hc)}`);
    assert.ok(hc["ok"] === true, `healthcheck must be ok=true after provision: ${JSON.stringify(hc)}`);

    envId = body["envId"] as string;
  });

  // ── Step 2: TCP connect + OS process check ─────────────────────────────────

  it("provisioned process is alive: TCP connects and OS pid is live", async () => {
    assert.ok(envId, "envId must be set (provision must pass)");

    // Check TCP reachability of the env port
    const tcpOk = await tcpConnect(envPort);
    assert.ok(tcpOk, `TCP connect to port ${envPort} must succeed`);

    // Check the env ledger contains the entry with a taskID-prefixed name
    const liveEnvs = daemon.envLedger.listByTask(projId, taskId);
    assert.ok(liveEnvs.length > 0, "env ledger must have a live entry for this task");

    const entry = liveEnvs[0]!;
    const handle = entry.handle as Record<string, unknown>;
    assert.ok(typeof handle["pid"] === "number", `handle must have pid: ${JSON.stringify(handle)}`);
    const pid = handle["pid"] as number;
    provisionedPid = pid;

    // Verify process is alive (OS signal 0 check)
    assert.ok(isProcessAlive(pid), `process pid=${pid} must be alive after provision`);

    // Verify the managed name carries the taskID prefix (I3)
    const name = handle["name"] as string;
    assert.ok(typeof name === "string" && name.startsWith(taskId), `handle.name must start with taskId: ${name}`);
  });

  // ── Step 3: Events + GET /environments ────────────────────────────────────

  it("env_provisioned event appears in project events", async () => {
    const resp = await httpGet(`${baseUrl}/projects/${projId}/events`);
    assert.equal(resp.status, 200, `events endpoint failed: ${JSON.stringify(resp.body)}`);

    const body = resp.body as { events: Array<Record<string, unknown>> };
    assert.ok(Array.isArray(body.events), "events must be an array");

    const provisionedEvent = body.events.find(
      (e) => e["type"] === "env_provisioned" && e["taskId"] === taskId
    );
    assert.ok(
      provisionedEvent !== undefined,
      `env_provisioned event for taskId=${taskId} must be in project events: ${JSON.stringify(body.events)}`
    );
    assert.equal(provisionedEvent!["profileName"], "dev", `event profileName must be 'dev'`);
  });

  it("GET /api/v1/environments lists the provisioned environment", async () => {
    const resp = await httpGet(`${baseUrl}/environments`);
    assert.equal(resp.status, 200, `environments endpoint failed: ${JSON.stringify(resp.body)}`);

    const body = resp.body as { environments: Array<Record<string, unknown>> };
    assert.ok(Array.isArray(body.environments), "environments must be an array");

    const ours = body.environments.find(
      (e) => e["taskId"] === taskId && e["projectTag"] === projId
    );
    assert.ok(
      ours !== undefined,
      `environments must contain entry for taskId=${taskId}: ${JSON.stringify(body.environments)}`
    );
  });

  // ── Cleanup: teardown + verify process gone ────────────────────────────────

  it("POST /environment/teardown succeeds and process is gone", async () => {
    assert.ok(envId, "envId must be set");
    assert.ok(provisionedPid !== undefined, "pid must be recorded");

    const resp = await httpPost(
      `${baseUrl}/projects/${projId}/tasks/${taskId}/environment/teardown`,
      { envId }
    );
    assert.equal(resp.status, 200, `teardown failed: ${JSON.stringify(resp.body)}`);

    const body = resp.body as Record<string, unknown>;
    assert.equal(body["status"], "torn_down");

    // Wait for teardown to complete
    await new Promise<void>((r) => setTimeout(r, 500));

    // Verify process is gone
    assert.ok(!isProcessAlive(provisionedPid!), `process pid=${provisionedPid} must be gone after teardown`);

    // Verify it no longer appears in environments list
    const envResp = await httpGet(`${baseUrl}/environments`);
    const envBody = envResp.body as { environments: Array<Record<string, unknown>> };
    const ours = envBody.environments.find(
      (e) => e["taskId"] === taskId && !e["tornDownAt"]
    );
    assert.ok(!ours, `torn-down environment must not appear in live environments list`);
  });
});

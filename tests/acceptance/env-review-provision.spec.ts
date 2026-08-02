/**
 * [AC-S9d7fdb-7-1] Auto-provision on in-review transition.
 *
 * Entry point (test-discipline rule 2, mixed story — Block A):
 *   Real HTTP client against a running daemon.
 *
 * Scenario (scenario-S9d7fdb-7.json, scenario-1-auto-provision-on-review):
 *   Preconditions: task R with environment: dev (process profile) in review-ready state;
 *                  task N WITHOUT environment: field in review-ready state.
 *
 *   Step 1: POST /api/v1/projects/:proj/tasks/:taskR/transition {to: 'in-review'}
 *           → 200; transition succeeds
 *   Step 2: poll GET /api/v1/projects/:proj/events
 *           → env_provisioned event for task R with profile 'dev'
 *           GET /api/v1/environments → list shows task R's environment
 *           TCP connect to the configured port confirms the dev server is really running
 *   Step 3: POST /transition {to: 'in-review'} for task N
 *           → transition succeeds; NO env_provisioned/env_provision_failed event for task N
 *   Cleanup: teardown task R environment
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

import { Daemon } from "../../packages/banto-daemon/src/daemon.js";

// imp-0012: テスト用の一時 state に隔離（本番の /tmp/banto-process-driver-state.json を汚さない）
const TEST_DRIVER_STATE = path.join(
  os.tmpdir(),
  "banto-process-driver-state-acceptance-env-review-provision.json"
);
process.env["BANTO_PROCESS_DRIVER_STATE"] = TEST_DRIVER_STATE;

after(() => {
  fs.rmSync(TEST_DRIVER_STATE, { force: true });
});

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
  timeoutMs = 8000,
  intervalMs = 150
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await new Promise<void>((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms`);
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

// Drive a task to review-ready through the minimal transition chain:
// draft → queued → (gate may auto-→ready) → planning → implementing → auditing → review-ready
// (disableAuditSpawn is true so auditing doesn't try to spawn a real pi session)
async function driveToReviewReady(
  baseUrl: string,
  projId: string,
  taskId: string
): Promise<void> {
  // Step 1: draft→queued
  let r = await httpPost(`${baseUrl}/projects/${projId}/tasks/${taskId}/transition`, {
    to: "queued",
    reason: "test_drive_to_review_ready",
  });
  assert.equal(r.status, 200, `transition to queued failed: ${JSON.stringify(r.body)}`);

  // Step 2: The gate evaluator may auto-promote queued→ready; check current status
  const taskResp = await httpGet(`${baseUrl}/projects/${projId}/tasks/${taskId}`);
  const taskData = ((taskResp.body as Record<string, unknown>)["task"] as Record<string, unknown>);
  if (taskData["status"] !== "ready") {
    r = await httpPost(`${baseUrl}/projects/${projId}/tasks/${taskId}/transition`, {
      to: "ready",
      reason: "test_drive_to_review_ready",
    });
    assert.equal(r.status, 200, `transition to ready failed: ${JSON.stringify(r.body)}`);
  }

  // Step 3: Drive the rest of the chain
  for (const to of ["planning", "implementing", "auditing", "review-ready"]) {
    r = await httpPost(`${baseUrl}/projects/${projId}/tasks/${taskId}/transition`, {
      to,
      reason: "test_drive_to_review_ready",
    });
    assert.equal(r.status, 200, `transition to ${to} failed: ${JSON.stringify(r.body)}`);
  }
}

// ── Test setup ────────────────────────────────────────────────────────────────

describe("[AC-S9d7fdb-7-1] auto-provision on in-review transition", () => {
  let daemon: Daemon;
  let daemonPort: number;
  let envPort: number;
  let dataDir: string;
  let projectDir: string;
  let baseUrl: string;
  const projId = `rev-prov-${Date.now()}`;
  const taskR = `task-review-env-${Date.now()}`;
  const taskN = `task-review-noenv-${Date.now()}`;
  let envId: string | undefined;

  before(async () => {
    daemonPort = await getFreePort();
    envPort = await getFreePort();
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "banto-review-prov-test-"));
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "banto-review-prov-proj-"));

    // Create meta/environments.yaml with a process driver profile "dev"
    const metaDir = path.join(projectDir, "meta");
    fs.mkdirSync(metaDir, { recursive: true });
    const cmd = `node -e "require('http').createServer((req,res)=>res.end('ok')).listen(${envPort},'127.0.0.1')"`;
    fs.writeFileSync(
      path.join(metaDir, "environments.yaml"),
      `profiles:\n  dev:\n    driver: process\n    config:\n      cmd: "${cmd}"\n      port: ${envPort}\n    ttl: 1h\n`,
      "utf8"
    );

    // Create task R with environment: dev
    const tasksDir = path.join(projectDir, "work", "tasks");
    fs.mkdirSync(tasksDir, { recursive: true });
    fs.writeFileSync(
      path.join(tasksDir, `${taskR}.md`),
      `---\nid: ${taskR}\ntitle: Review provision test (has env)\nenvironment: dev\n---\nContent.\n`,
      "utf8"
    );
    // Create task N without environment
    fs.writeFileSync(
      path.join(tasksDir, `${taskN}.md`),
      `---\nid: ${taskN}\ntitle: Review provision test (no env)\n---\nContent.\n`,
      "utf8"
    );

    daemon = Daemon.create({
      port: daemonPort,
      dataDir,
      watchIntervalMs: 500,
      tickIntervalMs: 60000,
      driverTimeoutMs: 10000,
      disableAuditSpawn: true,
      disableAutoSpawn: true,
      // No tmuxSession: unset → tmux-less; pane skip events expected for tmux part
    });
    await daemon.start();

    baseUrl = `http://127.0.0.1:${daemonPort}/api/v1`;

    // Register project
    const regResp = await httpPost(`${baseUrl}/projects`, { id: projId, repoPath: projectDir });
    assert.equal(regResp.status, 201, `project registration failed: ${JSON.stringify(regResp.body)}`);

    // Create both tasks via API
    const rResp = await httpPost(`${baseUrl}/projects/${projId}/tasks`, {
      id: taskR, title: "Review provision test (has env)", environment: "dev",
    });
    assert.equal(rResp.status, 201, `task R creation failed: ${JSON.stringify(rResp.body)}`);

    const nResp = await httpPost(`${baseUrl}/projects/${projId}/tasks`, {
      id: taskN, title: "Review provision test (no env)",
    });
    assert.equal(nResp.status, 201, `task N creation failed: ${JSON.stringify(nResp.body)}`);

    // Drive both tasks to review-ready
    await driveToReviewReady(baseUrl, projId, taskR);
    await driveToReviewReady(baseUrl, projId, taskN);
  });

  after(async () => {
    // Cleanup: teardown environment if provisioned
    if (envId) {
      try {
        await httpPost(`${baseUrl}/projects/${projId}/tasks/${taskR}/environment/teardown`, {
          envId,
        });
      } catch { /* best-effort */ }
    }
    await daemon.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(projectDir, { recursive: true, force: true });
    fs.rmSync(TEST_DRIVER_STATE, { force: true });
  });

  // ── Step 1: Transition task R to in-review ────────────────────────────────

  it("Step 1: POST transition to in-review succeeds (200) for task with environment", async () => {
    const resp = await httpPost(
      `${baseUrl}/projects/${projId}/tasks/${taskR}/transition`,
      { to: "in-review" }
    );
    assert.equal(
      resp.status,
      200,
      `transition to in-review must succeed with 200: ${JSON.stringify(resp.body)}`
    );
  });

  // ── Step 2: env_provisioned event and environments list ───────────────────

  it("Step 2a: env_provisioned event appears for task R after in-review transition", async () => {
    // Wait for the async auto-provision to complete
    await waitFor(async () => {
      const resp = await httpGet(`${baseUrl}/projects/${projId}/events`);
      const body = resp.body as { events: Array<Record<string, unknown>> };
      return body.events.some(
        (e) => e["type"] === "env_provisioned" && e["taskId"] === taskR
      );
    }, 10000);

    const resp = await httpGet(`${baseUrl}/projects/${projId}/events`);
    const body = resp.body as { events: Array<Record<string, unknown>> };
    const ev = body.events.find(
      (e) => e["type"] === "env_provisioned" && e["taskId"] === taskR
    );
    assert.ok(ev, `env_provisioned event for taskR must be present: ${JSON.stringify(body.events.map((e) => e["type"]))}`);
    assert.equal(ev!["profileName"], "dev", `event profileName must be 'dev'`);
  });

  it("Step 2b: GET /environments shows task R's environment", async () => {
    // Wait for provision to appear in the ledger
    await waitFor(async () => {
      const resp = await httpGet(`${baseUrl}/environments`);
      const body = resp.body as { environments: Array<Record<string, unknown>> };
      return body.environments.some(
        (e) => e["taskId"] === taskR && !e["tornDownAt"]
      );
    }, 8000);

    const resp = await httpGet(`${baseUrl}/environments`);
    const body = resp.body as { environments: Array<Record<string, unknown>> };
    const entry = body.environments.find(
      (e) => e["taskId"] === taskR && !e["tornDownAt"]
    );
    assert.ok(entry, `environments must list task R's provisioned environment: ${JSON.stringify(body.environments)}`);
    assert.equal(entry!["profileName"], "dev", `entry profileName must be 'dev'`);
    envId = entry!["envId"] as string;
  });

  it("Step 2c: dev server process is really running (TCP connect to env port)", async () => {
    // The process driver starts a real server on envPort
    const tcpOk = await tcpConnect(envPort, 3000);
    assert.ok(tcpOk, `TCP connect to env port ${envPort} must succeed — dev server must be running`);
  });

  // ── Step 3: Task N (no environment field) — no provision events ───────────

  it("Step 3a: POST transition to in-review succeeds for task N (no environment)", async () => {
    const resp = await httpPost(
      `${baseUrl}/projects/${projId}/tasks/${taskN}/transition`,
      { to: "in-review" }
    );
    assert.equal(
      resp.status,
      200,
      `transition to in-review for task N must succeed: ${JSON.stringify(resp.body)}`
    );
  });

  it("Step 3b: no env_provisioned/env_provision_failed event for task N", async () => {
    // Wait a moment for any async events that might have been triggered
    await new Promise<void>((r) => setTimeout(r, 800));

    const resp = await httpGet(`${baseUrl}/projects/${projId}/events`);
    const body = resp.body as { events: Array<Record<string, unknown>> };

    // No provision events for task N
    const provisionedForN = body.events.find(
      (e) => e["type"] === "env_provisioned" && e["taskId"] === taskN
    );
    const failedForN = body.events.find(
      (e) => e["type"] === "env_provision_failed" && e["taskId"] === taskN
    );
    assert.ok(
      !provisionedForN,
      `env_provisioned MUST NOT be emitted for task N (no environment field): ${JSON.stringify(provisionedForN)}`
    );
    assert.ok(
      !failedForN,
      `env_provision_failed MUST NOT be emitted for task N (no environment field): ${JSON.stringify(failedForN)}`
    );
  });

  it("Step 3c: environments list unchanged (no new live entry for task N)", async () => {
    const resp = await httpGet(`${baseUrl}/environments`);
    const body = resp.body as { environments: Array<Record<string, unknown>> };
    const forN = body.environments.find(
      (e) => e["taskId"] === taskN && !e["tornDownAt"]
    );
    assert.ok(!forN, `No live environment must exist for task N: ${JSON.stringify(body.environments)}`);
  });

  // ── Cleanup: teardown task R environment ──────────────────────────────────

  it("Cleanup: teardown task R environment via API", async () => {
    assert.ok(envId, "envId must have been captured in Step 2b");
    const resp = await httpPost(
      `${baseUrl}/projects/${projId}/tasks/${taskR}/environment/teardown`,
      { envId }
    );
    assert.equal(resp.status, 200, `teardown must succeed: ${JSON.stringify(resp.body)}`);
  });
});

// ── I2 nuance: a failing provision must NOT block the in-review transition ────
describe("[AC-S9d7fdb-7-1] provision failure is non-blocking (task stays in-review)", () => {
  let daemon: Daemon;
  let daemonPort: number;
  let dataDir: string;
  let projectDir: string;
  let baseUrl: string;
  const projId = `rev-prov-fail-${Date.now()}`;
  const taskF = `task-review-badenv-${Date.now()}`;

  before(async () => {
    daemonPort = await getFreePort();
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "banto-review-provfail-test-"));
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "banto-review-provfail-proj-"));

    // environments.yaml defines only "dev"; the task references an UNKNOWN profile,
    // so provisionEnv() will fail (unknown profile → env_provision_failed).
    const metaDir = path.join(projectDir, "meta");
    fs.mkdirSync(metaDir, { recursive: true });
    fs.writeFileSync(
      path.join(metaDir, "environments.yaml"),
      `profiles:\n  dev:\n    driver: process\n    config:\n      cmd: "true"\n    ttl: 1h\n`,
      "utf8"
    );
    const tasksDir = path.join(projectDir, "work", "tasks");
    fs.mkdirSync(tasksDir, { recursive: true });
    fs.writeFileSync(
      path.join(tasksDir, `${taskF}.md`),
      `---\nid: ${taskF}\ntitle: Review provision fail test\nenvironment: nonexistent-profile\n---\nContent.\n`,
      "utf8"
    );

    daemon = Daemon.create({
      port: daemonPort,
      dataDir,
      watchIntervalMs: 500,
      tickIntervalMs: 60000,
      driverTimeoutMs: 10000,
      disableAuditSpawn: true,
      disableAutoSpawn: true,
    });
    await daemon.start();
    baseUrl = `http://127.0.0.1:${daemonPort}/api/v1`;

    const regResp = await httpPost(`${baseUrl}/projects`, { id: projId, repoPath: projectDir });
    assert.equal(regResp.status, 201, `project registration failed: ${JSON.stringify(regResp.body)}`);
    const fResp = await httpPost(`${baseUrl}/projects/${projId}/tasks`, {
      id: taskF, title: "Review provision fail test", environment: "nonexistent-profile",
    });
    assert.equal(fResp.status, 201, `task F creation failed: ${JSON.stringify(fResp.body)}`);
    await driveToReviewReady(baseUrl, projId, taskF);
  });

  after(async () => {
    await daemon.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  it("transition to in-review returns 200 even though provision will fail", async () => {
    const resp = await httpPost(
      `${baseUrl}/projects/${projId}/tasks/${taskF}/transition`,
      { to: "in-review" }
    );
    assert.equal(resp.status, 200, `in-review transition must succeed: ${JSON.stringify(resp.body)}`);
  });

  it("env_provision_failed is emitted for the task (failure surfaced, I2)", async () => {
    await waitFor(async () => {
      const resp = await httpGet(`${baseUrl}/projects/${projId}/events`);
      const body = resp.body as { events: Array<Record<string, unknown>> };
      return body.events.some(
        (e) => e["type"] === "env_provision_failed" && e["taskId"] === taskF
      );
    }, 8000);
    const resp = await httpGet(`${baseUrl}/projects/${projId}/events`);
    const body = resp.body as { events: Array<Record<string, unknown>> };
    const failed = body.events.find(
      (e) => e["type"] === "env_provision_failed" && e["taskId"] === taskF
    );
    assert.ok(failed, `env_provision_failed must be emitted for the bad-profile task`);
  });

  it("the task remains in the in-review state (provision failure did not revert it)", async () => {
    const resp = await httpGet(`${baseUrl}/projects/${projId}/tasks/${taskF}`);
    const task = (resp.body as Record<string, unknown>)["task"] as Record<string, unknown>;
    assert.equal(
      task["status"],
      "in-review",
      `task must stay in-review despite provision failure: ${JSON.stringify(task)}`
    );
  });

  it("no live environment leaked for the failed provision", async () => {
    const resp = await httpGet(`${baseUrl}/environments`);
    const body = resp.body as { environments: Array<Record<string, unknown>> };
    const live = body.environments.find((e) => e["taskId"] === taskF && !e["tornDownAt"]);
    assert.ok(!live, `no ledger entry must exist for a failed provision: ${JSON.stringify(body.environments)}`);
  });
});

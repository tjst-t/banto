/**
 * [AC-S9d7fdb-4-3] Quota enforcement: provision rejection + QuotaCheck gate hold.
 *
 * Entry point (test-discipline rule 2, api story):
 *   Real HTTP client against a running daemon.
 *
 * Scenario (scenario-S9d7fdb-4.json, scenario-3-quota-gate):
 *   Preconditions:
 *     - Profile "capped" with quota.max_instances=1
 *     - Task A: provisioned on "capped" (quota full)
 *     - Task B: has environment: capped, in "queued" state (gate should block it)
 *
 *   Step 1: POST provision for a second task on "capped" → 409 with quota reason
 *   Step 2: Task B is NOT promoted; gate_evaluated event shows quota(physical_resource_limit) block
 *   Step 3: teardown task A's env → wait for gate-reeval tick → task B is promoted to ready
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
  "banto-process-driver-state-acceptance-env-quota.json"
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

/**
 * Wait up to timeoutMs for condition to be true, polling every intervalMs.
 */
async function waitFor(condition: () => Promise<boolean>, timeoutMs = 5000, intervalMs = 100): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await new Promise<void>((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}

// ── Test ─────────────────────────────────────────────────────────────────────

describe("[AC-S9d7fdb-4-3] quota enforcement and QuotaCheck gate hold", () => {
  let daemon: Daemon;
  let daemonPort: number;
  let envPort: number;
  let dataDir: string;
  let projectDir: string;
  let baseUrl: string;
  const projId = "quota-proj";
  const taskA = `task-quota-a-${Date.now()}`;
  const taskB = `task-quota-b-${Date.now()}`;
  let envAId: string | undefined;

  before(async () => {
    daemonPort = await getFreePort();
    envPort = await getFreePort();
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "banto-quota-test-"));
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "banto-quota-proj-"));

    const metaDir = path.join(projectDir, "meta");
    fs.mkdirSync(metaDir, { recursive: true });
    // "capped" profile with max_instances=1
    const cmd = `node -e "require('http').createServer((req,res)=>res.end('ok')).listen(${envPort},'127.0.0.1')"`;
    fs.writeFileSync(
      path.join(metaDir, "environments.yaml"),
      [
        "profiles:",
        "  capped:",
        `    driver: process`,
        `    config:`,
        `      cmd: "${cmd}"`,
        `      port: ${envPort}`,
        `    ttl: 1h`,
        `    quota:`,
        `      max_instances: 1`,
      ].join("\n") + "\n",
      "utf8"
    );

    const tasksDir = path.join(projectDir, "work", "tasks");
    fs.mkdirSync(tasksDir, { recursive: true });
    fs.writeFileSync(
      path.join(tasksDir, `${taskA}.md`),
      `---\nid: ${taskA}\ntitle: Quota task A\nenvironment: capped\n---\nContent A.\n`,
      "utf8"
    );
    fs.writeFileSync(
      path.join(tasksDir, `${taskB}.md`),
      `---\nid: ${taskB}\ntitle: Quota task B\nenvironment: capped\n---\nContent B.\n`,
      "utf8"
    );

    // Use a FAST tick interval so gate-reeval fires quickly.
    // disableAutoSpawn: prevents the pi-rpc driver from being invoked on ready tasks
    // (pi binary is not available in test env — would fail the task before we can observe it).
    daemon = Daemon.create({
      port: daemonPort,
      dataDir,
      watchIntervalMs: 200,
      tickIntervalMs: 200,   // fast tick for gate-reeval
      driverTimeoutMs: 10000,
      disableAuditSpawn: true,
      disableAutoSpawn: true,
    });
    await daemon.start();
    baseUrl = `http://127.0.0.1:${daemonPort}/api/v1`;

    const regResp = await httpPost(`${baseUrl}/projects`, { id: projId, repoPath: projectDir });
    assert.equal(regResp.status, 201, `project registration: ${JSON.stringify(regResp.body)}`);

    // Create task A and task B
    const tAResp = await httpPost(`${baseUrl}/projects/${projId}/tasks`, {
      id: taskA, title: "Quota task A", environment: "capped",
    });
    assert.equal(tAResp.status, 201, `task A creation: ${JSON.stringify(tAResp.body)}`);

    const tBResp = await httpPost(`${baseUrl}/projects/${projId}/tasks`, {
      id: taskB, title: "Quota task B", environment: "capped",
    });
    assert.equal(tBResp.status, 201, `task B creation: ${JSON.stringify(tBResp.body)}`);

    // Provision for task A (occupies the single slot)
    const provResp = await httpPost(
      `${baseUrl}/projects/${projId}/tasks/${taskA}/environment/provision`,
      {}
    );
    assert.equal(provResp.status, 201, `task A provision: ${JSON.stringify(provResp.body)}`);
    envAId = (provResp.body as Record<string, unknown>)["envId"] as string;

    // Transition task B to queued (it starts as draft; need to move it to queued for gate)
    // Task B was created in draft status; transition to queued so gate evaluates it
    const toQueuedResp = await httpPost(`${baseUrl}/projects/${projId}/tasks/${taskB}/transition`, {
      to: "queued",
    });
    assert.equal(toQueuedResp.status, 200, `task B → queued: ${JSON.stringify(toQueuedResp.body)}`);

    // Wait a bit for the gate-reeval to fire so the gate_evaluated event is recorded
    await new Promise<void>((r) => setTimeout(r, 500));
  });

  after(async () => {
    if (envAId) {
      try { await httpPost(`${baseUrl}/projects/${projId}/tasks/${taskA}/environment/teardown`, { envId: envAId }); } catch { /* best-effort */ }
    }
    await daemon.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(projectDir, { recursive: true, force: true });
    fs.rmSync(TEST_DRIVER_STATE, { force: true });
  });

  it("Step 1: POST provision for second task → 409 with quota reason", async () => {
    // Provision for task B should fail — quota full
    const resp = await httpPost(
      `${baseUrl}/projects/${projId}/tasks/${taskB}/environment/provision`,
      {}
    );
    assert.equal(resp.status, 409, `expected 409, got ${resp.status}: ${JSON.stringify(resp.body)}`);
    const body = resp.body as Record<string, unknown>;
    assert.ok(typeof body["error"] === "string", "error field must be string");
    assert.ok(
      (body["error"] as string).toLowerCase().includes("quota") ||
      (body["error"] as string).includes("max_instances"),
      `error must mention quota or max_instances: ${body["error"]}`
    );
  });

  it("Step 2: Task B stays queued; gate_evaluated shows quota block", async () => {
    // Task B should NOT have been promoted to ready (quota blocks it)
    const taskBResp = await httpGet(`${baseUrl}/projects/${projId}/tasks/${taskB}`);
    assert.equal(taskBResp.status, 200);
    const taskBData = (taskBResp.body as Record<string, unknown>)["task"] as Record<string, unknown>;
    assert.equal(taskBData["status"], "queued", `task B must remain queued while quota is full, got: ${taskBData["status"]}`);

    // Check gate_evaluated events — must show quota(physical_resource_limit) block for task B
    const evResp = await httpGet(`${baseUrl}/projects/${projId}/events`);
    assert.equal(evResp.status, 200);
    const evBody = evResp.body as { events: Array<Record<string, unknown>> };
    const quotaBlockEvent = evBody.events.find(
      (e) =>
        e["type"] === "gate_evaluated" &&
        e["taskId"] === taskB &&
        e["passed"] === false &&
        Array.isArray(e["blockedBy"]) &&
        (e["blockedBy"] as string[]).some((b) => b.startsWith("quota"))
    );
    assert.ok(
      quotaBlockEvent !== undefined,
      `gate_evaluated event with quota block for task B must exist: ${JSON.stringify(evBody.events.filter((e) => e["taskId"] === taskB))}`
    );
  });

  it("Step 3: teardown task A → task B promoted to ready", async () => {
    assert.ok(envAId, "envAId must be set");

    // Teardown task A's environment (frees the slot)
    const tdResp = await httpPost(
      `${baseUrl}/projects/${projId}/tasks/${taskA}/environment/teardown`,
      { envId: envAId }
    );
    assert.equal(tdResp.status, 200, `teardown task A: ${JSON.stringify(tdResp.body)}`);
    envAId = undefined; // prevent double-teardown in after()

    // Wait for the gate-reeval tick to fire and promote task B
    await waitFor(async () => {
      const resp = await httpGet(`${baseUrl}/projects/${projId}/tasks/${taskB}`);
      const data = (resp.body as Record<string, unknown>)["task"] as Record<string, unknown>;
      return data["status"] === "ready";
    }, 5000, 200);

    // Verify task B is now ready
    const taskBResp = await httpGet(`${baseUrl}/projects/${projId}/tasks/${taskB}`);
    const taskBData = (taskBResp.body as Record<string, unknown>)["task"] as Record<string, unknown>;
    assert.equal(taskBData["status"], "ready", `task B must be promoted to ready after quota freed`);

    // Verify a new gate_evaluated event was emitted showing passed=true
    const evResp = await httpGet(`${baseUrl}/projects/${projId}/events`);
    const evBody = evResp.body as { events: Array<Record<string, unknown>> };
    const passEvent = evBody.events.find(
      (e) =>
        e["type"] === "gate_evaluated" &&
        e["taskId"] === taskB &&
        e["passed"] === true
    );
    assert.ok(
      passEvent !== undefined,
      `gate_evaluated(passed=true) for task B must appear after teardown: ${JSON.stringify(evBody.events.filter((e) => e["taskId"] === taskB))}`
    );
  });
});

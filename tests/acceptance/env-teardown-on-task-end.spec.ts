/**
 * [AC-S9d7fdb-4-4] Teardown on terminal task state.
 *
 * Entry point (test-discipline rule 2, api story):
 *   Real HTTP client against a running daemon.
 *
 * Scenario (scenario-S9d7fdb-4.json, scenario-4-teardown-on-terminal):
 *   Preconditions: task C with a provisioned environment
 *   Step 1: POST /transition to "failed" → 200 (transition accepted)
 *   Step 2: GET /events → env_torn_down event for task C
 *          GET /environments → environment gone from live list
 *          OS check → process no longer alive
 *
 * Also verifies teardown on "closed" state.
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
  "banto-process-driver-state-acceptance-env-teardown-on-task-end.json"
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

async function waitFor(condition: () => Promise<boolean>, timeoutMs = 5000, intervalMs = 100): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await new Promise<void>((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}

/**
 * Create a fresh daemon + project with a given envPort for one profile.
 * Each sub-test uses a completely independent daemon + dataDir + projectDir.
 */
async function createDaemonWithProfile(envPort: number): Promise<{
  daemon: Daemon;
  baseUrl: string;
  projId: string;
  dataDir: string;
  projectDir: string;
}> {
  const daemonPort = await getFreePort();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "banto-teardown-term-"));
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "banto-teardown-proj-"));

  const metaDir = path.join(projectDir, "meta");
  fs.mkdirSync(metaDir, { recursive: true });
  const cmd = `node -e "require('http').createServer((req,res)=>res.end('ok')).listen(${envPort},'127.0.0.1')"`;
  fs.writeFileSync(
    path.join(metaDir, "environments.yaml"),
    `profiles:\n  dev:\n    driver: process\n    config:\n      cmd: "${cmd}"\n      port: ${envPort}\n    ttl: 1h\n`,
    "utf8"
  );

  const d = Daemon.create({
    port: daemonPort,
    dataDir,
    watchIntervalMs: 200,
    tickIntervalMs: 200,
    driverTimeoutMs: 10000,
    disableAuditSpawn: true,
    disableAutoSpawn: true,
  });
  await d.start();

  const baseUrl = `http://127.0.0.1:${daemonPort}/api/v1`;
  const projId = `teardown-proj-${daemonPort}`;

  const regResp = await httpPost(`${baseUrl}/projects`, { id: projId, repoPath: projectDir });
  if (regResp.status !== 201) {
    throw new Error(`project registration failed: ${JSON.stringify(regResp.body)}`);
  }

  return { daemon: d, baseUrl, projId, dataDir, projectDir };
}

async function provisionForTask(
  daemon: Daemon,
  baseUrl: string,
  projId: string,
  taskId: string,
  projectDir: string
): Promise<{ envId: string; pid: number | undefined }> {
  const tasksDir = path.join(projectDir, "work", "tasks");
  fs.mkdirSync(tasksDir, { recursive: true });
  fs.writeFileSync(
    path.join(tasksDir, `${taskId}.md`),
    `---\nid: ${taskId}\ntitle: Teardown terminal test ${taskId}\nenvironment: dev\n---\nContent.\n`,
    "utf8"
  );

  const taskResp = await httpPost(`${baseUrl}/projects/${projId}/tasks`, {
    id: taskId, title: "Teardown terminal test", environment: "dev",
  });
  assert.equal(taskResp.status, 201, `task creation: ${JSON.stringify(taskResp.body)}`);

  const provResp = await httpPost(
    `${baseUrl}/projects/${projId}/tasks/${taskId}/environment/provision`,
    {}
  );
  assert.equal(provResp.status, 201, `provision: ${JSON.stringify(provResp.body)}`);
  const envId = (provResp.body as Record<string, unknown>)["envId"] as string;

  const entry = daemon.envLedger.get(envId);
  const handle = entry?.handle as Record<string, unknown> | undefined;
  const pid = typeof handle?.["pid"] === "number" ? handle["pid"] : undefined;

  return { envId, pid };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("[AC-S9d7fdb-4-4] teardown on terminal task state", () => {

  it("daemon started with disableAutoSpawn:true emits daemon_config event", async () => {
    // Fix 1: governance — a daemon started with disableAutoSpawn must emit a daemon_config
    // event at startup so the suppression is visible to the PO via GET /events.
    const envPort0 = await getFreePort();
    const { daemon: d0, baseUrl: bu0, dataDir: dd0, projectDir: pd0 } =
      await createDaemonWithProfile(envPort0);
    try {
      // GET all events (daemon-wide) — daemon_config must be in the log.
      // bu0 is already "http://127.0.0.1:<port>/api/v1", so use bu0 + "/events"
      const evResp = await httpGet(`${bu0}/events`);
      assert.equal(evResp.status, 200);
      const evBody = evResp.body as { events: Array<Record<string, unknown>> };
      const configEvent = evBody.events.find(
        (e) => e["type"] === "daemon_config" && e["autoSpawnDisabled"] === true
      );
      assert.ok(
        configEvent !== undefined,
        `daemon_config event with autoSpawnDisabled:true must appear at startup when disableAutoSpawn is set. ` +
          `Events: ${JSON.stringify(evBody.events.map((e) => e["type"]))}`
      );
    } finally {
      await d0.stop();
      fs.rmSync(dd0, { recursive: true, force: true });
      fs.rmSync(pd0, { recursive: true, force: true });
    }
  });

  it("task → failed: env_torn_down event emitted, environment gone, process dead", async () => {
    const envPort = await getFreePort();
    const { daemon, baseUrl, projId, dataDir, projectDir } = await createDaemonWithProfile(envPort);

    const taskC = `task-term-failed-${Date.now()}`;
    try {
      const { envId, pid } = await provisionForTask(daemon, baseUrl, projId, taskC, projectDir);

      // Verify process is alive after provision
      if (pid !== undefined) {
        assert.ok(isProcessAlive(pid), `process pid=${pid} must be alive after provision`);
      }

      // Step 1: Transition task to failed (cross-cutting transition — valid from any state)
      const failResp = await httpPost(`${baseUrl}/projects/${projId}/tasks/${taskC}/transition`, {
        to: "failed",
        reason: "test_terminal_teardown",
      });
      assert.equal(failResp.status, 200, `transition to failed: ${JSON.stringify(failResp.body)}`);

      // Step 2: Wait for async teardown to complete
      await waitFor(async () => {
        const resp = await httpGet(`${baseUrl}/environments`);
        const body = resp.body as { environments: Array<Record<string, unknown>> };
        return !body.environments.some((e) => e["envId"] === envId && !e["tornDownAt"]);
      }, 5000, 200);

      // Verify env_torn_down event is in events
      const evResp = await httpGet(`${baseUrl}/projects/${projId}/events`);
      assert.equal(evResp.status, 200);
      const evBody = evResp.body as { events: Array<Record<string, unknown>> };
      const tornDownEvent = evBody.events.find(
        (e) => e["type"] === "env_torn_down" && e["taskId"] === taskC
      );
      assert.ok(
        tornDownEvent,
        `env_torn_down event for task ${taskC} must be in events: ${JSON.stringify(evBody.events.filter((e) => e["type"] === "env_torn_down"))}`
      );

      // Verify process is dead
      if (pid !== undefined) {
        await new Promise<void>((r) => setTimeout(r, 300));
        assert.ok(!isProcessAlive(pid), `process pid=${pid} must be dead after task failed`);
      }

      // Verify environment is gone from the live list
      const envsResp = await httpGet(`${baseUrl}/environments`);
      const envsBody = envsResp.body as { environments: Array<Record<string, unknown>> };
      const stillLive = envsBody.environments.find((e) => e["envId"] === envId && !e["tornDownAt"]);
      assert.ok(!stillLive, "torn-down environment must not appear in live list");
    } finally {
      await daemon.stop();
      fs.rmSync(dataDir, { recursive: true, force: true });
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it("task → superseded: environment is also torn down", async () => {
    // Use a fresh port for this test (independent from the first test)
    const envPort2 = await getFreePort();
    const { daemon: d2, baseUrl: bu2, projId: proj2, dataDir: dd2, projectDir: pd2 } =
      await createDaemonWithProfile(envPort2);

    const taskD = `task-term-superseded-${Date.now()}`;
    try {
      const { envId: envId2 } = await provisionForTask(d2, bu2, proj2, taskD, pd2);

      const supResp = await httpPost(`${bu2}/projects/${proj2}/tasks/${taskD}/transition`, {
        to: "superseded",
        reason: "test_superseded_teardown",
      });
      assert.equal(supResp.status, 200, `transition to superseded: ${JSON.stringify(supResp.body)}`);

      // Wait for teardown
      await waitFor(async () => {
        const resp = await httpGet(`${bu2}/environments`);
        const body = resp.body as { environments: Array<Record<string, unknown>> };
        return !body.environments.some((e) => e["envId"] === envId2 && !e["tornDownAt"]);
      }, 5000, 200);

      // Verify env_torn_down event
      const evResp = await httpGet(`${bu2}/projects/${proj2}/events`);
      const evBody = evResp.body as { events: Array<Record<string, unknown>> };
      const tornDownEvent = evBody.events.find(
        (e) => e["type"] === "env_torn_down" && e["taskId"] === taskD
      );
      assert.ok(
        tornDownEvent,
        `env_torn_down event for task ${taskD} must exist after superseded transition: ` +
          JSON.stringify(evBody.events.filter((e) => e["type"] === "env_torn_down"))
      );
    } finally {
      await d2.stop();
      fs.rmSync(dd2, { recursive: true, force: true });
      fs.rmSync(pd2, { recursive: true, force: true });
    }
  });

  it("task → closed (via merged→closed): environment is torn down", async () => {
    // Drive task to the `closed` terminal state via the shortest real path:
    // draft → queued → ready → planning → implementing → auditing → merging → merged → closed
    // (no-hypothesis path: merged→closed is valid in the transition table).
    // disableAutoSpawn + disableAuditSpawn means we can manually drive transitions
    // without triggering actual pi sessions.
    const envPort3 = await getFreePort();
    const { daemon: d3, baseUrl: bu3, projId: proj3, dataDir: dd3, projectDir: pd3 } =
      await createDaemonWithProfile(envPort3);

    const taskE = `task-term-closed-${Date.now()}`;
    try {
      const { envId: envId3 } = await provisionForTask(d3, bu3, proj3, taskE, pd3);

      // Drive through the transition chain to reach `closed`.
      // The gate evaluator may auto-promote draft→queued→ready when there are no
      // blockers. Transition queued first, then check status — if already promoted
      // to ready by the gate, skip the manual ready transition.
      // Full chain: draft→queued (gate may auto-→ready)→planning→implementing→
      //             auditing→merging→merged→closed (no-hypothesis path).

      // Step 1: draft→queued
      let r = await httpPost(`${bu3}/projects/${proj3}/tasks/${taskE}/transition`, {
        to: "queued", reason: "test_closed_path",
      });
      assert.equal(r.status, 200, `transition to queued: ${JSON.stringify(r.body)}`);

      // Step 2: Check if gate already promoted to ready; if not, do it manually.
      // (gate-reeval runs after transition() succeeds, so task may already be ready)
      const afterQueued = await httpGet(`${bu3}/projects/${proj3}/tasks/${taskE}`);
      const currentStatus = ((afterQueued.body as Record<string, unknown>)["task"] as Record<string, unknown>)["status"] as string;
      if (currentStatus !== "ready") {
        r = await httpPost(`${bu3}/projects/${proj3}/tasks/${taskE}/transition`, {
          to: "ready", reason: "test_closed_path",
        });
        assert.equal(r.status, 200, `transition to ready: ${JSON.stringify(r.body)}`);
      }

      // Step 3: Drive the rest of the chain to closed.
      const remaining = ["planning", "implementing", "auditing", "merging", "merged", "closed"];
      for (const toState of remaining) {
        r = await httpPost(`${bu3}/projects/${proj3}/tasks/${taskE}/transition`, {
          to: toState,
          reason: `test_closed_path`,
        });
        assert.equal(
          r.status,
          200,
          `transition to ${toState}: ${JSON.stringify(r.body)}`
        );
      }

      // Verify task is now closed
      const taskResp = await httpGet(`${bu3}/projects/${proj3}/tasks/${taskE}`);
      const taskData = (taskResp.body as Record<string, unknown>)["task"] as Record<string, unknown>;
      assert.equal(taskData["status"], "closed", `task must be in closed state`);

      // Wait for async teardown to complete
      await waitFor(async () => {
        const resp = await httpGet(`${bu3}/environments`);
        const body = resp.body as { environments: Array<Record<string, unknown>> };
        return !body.environments.some((e) => e["envId"] === envId3 && !e["tornDownAt"]);
      }, 5000, 200);

      // Verify env_torn_down event is in the log
      const evResp = await httpGet(`${bu3}/projects/${proj3}/events`);
      assert.equal(evResp.status, 200);
      const evBody = evResp.body as { events: Array<Record<string, unknown>> };
      const tornDownEvent = evBody.events.find(
        (e) => e["type"] === "env_torn_down" && e["taskId"] === taskE
      );
      assert.ok(
        tornDownEvent,
        `env_torn_down event for task ${taskE} must appear after closed transition: ` +
          JSON.stringify(evBody.events.filter((e) => e["type"] === "env_torn_down"))
      );

      // Verify environment is gone from live list
      const envsResp = await httpGet(`${bu3}/environments`);
      const envsBody = envsResp.body as { environments: Array<Record<string, unknown>> };
      const stillLive = envsBody.environments.find((e) => e["envId"] === envId3 && !e["tornDownAt"]);
      assert.ok(!stillLive, "torn-down environment must not appear in live list after task closed");
    } finally {
      await d3.stop();
      fs.rmSync(dd3, { recursive: true, force: true });
      fs.rmSync(pd3, { recursive: true, force: true });
    }
  });
});

/**
 * [AC-S9d7fdb-4-2] Ledger survival across daemon restart + corruption tolerance.
 *
 * Entry point (test-discipline rule 2, api story):
 *   Real HTTP client against running daemon(s).
 *
 * Scenario (scenario-S9d7fdb-4.json, scenario-2-restart-continuity):
 *   Part A — restart continuity:
 *     1. Provision an environment (process stays alive between daemon restarts)
 *     2. Stop the daemon, start a new daemon on the SAME dataDir
 *     3. GET /environments still lists the environment (ledger persisted)
 *     4. POST teardown succeeds and kills the still-running process
 *
 *   Part B — corruption tolerance:
 *     1. Overwrite the ledger file with garbage bytes
 *     2. Start a new daemon on the same dataDir
 *     3. GET /health → 200 (no crash)
 *     4. GET /api/v1/events → contains an error event about ledger corruption
 *     5. GET /environments → empty list (fresh ledger, not the corrupt one)
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
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EPERM") return true;
    return false;
  }
}

async function startDaemon(port: number, dataDir: string, projectDir: string): Promise<Daemon> {
  const d = Daemon.create({
    port,
    dataDir,
    watchIntervalMs: 500,
    tickIntervalMs: 60000,
    driverTimeoutMs: 10000,
    disableAuditSpawn: true,
  });
  await d.start();
  // Register project on first start (idempotent on 409 for subsequent starts)
  const regResp = await fetch(`http://127.0.0.1:${port}/api/v1/projects`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: "restart-proj", repoPath: projectDir }),
  });
  if (regResp.status !== 201 && regResp.status !== 409) {
    throw new Error(`project registration failed: ${regResp.status}`);
  }
  return d;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("[AC-S9d7fdb-4-2] ledger restart continuity and corruption tolerance", () => {
  let dataDir: string;
  let projectDir: string;
  let envPort: number;

  before(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "banto-restart-test-"));
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "banto-restart-proj-"));
  });

  after(() => {
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  // ── Part A: Restart continuity ──────────────────────────────────────────────

  describe("Part A: restart continuity", () => {
    let daemonA: Daemon;
    let portA: number;
    let envId: string;
    let envPid: number | undefined;
    let taskId: string;
    const projId = "restart-proj";

    before(async () => {
      portA = await getFreePort();
      envPort = await getFreePort();
      taskId = `task-restart-${Date.now()}`;

      // Set up project files
      const metaDir = path.join(projectDir, "meta");
      fs.mkdirSync(metaDir, { recursive: true });
      const cmd = `node -e "require('http').createServer((req,res)=>res.end('ok')).listen(${envPort},'127.0.0.1')"`;
      fs.writeFileSync(
        path.join(metaDir, "environments.yaml"),
        `profiles:\n  dev:\n    driver: process\n    config:\n      cmd: "${cmd}"\n      port: ${envPort}\n    ttl: 1h\n`,
        "utf8"
      );
      const tasksDir = path.join(projectDir, "work", "tasks");
      fs.mkdirSync(tasksDir, { recursive: true });
      fs.writeFileSync(
        path.join(tasksDir, `${taskId}.md`),
        `---\nid: ${taskId}\ntitle: Restart test\nenvironment: dev\n---\nContent.\n`,
        "utf8"
      );

      daemonA = await startDaemon(portA, dataDir, projectDir);

      // Create task and provision environment
      await httpPost(`http://127.0.0.1:${portA}/api/v1/projects/${projId}/tasks`, {
        id: taskId, title: "Restart test", environment: "dev",
      });
      const provResp = await httpPost(
        `http://127.0.0.1:${portA}/api/v1/projects/${projId}/tasks/${taskId}/environment/provision`,
        {}
      );
      assert.equal(provResp.status, 201, `provision failed: ${JSON.stringify(provResp.body)}`);
      envId = (provResp.body as Record<string, unknown>)["envId"] as string;

      // Record the pid from the ledger for post-teardown assertion
      const envEntry = daemonA.envLedger.get(envId);
      const handle = envEntry?.handle as Record<string, unknown> | undefined;
      envPid = typeof handle?.["pid"] === "number" ? handle["pid"] : undefined;
    });

    after(async () => {
      try { await daemonA.stop(); } catch { /* may already be stopped */ }
    });

    it("environment is in ledger before restart", async () => {
      const resp = await httpGet(`http://127.0.0.1:${portA}/api/v1/environments`);
      assert.equal(resp.status, 200);
      const body = resp.body as { environments: Array<Record<string, unknown>> };
      const entry = body.environments.find((e) => e["envId"] === envId);
      assert.ok(entry, "environment must be listed before restart");
    });

    it("after daemon restart, GET /environments still lists the environment", async () => {
      // Stop daemon A — the environment process keeps running
      await daemonA.stop();

      // Start a new daemon on the SAME dataDir
      const portB = await getFreePort();
      const daemonB = Daemon.create({
        port: portB,
        dataDir,
        watchIntervalMs: 500,
        tickIntervalMs: 60000,
        driverTimeoutMs: 10000,
        disableAuditSpawn: true,
      });
      await daemonB.start();

      try {
        // Re-register project (in-memory registry resets on restart)
        await httpPost(`http://127.0.0.1:${portB}/api/v1/projects`, {
          id: "restart-proj", repoPath: projectDir,
        });

        const resp = await httpGet(`http://127.0.0.1:${portB}/api/v1/environments`);
        assert.equal(resp.status, 200, `environments after restart: ${JSON.stringify(resp.body)}`);
        const body = resp.body as { environments: Array<Record<string, unknown>> };
        const entry = body.environments.find((e) => e["envId"] === envId);
        assert.ok(entry, `environment envId=${envId} must survive daemon restart`);

        // POST teardown — should still succeed and kill the live process
        const tdResp = await httpPost(
          `http://127.0.0.1:${portB}/api/v1/projects/restart-proj/tasks/${taskId}/environment/teardown`,
          { envId }
        );
        assert.equal(tdResp.status, 200, `teardown after restart: ${JSON.stringify(tdResp.body)}`);

        // Wait for teardown and verify process is gone
        await new Promise<void>((r) => setTimeout(r, 500));
        if (envPid !== undefined) {
          assert.ok(!isProcessAlive(envPid), `process pid=${envPid} must be dead after teardown`);
        }

        // Verify environment is gone from the list
        const afterTd = await httpGet(`http://127.0.0.1:${portB}/api/v1/environments`);
        const afterBody = afterTd.body as { environments: Array<Record<string, unknown>> };
        const stillThere = afterBody.environments.find((e) => e["envId"] === envId && !e["tornDownAt"]);
        assert.ok(!stillThere, "torn-down env must not appear in live list after teardown");
      } finally {
        await daemonB.stop();
      }
    });
  });

  // ── Part B: Corruption tolerance ────────────────────────────────────────────

  describe("Part B: corruption tolerance", () => {
    it("corrupt ledger → daemon starts + error event + empty environments", async () => {
      // Use a fresh dataDir for corruption test to avoid leftover state
      const corruptDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "banto-corrupt-ledger-"));

      // Write a garbage ledger file to trigger the corruption path
      fs.mkdirSync(corruptDataDir, { recursive: true });
      fs.writeFileSync(path.join(corruptDataDir, "env-ledger.json"), "GARBAGE_NOT_JSON!!!", "utf8");

      const portC = await getFreePort();
      const daemonC = Daemon.create({
        port: portC,
        dataDir: corruptDataDir,
        watchIntervalMs: 500,
        tickIntervalMs: 60000,
        driverTimeoutMs: 10000,
        disableAuditSpawn: true,
      });
      try {
        // Daemon must start despite corrupt ledger (no crash)
        await daemonC.start();

        // GET /health must return 200
        const healthResp = await httpGet(`http://127.0.0.1:${portC}/api/v1/health`);
        assert.equal(healthResp.status, 200, "daemon must be healthy despite corrupt ledger");

        // GET /api/v1/events must contain an error event about ledger corruption
        const eventsResp = await httpGet(`http://127.0.0.1:${portC}/api/v1/events`);
        assert.equal(eventsResp.status, 200, `events: ${JSON.stringify(eventsResp.body)}`);
        const evBody = eventsResp.body as { events: Array<Record<string, unknown>> };
        const corruptEvent = evBody.events.find(
          (e) => e["type"] === "tick_job_failed" &&
            typeof e["error"] === "string" &&
            (e["error"] as string).includes("env-ledger.json")
        );
        assert.ok(corruptEvent, `error event about env-ledger.json corruption must be in events: ${JSON.stringify(evBody.events)}`);

        // GET /environments must return empty list (fresh ledger, not the corrupt one)
        const envsResp = await httpGet(`http://127.0.0.1:${portC}/api/v1/environments`);
        assert.equal(envsResp.status, 200, `environments: ${JSON.stringify(envsResp.body)}`);
        const envsBody = envsResp.body as { environments: Array<Record<string, unknown>> };
        assert.ok(Array.isArray(envsBody.environments), "environments must be array");
        assert.equal(envsBody.environments.length, 0, "corrupt ledger → empty environments list");
      } finally {
        await daemonC.stop();
        fs.rmSync(corruptDataDir, { recursive: true, force: true });
      }
    });
  });
});

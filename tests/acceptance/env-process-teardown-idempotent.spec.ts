/**
 * [AC-S9d7fdb-2-4] Teardown idempotency and list taskID-prefix filtering.
 *
 * Entry point (test-discipline rule 2, mixed story, Block A + Block B):
 *   Block A (subprocess): `<process-driver> list` invoked directly to verify
 *     that the list contains the managed taskID-prefixed resource and NOT
 *     an unrelated process.
 *   Block B (HTTP): POST .../environment/teardown twice to verify idempotency;
 *     env_torn_down event appears; GET /api/v1/environments no longer lists entry.
 *
 * Scenario steps (from scenario-S9d7fdb-2.json, scenario-4-teardown-idempotent-list):
 *   preconditions: environment provisioned + one unrelated user process WITHOUT taskID prefix.
 *   1. `<process-driver> list` → contains taskID-prefixed resource, NOT unrelated.
 *   2. Kill provisioned process manually; POST .../teardown → 200 success (idempotent).
 *   3. POST .../teardown again → 200 success again; env_torn_down event; GET /environments empty.
 *
 * Cleanup: kill unrelated fixture process.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as childProcess from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as net from "node:net";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { ListOutput } from "../../packages/banto-core/src/index.js";

const _thisDir = path.dirname(fileURLToPath(import.meta.url));
const _repoRoot = path.resolve(_thisDir, "..", "..");
const PROCESS_DRIVER_PATH = path.join(_repoRoot, "packages", "banto-daemon", "src", "process-driver.ts");
const NODE = process.execPath;

import { Daemon } from "../../packages/banto-daemon/src/daemon.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const addr = s.address();
      if (!addr || typeof addr === "string") { s.close(() => reject(new Error("no addr"))); return; }
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
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EPERM") return true;
    return false;
  }
}

function invokeDriverList(): ListOutput {
  const r = childProcess.spawnSync(NODE, ["--import", "tsx", PROCESS_DRIVER_PATH, "list"], {
    input: "{}",
    encoding: "utf8",
    timeout: 5000,
    env: { ...process.env },
  });
  assert.equal(r.status, 0, `driver list exited ${r.status}: ${r.stderr}`);
  const raw = (r.stdout ?? "").trim();
  return raw ? (JSON.parse(raw) as ListOutput) : [];
}

// ── Test setup ────────────────────────────────────────────────────────────────

describe("[AC-S9d7fdb-2-4] teardown idempotency and list taskID-prefix filtering", () => {
  let daemon: Daemon;
  let daemonPort: number;
  let envPort: number;
  let dataDir: string;
  let projectDir: string;
  let baseUrl: string;
  const projId = "test-proj-teardown";
  const taskId = `task-teardown-${Date.now()}`;
  let envId: string | undefined;
  let provisionedPid: number | undefined;

  // Unrelated process: a long-sleep process WITHOUT the taskID prefix
  let unrelatedPid: number | undefined;

  before(async () => {
    daemonPort = await getFreePort();
    envPort = await getFreePort();
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "banto-teardown-test-"));
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "banto-teardown-proj-"));

    const metaDir = path.join(projectDir, "meta");
    fs.mkdirSync(metaDir, { recursive: true });
    const cmd = `node -e "require('http').createServer((req,res)=>res.end('ok')).listen(${envPort},'127.0.0.1')"`;
    fs.writeFileSync(
      path.join(metaDir, "environments.yaml"),
      `profiles:\n  dev:\n    driver: process\n    config:\n      cmd: "${cmd}"\n      port: ${envPort}\n    ttl: 1h\n`,
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

    // Register project + task
    await httpPost(`${baseUrl}/projects`, { id: projId, repoPath: projectDir });
    await httpPost(`${baseUrl}/projects/${projId}/tasks`, {
      id: taskId,
      title: "Teardown idempotent test task",
      environment: "dev",
    });

    // Provision the environment — profile resolved from task's environment field (D3, no body override)
    const provResp = await httpPost(
      `${baseUrl}/projects/${projId}/tasks/${taskId}/environment/provision`,
      {}
    );
    assert.equal(provResp.status, 201, `provision precondition failed: ${JSON.stringify(provResp.body)}`);
    const provBody = provResp.body as Record<string, unknown>;
    envId = provBody["envId"] as string;

    // Get pid from the env ledger
    const entry = daemon.envLedger.listByTask(projId, taskId)[0];
    const handle = entry?.handle as Record<string, unknown> | undefined;
    provisionedPid = handle?.["pid"] as number | undefined;

    // Start an unrelated process that does NOT use the taskID prefix
    // This tests that `list` only returns managed (taskID-prefixed) resources
    const unrelatedChild = childProcess.spawn(
      "node",
      ["-e", "setTimeout(()=>{},60000)"],
      { detached: true, stdio: "ignore" }
    );
    unrelatedChild.unref();
    unrelatedPid = unrelatedChild.pid;
  });

  after(async () => {
    // Kill unrelated fixture process
    if (unrelatedPid !== undefined && isProcessAlive(unrelatedPid)) {
      try { process.kill(unrelatedPid, "SIGKILL"); } catch { /* best-effort */ }
    }
    await daemon.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  // ── Step 1: list contains taskID-prefixed resource, NOT unrelated process ──

  it("driver list contains our taskID-prefixed resource", () => {
    const items = invokeDriverList();
    assert.ok(Array.isArray(items), "list output must be an array");

    const ours = items.find((item) => {
      const name = item.name as string;
      return typeof name === "string" && name.startsWith(taskId);
    });
    assert.ok(
      ours !== undefined,
      `list must contain our taskID-prefixed resource (taskId=${taskId}): ${JSON.stringify(items)}`
    );
  });

  it("driver list does NOT contain the unrelated process (no taskID prefix)", () => {
    assert.ok(unrelatedPid !== undefined, "unrelated process must be running");

    const items = invokeDriverList();
    assert.ok(Array.isArray(items), "list output must be an array");

    // Verify none of the listed items correspond to the unrelated process
    const hasUnrelated = items.some((item) => {
      const h = item.handle as Record<string, unknown>;
      return h["pid"] === unrelatedPid;
    });
    assert.ok(
      !hasUnrelated,
      `list must NOT contain the unrelated process (pid=${unrelatedPid}): ${JSON.stringify(items)}`
    );
  });

  // ── Step 2: kill process manually, then POST teardown ─────────────────────

  it("teardown succeeds even when process was already killed manually (idempotent)", async () => {
    assert.ok(provisionedPid !== undefined, "provisioned pid must be set");
    assert.ok(envId, "envId must be set");

    // Kill the process manually (simulate it already being gone)
    if (isProcessAlive(provisionedPid!)) {
      try { process.kill(provisionedPid!, "SIGKILL"); } catch { /* already gone */ }
    }

    // Wait for the OS to reap the process
    await new Promise<void>((r) => setTimeout(r, 300));
    assert.ok(!isProcessAlive(provisionedPid!), `process must be dead after manual kill`);

    // POST teardown — must succeed even though process is already gone
    const resp = await httpPost(
      `${baseUrl}/projects/${projId}/tasks/${taskId}/environment/teardown`,
      { envId }
    );
    assert.equal(
      resp.status,
      200,
      `teardown must return 200 even when process already gone: ${JSON.stringify(resp.body)}`
    );
    const body = resp.body as Record<string, unknown>;
    assert.equal(body["status"], "torn_down", `status must be torn_down: ${JSON.stringify(body)}`);
  });

  // ── Step 3: POST teardown again (already torn down) ───────────────────────

  it("second teardown returns 200 (idempotent — already torn down)", async () => {
    assert.ok(envId, "envId must be set");

    const resp = await httpPost(
      `${baseUrl}/projects/${projId}/tasks/${taskId}/environment/teardown`,
      { envId }
    );
    assert.equal(
      resp.status,
      200,
      `second teardown must return 200 (idempotent): ${JSON.stringify(resp.body)}`
    );
  });

  it("env_torn_down event appears in project events", async () => {
    const resp = await httpGet(`${baseUrl}/projects/${projId}/events`);
    assert.equal(resp.status, 200);
    const body = resp.body as { events: Array<Record<string, unknown>> };
    assert.ok(Array.isArray(body.events), "events must be an array");

    const tornDown = body.events.find(
      (e) => e["type"] === "env_torn_down" && e["taskId"] === taskId
    );
    assert.ok(
      tornDown !== undefined,
      `env_torn_down event for taskId=${taskId} must be in project events: ${JSON.stringify(body.events)}`
    );
  });

  it("GET /api/v1/environments no longer lists the torn-down entry", async () => {
    const resp = await httpGet(`${baseUrl}/environments`);
    assert.equal(resp.status, 200);
    const body = resp.body as { environments: Array<Record<string, unknown>> };
    assert.ok(Array.isArray(body.environments), "environments must be an array");

    // The entry must NOT appear as a live environment
    const ours = body.environments.find(
      (e) => e["taskId"] === taskId && e["projectTag"] === projId && !e["tornDownAt"]
    );
    assert.ok(
      !ours,
      `torn-down environment must not appear in live environments: ${JSON.stringify(body.environments)}`
    );
  });
});

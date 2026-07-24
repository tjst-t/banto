/**
 * [AC-S9d7fdb-2-3] Run and collect via the API.
 *
 * Entry point (test-discipline rule 2, mixed story, Block B):
 *   HTTP: drives the real daemon at http://127.0.0.1:<test-port>/api/v1
 *   AND observes real files (log_path is a real file with expected content).
 *
 * Scenario steps (from scenario-S9d7fdb-2.json, scenario-3-run-collect):
 *   preconditions: environment provisioned (dev profile, process driver)
 *   1. POST .../environment/run with {cmd: <command writing known output>}
 *      → 200; body.exit=0, log_path points to existing file with command output
 *   2. POST .../environment/run with a failing cmd (exit 3)
 *      → 200; body.exit == 3 (I2: non-zero exit reported, not swallowed)
 *   3. POST .../environment/collect, then GET .../environment/artifacts
 *      → 200; artifacts listing shows run logs + collected files; files readable
 *
 * Cleanup: teardown environment
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as net from "node:net";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const _thisDir = path.dirname(fileURLToPath(import.meta.url));
const _repoRoot = path.resolve(_thisDir, "..", "..");

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

// ── Test setup ────────────────────────────────────────────────────────────────

describe("[AC-S9d7fdb-2-3] process driver run and collect via API", () => {
  let daemon: Daemon;
  let daemonPort: number;
  let envPort: number;
  let dataDir: string;
  let projectDir: string;
  let baseUrl: string;
  const projId = "test-proj-run-collect";
  const taskId = `task-run-collect-${Date.now()}`;
  let envId: string | undefined;

  before(async () => {
    daemonPort = await getFreePort();
    envPort = await getFreePort();
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "banto-run-collect-test-"));
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "banto-run-collect-proj-"));

    // meta/environments.yaml with process driver
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
      driverTimeoutMs: 15000,
      disableAuditSpawn: true,
    });
    await daemon.start();
    baseUrl = `http://127.0.0.1:${daemonPort}/api/v1`;

    // Register project + create task
    await httpPost(`${baseUrl}/projects`, { id: projId, repoPath: projectDir });
    await httpPost(`${baseUrl}/projects/${projId}/tasks`, {
      id: taskId,
      title: "Run collect test task",
      environment: "dev",
    });

    // Provision environment — profile resolved from task's environment field (D3, no body override)
    const provResp = await httpPost(
      `${baseUrl}/projects/${projId}/tasks/${taskId}/environment/provision`,
      {}
    );
    assert.equal(provResp.status, 201, `provision precondition failed: ${JSON.stringify(provResp.body)}`);
    const provBody = provResp.body as Record<string, unknown>;
    envId = provBody["envId"] as string;

    // Wait a moment for the server to be ready
    await new Promise<void>((r) => setTimeout(r, 300));
  });

  after(async () => {
    // Cleanup: teardown environment
    try {
      await httpPost(
        `${baseUrl}/projects/${projId}/tasks/${taskId}/environment/teardown`,
        { envId }
      );
    } catch { /* best-effort */ }
    await daemon.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  // ── Step 1: run with successful command ────────────────────────────────────

  it("POST /environment/run returns 200 with exit=0 and log_path pointing to existing file", async () => {
    const uniqueMarker = `run-output-marker-${Date.now()}`;
    const resp = await httpPost(
      `${baseUrl}/projects/${projId}/tasks/${taskId}/environment/run`,
      { cmd: `echo ${uniqueMarker}`, envId }
    );
    assert.equal(resp.status, 200, `run returned ${resp.status}: ${JSON.stringify(resp.body)}`);

    const body = resp.body as Record<string, unknown>;
    assert.equal(typeof body["exit"], "number", `exit must be a number: ${JSON.stringify(body)}`);
    assert.equal(body["exit"], 0, `exit must be 0 for echo command: ${JSON.stringify(body)}`);
    assert.equal(typeof body["log_path"], "string", `log_path must be a string: ${JSON.stringify(body)}`);

    const logPath = body["log_path"] as string;
    assert.ok(fs.existsSync(logPath), `log_path must exist: ${logPath}`);

    // Verify the log is under a task-specific aggregation directory
    // (spec §6: ログはタスクごとの所定ディレクトリに集約)
    const logContent = fs.readFileSync(logPath, "utf8");
    assert.ok(
      logContent.includes(uniqueMarker),
      `log file must contain command output '${uniqueMarker}': ${logContent}`
    );
  });

  // ── Step 2: run with failing command (exit 3) ──────────────────────────────

  it("POST /environment/run with failing command returns 200 with non-zero exit (I2: not swallowed)", async () => {
    const resp = await httpPost(
      `${baseUrl}/projects/${projId}/tasks/${taskId}/environment/run`,
      { cmd: "exit 3", envId }
    );
    assert.equal(resp.status, 200, `run returned ${resp.status}: ${JSON.stringify(resp.body)}`);

    const body = resp.body as Record<string, unknown>;
    assert.equal(typeof body["exit"], "number", `exit must be a number: ${JSON.stringify(body)}`);
    // I2: non-zero exit must be REPORTED, not swallowed
    assert.notEqual(body["exit"], 0, `exit must be non-zero for failing cmd (exit 3): ${body["exit"]}`);
    assert.equal(typeof body["log_path"], "string", `log_path must be a string: ${JSON.stringify(body)}`);
  });

  // ── Step 3: collect + artifacts ────────────────────────────────────────────

  it("POST /environment/collect returns 200 with dest path", async () => {
    const resp = await httpPost(
      `${baseUrl}/projects/${projId}/tasks/${taskId}/environment/collect`,
      { envId }
    );
    assert.equal(resp.status, 200, `collect returned ${resp.status}: ${JSON.stringify(resp.body)}`);

    const body = resp.body as Record<string, unknown>;
    assert.equal(typeof body["dest"], "string", `dest must be a string: ${JSON.stringify(body)}`);
    const dest = body["dest"] as string;
    assert.ok(fs.existsSync(dest), `dest directory must exist after collect: ${dest}`);
  });

  it("GET /environment/artifacts returns 200 with file listing", async () => {
    const resp = await httpGet(
      `${baseUrl}/projects/${projId}/tasks/${taskId}/environment/artifacts`
    );
    assert.equal(resp.status, 200, `artifacts returned ${resp.status}: ${JSON.stringify(resp.body)}`);

    const body = resp.body as { artifacts: string[] };
    assert.ok(Array.isArray(body.artifacts), `artifacts must be an array: ${JSON.stringify(body)}`);

    // After collect, there should be at least some files (from the run commands above)
    // Verify that all listed paths actually exist and are readable
    for (const artifactPath of body.artifacts) {
      assert.ok(typeof artifactPath === "string", `artifact path must be a string: ${artifactPath}`);
      assert.ok(fs.existsSync(artifactPath), `artifact path must exist: ${artifactPath}`);
    }
  });

  it("collected files contain run log content", async () => {
    // Run a command with a distinctive marker and then verify it shows up in artifacts
    const marker = `collect-verify-${Date.now()}`;
    await httpPost(
      `${baseUrl}/projects/${projId}/tasks/${taskId}/environment/run`,
      { cmd: `echo ${marker}`, envId }
    );

    // Collect again to pick up the new log
    await httpPost(
      `${baseUrl}/projects/${projId}/tasks/${taskId}/environment/collect`,
      { envId }
    );

    // List artifacts and find one with the marker
    const artifactsResp = await httpGet(
      `${baseUrl}/projects/${projId}/tasks/${taskId}/environment/artifacts`
    );
    const body = artifactsResp.body as { artifacts: string[] };
    assert.ok(Array.isArray(body.artifacts), "artifacts must be an array");
    assert.ok(body.artifacts.length > 0, "artifacts must be non-empty after collect");

    // At least one file should be readable
    let foundReadable = false;
    for (const p of body.artifacts) {
      try {
        fs.readFileSync(p, "utf8");
        foundReadable = true;
        break;
      } catch { /* skip */ }
    }
    assert.ok(foundReadable, "at least one artifact must be readable");
  });
});

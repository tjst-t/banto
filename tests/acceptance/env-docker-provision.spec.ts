/**
 * [AC-S9d7fdb-3-1] Docker driver provision via the HTTP API and real docker observation.
 *
 * Entry point (test-discipline rule 2, mixed story — Block B/A):
 *   Block B — HTTP: drives the real daemon over HTTP at http://127.0.0.1:<test-port>/api/v1
 *   Block A — subprocess: `docker compose ls` is run from the test shell to observe the
 *             real docker daemon state (not driver output — independent observation per
 *             scenario-S9d7fdb-3.json scenario-1-provision-docker step 2).
 *
 * Scenario steps (from scenario-S9d7fdb-3.json, scenario-1-provision-docker):
 *   1. POST /api/v1/projects/:proj/tasks/:taskId/environment/provision → 201 + envId + healthcheck.ok
 *   2. shell: `docker compose ls --format json` → project with taskID prefix is running
 *   3. GET /api/v1/projects/:proj/events → env_provisioned event with taskId + profileName
 *
 * Cleanup: POST .../environment/teardown; docker compose ls no longer shows the project.
 *
 * AC-S9d7fdb-3-1: driver: docker profile provisions a taskID-prefixed compose project.
 *
 * Real docker required — test FAILS (not skips) if docker is unavailable.
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
const _repoRoot = path.resolve(_thisDir, "..", "..");
const COMPOSE_FIXTURE = path.join(_repoRoot, "tests", "fixtures", "docker", "test-compose.yaml");

import { Daemon } from "../../packages/banto-daemon/src/daemon.js";

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

/** Run a shell command synchronously and return stdout. Fails test if exit != 0. */
function runShell(cmd: string, args: string[]): { exitCode: number; stdout: string; stderr: string } {
  const result = childProcess.spawnSync(cmd, args, {
    encoding: "utf8",
    timeout: 30_000,
  });
  return {
    exitCode: result.status ?? -1,
    stdout: (result.stdout as string) ?? "",
    stderr: (result.stderr as string) ?? "",
  };
}

// ── Docker availability check — FAIL (not skip) if docker is absent ───────────

function assertDockerAvailable(): void {
  const r = runShell("docker", ["compose", "version"]);
  assert.equal(
    r.exitCode,
    0,
    `docker compose is not available on this host — ` +
      `test FAILS as required (I1: no skips). Error: ${r.stderr}`
  );
}

// ── Test suite ────────────────────────────────────────────────────────────────

describe("[AC-S9d7fdb-3-1] docker driver provision via API — real docker", () => {
  let daemon: Daemon;
  let daemonPort: number;
  let dataDir: string;
  let projectDir: string;
  let baseUrl: string;

  const projId = "test-proj-docker-provision";
  // Unique taskId per run to avoid cross-test pollution
  const taskId = `task-docker-prov-${Date.now()}`;
  let envId: string | undefined;
  let composeProjectName: string | undefined;

  before(async () => {
    // Fail fast if docker is not available (I1: no skips)
    assertDockerAvailable();

    daemonPort = await getFreePort();
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "banto-docker-prov-data-"));
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "banto-docker-prov-proj-"));

    // Create meta/environments.yaml with docker driver profile.
    // config.compose points to the fixture compose file.
    const metaDir = path.join(projectDir, "meta");
    fs.mkdirSync(metaDir, { recursive: true });
    const envFile = path.join(metaDir, "environments.yaml");
    fs.writeFileSync(
      envFile,
      [
        "profiles:",
        "  test:",
        "    driver: docker",
        `    config:`,
        `      compose: "${COMPOSE_FIXTURE}"`,
        "    ttl: 30m",
      ].join("\n") + "\n",
      "utf8"
    );

    // Create a task file referencing environment: test
    const tasksDir = path.join(projectDir, "work", "tasks");
    fs.mkdirSync(tasksDir, { recursive: true });
    fs.writeFileSync(
      path.join(tasksDir, `${taskId}.md`),
      `---\nid: ${taskId}\ntitle: Docker provision test task\nenvironment: test\n---\n\nTask content.\n`,
      "utf8"
    );

    daemon = Daemon.create({
      port: daemonPort,
      dataDir,
      watchIntervalMs: 500,
      tickIntervalMs: 60000,
      driverTimeoutMs: 60_000, // docker pull can be slow
      disableAuditSpawn: true,
    });
    await daemon.start();

    baseUrl = `http://127.0.0.1:${daemonPort}/api/v1`;

    // Register project
    const regResp = await httpPost(`${baseUrl}/projects`, {
      id: projId,
      repoPath: projectDir,
    });
    assert.equal(
      regResp.status,
      201,
      `project registration failed: ${JSON.stringify(regResp.body)}`
    );

    // Create task via API
    const taskResp = await httpPost(`${baseUrl}/projects/${projId}/tasks`, {
      id: taskId,
      title: "Docker provision test task",
      environment: "test",
    });
    assert.equal(
      taskResp.status,
      201,
      `task creation failed: ${JSON.stringify(taskResp.body)}`
    );
  });

  after(async () => {
    // Cleanup: teardown environment if still live
    if (envId) {
      try {
        await httpPost(
          `${baseUrl}/projects/${projId}/tasks/${taskId}/environment/teardown`,
          { envId }
        );
      } catch { /* best-effort */ }
    }
    // Belt-and-suspenders: tear down any leftover compose project directly
    if (composeProjectName) {
      runShell("docker", ["compose", "-p", composeProjectName, "down", "-v"]);
    }
    await daemon.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  // ── Step 1: POST provision ─────────────────────────────────────────────────

  it("POST /environment/provision returns 201 with envId, profileName=test, healthcheck.ok=true", async () => {
    // Profile is resolved from task `environment: test` field (D3: file is the source of truth)
    const resp = await httpPost(
      `${baseUrl}/projects/${projId}/tasks/${taskId}/environment/provision`,
      {}
    );
    assert.equal(
      resp.status,
      201,
      `expected 201, got ${resp.status}: ${JSON.stringify(resp.body)}`
    );

    const body = resp.body as Record<string, unknown>;
    assert.ok(
      typeof body["envId"] === "string" && body["envId"].length > 0,
      `envId must be a non-empty string: ${JSON.stringify(body)}`
    );
    assert.equal(body["profileName"], "test", `profileName must be 'test': ${JSON.stringify(body)}`);
    assert.ok(
      typeof body["healthcheck"] === "object" && body["healthcheck"] !== null,
      `healthcheck must be an object: ${JSON.stringify(body)}`
    );

    const hc = body["healthcheck"] as Record<string, unknown>;
    assert.equal(typeof hc["ok"], "boolean", `healthcheck.ok must be boolean: ${JSON.stringify(hc)}`);
    assert.ok(
      hc["ok"] === true,
      `healthcheck must be ok=true after provision: ${JSON.stringify(hc)}`
    );

    envId = body["envId"] as string;

    // Extract compose project name from the env ledger handle for later cleanup
    const liveEnvs = daemon.envLedger.listByTask(projId, taskId);
    if (liveEnvs.length > 0) {
      const handle = liveEnvs[0]!.handle as Record<string, unknown>;
      composeProjectName = handle["project"] as string | undefined;
    }
  });

  // ── Step 2: Shell observation — docker compose ls shows taskID-prefixed project ──

  it("docker compose ls shows a running project with taskID prefix (real docker observation)", () => {
    assert.ok(envId, "envId must be set (provision must pass first)");

    // Run `docker compose ls --format json` from the test shell (not the driver)
    // This is an INDEPENDENT observation of the real docker daemon state.
    const r = runShell("docker", ["compose", "ls", "--format", "json"]);
    assert.equal(
      r.exitCode,
      0,
      `docker compose ls failed (exit ${r.exitCode}): ${r.stderr}`
    );

    let projects: Array<{ Name: string; Status: string; ConfigFiles: string }>;
    try {
      const parsed = JSON.parse(r.stdout.trim());
      projects = Array.isArray(parsed) ? parsed : [parsed];
    } catch {
      assert.fail(`docker compose ls output is not valid JSON: ${r.stdout}`);
    }

    // Find a project whose name starts with the taskId (I3: taskID-prefixed naming)
    const ours = projects.find((p) => p.Name.startsWith(taskId));
    assert.ok(
      ours !== undefined,
      `docker compose ls must show a project starting with taskId="${taskId}": ` +
        `found projects=${JSON.stringify(projects.map((p) => p.Name))}`
    );

    // Must be in running state
    assert.ok(
      ours.Status.toLowerCase().includes("running"),
      `compose project "${ours.Name}" must be in running state: ${ours.Status}`
    );
  });

  // ── Step 3: GET events → env_provisioned ────────────────────────────────────

  it("env_provisioned event appears in project events", async () => {
    assert.ok(envId, "envId must be set (provision must pass first)");

    const resp = await httpGet(`${baseUrl}/projects/${projId}/events`);
    assert.equal(resp.status, 200, `events endpoint failed: ${JSON.stringify(resp.body)}`);

    const body = resp.body as { events: Array<Record<string, unknown>> };
    assert.ok(Array.isArray(body.events), "events must be an array");

    const provisionedEvent = body.events.find(
      (e) => e["type"] === "env_provisioned" && e["taskId"] === taskId
    );
    assert.ok(
      provisionedEvent !== undefined,
      `env_provisioned event for taskId=${taskId} must be in project events: ` +
        `${JSON.stringify(body.events.map((e) => ({ type: e["type"], taskId: e["taskId"] })))}`
    );
    assert.equal(
      provisionedEvent!["profileName"],
      "test",
      `event profileName must be 'test': ${JSON.stringify(provisionedEvent)}`
    );
  });

  // ── Cleanup step: teardown + docker compose ls no longer shows the project ──

  it("POST /environment/teardown succeeds and docker compose ls no longer shows the project", async () => {
    assert.ok(envId, "envId must be set");

    const resp = await httpPost(
      `${baseUrl}/projects/${projId}/tasks/${taskId}/environment/teardown`,
      { envId }
    );
    assert.equal(
      resp.status,
      200,
      `teardown failed: ${JSON.stringify(resp.body)}`
    );

    const body = resp.body as Record<string, unknown>;
    assert.equal(body["status"], "torn_down", `teardown status must be torn_down: ${JSON.stringify(body)}`);

    // Allow teardown to fully complete
    await new Promise<void>((r) => setTimeout(r, 1000));

    // Verify docker compose ls no longer shows the project (real docker observation)
    const r = runShell("docker", ["compose", "ls", "--format", "json"]);
    assert.equal(r.exitCode, 0, `docker compose ls failed: ${r.stderr}`);

    let projects: Array<{ Name: string }> = [];
    if (r.stdout.trim()) {
      try {
        const parsed = JSON.parse(r.stdout.trim());
        projects = Array.isArray(parsed) ? parsed : [parsed];
      } catch { /* empty output after teardown is fine */ }
    }

    const ours = projects.find((p) => p.Name.startsWith(taskId));
    assert.ok(
      !ours,
      `docker compose ls must NOT show a project for taskId="${taskId}" after teardown: ` +
        `found=${JSON.stringify(projects.map((p) => p.Name))}`
    );

    // Clear envId so after() doesn't attempt a double teardown
    envId = undefined;
    composeProjectName = undefined;
  });
});

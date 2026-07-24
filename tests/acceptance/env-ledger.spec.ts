/**
 * [AC-S9d7fdb-4-1] Ledger registration on successful provision.
 *
 * Entry point (test-discipline rule 2, api story):
 *   Real HTTP client against a running daemon at http://127.0.0.1:<test-port>/api/v1.
 *
 * Scenario (scenario-S9d7fdb-4.json, scenario-1-ledger-register):
 *   1. POST /environment/provision → 201 with envId
 *   2. GET /environments → entry with envId, projectTag, taskId, profileName, createdAt, ttlDeadline
 *   3. Read ledger file on disk → atomic-write JSON {version, entries} with all required fields
 *      GET /projects/:proj/events → env_provisioned event recorded
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

// ── Test ─────────────────────────────────────────────────────────────────────

describe("[AC-S9d7fdb-4-1] ledger registration on provision", () => {
  let daemon: Daemon;
  let daemonPort: number;
  let envPort: number;
  let dataDir: string;
  let projectDir: string;
  let baseUrl: string;
  const projId = "ledger-reg-proj";
  const taskId = `task-ledger-reg-${Date.now()}`;
  let envId: string | undefined;

  before(async () => {
    daemonPort = await getFreePort();
    envPort = await getFreePort();
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "banto-ledger-reg-"));
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "banto-ledger-reg-proj-"));

    const metaDir = path.join(projectDir, "meta");
    fs.mkdirSync(metaDir, { recursive: true });
    // Profile with a 1h TTL — daemon will record ttlDeadline = createdAt + 3600000ms
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
      `---\nid: ${taskId}\ntitle: Ledger reg test\nenvironment: dev\n---\nContent.\n`,
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

    const regResp = await httpPost(`${baseUrl}/projects`, { id: projId, repoPath: projectDir });
    assert.equal(regResp.status, 201, `project registration: ${JSON.stringify(regResp.body)}`);

    const taskResp = await httpPost(`${baseUrl}/projects/${projId}/tasks`, {
      id: taskId, title: "Ledger reg test", environment: "dev",
    });
    assert.equal(taskResp.status, 201, `task creation: ${JSON.stringify(taskResp.body)}`);
  });

  after(async () => {
    if (envId) {
      try { await httpPost(`${baseUrl}/projects/${projId}/tasks/${taskId}/environment/teardown`, { envId }); } catch { /* best-effort */ }
    }
    await daemon.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  it("POST /environment/provision returns 201 with envId", async () => {
    const resp = await httpPost(
      `${baseUrl}/projects/${projId}/tasks/${taskId}/environment/provision`,
      {}
    );
    assert.equal(resp.status, 201, `provision: ${JSON.stringify(resp.body)}`);
    const body = resp.body as Record<string, unknown>;
    assert.ok(typeof body["envId"] === "string" && body["envId"].length > 0, "envId must be non-empty string");
    envId = body["envId"] as string;
  });

  it("GET /environments lists the entry with all required ledger fields", async () => {
    assert.ok(envId, "envId must be set");
    const resp = await httpGet(`${baseUrl}/environments`);
    assert.equal(resp.status, 200, `environments: ${JSON.stringify(resp.body)}`);
    const body = resp.body as { environments: Array<Record<string, unknown>> };
    assert.ok(Array.isArray(body.environments), "environments must be array");

    const entry = body.environments.find((e) => e["envId"] === envId);
    assert.ok(entry, `entry for envId=${envId} must be in list: ${JSON.stringify(body.environments)}`);

    // Verify all required fields
    assert.equal(entry!["projectTag"], projId, "projectTag");
    assert.equal(entry!["taskId"], taskId, "taskId");
    assert.equal(entry!["profileName"], "dev", "profileName");
    assert.ok(typeof entry!["createdAt"] === "string" && entry!["createdAt"].length > 0, "createdAt must be ISO string");
    // S9d7fdb-4: ttlDeadline must be present and > createdAt
    assert.ok(typeof entry!["ttlDeadline"] === "string" && entry!["ttlDeadline"].length > 0, "ttlDeadline must be ISO string");
    const createdMs = Date.parse(entry!["createdAt"] as string);
    const deadlineMs = Date.parse(entry!["ttlDeadline"] as string);
    assert.ok(deadlineMs > createdMs, `ttlDeadline (${entry!["ttlDeadline"]}) must be after createdAt (${entry!["createdAt"]})`);
  });

  it("ledger file on disk has atomic-write JSON format with ttlDeadline", async () => {
    const ledgerPath = path.join(dataDir, "env-ledger.json");
    assert.ok(fs.existsSync(ledgerPath), "env-ledger.json must exist on disk");

    const raw = fs.readFileSync(ledgerPath, "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    assert.equal(parsed["version"], 1, "ledger version must be 1");
    assert.ok(Array.isArray(parsed["entries"]), "entries must be array");

    const entries = parsed["entries"] as Array<Record<string, unknown>>;
    const diskEntry = entries.find((e) => e["envId"] === envId);
    assert.ok(diskEntry, `envId=${envId} must be in disk ledger`);
    assert.ok(typeof diskEntry!["ttlDeadline"] === "string", "ttlDeadline must be in disk entry");
    assert.ok(typeof diskEntry!["createdAt"] === "string", "createdAt must be in disk entry");
    assert.ok(typeof diskEntry!["handle"] === "object", "handle must be in disk entry");
    assert.ok(typeof diskEntry!["driver"] === "string", "driver must be in disk entry");
  });

  it("env_provisioned event appears in project events", async () => {
    const resp = await httpGet(`${baseUrl}/projects/${projId}/events`);
    assert.equal(resp.status, 200, `events: ${JSON.stringify(resp.body)}`);
    const body = resp.body as { events: Array<Record<string, unknown>> };
    const provEvent = body.events.find((e) => e["type"] === "env_provisioned" && e["taskId"] === taskId);
    assert.ok(provEvent, `env_provisioned event for taskId=${taskId} must be in events`);
    assert.equal(provEvent!["profileName"], "dev", "event profileName");
    assert.equal(provEvent!["projectTag"], projId, "event projectTag");
  });
});

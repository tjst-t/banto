/**
 * [AC-S9d7fdb-6-3] sops decryption failure → provision fails with reason; no environment created.
 *
 * Entry point (test-discipline rule 2, api story):
 *   Real HTTP client against the running daemon; real sops + age (I1: no mocking).
 *
 * Scenario steps (scenario-S9d7fdb-6.json, scenario-3-decrypt-failure):
 *   Step A — missing credentials file:
 *     POST provision with credentials reference whose encrypted file does not exist.
 *     Expected: 502; error message names the missing credentials; no env_provisioned event;
 *     no new env ledger entry; no driver process started.
 *
 *   Step B — wrong/missing age key:
 *     Encrypted file exists but daemon started without the correct SOPS_AGE_KEY_FILE.
 *     Expected: 502 with decryption-failure reason; no environment created; no silent proceed.
 *
 * I2: credentials failure is always surfaced (provision fails, env_provision_failed event emitted).
 * No partial state: if credentials cannot be decrypted, no ledger entry is written.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as net from "node:net";
import * as crypto from "node:crypto";
import * as childProcess from "node:child_process";
import { fileURLToPath } from "node:url";

const _thisDir = path.dirname(fileURLToPath(import.meta.url));
const _repoRoot = path.resolve(_thisDir, "..", "..");
const _driverPath = path.join(_repoRoot, "tests", "fixtures", "env-proof-driver", "env-proof-driver.ts");

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
  const data = await resp.json().catch(() => null);
  return { status: resp.status, body: data };
}

async function httpGet(url: string): Promise<{ status: number; body: unknown }> {
  const resp = await fetch(url);
  const data = await resp.json().catch(() => null);
  return { status: resp.status, body: data };
}

function generateAgeKeypair(dir: string): { privateKeyFile: string; publicKey: string } {
  const privateKeyFile = path.join(dir, "age-test-key.txt");
  const result = childProcess.spawnSync("age-keygen", ["-o", privateKeyFile], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`age-keygen failed: ${result.stderr}`);
  const match = result.stderr.match(/Public key:\s*(age1\S+)/);
  if (!match) throw new Error(`age-keygen output did not contain public key: ${result.stderr}`);
  return { privateKeyFile, publicKey: match[1]! };
}

function sopsEncrypt(filePath: string, plaintext: string, agePublicKey: string, tmpDir: string): void {
  const plaintextFile = path.join(tmpDir, `plaintext-${Date.now()}.yaml`);
  fs.writeFileSync(plaintextFile, plaintext, "utf8");
  try {
    const result = childProcess.spawnSync(
      "sops",
      ["--encrypt", "--age", agePublicKey, "--output", filePath, plaintextFile],
      { encoding: "utf8" }
    );
    if (result.status !== 0) throw new Error(`sops encrypt failed (exit ${result.status}): ${result.stderr}`);
  } finally {
    try { fs.unlinkSync(plaintextFile); } catch { /* best-effort */ }
  }
}

// ── Suite A: missing credentials file ────────────────────────────────────────

describe("[AC-S9d7fdb-6-3-A] missing credentials file → provision fails, no env created", () => {
  let daemon: Daemon;
  let daemonPort: number;
  let dataDir: string;
  let projectDir: string;
  let keyDir: string;
  let baseUrl: string;
  const projId = "test-proj-sops-missing-cred";
  const taskId = `task-creds-missing-${Date.now()}`;

  before(async () => {
    daemonPort = await getFreePort();
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "banto-failA-test-"));
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "banto-failA-proj-"));
    keyDir = fs.mkdtempSync(path.join(os.tmpdir(), "banto-failA-keys-"));

    const { privateKeyFile, publicKey: _publicKey } = generateAgeKeypair(keyDir);

    // Create meta dir but DO NOT create the credentials file (the reference "missing-creds" does not exist).
    const metaDir = path.join(projectDir, "meta");
    fs.mkdirSync(metaDir, { recursive: true });
    // Also create the credentials dir but leave it empty.
    fs.mkdirSync(path.join(metaDir, "credentials"), { recursive: true });

    fs.writeFileSync(
      path.join(metaDir, "environments.yaml"),
      [
        "profiles:",
        "  secured:",
        `    driver: "${_driverPath}"`,
        "    credentials: missing-creds",   // <── this file does not exist
        "    ttl: 1h",
      ].join("\n") + "\n",
      "utf8"
    );

    const tasksDir = path.join(projectDir, "work", "tasks");
    fs.mkdirSync(tasksDir, { recursive: true });
    fs.writeFileSync(
      path.join(tasksDir, `${taskId}.md`),
      `---\nid: ${taskId}\ntitle: Missing creds test\nenvironment: secured\n---\n\nTask body.\n`,
      "utf8"
    );

    daemon = Daemon.create({
      port: daemonPort,
      dataDir,
      watchIntervalMs: 500,
      tickIntervalMs: 60000,
      driverTimeoutMs: 10000,
      disableAuditSpawn: true,
      sopsAgeKeyFile: privateKeyFile,
    });
    await daemon.start();

    baseUrl = `http://127.0.0.1:${daemonPort}/api/v1`;

    const regResp = await httpPost(`${baseUrl}/projects`, { id: projId, repoPath: projectDir });
    assert.equal(regResp.status, 201, `project registration failed: ${JSON.stringify(regResp.body)}`);

    const taskResp = await httpPost(`${baseUrl}/projects/${projId}/tasks`, {
      id: taskId,
      title: "Missing creds test",
      environment: "secured",
    });
    assert.equal(taskResp.status, 201, `task creation failed: ${JSON.stringify(taskResp.body)}`);
  });

  after(async () => {
    await daemon.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(projectDir, { recursive: true, force: true });
    fs.rmSync(keyDir, { recursive: true, force: true });
  });

  it("POST provision returns 5xx when credentials file is missing", async () => {
    const resp = await httpPost(
      `${baseUrl}/projects/${projId}/tasks/${taskId}/environment/provision`,
      {}
    );
    // Must fail (5xx range) — not 201
    assert.ok(
      resp.status >= 500 && resp.status < 600,
      `expected 5xx, got ${resp.status}: ${JSON.stringify(resp.body)}`
    );

    const body = resp.body as Record<string, unknown>;
    // Error message must name the credentials reference or reason
    const errorStr = JSON.stringify(body);
    assert.ok(
      errorStr.includes("missing-creds") || errorStr.includes("credentials") || errorStr.includes("not found"),
      `error must name the missing credentials reference: ${errorStr.slice(0, 500)}`
    );
  });

  it("GET /environments has no new entry after provision failure", async () => {
    const resp = await httpGet(`${baseUrl}/environments`);
    assert.equal(resp.status, 200, `GET /environments failed: ${JSON.stringify(resp.body)}`);
    // GET /environments returns { environments: [...] }
    const bodyRec = resp.body as Record<string, unknown>;
    const envs = bodyRec["environments"] as unknown[] | undefined;
    assert.ok(Array.isArray(envs), `environments must be an array, got: ${JSON.stringify(bodyRec)}`);
    // No environment should be registered for this task
    const found = envs.filter((e) => {
      const rec = e as Record<string, unknown>;
      return rec["taskId"] === taskId;
    });
    assert.deepEqual(
      found,
      [],
      `No environments must be created after credentials failure, but found: ${JSON.stringify(found)}`
    );
  });

  it("GET events contains env_provision_failed event for this task (not env_provisioned)", async () => {
    const resp = await httpGet(`${baseUrl}/projects/${projId}/events`);
    assert.equal(resp.status, 200, `GET events failed: ${JSON.stringify(resp.body)}`);
    // GET /projects/:proj/events returns { events: [...] }
    const bodyRec = resp.body as Record<string, unknown>;
    const events = bodyRec["events"] as unknown[] | undefined;
    assert.ok(Array.isArray(events), `events must be an array, got: ${JSON.stringify(bodyRec)}`);

    // Must have env_provision_failed
    const failed = events.filter((e) => {
      const rec = e as Record<string, unknown>;
      return rec["type"] === "env_provision_failed" && rec["taskId"] === taskId;
    });
    assert.ok(failed.length > 0, `must have env_provision_failed event for taskId=${taskId}`);

    // Must NOT have env_provisioned
    const provisioned = events.filter((e) => {
      const rec = e as Record<string, unknown>;
      return rec["type"] === "env_provisioned" && rec["taskId"] === taskId;
    });
    assert.deepEqual(
      provisioned,
      [],
      `must NOT have env_provisioned event when credentials fail: ${JSON.stringify(provisioned)}`
    );
  });
});

// ── Suite B: wrong/missing age key → sops decryption fails ───────────────────

describe("[AC-S9d7fdb-6-3-B] wrong age key → provision fails; no silent proceed", () => {
  let daemon: Daemon;
  let daemonPort: number;
  let dataDir: string;
  let projectDir: string;
  let keyDirCorrect: string;
  let keyDirWrong: string;
  let baseUrl: string;
  const projId = "test-proj-sops-wrongkey";
  const taskId = `task-creds-wrongkey-${Date.now()}`;
  const knownSecret = `test-secret-${crypto.randomBytes(8).toString("hex")}`;

  before(async () => {
    daemonPort = await getFreePort();
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "banto-failB-test-"));
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "banto-failB-proj-"));
    keyDirCorrect = fs.mkdtempSync(path.join(os.tmpdir(), "banto-failB-correct-keys-"));
    keyDirWrong = fs.mkdtempSync(path.join(os.tmpdir(), "banto-failB-wrong-keys-"));

    // Generate TWO keypairs: one used for encryption (correct), one given to daemon (wrong).
    const { privateKeyFile: _correctKey, publicKey: correctPublicKey } = generateAgeKeypair(keyDirCorrect);
    const { privateKeyFile: wrongKeyFile } = generateAgeKeypair(keyDirWrong);

    // Encrypt the credentials with the CORRECT public key
    const credDir = path.join(projectDir, "meta", "credentials");
    fs.mkdirSync(credDir, { recursive: true });
    const encryptedCredsFile = path.join(credDir, "staging-creds.yaml");
    sopsEncrypt(encryptedCredsFile, `TEST_SECRET: "${knownSecret}"\n`, correctPublicKey, keyDirCorrect);

    const metaDir = path.join(projectDir, "meta");
    fs.writeFileSync(
      path.join(metaDir, "environments.yaml"),
      [
        "profiles:",
        "  secured:",
        `    driver: "${_driverPath}"`,
        "    credentials: staging-creds",
        "    ttl: 1h",
      ].join("\n") + "\n",
      "utf8"
    );

    const tasksDir = path.join(projectDir, "work", "tasks");
    fs.mkdirSync(tasksDir, { recursive: true });
    fs.writeFileSync(
      path.join(tasksDir, `${taskId}.md`),
      `---\nid: ${taskId}\ntitle: Wrong key test\nenvironment: secured\n---\n\nTask body.\n`,
      "utf8"
    );

    // Start daemon with the WRONG key — sops decryption must fail
    daemon = Daemon.create({
      port: daemonPort,
      dataDir,
      watchIntervalMs: 500,
      tickIntervalMs: 60000,
      driverTimeoutMs: 10000,
      disableAuditSpawn: true,
      sopsAgeKeyFile: wrongKeyFile,  // <── wrong key: cannot decrypt
    });
    await daemon.start();

    baseUrl = `http://127.0.0.1:${daemonPort}/api/v1`;

    const regResp = await httpPost(`${baseUrl}/projects`, { id: projId, repoPath: projectDir });
    assert.equal(regResp.status, 201, `project registration failed: ${JSON.stringify(regResp.body)}`);

    const taskResp = await httpPost(`${baseUrl}/projects/${projId}/tasks`, {
      id: taskId,
      title: "Wrong key test",
      environment: "secured",
    });
    assert.equal(taskResp.status, 201, `task creation failed: ${JSON.stringify(taskResp.body)}`);
  });

  after(async () => {
    await daemon.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(projectDir, { recursive: true, force: true });
    fs.rmSync(keyDirCorrect, { recursive: true, force: true });
    fs.rmSync(keyDirWrong, { recursive: true, force: true });
  });

  it("POST provision returns 5xx when age key is wrong (cannot decrypt)", async () => {
    const resp = await httpPost(
      `${baseUrl}/projects/${projId}/tasks/${taskId}/environment/provision`,
      {}
    );
    // Must fail — sops cannot decrypt with the wrong key
    assert.ok(
      resp.status >= 500 && resp.status < 600,
      `expected 5xx when key is wrong, got ${resp.status}: ${JSON.stringify(resp.body)}`
    );

    const body = resp.body as Record<string, unknown>;
    const errorStr = JSON.stringify(body);
    // Error must indicate decryption failure (not a silent empty result)
    assert.ok(
      errorStr.includes("sops") || errorStr.includes("decrypt") || errorStr.includes("credentials") || errorStr.includes("error"),
      `error must indicate decryption failure: ${errorStr.slice(0, 500)}`
    );
  });

  it("GET /environments has no entry after wrong-key provision failure", async () => {
    const resp = await httpGet(`${baseUrl}/environments`);
    assert.equal(resp.status, 200);
    const bodyRec = resp.body as Record<string, unknown>;
    const envs = bodyRec["environments"] as unknown[] | undefined;
    assert.ok(Array.isArray(envs), `environments must be an array, got: ${JSON.stringify(bodyRec)}`);
    const found = envs.filter((e) => (e as Record<string, unknown>)["taskId"] === taskId);
    assert.deepEqual(
      found,
      [],
      `No environments must be created when decryption fails: ${JSON.stringify(found)}`
    );
  });

  it("env_provision_failed event is emitted (I2: failure surfaced, not swallowed)", async () => {
    const resp = await httpGet(`${baseUrl}/projects/${projId}/events`);
    assert.equal(resp.status, 200);
    const bodyRec = resp.body as Record<string, unknown>;
    const events = bodyRec["events"] as unknown[] | undefined;
    assert.ok(Array.isArray(events), `events must be an array, got: ${JSON.stringify(bodyRec)}`);

    const failed = events.filter((e) => {
      const rec = e as Record<string, unknown>;
      return rec["type"] === "env_provision_failed" && rec["taskId"] === taskId;
    });
    assert.ok(failed.length > 0, `must have env_provision_failed event; got events: ${JSON.stringify(events.slice(0, 5))}`);

    // Must NOT have env_provisioned (no partial success)
    const provisioned = events.filter((e) => {
      const rec = e as Record<string, unknown>;
      return rec["type"] === "env_provisioned" && rec["taskId"] === taskId;
    });
    assert.deepEqual(provisioned, [], "must NOT have env_provisioned when decryption fails");

    // The event reason must NOT contain the plaintext secret (even in error messages)
    for (const ev of events) {
      const evStr = JSON.stringify(ev);
      assert.ok(
        !evStr.includes(knownSecret),
        `event must not contain plaintext secret: ${evStr.slice(0, 300)}`
      );
    }
  });
});

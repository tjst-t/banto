/**
 * [AC-S9d7fdb-6-2] Credential plaintext values do not appear in any observable or persisted
 * surface: event logs, API responses, env ledger, run-log artifacts, or session JSONL.
 *
 * Entry point (test-discipline rule 2, api story):
 *   Real HTTP client against the running daemon; real sops + age decryption (I1: no mocking).
 *   Real grep across all persisted files after a full provision + run + collect cycle.
 *
 * Scenario steps (scenario-S9d7fdb-6.json, scenario-2-no-leak-grep):
 *   1. Provision environment (same setup as AC-1 with real sops).
 *   2. Run a command in the environment.
 *   3. Collect artifacts.
 *   4. API responses: grep all responses for the known secret value → 0 occurrences.
 *   5. File grep: event log files, env ledger, artifact dir, session JSONL → 0 occurrences.
 *
 * The known secret value is a random string. If it appears anywhere, the test fails.
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

async function httpPost(url: string, reqBody: unknown): Promise<{ status: number; bodyText: string; body: unknown }> {
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(reqBody),
  });
  const bodyText = await resp.text();
  let body: unknown = null;
  try { body = JSON.parse(bodyText); } catch { /* keep null */ }
  return { status: resp.status, bodyText, body };
}

async function httpGetRaw(url: string): Promise<{ status: number; bodyText: string; body: unknown }> {
  const resp = await fetch(url);
  const bodyText = await resp.text();
  let body: unknown = null;
  try { body = JSON.parse(bodyText); } catch { /* keep null */ }
  return { status: resp.status, bodyText, body };
}

function generateAgeKeypair(dir: string): { privateKeyFile: string; publicKey: string } {
  const privateKeyFile = path.join(dir, "age-test-key.txt");
  const result = childProcess.spawnSync("age-keygen", ["-o", privateKeyFile], { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`age-keygen failed: ${result.stderr}`);
  }
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
    if (result.status !== 0) {
      throw new Error(`sops encrypt failed (exit ${result.status}): ${result.stderr}`);
    }
  } finally {
    try { fs.unlinkSync(plaintextFile); } catch { /* best-effort */ }
  }
}

/**
 * Recursively list all files under a directory.
 */
function listFilesRecursive(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const result: string[] = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) result.push(...listFilesRecursive(full));
    else result.push(full);
  }
  return result;
}

/**
 * Search for a string in all files under a directory.
 * Returns file paths where the string was found.
 */
function grepFilesForString(dir: string, needle: string): string[] {
  const files = listFilesRecursive(dir);
  const hits: string[] = [];
  for (const file of files) {
    try {
      const content = fs.readFileSync(file, "utf8");
      if (content.includes(needle)) {
        hits.push(file);
      }
    } catch {
      // Ignore unreadable files (binary, etc.)
    }
  }
  return hits;
}

// ── Test setup ────────────────────────────────────────────────────────────────

describe("[AC-S9d7fdb-6-2] credential plaintext never appears in any observable surface", () => {
  let daemon: Daemon;
  let daemonPort: number;
  let dataDir: string;
  let projectDir: string;
  let keyDir: string;
  let baseUrl: string;
  const projId = "test-proj-sops-noleak";
  const taskId = `task-creds-noleak-${Date.now()}`;
  let envId: string | undefined;

  /** The known secret value — used as the search needle for grep. */
  const knownSecret = `test-secret-value-${crypto.randomBytes(12).toString("hex")}`;

  /** Accumulate all API response texts for the final grep check. */
  const apiResponseTexts: string[] = [];

  before(async () => {
    daemonPort = await getFreePort();
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "banto-noleak-test-"));
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "banto-noleak-proj-"));
    keyDir = fs.mkdtempSync(path.join(os.tmpdir(), "banto-noleak-keys-"));

    // 1. Generate age keypair
    const { privateKeyFile, publicKey } = generateAgeKeypair(keyDir);

    // 2. Create encrypted credentials
    const credDir = path.join(projectDir, "meta", "credentials");
    fs.mkdirSync(credDir, { recursive: true });
    const encryptedCredsFile = path.join(credDir, "staging-creds.yaml");
    sopsEncrypt(
      encryptedCredsFile,
      `TEST_SECRET: "${knownSecret}"\n`,
      publicKey,
      keyDir
    );

    // 3. Create meta/environments.yaml
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

    // 4. Create task file
    const tasksDir = path.join(projectDir, "work", "tasks");
    fs.mkdirSync(tasksDir, { recursive: true });
    fs.writeFileSync(
      path.join(tasksDir, `${taskId}.md`),
      `---\nid: ${taskId}\ntitle: No-leak test task\nenvironment: secured\n---\n\nTask body.\n`,
      "utf8"
    );

    // 5. Start daemon
    daemon = Daemon.create({
      port: daemonPort,
      dataDir,
      watchIntervalMs: 500,
      tickIntervalMs: 60000,
      driverTimeoutMs: 15000,
      disableAuditSpawn: true,
      sopsAgeKeyFile: privateKeyFile,
    });
    await daemon.start();

    baseUrl = `http://127.0.0.1:${daemonPort}/api/v1`;

    const regResp = await httpPost(`${baseUrl}/projects`, { id: projId, repoPath: projectDir });
    apiResponseTexts.push(regResp.bodyText);
    assert.equal(regResp.status, 201, `project registration failed: ${JSON.stringify(regResp.body)}`);

    const taskResp = await httpPost(`${baseUrl}/projects/${projId}/tasks`, {
      id: taskId,
      title: "No-leak test task",
      environment: "secured",
    });
    apiResponseTexts.push(taskResp.bodyText);
    assert.equal(taskResp.status, 201, `task creation failed: ${JSON.stringify(taskResp.body)}`);
  });

  after(async () => {
    if (envId) {
      try {
        const r = await httpPost(`${baseUrl}/projects/${projId}/tasks/${taskId}/environment/teardown`, { envId });
        apiResponseTexts.push(r.bodyText);
      } catch { /* best-effort */ }
    }
    await daemon.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(projectDir, { recursive: true, force: true });
    fs.rmSync(keyDir, { recursive: true, force: true });
  });

  // ── Step 1: Provision ──────────────────────────────────────────────────────

  it("POST provision succeeds and collects API response for grep", async () => {
    const resp = await httpPost(
      `${baseUrl}/projects/${projId}/tasks/${taskId}/environment/provision`,
      {}
    );
    apiResponseTexts.push(resp.bodyText);
    assert.equal(resp.status, 201, `expected 201, got ${resp.status}: ${resp.bodyText.slice(0, 500)}`);
    const body = resp.body as Record<string, unknown>;
    envId = body["envId"] as string;
    assert.ok(envId, "envId must be set");
  });

  // ── Step 2: Run command in environment ────────────────────────────────────

  it("POST run command in environment (collect API response for grep)", async () => {
    assert.ok(envId, "envId must be set");
    const resp = await httpPost(
      `${baseUrl}/projects/${projId}/tasks/${taskId}/environment/run`,
      { cmd: "echo test-run-command" }
    );
    apiResponseTexts.push(resp.bodyText);
    // Driver may or may not return 200 depending on implementation; we just collect the response.
    // Non-200 is acceptable here — the key is that the response body doesn't contain the secret.
  });

  // ── Step 3: Collect artifacts ─────────────────────────────────────────────

  it("POST collect artifacts (collect API response for grep)", async () => {
    assert.ok(envId, "envId must be set");
    const resp = await httpPost(
      `${baseUrl}/projects/${projId}/tasks/${taskId}/environment/collect`,
      {}
    );
    apiResponseTexts.push(resp.bodyText);
  });

  // ── Step 4: Collect all API responses and grep for the secret ─────────────

  it("GET all events and environments API responses — secret must not appear", async () => {
    assert.ok(envId, "envId must be set");

    // Collect all relevant API endpoints
    const endpoints = [
      `${baseUrl}/events`,
      `${baseUrl}/projects/${projId}/events`,
      `${baseUrl}/environments`,
      `${baseUrl}/projects/${projId}/environments`,
      `${baseUrl}/projects/${projId}/tasks/${taskId}`,
    ];

    for (const url of endpoints) {
      const r = await httpGetRaw(url);
      apiResponseTexts.push(r.bodyText);
    }

    // Also collect artifacts listing
    const artResp = await httpGetRaw(`${baseUrl}/projects/${projId}/tasks/${taskId}/environment/artifacts`);
    apiResponseTexts.push(artResp.bodyText);

    // GREP ALL API RESPONSES for the known secret value
    for (let i = 0; i < apiResponseTexts.length; i++) {
      const text = apiResponseTexts[i]!;
      assert.ok(
        !text.includes(knownSecret),
        `API response #${i} must NOT contain the plaintext secret. Found in: "${text.slice(0, 300)}"`
      );
    }
  });

  // ── Step 5: Grep all persisted files ──────────────────────────────────────

  it("persisted files (event log, ledger, artifacts, session JSONL) do not contain the secret", () => {
    // Wait a moment for any async writes to flush
    // (all operations above are synchronous at the caller level via await)

    // 1. Grep the entire dataDir for the known secret
    const dataDirHits = grepFilesForString(dataDir, knownSecret);
    assert.deepEqual(
      dataDirHits,
      [],
      `Found plaintext secret in dataDir files: ${dataDirHits.join(", ")}`
    );

    // 2. Grep the projectDir for the known secret
    //    (the sops-encrypted file itself contains ciphertext, NOT plaintext —
    //     so this also verifies sops encryption is working).
    //    We exclude the key file (keyDir is separate and has already been cleaned up in tests
    //    that run first; we're checking projectDir here).
    const projDirHits = grepFilesForString(projectDir, knownSecret);
    // The plaintext secret must not appear in any file under projectDir.
    // The encrypted credentials file contains ciphertext only (not plaintext).
    assert.deepEqual(
      projDirHits,
      [],
      `Found plaintext secret in projectDir files: ${projDirHits.join(", ")}`
    );
  });
});

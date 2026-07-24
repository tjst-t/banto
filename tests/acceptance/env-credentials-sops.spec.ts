/**
 * [AC-S9d7fdb-6-1] credentials in environments.yaml are a reference name only;
 * daemon decrypts via sops (real age key) and injects values into driver spawn env.
 *
 * Entry point (test-discipline rule 2, api story):
 *   Real HTTP client against the running daemon; real sops + age decryption (I1: no mocking).
 *
 * Scenario steps (scenario-S9d7fdb-6.json, scenario-1-sops-injection):
 *   1. Setup: generate age keypair; encrypt a YAML secrets file with sops+age;
 *      create environments.yaml with credentials: staging-creds.
 *   2. POST .../environment/provision → 201; healthcheck.detail contains sha256 of the
 *      known secret — proves driver process received TEST_SECRET via spawn env.
 *   3. GET /api/v1/projects/:proj/environments → credentials field shows reference name only.
 *
 * Cleanup: teardown environment.
 *
 * D6: real sops + age binaries (pre-installed); no npm crypto/sops dep.
 * I1: decryption is NOT mocked; this test fails if sops or age is missing.
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

function sha256hex(input: string): string {
  return crypto.createHash("sha256").update(input, "utf8").digest("hex");
}

/** Generate an age keypair using `age-keygen`. Returns { privateKeyFile, publicKey }. */
function generateAgeKeypair(dir: string): { privateKeyFile: string; publicKey: string } {
  const privateKeyFile = path.join(dir, "age-test-key.txt");
  const result = childProcess.spawnSync("age-keygen", ["-o", privateKeyFile], { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`age-keygen failed: ${result.stderr}`);
  }
  // age-keygen prints "Public key: age1..." to stderr
  const match = result.stderr.match(/Public key:\s*(age1\S+)/);
  if (!match) {
    throw new Error(`age-keygen output did not contain public key: ${result.stderr}`);
  }
  return { privateKeyFile, publicKey: match[1]! };
}

/**
 * Create a sops-encrypted YAML file.
 *
 * @param filePath      Where to write the encrypted file.
 * @param plaintext     YAML content to encrypt (key: value pairs).
 * @param agePublicKey  The age public key to use for encryption.
 * @param tmpDir        Temp directory for staging the plaintext file.
 */
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
    // Immediately delete the plaintext staging file (security hygiene).
    try { fs.unlinkSync(plaintextFile); } catch { /* best-effort */ }
  }
}

// ── Test setup ────────────────────────────────────────────────────────────────

describe("[AC-S9d7fdb-6-1] sops credentials injection into driver spawn env", () => {
  let daemon: Daemon;
  let daemonPort: number;
  let dataDir: string;
  let projectDir: string;
  let keyDir: string;
  let baseUrl: string;
  const projId = "test-proj-sops-inject";
  const taskId = `task-creds-inject-${Date.now()}`;
  let envId: string | undefined;

  /** The known secret value used in the test. A random string so no accidental match. */
  const knownSecret = `test-secret-value-${crypto.randomBytes(12).toString("hex")}`;
  const knownSecretHash = sha256hex(knownSecret);

  before(async () => {
    daemonPort = await getFreePort();
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "banto-sops-test-"));
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "banto-sops-proj-"));
    keyDir = fs.mkdtempSync(path.join(os.tmpdir(), "banto-sops-keys-"));

    // 1. Generate age keypair
    const { privateKeyFile, publicKey } = generateAgeKeypair(keyDir);

    // 2. Create credentials directory and encrypt a YAML secrets file
    const credDir = path.join(projectDir, "meta", "credentials");
    fs.mkdirSync(credDir, { recursive: true });
    const encryptedCredsFile = path.join(credDir, "staging-creds.yaml");
    // The YAML content: TEST_SECRET: <knownSecret>
    sopsEncrypt(
      encryptedCredsFile,
      `TEST_SECRET: "${knownSecret}"\n`,
      publicKey,
      keyDir
    );
    assert.ok(fs.existsSync(encryptedCredsFile), "encrypted credentials file must exist");

    // 3. Create meta/environments.yaml with env-proof driver + credentials reference
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

    // 4. Create a task file referencing the profile
    const tasksDir = path.join(projectDir, "work", "tasks");
    fs.mkdirSync(tasksDir, { recursive: true });
    fs.writeFileSync(
      path.join(tasksDir, `${taskId}.md`),
      `---\nid: ${taskId}\ntitle: Creds injection test task\nenvironment: secured\n---\n\nTask body.\n`,
      "utf8"
    );

    // 5. Start daemon with sopsAgeKeyFile configured
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

    // Register project
    const regResp = await httpPost(`${baseUrl}/projects`, { id: projId, repoPath: projectDir });
    assert.equal(regResp.status, 201, `project registration failed: ${JSON.stringify(regResp.body)}`);

    // Create task
    const taskResp = await httpPost(`${baseUrl}/projects/${projId}/tasks`, {
      id: taskId,
      title: "Creds injection test task",
      environment: "secured",
    });
    assert.equal(taskResp.status, 201, `task creation failed: ${JSON.stringify(taskResp.body)}`);
  });

  after(async () => {
    if (envId) {
      try {
        await httpPost(`${baseUrl}/projects/${projId}/tasks/${taskId}/environment/teardown`, { envId });
      } catch { /* best-effort */ }
    }
    await daemon.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(projectDir, { recursive: true, force: true });
    fs.rmSync(keyDir, { recursive: true, force: true });
  });

  // ── Test 1: provision returns 201 with healthcheck proof ──────────────────

  it("POST /environment/provision returns 201; healthcheck.detail = sha256 of known secret", async () => {
    const resp = await httpPost(
      `${baseUrl}/projects/${projId}/tasks/${taskId}/environment/provision`,
      {}
    );
    assert.equal(resp.status, 201, `expected 201, got ${resp.status}: ${JSON.stringify(resp.body)}`);

    const body = resp.body as Record<string, unknown>;
    assert.ok(typeof body["envId"] === "string" && body["envId"].length > 0, `envId must be a non-empty string: ${JSON.stringify(body)}`);
    assert.equal(body["profileName"], "secured", `profileName must be 'secured': ${JSON.stringify(body)}`);

    const hc = body["healthcheck"] as Record<string, unknown>;
    assert.ok(hc !== null && typeof hc === "object", `healthcheck must be an object: ${JSON.stringify(body)}`);
    assert.equal(hc["ok"], true, `healthcheck.ok must be true: ${JSON.stringify(hc)}`);

    // CORE PROOF: detail must contain sha256 of the known secret.
    // This proves the driver process saw TEST_SECRET in its environment — not via stdin/argv.
    const expectedDetail = `sha256:${knownSecretHash}`;
    assert.equal(
      hc["detail"],
      expectedDetail,
      `healthcheck.detail must be sha256 of known secret. Expected: "${expectedDetail}", got: "${String(hc["detail"])}". This proves credentials were injected via spawn env.`
    );

    envId = body["envId"] as string;
  });

  // ── Test 2: GET environments shows reference name only ────────────────────

  it("GET /environments lists environment with credentials reference name only (not plaintext)", async () => {
    assert.ok(envId, "envId must be set (provision must pass)");

    const resp = await httpGet(`${baseUrl}/environments`);
    assert.equal(resp.status, 200, `GET /environments failed: ${JSON.stringify(resp.body)}`);

    // GET /environments returns { environments: [...] }
    const bodyRec = resp.body as Record<string, unknown>;
    const envs = bodyRec["environments"] as unknown[] | undefined;
    assert.ok(Array.isArray(envs), `environments must be an array, got: ${JSON.stringify(bodyRec)}`);

    // Find our env entry
    const entry = envs.find((e) => {
      const rec = e as Record<string, unknown>;
      return rec["envId"] === envId;
    }) as Record<string, unknown> | undefined;
    assert.ok(entry, `must find env entry for envId=${envId}`);

    // The ledger/API response must NOT contain the plaintext secret.
    const entryStr = JSON.stringify(entry);
    assert.ok(
      !entryStr.includes(knownSecret),
      `GET /environments response must NOT contain plaintext secret. Found secret in: ${entryStr.slice(0, 300)}`
    );

    // The profileName is stored (the ledger stores envId, profileName, driver, handle).
    assert.equal(entry["profileName"], "secured", `profileName must be 'secured': ${entryStr}`);
  });

  // ── Test 3: credentials reference name appears in environments.yaml response ─

  it("credentials field in environments.yaml profile is the reference name only", async () => {
    // Verify the profile listing shows credentials as the reference name
    // (GET /projects/:proj/environments returns valid profiles with credentials: string).
    const resp = await httpGet(`${baseUrl}/projects/${projId}/environments`);
    assert.equal(resp.status, 200, `GET /projects/${projId}/environments failed: ${JSON.stringify(resp.body)}`);

    const bodyRec = resp.body as Record<string, unknown>;
    const profiles = bodyRec["profiles"] as unknown[] | undefined;
    assert.ok(Array.isArray(profiles), "profiles must be an array");

    const secured = (profiles as Array<Record<string, unknown>>).find((p) => p["name"] === "secured");
    assert.ok(secured, "must find 'secured' profile");

    // credentials field must be the reference name string, not the secret value
    assert.equal(secured["credentials"], "staging-creds", `profile.credentials must be reference name "staging-creds", got: ${JSON.stringify(secured["credentials"])}`);
    assert.ok(
      !JSON.stringify(secured).includes(knownSecret),
      "profile listing must NOT contain plaintext secret"
    );
  });
});

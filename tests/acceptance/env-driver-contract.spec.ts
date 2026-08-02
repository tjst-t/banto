/**
 * [AC-S9d7fdb-2-1] Environment driver contract test suite.
 *
 * Verifies that the builtin process driver satisfies the common driver contract
 * for all 7 verbs (provision/deploy/healthcheck/run/collect/teardown/list).
 *
 * Entry point (test-discipline rule 2, mixed story):
 *   Block A — subprocess: the driver executable is invoked as a subprocess
 *   (<driver> <verb> with stdin JSON) — the exact surface external driver authors
 *   program against. NO in-process imports of driver internals.
 *
 * Contract verifications:
 *   - stdin JSON input; stdout JSON output; exit 0 = success; exit != 0 = failure
 *   - handle returned by provision is opaque (harness does NOT interpret fields)
 *   - healthcheck → {ok: bool}
 *   - run → {exit: int, log_path: <existing file>}
 *   - teardown is idempotent (call twice → still exit 0)
 *   - list → JSON array of {handle, name, created}
 *   - run on torn-down environment → exit != 0 (failure path)
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as childProcess from "node:child_process";
import * as path from "node:path";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import { fileURLToPath } from "node:url";
import type { EnvHandle, ProvisionOutput, HealthcheckOutput, RunOutput, ListOutput } from "../../packages/banto-core/src/index.js";

const _thisDir = path.dirname(fileURLToPath(import.meta.url));
const _repoRoot = path.resolve(_thisDir, "..", "..");
const PROCESS_DRIVER_PATH = path.join(_repoRoot, "packages", "banto-environment-pool", "src", "process-driver.ts");
const NODE = process.execPath;

// imp-0012: テスト用の一時 state に隔離（本番の /tmp/banto-process-driver-state.json を汚さない）
const TEST_DRIVER_STATE = path.join(
  os.tmpdir(),
  "banto-process-driver-state-acceptance-env-driver-contract.json"
);
process.env["BANTO_PROCESS_DRIVER_STATE"] = TEST_DRIVER_STATE;

// ── Helper to invoke the driver ───────────────────────────────────────────────

/**
 * Invoke the process driver as a subprocess for a given verb.
 * Returns { exitCode, stdout, stderr }.
 *
 * test-discipline rule 2: drives the REAL driver executable as a subprocess,
 * not an in-process import.
 */
function invokeDriver(
  verb: string,
  input: Record<string, unknown>,
  timeoutMs = 10_000
): { exitCode: number; stdout: string; stderr: string } {
  const inputJson = JSON.stringify(input);
  const result = childProcess.spawnSync(
    NODE,
    ["--import", "tsx", PROCESS_DRIVER_PATH, verb],
    {
      input: inputJson,
      encoding: "utf8",
      timeout: timeoutMs,
      env: { ...process.env },
    }
  );
  return {
    exitCode: result.status ?? -1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

/**
 * Parse JSON output from the driver.
 * Returns null if empty (valid for verbs with no output: deploy, collect, teardown).
 */
function parseOutput(stdout: string): unknown {
  const trimmed = stdout.trim();
  if (!trimmed) return {};
  return JSON.parse(trimmed);
}

// ── Free port helper ──────────────────────────────────────────────────────────

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        server.close(() => reject(new Error("no address")));
        return;
      }
      const port = addr.port;
      server.close(() => resolve(port));
    });
    server.once("error", reject);
  });
}

// ── Contract test suite ───────────────────────────────────────────────────────

describe("[AC-S9d7fdb-2-1] environment driver contract — process driver", () => {
  let handle: EnvHandle;
  let port: number;
  const taskId = `contract-test-${Date.now()}`;

  before(async () => {
    port = await getFreePort();
  });

  after(async () => {
    // Cleanup: teardown if handle was obtained (idempotent — safe to call even if already torn down)
    if (handle) {
      invokeDriver("teardown", { handle });
    }
    fs.rmSync(TEST_DRIVER_STATE, { force: true });
  });

  // ── 1. provision ────────────────────────────────────────────────────────────

  it("provision exits 0 and returns {handle: {...}}", () => {
    // A simple HTTP server that listens on the free port.
    // We use node itself to serve a trivial HTTP response.
    const cmd = `node -e "require('http').createServer((req,res)=>res.end('ok')).listen(${port},'127.0.0.1')"`;
    const r = invokeDriver("provision", {
      config: { cmd, port },
      taskId,
    });
    assert.equal(r.exitCode, 0, `provision exited ${r.exitCode}: ${r.stderr}`);

    const out = parseOutput(r.stdout) as ProvisionOutput;
    assert.ok(
      typeof out === "object" && out !== null && "handle" in out,
      `stdout must be {handle: {...}}: got ${r.stdout}`
    );
    // handle is opaque — harness does NOT interpret its fields (spec §2, D3)
    assert.equal(typeof out.handle, "object");
    assert.notEqual(out.handle, null);

    // Save for subsequent tests
    handle = out.handle;
  });

  // ── 2. healthcheck ──────────────────────────────────────────────────────────

  it("healthcheck exits 0 and returns {ok: bool}", async () => {
    assert.ok(handle, "handle must be set (provision must pass first)");

    // Wait a moment for the HTTP server to bind
    await new Promise<void>((r) => setTimeout(r, 500));

    const r = invokeDriver("healthcheck", { handle });
    assert.equal(r.exitCode, 0, `healthcheck exited ${r.exitCode}: ${r.stderr}`);

    const out = parseOutput(r.stdout) as HealthcheckOutput;
    assert.ok(
      typeof out === "object" && out !== null && "ok" in out,
      `stdout must be {ok: bool}: got ${r.stdout}`
    );
    assert.equal(typeof out.ok, "boolean", `ok must be boolean: ${r.stdout}`);
    assert.ok(out.ok === true, `healthcheck must return ok=true after provision: ${JSON.stringify(out)}`);
  });

  // ── 3. deploy ───────────────────────────────────────────────────────────────

  it("deploy exits 0 (artifact_path + handle input)", () => {
    assert.ok(handle, "handle must be set");
    // Create a temp artifact file to pass
    const artifactPath = path.join(os.tmpdir(), `banto-contract-test-artifact-${Date.now()}.txt`);
    fs.writeFileSync(artifactPath, "test artifact content");

    try {
      const r = invokeDriver("deploy", { handle, artifact_path: artifactPath });
      assert.equal(r.exitCode, 0, `deploy exited ${r.exitCode}: ${r.stderr}`);
      // Output can be empty or a JSON object (spec §2: no required fields for deploy)
      // Just verify it's parseable if non-empty
      parseOutput(r.stdout); // throws on invalid JSON
    } finally {
      try { fs.unlinkSync(artifactPath); } catch { /* best-effort */ }
    }
  });

  // ── 4. run ──────────────────────────────────────────────────────────────────

  it("run exits 0 and returns {exit: int, log_path: <existing file>}", () => {
    assert.ok(handle, "handle must be set");

    const r = invokeDriver("run", { handle, cmd: "echo contract-test-output" });
    assert.equal(r.exitCode, 0, `run exited ${r.exitCode}: ${r.stderr}`);

    const out = parseOutput(r.stdout) as RunOutput;
    assert.ok(
      typeof out === "object" && out !== null,
      `stdout must be a JSON object: ${r.stdout}`
    );
    assert.equal(typeof out.exit, "number", `exit must be a number: ${JSON.stringify(out)}`);
    assert.equal(typeof out.log_path, "string", `log_path must be a string: ${JSON.stringify(out)}`);
    assert.ok(out.log_path.length > 0, "log_path must be non-empty");
    assert.ok(
      fs.existsSync(out.log_path),
      `log_path must point to an existing file: ${out.log_path}`
    );
    // Verify the command output is in the log file
    const logContent = fs.readFileSync(out.log_path, "utf8");
    assert.ok(
      logContent.includes("contract-test-output"),
      `log file must contain command output: ${logContent}`
    );
    assert.equal(out.exit, 0, `command exit must be 0 for 'echo': ${out.exit}`);
  });

  // ── 5. collect ──────────────────────────────────────────────────────────────

  it("collect exits 0 and writes to dest directory", () => {
    assert.ok(handle, "handle must be set");

    const dest = fs.mkdtempSync(path.join(os.tmpdir(), "banto-contract-collect-"));
    try {
      const r = invokeDriver("collect", { handle, dest });
      assert.equal(r.exitCode, 0, `collect exited ${r.exitCode}: ${r.stderr}`);
      // dest directory should exist (collect may or may not have written files)
      assert.ok(fs.existsSync(dest), "dest directory must exist after collect");
    } finally {
      fs.rmSync(dest, { recursive: true, force: true });
    }
  });

  // ── 6. list ─────────────────────────────────────────────────────────────────

  it("list exits 0 and returns JSON array with [{handle, name, created}]", () => {
    const r = invokeDriver("list", {});
    assert.equal(r.exitCode, 0, `list exited ${r.exitCode}: ${r.stderr}`);

    const out = parseOutput(r.stdout) as ListOutput;
    assert.ok(Array.isArray(out), `list output must be a JSON array: ${r.stdout}`);

    // Our provisioned entry should be in the list (taskID-prefixed name — I3)
    const ours = out.find((item) => {
      const name = item.name as string;
      return name.startsWith(taskId);
    });
    assert.ok(ours, `list must contain our taskID-prefixed resource (taskId=${taskId}): ${r.stdout}`);
    // Verify list item shape: {handle, name, created}
    assert.equal(typeof ours.handle, "object", "list item must have handle");
    assert.equal(typeof ours.name, "string", "list item must have name");
    assert.equal(typeof ours.created, "string", "list item must have created");
    // Verify created is a valid ISO-8601 timestamp
    assert.ok(!isNaN(new Date(ours.created).getTime()), `created must be valid ISO-8601: ${ours.created}`);
  });

  // ── 7. teardown + idempotency ────────────────────────────────────────────────

  it("teardown exits 0 (first call)", () => {
    assert.ok(handle, "handle must be set");

    const r = invokeDriver("teardown", { handle });
    assert.equal(r.exitCode, 0, `teardown exited ${r.exitCode}: ${r.stderr}`);
  });

  it("teardown exits 0 again (idempotent — target already gone)", () => {
    assert.ok(handle, "handle must be set");

    // Second teardown — process is already gone; must still succeed (spec §2: 冪等必須)
    const r = invokeDriver("teardown", { handle });
    assert.equal(r.exitCode, 0, `second teardown must exit 0 (idempotent): ${r.stderr}`);
  });

  // ── 8. list after teardown — our resource is no longer listed ────────────────

  it("list no longer contains our resource after teardown", () => {
    const r = invokeDriver("list", {});
    assert.equal(r.exitCode, 0, `list exited ${r.exitCode}: ${r.stderr}`);

    const out = parseOutput(r.stdout) as ListOutput;
    assert.ok(Array.isArray(out), `list output must be JSON array: ${r.stdout}`);

    const ours = out.find((item) => {
      const name = item.name as string;
      return name.startsWith(taskId);
    });
    assert.ok(!ours, `list must NOT contain our resource after teardown: ${r.stdout}`);
  });

  // ── 9. run on torn-down environment → exit != 0 ─────────────────────────────

  it("run with a handle for a torn-down environment exits != 0 (failure path)", () => {
    assert.ok(handle, "handle must be set");

    // The process was killed by teardown, so run should fail
    // Scenario 1 step 4: "exit != 0 (non-zero exit is the failure signal)"
    const r = invokeDriver("run", { handle, cmd: "echo should-fail" });
    assert.notEqual(
      r.exitCode,
      0,
      `run on torn-down environment must exit != 0: exitCode=${r.exitCode}, stderr=${r.stderr}`
    );
  });
});

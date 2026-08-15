/**
 * [AC-S9d7fdb-3-2] Docker driver `run` verb — executes commands in the container.
 *
 * Entry point (test-discipline rule 2, mixed story — Block A):
 *   Block A — subprocess: the docker driver is invoked as a subprocess (driver <verb>
 *   with stdin JSON), and real docker containers are observed.
 *
 * Scenario steps (from scenario-S9d7fdb-3.json, scenario-2-run-in-container):
 *   1. provision → obtain handle
 *   2. run {cmd: "hostname && cat /etc/hostname"} → exit=0, log_path; log contains a
 *      container hostname (different from the host's — proves execution inside the container)
 *   3. run {cmd: "exit 7"} → exit=7 (I2: failure exit observable as-is)
 *
 * Cleanup: teardown (x2 for idempotency check in AC-S9d7fdb-3-3)
 *
 * AC-S9d7fdb-3-2: run executes inside the container; non-zero exits surface as-is (I2).
 *
 * Real docker required — test FAILS (not skips) if docker is unavailable.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as childProcess from "node:child_process";
import { fileURLToPath } from "node:url";

const _thisDir = path.dirname(fileURLToPath(import.meta.url));
const _repoRoot = path.resolve(_thisDir, "..", "..");
const DOCKER_DRIVER_PATH = path.join(
  _repoRoot,
  "packages",
  "banto-environment-pool",
  "src",
  "docker-driver.ts"
);
const COMPOSE_FIXTURE = path.join(_repoRoot, "tests", "fixtures", "docker", "test-compose.yaml");
const NODE = process.execPath;

// ── Driver invocation helper (mirrors env-driver-contract.spec.ts) ─────────────

function invokeDriver(
  verb: string,
  input: Record<string, unknown>,
  timeoutMs = 60_000
): { exitCode: number; stdout: string; stderr: string } {
  const result = childProcess.spawnSync(
    NODE,
    ["--import", "tsx", DOCKER_DRIVER_PATH, verb],
    {
      input: JSON.stringify(input),
      encoding: "utf8",
      timeout: timeoutMs,
      env: { ...process.env },
    }
  );
  return {
    exitCode: result.status ?? -1,
    stdout: (result.stdout as string) ?? "",
    stderr: (result.stderr as string) ?? "",
  };
}

function parseOutput(stdout: string): unknown {
  const trimmed = stdout.trim();
  if (!trimmed) return {};
  return JSON.parse(trimmed);
}

/** Run a shell command synchronously and return result. */
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

describe("[AC-S9d7fdb-3-2] docker driver run — executes in container, non-zero exit preserved", () => {
  const taskId = `task-docker-run-${Date.now()}`;
  const HOST_HOSTNAME = os.hostname();

  let handle: Record<string, unknown> | undefined;

  before(() => {
    // Fail fast if docker is not available (I1: no skips)
    assertDockerAvailable();

    // Provision via driver subprocess
    const r = invokeDriver(
      "provision",
      { config: { compose: COMPOSE_FIXTURE }, taskId, envId: taskId },
      120_000
    );
    assert.equal(
      r.exitCode,
      0,
      `docker driver provision failed (exit ${r.exitCode}): ${r.stderr}`
    );

    const out = parseOutput(r.stdout) as { handle: Record<string, unknown> };
    assert.ok(
      typeof out === "object" && out !== null && "handle" in out,
      `provision must return {handle: {...}}: got ${r.stdout}`
    );
    handle = out.handle;
  });

  after(() => {
    // Cleanup: teardown if handle was obtained (idempotent)
    if (handle) {
      invokeDriver("teardown", { handle }, 30_000);
    }
  });

  // ── Step 1: run writes a marker proving execution inside the container ─────

  it("run exits 0, log_path points to an existing file, log contains container hostname (proves in-container execution)", () => {
    assert.ok(handle, "handle must be set (provision must pass first)");

    // Run a command that outputs the container hostname.
    // The container hostname is a short SHA (like "1af870e505da"), NOT the host hostname.
    const r = invokeDriver("run", {
      handle,
      cmd: "hostname && echo marker-from-container",
    });

    assert.equal(
      r.exitCode,
      0,
      `docker driver run failed (exit ${r.exitCode}): ${r.stderr}`
    );

    const out = parseOutput(r.stdout) as { exit: number; log_path: string };
    assert.ok(
      typeof out === "object" && out !== null,
      `stdout must be a JSON object: ${r.stdout}`
    );
    assert.equal(typeof out.exit, "number", `exit must be a number: ${JSON.stringify(out)}`);
    assert.equal(
      typeof out.log_path,
      "string",
      `log_path must be a string: ${JSON.stringify(out)}`
    );
    assert.ok(out.log_path.length > 0, "log_path must be non-empty");
    assert.ok(
      fs.existsSync(out.log_path),
      `log_path must point to an existing file: ${out.log_path}`
    );
    assert.equal(out.exit, 0, `command exit must be 0 for hostname: ${out.exit}`);

    // Verify execution was inside the container:
    //   - The log must contain "marker-from-container"
    //   - The hostname in the log must NOT equal the host's hostname
    const logContent = fs.readFileSync(out.log_path, "utf8");
    assert.ok(
      logContent.includes("marker-from-container"),
      `log must contain "marker-from-container": ${logContent}`
    );

    // Extract hostname from log (first line before "marker-from-container")
    const lines = logContent.trim().split("\n");
    const containerHostname = lines[0]?.trim() ?? "";
    assert.ok(
      containerHostname.length > 0,
      `container hostname must be non-empty in log: ${logContent}`
    );
    assert.notEqual(
      containerHostname,
      HOST_HOSTNAME,
      `container hostname "${containerHostname}" must differ from host hostname ` +
        `"${HOST_HOSTNAME}" — proving execution was inside the container`
    );
  });

  // ── Step 2: non-zero exit is preserved as-is (I2: never swallowed) ─────────

  it("run with exit 7 returns {exit: 7} — non-zero exit preserved as-is (I2)", () => {
    assert.ok(handle, "handle must be set");

    // Note: driver exit 0 (success), body.exit = 7 (command exit)
    const r = invokeDriver("run", { handle, cmd: "exit 7" });
    assert.equal(
      r.exitCode,
      0,
      `driver must exit 0 for run (it's the command that exits 7, not the driver): ${r.stderr}`
    );

    const out = parseOutput(r.stdout) as { exit: number; log_path: string };
    assert.equal(
      typeof out.exit,
      "number",
      `exit must be a number: ${JSON.stringify(out)}`
    );
    assert.equal(
      out.exit,
      7,
      `body.exit must be 7 (I2: non-zero exit preserved as-is): got ${out.exit}`
    );
    // log_path must still be a valid file path (even for failed commands)
    assert.equal(typeof out.log_path, "string", `log_path must be a string: ${JSON.stringify(out)}`);
    assert.ok(
      fs.existsSync(out.log_path),
      `log_path must exist even for failed command: ${out.log_path}`
    );
  });

  // ── Step 3: run inside torn-down environment exits != 0 ────────────────────

  it("run after teardown exits != 0 (I2: failure is surfaced, never swallowed)", () => {
    assert.ok(handle, "handle must be set");

    // First teardown
    const td = invokeDriver("teardown", { handle });
    assert.equal(td.exitCode, 0, `first teardown must exit 0: ${td.stderr}`);

    // Now run on a torn-down environment → driver must exit != 0
    const r = invokeDriver("run", { handle, cmd: "echo should-fail" });
    assert.notEqual(
      r.exitCode,
      0,
      `run on torn-down environment must exit != 0 (I2: failure is surfaced): ` +
        `exitCode=${r.exitCode}, stderr=${r.stderr}`
    );

    // Clear handle so after() doesn't teardown again (already done)
    handle = undefined;
  });
});

// ── Collect log isolation: two tasks must not cross-contaminate ───────────────
//
// AC-S9d7fdb-3-2 (review fix): log filenames are taskId-scoped (`${taskId}-run-*`).
// Collect for task A must return only A's logs; task B's logs must not appear.
// This is asserted at the filename/dir level — collecting for task A can only
// find files prefixed with A's taskId, even if B's files are in the same logDir.

describe("[AC-S9d7fdb-3-2-collect-isolation] collect log isolation — taskId-scoped filenames", () => {
  const taskIdA = `task-collect-a-${Date.now()}`;
  const taskIdB = `task-collect-b-${Date.now()}`;

  let handleA: Record<string, unknown> | undefined;
  let handleB: Record<string, unknown> | undefined;

  before(() => {
    assertDockerAvailable();

    // Provision two separate environments
    const rA = invokeDriver(
      "provision",
      { config: { compose: COMPOSE_FIXTURE }, taskId: taskIdA, envId: taskIdA },
      120_000
    );
    assert.equal(rA.exitCode, 0, `provision A failed: ${rA.stderr}`);
    handleA = (parseOutput(rA.stdout) as { handle: Record<string, unknown> }).handle;

    const rB = invokeDriver(
      "provision",
      { config: { compose: COMPOSE_FIXTURE }, taskId: taskIdB, envId: taskIdB },
      120_000
    );
    assert.equal(rB.exitCode, 0, `provision B failed: ${rB.stderr}`);
    handleB = (parseOutput(rB.stdout) as { handle: Record<string, unknown> }).handle;
  });

  after(() => {
    if (handleA) invokeDriver("teardown", { handle: handleA }, 30_000);
    if (handleB) invokeDriver("teardown", { handle: handleB }, 30_000);
  });

  it("log filename for task A is prefixed with taskIdA (taskId-scoped)", () => {
    assert.ok(handleA, "handleA must be set");

    // Run a command for task A — this creates a log file in the shared logDir
    const r = invokeDriver("run", { handle: handleA, cmd: "echo output-from-task-a" });
    assert.equal(r.exitCode, 0, `run A failed (exit ${r.exitCode}): ${r.stderr}`);

    const out = parseOutput(r.stdout) as { exit: number; log_path: string };
    assert.equal(typeof out.log_path, "string", `log_path must be a string: ${JSON.stringify(out)}`);
    assert.ok(fs.existsSync(out.log_path), `log_path must exist: ${out.log_path}`);

    // The filename must be prefixed with taskIdA (not a bare "run-" prefix)
    const basename = path.basename(out.log_path);
    assert.ok(
      basename.startsWith(`${taskIdA}-run-`),
      `log filename must be taskId-scoped: expected prefix "${taskIdA}-run-", got "${basename}"`
    );
  });

  it("collect for task A returns only A's logs — B's logs are not included", () => {
    assert.ok(handleA, "handleA must be set");
    assert.ok(handleB, "handleB must be set");

    // Run a command for task B too, to put a B-prefixed log in the shared logDir
    const rB = invokeDriver("run", { handle: handleB, cmd: "echo output-from-task-b" });
    assert.equal(rB.exitCode, 0, `run B failed (exit ${rB.exitCode}): ${rB.stderr}`);
    const outB = parseOutput(rB.stdout) as { exit: number; log_path: string };
    assert.ok(fs.existsSync(outB.log_path), `B log_path must exist: ${outB.log_path}`);

    // Also run for A (in case previous test ran in isolation)
    const rA = invokeDriver("run", { handle: handleA, cmd: "echo output-from-task-a-again" });
    assert.equal(rA.exitCode, 0, `run A failed (exit ${rA.exitCode}): ${rA.stderr}`);

    // Collect for task A
    const destA = fs.mkdtempSync(path.join(os.tmpdir(), "banto-collect-a-"));
    try {
      const rc = invokeDriver("collect", { handle: handleA, dest: destA });
      assert.equal(rc.exitCode, 0, `collect A failed (exit ${rc.exitCode}): ${rc.stderr}`);

      const collected = fs.readdirSync(destA);

      // All collected files must be prefixed with taskIdA
      for (const file of collected) {
        assert.ok(
          file.startsWith(`${taskIdA}-run-`),
          `collected file "${file}" must be prefixed with "${taskIdA}-run-" (no cross-contamination)`
        );
      }

      // No file from task B must appear
      const bFiles = collected.filter((f) => f.startsWith(`${taskIdB}-run-`));
      assert.equal(
        bFiles.length,
        0,
        `collect for task A must not include task B's logs: found B files=${JSON.stringify(bFiles)}`
      );

      // At least one A log must be collected (we ran commands above)
      const aFiles = collected.filter((f) => f.startsWith(`${taskIdA}-run-`));
      assert.ok(
        aFiles.length > 0,
        `collect for task A must include at least one A log file: collected=${JSON.stringify(collected)}`
      );
    } finally {
      fs.rmSync(destA, { recursive: true, force: true });
    }
  });
});

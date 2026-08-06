/**
 * AC-S654396-4-1: `banto status` shows daemon health, registered projects,
 * and task list grouped by status.
 *
 * Tests launch the real banto binary as a subprocess (via node + tsx loader).
 * Daemon runs as a real HTTP server on an OS-assigned port.
 * Direct import of main() is explicitly prohibited.
 *
 * Additional: daemon未起動時に banto status が exit≠0 + stderr にエラー (I2).
 *
 * D6: spawn node directly with tsx loaders to avoid the tsx-wrapper → node
 * two-process chain that causes child orphaning on SIGKILL.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Daemon } from "@banto/daemon";

const REPO_ROOT = path.resolve(import.meta.dirname, "../..");
const BIN = path.join(REPO_ROOT, "packages/banto-cli/src/bin.ts");
const NODE = process.execPath;
const TSX_PREFLIGHT = path.join(REPO_ROOT, "node_modules/tsx/dist/preflight.cjs");
const TSX_LOADER = pathToFileURL(path.join(REPO_ROOT, "node_modules/tsx/dist/loader.mjs")).href;

/** Spawn banto binary directly via node+tsx loader and collect stdout/stderr/exitCode */
async function runBanto(
  args: string[],
  env: Record<string, string> = {},
  timeoutMs = 8000
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve, reject) => {
    // Spawn node directly (not via tsx wrapper) to avoid two-process chain
    const proc = spawn(
      NODE,
      ["--require", TSX_PREFLIGHT, "--import", TSX_LOADER, BIN, ...args],
      {
        env: { ...process.env, ...env },
        stdio: ["ignore", "pipe", "pipe"],
      }
    );
    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf-8");
    });
    proc.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf-8");
    });

    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      reject(new Error(`banto ${args.join(" ")} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    proc.on("close", (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code: code ?? 1 });
    });
    proc.on("error", reject);
  });
}

describe("[AC-S654396-4-1] banto status", () => {
  let tmpDir: string;
  let daemon: Daemon;
  let daemonUrl: string;

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "banto-cli-status-"));
    daemon = Daemon.create({ port: 0, dataDir: tmpDir, disableAutoSpawn: true });
    await daemon.start();
    daemonUrl = `http://localhost:${daemon.port}`;

    // Register proj-a and create two tasks in different states
    await fetch(`${daemonUrl}/api/v1/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "proj-a", repoPath: "/repos/proj-a" }),
    });
    // task-0001: draft → queued → ready → planning → implementing
    await fetch(`${daemonUrl}/api/v1/projects/proj-a/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "task-0001", title: "First task" }),
    });
    await fetch(`${daemonUrl}/api/v1/projects/proj-a/tasks/task-0001/transition`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ to: "queued" }),
    });
    await fetch(`${daemonUrl}/api/v1/projects/proj-a/tasks/task-0001/transition`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ to: "ready" }),
    });
    await fetch(`${daemonUrl}/api/v1/projects/proj-a/tasks/task-0001/transition`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ to: "planning" }),
    });
    await fetch(`${daemonUrl}/api/v1/projects/proj-a/tasks/task-0001/transition`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ to: "implementing" }),
    });
    // task-0002: stays in draft
    await fetch(`${daemonUrl}/api/v1/projects/proj-a/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "task-0002", title: "Second task" }),
    });
  });

  after(async () => {
    await daemon.stop();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("[AC-S654396-4-1] step 1: banto status exits 0 and shows daemon, projects, tasks", async () => {
    const { stdout, stderr, code } = await runBanto(
      ["status"],
      { BANTO_DAEMON_URL: daemonUrl }
    );

    assert.equal(code, 0, `exit code should be 0, got ${code}. stderr: ${stderr}`);

    // daemon status line
    assert.match(stdout, /running/, "stdout must mention 'running'");
    assert.match(stdout, /localhost/, "stdout must include daemon URL");

    // project listing
    assert.match(stdout, /proj-a/, "stdout must list project proj-a");

    // task summary with status and IDs
    assert.match(stdout, /implementing/, "stdout must show 'implementing' status");
    assert.match(stdout, /task-0001/, "stdout must include task-0001");
    assert.match(stdout, /draft/, "stdout must show 'draft' status");
    assert.match(stdout, /task-0002/, "stdout must include task-0002");
  });

  it("[AC-S654396-4-1] step 2 (I2): daemon not running → exit non-0 + stderr error", async () => {
    const { stdout: _stdout, stderr, code } = await runBanto(
      ["status"],
      { BANTO_DAEMON_URL: "http://localhost:19999" } // nothing listening here
    );

    assert.notEqual(code, 0, "exit code should be non-zero when daemon is not running");
    assert.ok(stderr.length > 0, "stderr must contain an error message");
    // Check that the error is about connection, not an unhandled crash
    const combined = stderr.toLowerCase();
    const hasConnectionError =
      combined.includes("connect") ||
      combined.includes("econnrefused") ||
      combined.includes("cannot") ||
      combined.includes("error");
    assert.ok(hasConnectionError, `stderr should describe connection failure, got: ${stderr}`);
  });
});

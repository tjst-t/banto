/**
 * AC-S654396-4-2: `banto events --follow` streams events via WebSocket.
 *
 * Tests launch the real banto binary as a subprocess (node + tsx loader).
 * Daemon runs as a real HTTP server on an OS-assigned port.
 * Direct import of main() is explicitly prohibited.
 *
 * Scenarios:
 *   1. Connect + subscribe → print connection message (within 3s)
 *   2. REST API creates a task → event appears in stdout (within 3s)
 *   3. SIGINT → exit code 0, no stderr errors
 *   4. --after <id> reconnect catches up missed events
 *
 * D6: spawn node directly with tsx loaders to avoid the tsx-wrapper → node
 * two-process chain that causes child orphaning on SIGKILL.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { spawn, ChildProcess } from "node:child_process";
import { pathToFileURL } from "node:url";
import { Daemon } from "@banto/daemon";

const REPO_ROOT = path.resolve(import.meta.dirname, "../..");
const BIN = path.join(REPO_ROOT, "packages/banto-cli/src/bin.ts");
const NODE = process.execPath;
const TSX_PREFLIGHT = path.join(REPO_ROOT, "node_modules/tsx/dist/preflight.cjs");
const TSX_LOADER = pathToFileURL(path.join(REPO_ROOT, "node_modules/tsx/dist/loader.mjs")).href;

/** Spawn `banto events --follow [--after N]` and return the process + readers.
 *  Spawns node directly (not via tsx wrapper) to avoid the two-process chain
 *  that causes child orphaning when the parent is killed.
 */
function spawnEventsFollow(
  daemonUrl: string,
  afterId?: number
): {
  proc: ChildProcess;
  stdoutLines: string[];
  stderrLines: string[];
} {
  const cliArgs = ["events", "--follow"];
  if (typeof afterId === "number") {
    cliArgs.push("--after", String(afterId));
  }
  const nodeArgs = ["--require", TSX_PREFLIGHT, "--import", TSX_LOADER, BIN, ...cliArgs];

  const proc = spawn(NODE, nodeArgs, {
    env: { ...process.env, BANTO_DAEMON_URL: daemonUrl },
    stdio: ["ignore", "pipe", "pipe"],
  });

  const stdoutLines: string[] = [];
  const stderrLines: string[] = [];

  proc.stdout!.on("data", (chunk: Buffer) => {
    const text = chunk.toString("utf-8");
    text.split("\n").filter((l) => l.trim()).forEach((l) => stdoutLines.push(l));
  });
  proc.stderr!.on("data", (chunk: Buffer) => {
    const text = chunk.toString("utf-8");
    text.split("\n").filter((l) => l.trim()).forEach((l) => stderrLines.push(l));
  });

  return { proc, stdoutLines, stderrLines };
}

/** Wait until predicate over lines returns true, or timeout */
function waitForLine(
  lines: string[],
  predicate: (line: string) => boolean,
  timeoutMs: number
): Promise<string> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const check = () => {
      const found = lines.find(predicate);
      if (found) {
        resolve(found);
        return;
      }
      if (Date.now() > deadline) {
        reject(new Error(`Timed out waiting for matching line. Lines so far: ${JSON.stringify(lines)}`));
        return;
      }
      setTimeout(check, 50);
    };
    check();
  });
}

/** Send SIGINT to process and wait for it to exit */
function killAndWait(proc: ChildProcess, timeoutMs = 4000): Promise<number> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      reject(new Error("Process did not exit after SIGINT within timeout"));
    }, timeoutMs);
    proc.once("close", (code) => {
      clearTimeout(timer);
      resolve(code ?? 0);
    });
    proc.kill("SIGINT");
  });
}

describe("[AC-S654396-4-2] banto events --follow", () => {
  let tmpDir: string;
  let daemon: Daemon;
  let daemonUrl: string;

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "banto-cli-events-"));
    daemon = Daemon.create({ port: 0, dataDir: tmpDir, disableAutoSpawn: true });
    await daemon.start();
    daemonUrl = `http://localhost:${daemon.port}`;

    // Register proj-a so the follow command has something to subscribe to
    await fetch(`${daemonUrl}/api/v1/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "proj-a", repoPath: "/repos/proj-a" }),
    });
  });

  after(async () => {
    await daemon.stop();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("[AC-S654396-4-2] step 1: WS connection established, listening message appears", async () => {
    const { proc, stdoutLines } = spawnEventsFollow(daemonUrl);
    try {
      // Expect either "Connecting" or "Listening" within 3 seconds
      const line = await waitForLine(
        stdoutLines,
        (l) => /connect|listen/i.test(l),
        3000
      );
      assert.ok(line, "A connection/listening message must appear");
    } finally {
      proc.kill("SIGKILL");
      await new Promise((r) => proc.once("close", r));
    }
  });

  it("[AC-S654396-4-2] step 2: REST task_created event appears in stdout within 3s", async () => {
    const { proc, stdoutLines, stderrLines } = spawnEventsFollow(daemonUrl);
    try {
      // Wait for the subscription ack first (up to 4s for tsx startup + WS connect)
      await waitForLine(stdoutLines, (l) => /listen|subscrib/i.test(l), 4000);

      // Inject a new task via REST API
      const res = await fetch(`${daemonUrl}/api/v1/projects/proj-a/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: "task-ev-001", title: "Event follow test" }),
      });
      assert.equal(res.status, 201);

      // The event must appear in stdout within 3 seconds
      const evtLine = await waitForLine(
        stdoutLines,
        (l) => l.includes("task_created"),
        3000
      );
      assert.match(evtLine, /task_created/, "stdout must show task_created event");

      // No errors on stderr
      const errorLines = stderrLines.filter((l) => /error/i.test(l));
      assert.equal(errorLines.length, 0, `Unexpected stderr errors: ${errorLines.join(", ")}`);
    } finally {
      proc.kill("SIGKILL");
      await new Promise((r) => proc.once("close", r));
    }
  });

  it("[AC-S654396-4-2] step 3: SIGINT → exit code 0, no stderr errors", async () => {
    const { proc, stdoutLines, stderrLines } = spawnEventsFollow(daemonUrl);

    // Wait for connection to be established before sending SIGINT
    await waitForLine(stdoutLines, (l) => /connect|listen/i.test(l), 4000);

    const exitCode = await killAndWait(proc, 4000);
    assert.equal(exitCode, 0, `SIGINT should cause exit code 0, got ${exitCode}`);

    // No unexpected errors on stderr (ignore graceful close messages)
    const errorLines = stderrLines.filter(
      (l) => /error/i.test(l) && !/connection closed/i.test(l)
    );
    assert.equal(errorLines.length, 0, `Unexpected stderr errors: ${errorLines.join(", ")}`);
  });

  it("[AC-S654396-4-2] step 4: --after <id> catches up missed events on reconnect", async () => {
    // Phase A: connect, get initial subscription
    const { proc: proc1, stdoutLines: lines1 } = spawnEventsFollow(daemonUrl);
    await waitForLine(lines1, (l) => /listen|subscrib/i.test(l), 4000);

    // Inject one task to get a known eventId
    await fetch(`${daemonUrl}/api/v1/projects/proj-a/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "task-before-gap", title: "Before gap" }),
    });
    const evtLine = await waitForLine(
      lines1,
      (l) => l.includes("task-before-gap") || (l.includes("task_created") && /event #/.test(l)),
      3000
    );
    // Extract eventId from line format: "event #N [ts] task_created ..."
    const evtIdMatch = evtLine.match(/event #(\d+)/);
    assert.ok(evtIdMatch, `Could not parse eventId from: ${evtLine}`);
    const lastSeenId = parseInt(evtIdMatch[1], 10);

    // Kill first subscriber
    proc1.kill("SIGKILL");
    await new Promise((r) => proc1.once("close", r));

    // Phase B: inject 2 more tasks while disconnected
    await fetch(`${daemonUrl}/api/v1/projects/proj-a/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "task-gap-1", title: "Gap task 1" }),
    });
    await fetch(`${daemonUrl}/api/v1/projects/proj-a/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "task-gap-2", title: "Gap task 2" }),
    });

    // Phase C: reconnect with --after lastSeenId; collect catch-up events
    const { proc: proc2, stdoutLines: lines2 } = spawnEventsFollow(daemonUrl, lastSeenId);
    try {
      // Must receive both gap events via catch-up replay
      await waitForLine(lines2, (l) => l.includes("task-gap-1"), 4000);
      await waitForLine(lines2, (l) => l.includes("task-gap-2"), 3000);

      // All catch-up event lines must have eventId > lastSeenId
      const catchUpLines = lines2.filter((l) => /event #\d+/.test(l) && /task_created/.test(l));
      assert.ok(catchUpLines.length >= 2, `Expected ≥2 catch-up events, got ${catchUpLines.length}`);

      for (const line of catchUpLines) {
        const m = line.match(/event #(\d+)/);
        if (m) {
          const eid = parseInt(m[1], 10);
          assert.ok(eid > lastSeenId, `Catch-up event #${eid} should be > lastSeenId ${lastSeenId}`);
        }
      }
    } finally {
      proc2.kill("SIGKILL");
      await new Promise((r) => proc2.once("close", r));
    }
  });
});

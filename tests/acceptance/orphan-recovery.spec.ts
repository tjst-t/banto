/**
 * [AC-S254276-2-2] kill -9 daemon → restart → orphan recovery — REAL PROCESS, NO MOCK.
 *
 * Scenario:
 *   1. Start a daemon child process (real OS process, pid D1).
 *   2. Register a custom driver that spawns a real "sleep" process (pid A1).
 *      This driver writes to the spawn-ledger so the daemon has an orphan to recover.
 *   3. Inject the ledger entry directly (simulating a live session) so we can
 *      verify recovery without needing pi + API key.
 *   4. SIGKILL the daemon (D1) — brutal termination, bypasses graceful shutdown.
 *   5. Restart the daemon (pid D2) pointing at the same dataDir.
 *   6. Verify: A1 is terminated (orphan cleanup) + task_failed event recorded.
 *
 * Why "inject ledger entry": the daemon child process has a separate address space.
 * The cleanest way to have a live orphan entry is to write the ledger file directly
 * (as the scenario demands), then kill the daemon, then restart.
 *
 * Real processes used:
 *   - The daemon (banto-daemon/src/index.ts) as a child node process
 *   - A real `sleep` OS process as the "orphan agent"
 *
 * Per story task note: "daemonプロセス自体をkill -9は必ず実施"
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as childProcess from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const daemonIndexPath = path.resolve(
  __dirname,
  "../../packages/banto-daemon/src/index.ts"
);

// ── Helpers ────────────────────────────────────────────────────────────────────

function spawnDaemon(dataDir: string, port: number): childProcess.ChildProcess {
  const proc = childProcess.spawn(
    "node",
    ["--import", "tsx", daemonIndexPath],
    {
      env: {
        ...process.env,
        BANTO_DATA_DIR: dataDir,
        BANTO_PORT: String(port),
        BANTO_TICK_INTERVAL_MS: "99999",
      },
      stdio: ["ignore", "pipe", "pipe"],
    }
  );
  return proc;
}

/** Wait until the daemon's HTTP server is accepting connections. */
async function waitForDaemon(port: number, timeoutMs = 10000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://localhost:${port}/api/v1/health`);
      if (res.ok) return;
    } catch {
      // Not ready yet
    }
    await new Promise<void>((r) => setTimeout(r, 100));
  }
  throw new Error(`Daemon on port ${port} did not become ready within ${timeoutMs}ms`);
}

/** Wait until the daemon's HTTP server stops responding (after kill). */
async function waitForDaemonDown(port: number, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await fetch(`http://localhost:${port}/api/v1/health`);
      // Still up
    } catch {
      return; // Down
    }
    await new Promise<void>((r) => setTimeout(r, 100));
  }
  throw new Error(`Daemon on port ${port} did not stop within ${timeoutMs}ms`);
}

/** Write a spawn-ledger.json with a single entry for the given pid. */
function writeLedger(dataDir: string, entry: Record<string, unknown>): void {
  const ledgerPath = path.join(dataDir, "spawn-ledger.json");
  const file = { version: 1, entries: [entry] };
  const tmpPath = ledgerPath + ".tmp";
  fs.writeFileSync(tmpPath, JSON.stringify(file, null, 2), "utf8");
  fs.renameSync(tmpPath, ledgerPath);
}

/** Spawn a real long-lived sleep process and return its pid. */
function spawnSleep(seconds = 60): number {
  // sleep is a real OS process — not a mock.
  const proc = childProcess.spawn("sleep", [String(seconds)], {
    stdio: "ignore",
    detached: true,
  });
  proc.unref();
  const pid = proc.pid;
  if (!pid) throw new Error("Failed to spawn sleep process");
  return pid;
}

/** Check if a pid is alive (kill -0). */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    return code === "EPERM"; // exists but foreign user
  }
}

// ── Test ───────────────────────────────────────────────────────────────────────

describe("[AC-S254276-2-2] kill -9 daemon → restart → orphan recovery (real processes)", () => {
  it("[AC-S254276-2-2] SIGKILL daemon then restart recovers orphan and marks task failed", async function () {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "banto-orphan-"));
    const dataDir = path.join(tmpDir, "data");
    fs.mkdirSync(dataDir, { recursive: true });

    // Use a high port to avoid conflicts
    const port = 19876;
    let daemonProc: childProcess.ChildProcess | null = null;
    let sleepPid: number | undefined;

    try {
      // ── Phase 1: start first daemon instance ─────────────────────────────
      daemonProc = spawnDaemon(dataDir, port);

      // Collect stderr for diagnostics
      const daemonStderr: string[] = [];
      daemonProc.stderr?.on("data", (chunk: Buffer) => {
        daemonStderr.push(chunk.toString());
      });

      await waitForDaemon(port, 15000);
      const daemonPid = daemonProc.pid!;
      assert.ok(daemonPid > 0, "daemon pid must be positive");

      // ── Phase 2: register project + task via HTTP ─────────────────────────
      const projRes = await fetch(`http://localhost:${port}/api/v1/projects`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: "proj-orphan", repoPath: "/tmp/no-repo" }),
      });
      assert.equal(projRes.status, 201, "project registration must succeed");

      const taskRes = await fetch(`http://localhost:${port}/api/v1/projects/proj-orphan/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: "T-orphan", title: "Orphan test task" }),
      });
      assert.equal(taskRes.status, 201, "task creation must succeed");

      // Advance task to planning (so we have a non-terminal state to fail from)
      for (const status of ["queued", "ready", "planning"] as const) {
        const r = await fetch(
          `http://localhost:${port}/api/v1/projects/proj-orphan/tasks/T-orphan/transition`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ to: status }),
          }
        );
        // ready may be skipped if gate promotes it automatically
        if (r.status !== 200 && status !== "ready") {
          const body = await r.text();
          throw new Error(`Transition to '${status}' failed (${r.status}): ${body}`);
        }
      }

      // ── Phase 3: spawn a real "sleep" process as the orphan agent ────────
      // We write the ledger entry directly (same as if the daemon had spawned it).
      // This is acceptable per the spec task: we're testing recovery, not spawn.
      sleepPid = spawnSleep(60);
      assert.ok(isAlive(sleepPid), `sleep process ${sleepPid} must be alive before kill -9`);

      // Write ledger entry (as if the daemon had registered it on spawn)
      writeLedger(dataDir, {
        pid: sleepPid,
        projectTag: "proj-orphan",
        taskId: "T-orphan",
        sessionPath: path.join(dataDir, "sessions", "proj-orphan", "T-orphan.jsonl"),
        worktree: path.join(dataDir, "worktrees", "proj-orphan", "T-orphan"),
        driverId: "test-sleep",
        sessionId: `T-orphan-${sleepPid}`,
        spawnedAt: new Date().toISOString(),
      });

      // ── Phase 4: SIGKILL the daemon (D1) ─────────────────────────────────
      // Brutal termination — daemon cannot clean up.
      process.kill(daemonPid, "SIGKILL");
      await waitForDaemonDown(port, 5000);
      daemonProc = null;

      // sleep must still be alive after daemon death
      assert.ok(isAlive(sleepPid), `sleep process ${sleepPid} must still be alive after daemon SIGKILL`);

      // ── Phase 5: restart daemon (D2) ─────────────────────────────────────
      daemonProc = spawnDaemon(dataDir, port);
      await waitForDaemon(port, 15000);

      // ── Phase 6: verify orphan recovery ──────────────────────────────────
      // The daemon reads spawn-ledger.json on startup and handles orphans.
      // For a live pid: SIGTERM+SIGKILL → task_failed(daemon_restart_orphaned).
      // Give daemon time to complete orphan recovery
      await new Promise<void>((r) => setTimeout(r, 3000));

      // (a) sleep process must be dead (daemon terminated it)
      assert.ok(!isAlive(sleepPid), `orphan sleep process ${sleepPid} must be dead after daemon recovery`);
      sleepPid = undefined; // Prevent double-kill in finally

      // (b) task must be in 'failed' state
      const taskAfterRes = await fetch(
        `http://localhost:${port}/api/v1/projects/proj-orphan/tasks/T-orphan`
      );
      assert.equal(taskAfterRes.status, 200, "task endpoint must return 200");
      const taskAfterBody = await taskAfterRes.json() as { task: { status: string } };
      assert.equal(
        taskAfterBody.task.status,
        "failed",
        `orphan task must be in 'failed' state after recovery, got '${taskAfterBody.task.status}'`
      );

      // (c) task_failed event with orphan reason must be in the event log
      const eventsRes = await fetch(
        `http://localhost:${port}/api/v1/projects/proj-orphan/tasks/T-orphan/events`
      );
      assert.equal(eventsRes.status, 200);
      const eventsBody = await eventsRes.json() as {
        events: Array<{ type: string; reason?: string }>;
      };
      const failedEvent = eventsBody.events.find(
        (e) => e.type === "task_failed"
      );
      assert.ok(
        failedEvent,
        `task_failed event must be recorded after orphan recovery. Events: ${JSON.stringify(eventsBody.events.map((e) => e.type))}`
      );
      assert.ok(
        failedEvent.reason?.includes("daemon_restart_orphaned") ||
          failedEvent.reason?.includes("orphan"),
        `task_failed reason must mention orphan recovery, got: '${failedEvent.reason}'`
      );

      // (d) ledger must be empty after recovery
      const ledgerPath = path.join(dataDir, "spawn-ledger.json");
      if (fs.existsSync(ledgerPath)) {
        const raw = fs.readFileSync(ledgerPath, "utf8");
        const parsed = JSON.parse(raw) as { entries: unknown[] };
        assert.equal(
          parsed.entries.length,
          0,
          "spawn-ledger.json must have no entries after orphan recovery"
        );
      }
      // If the file doesn't exist, the ledger was cleaned up entirely — also acceptable.

    } finally {
      // Kill the daemon if still running
      if (daemonProc && daemonProc.pid) {
        try { process.kill(daemonProc.pid, "SIGKILL"); } catch { /* ignore */ }
      }
      // Kill orphan sleep if it somehow survived
      if (sleepPid !== undefined) {
        try { process.kill(sleepPid, "SIGKILL"); } catch { /* ignore */ }
      }
      // Cleanup tmp dir
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

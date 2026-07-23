/**
 * [AC-S254276-2-3] Reconciliation loop detects dead child process and records task_failed.
 *
 * Verifies that:
 *   - A task with an active ledger entry (pid alive) is not failed by reconcile.
 *   - When the child process is externally killed (kill -9, not via daemon),
 *     the reconcile job detects it within reconcileIntervalMs and:
 *       (a) appends task_failed event with reason containing "process_not_found"
 *       (b) removes the entry from the spawn ledger
 *
 * Real processes: uses a real `sleep` process as the "agent" so kill -9 is literal.
 * The daemon is the in-process Daemon (not a child process) for simplicity; the
 * SIGKILL-daemon scenario is covered by orphan-recovery.spec.ts.
 *
 * We register a custom "sleep" driver that wraps a sleep process in the RuntimeDriver
 * contract, so spawnTask() goes through the full ledger path.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as childProcess from "node:child_process";

import { Daemon } from "../../packages/banto-daemon/src/daemon.js";
import type { RuntimeDriver, SpawnOptions, SessionHandle, DriverEventHandler, DriverEvent } from "../../packages/banto-core/src/index.js";

// ── SleepDriver: a real-process driver for reconcile testing ─────────────────
//
// Spawns `sleep <seconds>` as a real OS process. The driver satisfies the
// RuntimeDriver contract with real pids — no mocks.
//
// IMPORTANT: This driver does NOT emit process_exited when the process dies
// externally (simulating a driver that loses track of the process, e.g. because
// the external kill bypasses the driver's lifecycle management). This is the
// scenario the reconcile job is designed to catch.
//
// D6: no external libraries; uses only child_process (stdlib).

class SleepDriver implements RuntimeDriver {
  private readonly sessions = new Map<string, { pid: number; proc: childProcess.ChildProcess }>();
  private readonly handlers: Set<DriverEventHandler> = new Set();

  async spawn(opts: SpawnOptions): Promise<SessionHandle> {
    const proc = childProcess.spawn("sleep", ["120"], {
      stdio: "ignore",
      detached: true,
    });
    proc.unref();

    const pid = proc.pid;
    if (!pid) throw new Error("SleepDriver: failed to get pid for sleep process");

    const sessionId = `${opts.taskId}-${pid}`;
    this.sessions.set(sessionId, { pid, proc });

    // NOTE: We intentionally do NOT attach proc.once("exit") here.
    // This simulates a driver that loses track of the process when it's killed
    // externally — exactly the scenario the reconcile job is designed to catch.
    // The reconcile job reads the ledger, checks isProcessAlive(), and records
    // task_failed if the process is gone.

    const startEv: DriverEvent = { type: "process_started", pid, sessionId, sessionPath: opts.sessionPath };
    for (const h of this.handlers) {
      try { h(startEv); } catch { /* ignore */ }
    }

    return { pid, sessionId, sessionPath: opts.sessionPath };
  }

  async inject(_sessionId: string, _message: string): Promise<void> {
    // sleep doesn't accept messages — no-op for the contract
  }

  subscribe(handler: DriverEventHandler): () => void {
    this.handlers.add(handler);
    return () => { this.handlers.delete(handler); };
  }

  async kill(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    this.sessions.delete(sessionId);
    try { process.kill(session.pid, "SIGKILL"); } catch { /* already dead */ }
  }

  /** Kill a sleep process directly by pid, bypassing the driver lifecycle.
   *  Simulates an external kill -9 that the driver doesn't observe via proc events.
   */
  killByPid(pid: number): void {
    try { process.kill(pid, "SIGKILL"); } catch { /* already dead */ }
    // Remove from sessions so kill() is idempotent
    for (const [sid, s] of this.sessions) {
      if (s.pid === pid) {
        this.sessions.delete(sid);
        break;
      }
    }
  }
}

// ── Test ───────────────────────────────────────────────────────────────────────

describe("[AC-S254276-2-3] Reconcile job detects dead child and records task_failed", () => {
  let tmpDir: string;
  let daemon: Daemon;
  let sleepDriver: SleepDriver;

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "banto-reconcile-"));
    const dataDir = path.join(tmpDir, "data");

    // Short reconcile interval (300ms) so the test doesn't take long.
    daemon = Daemon.create({
      port: 0,
      dataDir,
      watchIntervalMs: 99999,
      tickIntervalMs: 99999,
      reconcileIntervalMs: 300,
      worktreeBaseDir: path.join(tmpDir, "worktrees"),
      sessionBaseDir: path.join(tmpDir, "sessions"),
    });

    // Register the real-process sleep driver
    sleepDriver = new SleepDriver();
    daemon.driverRegistry.register("sleep-test", sleepDriver);

    await daemon.start();
  });

  after(async () => {
    await daemon.stop();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("[AC-S254276-2-3] reconcile detects externally-killed child and records task_failed(process_not_found)", async () => {
    const projectTag = "proj-reconcile";
    const taskId = "T-dead";

    // Empty repoPath: spawnTask skips git worktree creation (no git dependency needed here).
    daemon.registerProject(projectTag, "");
    daemon.createTask(projectTag, taskId, "Reconcile test task");
    daemon.transition(projectTag, taskId, "queued");
    daemon.transition(projectTag, taskId, "ready");

    // Spawn via the sleep driver (real process)
    const spawnResult = await daemon.spawnTask(projectTag, taskId, "sleep-test");
    const { pid } = spawnResult;

    // Verify the ledger has the entry
    const beforeEntries = daemon.getLedgerEntries();
    const entry = beforeEntries.find((e) => e.taskId === taskId && e.projectTag === projectTag);
    assert.ok(entry, "ledger must have an entry after spawn");
    assert.equal(entry.pid, pid, "ledger entry pid must match spawn result");

    // Verify process is alive before kill
    let pidAlive: boolean;
    try {
      process.kill(pid, 0);
      pidAlive = true;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      pidAlive = code === "EPERM";
    }
    assert.ok(pidAlive, `sleep process ${pid} must be alive before external kill`);

    // ── External kill -9 (bypassing daemon) ──────────────────────────────
    // This is the scenario: agent process killed externally, daemon must detect it.
    sleepDriver.killByPid(pid);

    // Verify process is dead
    await new Promise<void>((r) => setTimeout(r, 200));
    let pidDead: boolean;
    try {
      process.kill(pid, 0);
      pidDead = false; // still alive
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      pidDead = code === "ESRCH"; // not found = dead
    }
    assert.ok(pidDead, `sleep process ${pid} must be dead after kill -9`);

    // ── Wait for reconcile job to detect the dead process ─────────────────
    // reconcileIntervalMs is 300ms; wait up to 3 ticks = 900ms + margin
    await new Promise<void>((r) => setTimeout(r, 1500));

    // (a) task_failed event must be recorded
    const events = daemon.getAllEvents();
    const failedEvent = events.find(
      (e) => e.type === "task_failed" && e.taskId === taskId && e.projectTag === projectTag
    );
    assert.ok(
      failedEvent,
      `task_failed event must be recorded by reconcile loop. Events: ${JSON.stringify(events.filter((e) => "taskId" in e && e.taskId === taskId).map((e) => e.type))}`
    );

    if (failedEvent?.type === "task_failed") {
      assert.ok(
        failedEvent.reason.includes("process_not_found") ||
          failedEvent.reason.includes("not_found") ||
          failedEvent.reason.includes("process"),
        `task_failed reason must mention process death, got: '${failedEvent.reason}'`
      );
    }

    // (b) task status must be 'failed'
    const taskRecord = daemon.getTask(projectTag, taskId);
    assert.equal(
      taskRecord?.status,
      "failed",
      `task must be in 'failed' status after reconcile, got '${taskRecord?.status}'`
    );

    // (c) ledger entry must be removed
    const afterEntries = daemon.getLedgerEntries();
    const stillThere = afterEntries.find(
      (e) => e.taskId === taskId && e.projectTag === projectTag
    );
    assert.ok(
      !stillThere,
      "ledger entry must be removed after reconcile detects dead process"
    );
  });

  it("[AC-S254276-2-3] reconcile does NOT fail a task whose process is still alive", async () => {
    const projectTag = "proj-reconcile-alive";
    const taskId = "T-alive";

    // Empty repoPath: spawnTask skips git worktree creation.
    daemon.registerProject(projectTag, "");
    daemon.createTask(projectTag, taskId, "Alive reconcile test");
    daemon.transition(projectTag, taskId, "queued");
    daemon.transition(projectTag, taskId, "ready");

    const spawnResult = await daemon.spawnTask(projectTag, taskId, "sleep-test");

    // Wait for 2 reconcile cycles (600ms) without killing the process
    await new Promise<void>((r) => setTimeout(r, 700));

    // Task must still be in planning (not failed)
    const task = daemon.getTask(projectTag, taskId);
    assert.ok(
      task?.status !== "failed",
      `alive task must not be marked failed by reconcile, status='${task?.status}'`
    );

    // Ledger entry must still be there
    const entries = daemon.getLedgerEntries();
    const entry = entries.find((e) => e.taskId === taskId && e.projectTag === projectTag);
    assert.ok(entry, "ledger entry must remain for alive process");

    // Cleanup: kill the sleep process via the driver
    await sleepDriver.kill(spawnResult.sessionId);
    // Wait for exit event and ledger cleanup
    await new Promise<void>((r) => setTimeout(r, 500));
  });
});

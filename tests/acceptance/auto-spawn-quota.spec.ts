/**
 * [AC-S75f66b-2-2] Physical quota (maxConcurrentSessions) caps concurrent spawns;
 * freed slots are refilled in order.
 *
 * Story: S75f66b-2 「readyタスクの自動spawn（tickジョブ）」
 *
 * Entry point: HTTP API only (story_type=api, Rule 2).
 * Test driver: SleepDriver (real OS process, satisfies RuntimeDriver contract).
 * No pi binary, no LLM calls required.
 *
 * Scenario coverage (scenario-2):
 *   step-1: Two ready-eligible tasks are dropped. maxConcurrentSessions=1.
 *     → Exactly one is spawned (task-A); task-B stays 'ready'.
 *     → No rejection event for task-B — quota skip is silent.
 *     → Across ≥3 further ticks, task-B is NOT spawned (quota full).
 *   step-2: task-A's session ends (process exit triggers agent_exited).
 *     → Within one tick, task-B is spawned (slot freed).
 *     → GET tasks shows task-B 'planning'.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as childProcess from "node:child_process";

import { Daemon } from "../../packages/banto-daemon/src/daemon.js";
import { startWorkerPool, type WorkerPoolHarness } from "./worker-pool-harness.js";
import type {
  RuntimeDriver,
  SpawnOptions,
  SessionHandle,
  DriverEventHandler,
  DriverEvent,
} from "../../packages/banto-core/src/index.js";

// ── SleepDriver: real-process driver that emits process_exited on kill ────────
//
// Spawns `sleep 120`. Emits process_exited when the process dies (via proc.once("exit"))
// so the daemon removes the ledger entry and counts the slot as freed.
//
// D6: no external libraries; uses only child_process (stdlib).

class SleepDriver implements RuntimeDriver {
  private readonly sessions = new Map<
    string,
    { pid: number; proc: childProcess.ChildProcess }
  >();
  private readonly handlers: Set<DriverEventHandler> = new Set();

  async spawn(opts: SpawnOptions): Promise<SessionHandle> {
    const proc = childProcess.spawn("sleep", ["120"], {
      stdio: "ignore",
      detached: true,
    });
    proc.unref();

    const pid = proc.pid;
    if (!pid) throw new Error("SleepDriver: failed to get pid");

    const sessionId = `${opts.taskId}-${pid}`;
    this.sessions.set(sessionId, { pid, proc });

    // Emit process_exited when the process dies so the daemon removes the ledger entry.
    proc.once("exit", (code, signal) => {
      const exitEv: DriverEvent = {
        type: "process_exited",
        pid,
        sessionId,
        exitCode: code,
        signal,
      };
      for (const h of this.handlers) {
        try {
          h(exitEv);
        } catch {
          /* ignore handler errors */
        }
      }
      this.sessions.delete(sessionId);
    });

    const startEv: DriverEvent = {
      type: "process_started",
      pid,
      sessionId,
      sessionPath: opts.sessionPath,
    };
    for (const h of this.handlers) {
      try {
        h(startEv);
      } catch {
        /* ignore */
      }
    }

    return { pid, sessionId, sessionPath: opts.sessionPath };
  }

  async inject(_sessionId: string, _message: string): Promise<void> {
    // no-op
  }

  subscribe(handler: DriverEventHandler): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  async kill(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    // SIGTERM → proc.once("exit") fires → process_exited emitted → daemon removes ledger entry.
    try {
      process.kill(session.pid, "SIGTERM");
    } catch {
      /* already dead */
    }
  }

  /** Kill all tracked sessions (cleanup helper for after()). */
  async killAll(): Promise<void> {
    for (const [sid] of this.sessions) {
      await this.kill(sid);
    }
    await new Promise<void>((r) => setTimeout(r, 200));
  }

  /** List active session IDs. */
  listSessions(): string[] {
    return [...this.sessions.keys()];
  }
}

// ── Poll helper ───────────────────────────────────────────────────────────────

async function pollUntil<T>(
  fn: () => Promise<T>,
  pred: (v: T) => boolean,
  timeoutMs = 6000,
  intervalMs = 100
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last = await fn();
  while (!pred(last) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, intervalMs));
    last = await fn();
  }
  return last;
}

async function getStatus(
  base: string,
  proj: string,
  taskId: string
): Promise<string> {
  const r = await fetch(`${base}/api/v1/projects/${proj}/tasks/${taskId}`);
  return (await r.json() as { task: { status: string } }).task.status;
}

async function getProjectEvents(
  base: string,
  proj: string
): Promise<Array<{ type: string; taskId?: string }>> {
  const r = await fetch(`${base}/api/v1/projects/${proj}/events`);
  return (await r.json() as { events: Array<{ type: string; taskId?: string }> }).events;
}

// ── git helpers ───────────────────────────────────────────────────────────────

function git(args: string[], cwd: string): void {
  const r = childProcess.spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0)
    throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
}

function initRepo(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  git(["init", "-b", "main"], dir);
  git(["config", "user.email", "test@example.com"], dir);
  git(["config", "user.name", "Test"], dir);
  fs.writeFileSync(path.join(dir, "README.md"), "test\n");
  git(["add", "."], dir);
  git(["commit", "-m", "init"], dir);
}

// ── Suite: AC-S75f66b-2-2 ─────────────────────────────────────────────────────

describe("[AC-S75f66b-2-2] Physical quota caps concurrent spawns; freed slot unblocks waiting task", () => {
  let tmpDir: string;
  let repoDir: string;
  let daemon: Daemon;
  let base: string;
  let driver: SleepDriver;
  let workers: WorkerPoolHarness;
  const proj = "proj-quota";
  const taskA = "task-quota-a";
  const taskB = "task-quota-b";

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "banto-autospawn-quota-"));
    repoDir = path.join(tmpDir, "repo");
    initRepo(repoDir);

    // 職人を起こすのは Worker Pool（決定60）。数える相手も Worker Pool の職人になる
    driver = new SleepDriver();
    workers = await startWorkerPool(driver);

    // maxConcurrentSessions=1 enforces the quota at 1 concurrent session.
    daemon = Daemon.create({
      port: 0,
      dataDir: path.join(tmpDir, "data"),
      watchIntervalMs: 99999,
      tickIntervalMs: 300,
      maxConcurrentSessions: 1,
      worktreeBaseDir: path.join(tmpDir, "worktrees"),
      workerPoolUrl: workers.url,
    });

    await daemon.start();
    base = `http://localhost:${daemon.port}`;

    const projRes = await fetch(`${base}/api/v1/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: proj, repoPath: repoDir }),
    });
    assert.equal(projRes.status, 201, "project must register");
  });

  after(async () => {
    await daemon.stop();
    await workers.close();
    await driver.killAll();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it(
    "[AC-S75f66b-2-2] scenario-2 step-1: with quota=1, second ready task waits (no silent rejection event)",
    async () => {
      // Create task-A (no deps, unique scope) → queue it.
      // Gate promotes queued→ready immediately (no deps, no overlap).
      const resA = await fetch(`${base}/api/v1/projects/${proj}/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: taskA,
          title: "Quota test task A",
          scope: { paths: ["src/module-a/**"] },
        }),
      });
      assert.equal(resA.status, 201);

      const resB = await fetch(`${base}/api/v1/projects/${proj}/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: taskB,
          title: "Quota test task B",
          scope: { paths: ["src/module-b/**"] },
        }),
      });
      assert.equal(resB.status, 201);

      // Queue both tasks. Gate re-eval fires on each transition.
      // Both tasks have non-overlapping scopes and no deps → both reach 'ready'.
      const qA = await fetch(
        `${base}/api/v1/projects/${proj}/tasks/${taskA}/transition`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ to: "queued" }),
        }
      );
      assert.equal(qA.status, 200);

      const qB = await fetch(
        `${base}/api/v1/projects/${proj}/tasks/${taskB}/transition`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ to: "queued" }),
        }
      );
      assert.equal(qB.status, 200);

      // Wait for both tasks to become 'ready' (gate re-eval fires immediately on transition).
      const aReady = await pollUntil(
        () => getStatus(base, proj, taskA),
        (s) => s === "ready" || s === "planning",
        3000
      );
      const bReady = await pollUntil(
        () => getStatus(base, proj, taskB),
        (s) => s === "ready" || s === "planning",
        3000
      );
      // Both must have passed the gate (reached ready or beyond)
      assert.ok(
        aReady === "ready" || aReady === "planning",
        `task-A must be ready or planning. Got '${aReady}'`
      );
      assert.ok(
        bReady === "ready" || bReady === "planning",
        `task-B must be ready or planning. Got '${bReady}'`
      );

      // Wait for auto-spawn to run (≥1 tick at 300 ms + margin).
      await new Promise<void>((r) => setTimeout(r, 700));

      // With quota=1: exactly ONE task should be 'planning', the other still 'ready'.
      const statusA = await getStatus(base, proj, taskA);
      const statusB = await getStatus(base, proj, taskB);

      const planningCount = [statusA, statusB].filter(
        (s) => s === "planning"
      ).length;
      const readyCount = [statusA, statusB].filter((s) => s === "ready").length;

      assert.equal(
        planningCount,
        1,
        `Exactly 1 task must be 'planning' with quota=1. ` +
          `task-A='${statusA}', task-B='${statusB}'`
      );
      assert.equal(
        readyCount,
        1,
        `Exactly 1 task must remain 'ready' with quota=1. ` +
          `task-A='${statusA}', task-B='${statusB}'`
      );

      // Wait ≥3 more ticks and verify the 'ready' task has NOT been spawned.
      await new Promise<void>((r) => setTimeout(r, 1100));

      const statusAAfter = await getStatus(base, proj, taskA);
      const statusBAfter = await getStatus(base, proj, taskB);

      // The 'ready' task must still be 'ready' (quota still full).
      const planningAfter = [statusAAfter, statusBAfter].filter(
        (s) => s === "planning"
      ).length;
      assert.equal(
        planningAfter,
        1,
        `Still exactly 1 task 'planning' across further ticks (quota=1 still full). ` +
          `task-A='${statusAAfter}', task-B='${statusBAfter}'`
      );

      // No rejection event should be emitted for the waiting task (silent quota skip).
      const events = await getProjectEvents(base, proj);
      const rejectionEvents = events.filter(
        (e) =>
          e.type === "transition_rejected" ||
          e.type === "task_failed" ||
          e.type === "tick_job_failed"
      );
      // There should be no rejection/failure events for the quota-waiting task.
      // (tick_job_failed for unrelated daemon events is acceptable, but none expected here.)
      const quotaRejections = rejectionEvents.filter((e) => {
        if (e.type === "task_failed") {
          const taskIds = [taskA, taskB];
          return taskIds.includes(e.taskId ?? "");
        }
        return false;
      });
      assert.equal(
        quotaRejections.length,
        0,
        `No task_failed events expected for quota-waiting tasks (silent skip). ` +
          `Got: ${JSON.stringify(quotaRejections)}`
      );
    }
  );

  it(
    "[AC-S75f66b-2-2] scenario-2 step-2: when quota frees up, the waiting task is spawned",
    async () => {
      // Find which task is 'planning' (was spawned first) and kill its session.
      const statusA = await getStatus(base, proj, taskA);
      const statusB = await getStatus(base, proj, taskB);

      const [spawnedTask, waitingTask] =
        statusA === "planning" ? [taskA, taskB] : [taskB, taskA];

      assert.equal(
        await getStatus(base, proj, spawnedTask),
        "planning",
        `${spawnedTask} must be 'planning'`
      );
      assert.equal(
        await getStatus(base, proj, waitingTask),
        "ready",
        `${waitingTask} must be 'ready'`
      );

      // Kill the spawned task's session to free the quota slot.
      // SleepDriver.kill() が SIGTERM を送ると、Worker Pool の職人が「生きていない」に変わる
      // ——Kobo は毎 tick そこを数え直すので、空いた枠が次の tick で効く（決定60）
      const sessionsBefore = driver.listSessions();
      assert.equal(
        sessionsBefore.length,
        1,
        "Exactly 1 session must be active before killing"
      );
      await driver.kill(sessionsBefore[0]);

      // Wait for the process_exited event to propagate and the ledger to be updated,
      // then for at least one auto-spawn tick to run.
      // Budget: agent_exited propagation + 1 tick (300 ms) + margin = ~1 s total.
      const waitingTaskFinalStatus = await pollUntil(
        () => getStatus(base, proj, waitingTask),
        (s) => s === "planning" || s === "failed",
        5000
      );

      assert.equal(
        waitingTaskFinalStatus,
        "planning",
        `${waitingTask} must be auto-spawned to 'planning' once the slot frees. ` +
          `Got '${waitingTaskFinalStatus}'.`
      );

      // Verify agent_spawned event for the waiting task now exists.
      const eventsAfter = await getProjectEvents(base, proj);
      const spawnedEventsForWaiting = eventsAfter.filter(
        (e) => e.type === "agent_spawned" && e.taskId === waitingTask
      );
      assert.ok(
        spawnedEventsForWaiting.length >= 1,
        `Expected agent_spawned for ${waitingTask}. ` +
          `Events: ${JSON.stringify(eventsAfter.map((e) => `${e.type}(${e.taskId ?? ""})`))}`
      );
    }
  );
});

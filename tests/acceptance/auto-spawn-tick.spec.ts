/**
 * [AC-S75f66b-2-1] ready tasks are auto-spawned on the next tick (no manual spawn).
 * [AC-S75f66b-2-3] spawn failure → task_failed + no re-spawn loop.
 *
 * Story: S75f66b-2 「readyタスクの自動spawn（tickジョブ）」
 *
 * Entry point: HTTP API only (story_type=api, Rule 2).
 * Test driver: SleepDriver (real OS process, satisfies RuntimeDriver contract).
 * No pi binary, no LLM calls required.
 *
 * task-0060（ADR-0013 決定60）: Kobo は職人を自分で起こさない。差し替えるのは
 * **Worker Pool のランタイム**（pi の代わり）で、Worker Pool 自体は本物を独立サービスとして
 * 立てる——決定27b の呼び出し経路がテストのたびに実際に通る。
 *
 * Scenario coverage:
 *   scenario-1 (AC-S75f66b-2-1): PO drops a task file → gate promotes queued→ready →
 *     auto-spawn tick picks it up → agent_spawned + state_transitioned(ready→planning)
 *     observed via HTTP, with no manual spawn API call.
 *   scenario-3 (AC-S75f66b-2-3): spawn always fails → task_failed once → stays failed
 *     → further ticks produce no additional spawn-attempt events.
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
// Spawns `sleep 120` as a real OS process. Emits process_exited when the
// process dies so the daemon removes the ledger entry and can track clean exit.
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

    // Emit process_exited when the process dies (so daemon removes ledger entry).
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
    // no-op — sleep doesn't accept messages
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
    // Kill by SIGTERM — proc.once("exit") will fire and emit process_exited.
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
    // Brief wait for exit events to propagate
    await new Promise<void>((r) => setTimeout(r, 100));
  }
}

// ── FailDriver: always throws on spawn ────────────────────────────────────────
//
// Used for AC-S75f66b-2-3: spawn failure → task_failed → no re-spawn loop.

class FailDriver implements RuntimeDriver {
  private readonly handlers: Set<DriverEventHandler> = new Set();

  async spawn(_opts: SpawnOptions): Promise<SessionHandle> {
    throw new Error("FailDriver: spawn always fails (test-only driver)");
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

  async kill(_sessionId: string): Promise<void> {
    // no-op — nothing to kill
  }
}

// ── Poll helper ───────────────────────────────────────────────────────────────

async function pollUntil<T>(
  fn: () => Promise<T>,
  pred: (v: T) => boolean,
  timeoutMs = 5000,
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
  return (
    (await r.json() as { task: { status: string } }).task.status
  );
}

async function getTaskEvents(
  base: string,
  proj: string,
  taskId: string
): Promise<Array<{ type: string }>> {
  const r = await fetch(
    `${base}/api/v1/projects/${proj}/tasks/${taskId}/events`
  );
  return (await r.json() as { events: Array<{ type: string }> }).events;
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

// ── Suite 1: AC-S75f66b-2-1 auto-spawn on tick ────────────────────────────────

describe("[AC-S75f66b-2-1] ready task is auto-spawned on next tick (no manual spawn)", () => {
  let tmpDir: string;
  let repoDir: string;
  let daemon: Daemon;
  let base: string;
  let driver: SleepDriver;
  let workers: WorkerPoolHarness;
  const proj = "proj-autospawn";
  const taskId = "task-autospawn-1";

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "banto-autospawn-tick-"));
    repoDir = path.join(tmpDir, "repo");
    initRepo(repoDir);

    // 職人を起こすのは Worker Pool。ランタイムだけ SleepDriver に差し替える
    driver = new SleepDriver();
    workers = await startWorkerPool(driver);

    // Short tick so auto-spawn fires within the test budget.
    daemon = Daemon.create({
      port: 0,
      dataDir: path.join(tmpDir, "data"),
      tickIntervalMs: 300,
      worktreeBaseDir: path.join(tmpDir, "worktrees"),
      workerPoolUrl: workers.url,
    });

    await daemon.start();
    base = `http://localhost:${daemon.port}`;

    // Register project with a real git repo so worktree creation succeeds.
    const projRes = await fetch(`${base}/api/v1/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: proj, repoPath: repoDir }),
    });
    assert.equal(projRes.status, 201, "project must register successfully");
  });

  after(async () => {
    await daemon.stop();
    await workers.close();
    await driver.killAll();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it(
    "[AC-S75f66b-2-1] scenario-1 step-1: queued→ready task is auto-spawned without a manual spawn API call",
    async () => {
      // Create task via HTTP (draft status).
      const createRes = await fetch(`${base}/api/v1/projects/${proj}/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: taskId, title: "Auto-spawn test task" }),
      });
      assert.equal(createRes.status, 201, "task must be created");

      // Transition to queued via HTTP. Gate re-eval fires immediately and promotes to ready
      // (no dependencies, no scope overlap). The auto-spawn tick then picks it up.
      const queueRes = await fetch(
        `${base}/api/v1/projects/${proj}/tasks/${taskId}/transition`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ to: "queued" }),
        }
      );
      assert.equal(queueRes.status, 200, "queued transition must succeed");

      // Poll until the task reaches 'planning' (auto-spawned).
      // Budget: 5 s (much more than 1–2 tick cycles at 300 ms).
      const finalStatus = await pollUntil(
        () => getStatus(base, proj, taskId),
        (s) => s === "planning" || s === "failed",
        5000
      );

      // Verify the task is 'planning' (not 'failed' or 'ready').
      assert.equal(
        finalStatus,
        "planning",
        `Task must be 'planning' after auto-spawn. Got '${finalStatus}'. ` +
          "Check that the auto-spawn tick job is registered and SleepDriver is active."
      );

      // Verify event sequence: gate_evaluated(passed) → state_transitioned(queued→ready)
      //   → agent_spawned → state_transitioned(ready→planning)
      // All observed via GET /events — no manual spawn API call was made.
      const events = await getTaskEvents(base, proj, taskId);
      const eventTypes = events.map((e) => e.type);

      assert.ok(
        events.some((e) => e.type === "gate_evaluated"),
        `Expected gate_evaluated event. Events: ${JSON.stringify(eventTypes)}`
      );
      assert.ok(
        events.some((e) => e.type === "agent_spawned"),
        `Expected agent_spawned event. Events: ${JSON.stringify(eventTypes)}`
      );

      // gate_evaluated must appear before agent_spawned.
      const gateIdx = events.findIndex((e) => e.type === "gate_evaluated");
      const spawnedIdx = events.findIndex((e) => e.type === "agent_spawned");
      assert.ok(
        gateIdx < spawnedIdx,
        `gate_evaluated (idx=${gateIdx}) must precede agent_spawned (idx=${spawnedIdx})`
      );

      // Confirm the state_transitioned(ready→planning) event exists.
      const transitions = events.filter((e) => e.type === "state_transitioned") as Array<{
        type: string;
        from?: string;
        to?: string;
      }>;
      const readyToPlanning = transitions.find(
        (e) => e.from === "ready" && e.to === "planning"
      );
      assert.ok(
        readyToPlanning,
        `Expected state_transitioned(ready→planning). Transitions: ${JSON.stringify(transitions)}`
      );
    }
  );
});

// ── Suite 2: AC-S75f66b-2-3 spawn failure → failed + no re-spawn loop ─────────

describe("[AC-S75f66b-2-3] spawn failure results in task_failed; no re-spawn loop occurs", () => {
  let tmpDir: string;
  let daemon: Daemon;
  let base: string;
  let workers: WorkerPoolHarness;
  const proj = "proj-fail";
  const taskId = "task-fail-1";

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "banto-autospawn-fail-"));

    // 起動が必ず失敗するランタイムを Worker Pool に載せる
    workers = await startWorkerPool(new FailDriver());

    daemon = Daemon.create({
      port: 0,
      dataDir: path.join(tmpDir, "data"),
      tickIntervalMs: 300,
      workerPoolUrl: workers.url,
      // No worktreeBaseDir / repoPath needed: FailDriver throws before worktree creation
    });

    await daemon.start();
    base = `http://localhost:${daemon.port}`;

    const projRes = await fetch(`${base}/api/v1/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // No real repo needed: FailDriver throws before worktree creation.
      body: JSON.stringify({ id: proj, repoPath: "" }),
    });
    assert.equal(projRes.status, 201, "project must register");
  });

  after(async () => {
    await daemon.stop();
    await workers.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it(
    "[AC-S75f66b-2-3] scenario-3 step-1: spawn failure records task_failed",
    async () => {
      // Create task and queue it. Gate will promote to ready immediately.
      const createRes = await fetch(`${base}/api/v1/projects/${proj}/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: taskId, title: "Fail spawn test task" }),
      });
      assert.equal(createRes.status, 201, "task must be created");

      const queueRes = await fetch(
        `${base}/api/v1/projects/${proj}/tasks/${taskId}/transition`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ to: "queued" }),
        }
      );
      assert.equal(queueRes.status, 200, "queued transition must succeed");

      // Poll until the task reaches 'failed' (FailDriver throws, task_failed is recorded).
      const finalStatus = await pollUntil(
        () => getStatus(base, proj, taskId),
        (s) => s === "failed" || s === "planning",
        5000
      );

      assert.equal(
        finalStatus,
        "failed",
        `Task must be 'failed' after spawn failure. Got '${finalStatus}'.`
      );

      // Verify task_failed event exists in the log.
      const events = await getTaskEvents(base, proj, taskId);
      const failedEvent = events.find((e) => e.type === "task_failed");
      assert.ok(
        failedEvent,
        `Expected task_failed event. Events: ${JSON.stringify(events.map((e) => e.type))}`
      );
    }
  );

  it(
    "[AC-S75f66b-2-3] scenario-3 step-2: no re-spawn loop after task_failed (≥3 tick wait)",
    async () => {
      // Wait for ≥3 further ticks (3 × 300 ms = 900 ms + buffer).
      // If there were a re-spawn loop, task_failed events would accumulate.
      await new Promise<void>((r) => setTimeout(r, 1200));

      // Re-read task status — must still be 'failed'.
      const status = await getStatus(base, proj, taskId);
      assert.equal(status, "failed", "Task must remain 'failed' after additional ticks");

      // Count spawn-attempt events. In a healthy implementation:
      //   - exactly 1 agent_spawned (or 0, if FailDriver throws before agent_spawned)
      //   - exactly 1 task_failed
      // A re-spawn loop would produce multiple task_failed events.
      const events = await getTaskEvents(base, proj, taskId);
      const failedEvents = events.filter((e) => e.type === "task_failed");
      assert.equal(
        failedEvents.length,
        1,
        `Expected exactly 1 task_failed event (no re-spawn loop). Got ${failedEvents.length}. ` +
          `All events: ${JSON.stringify(events.map((e) => e.type))}`
      );

      // agent_spawned should be 0 (FailDriver throws before spawnTask reaches that point)
      // or at most 1 if the driver emits it before throwing — either way no loop.
      const spawnedEvents = events.filter((e) => e.type === "agent_spawned");
      assert.ok(
        spawnedEvents.length <= 1,
        `Expected at most 1 agent_spawned event (no re-spawn loop). Got ${spawnedEvents.length}.`
      );
    }
  );
});

/**
 * [AC-S75f66b-3-3] 監査セッションが audit_report ツールで pass を報告すると、
 * review.policy が auto のタスクは merging へ、それ以外は review-ready へ遷移する。
 *
 * 検証内容:
 *   - task-manual (no policy): POST audit-report(pass) → status: review-ready
 *   - task-auto-policy (review.policy=auto): POST audit-report(pass) → status: merging
 *   - state_transitioned events recorded for both paths
 *   - audit_verdict event recorded
 *
 * Entry point: HTTP API (story_type=api, Rule 2).
 * The audit_report tool calls POST /api/v1/projects/:proj/tasks/:id/audit-report
 * (same path the daemon HTTP endpoint serves).
 *
 * Scenario: scenario-3-api
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as childProcess from "node:child_process";

import { Daemon } from "../../packages/banto-daemon/src/daemon.js";
import { startWorkerPool, type WorkerPoolHarness } from "./worker-pool-harness.js";
import { advanceTask } from "./task-flow.js";
import type {
  RuntimeDriver,
  SpawnOptions,
  SessionHandle,
  DriverEventHandler,
  DriverEvent,
} from "../../packages/banto-core/src/index.js";

// ── SleepDriver ────────────────────────────────────────────────────────────────

class SleepDriver implements RuntimeDriver {
  private readonly sessions = new Map<string, { pid: number; proc: childProcess.ChildProcess }>();
  private readonly handlers: Set<DriverEventHandler> = new Set();

  async spawn(opts: SpawnOptions): Promise<SessionHandle> {
    const proc = childProcess.spawn("sleep", ["120"], { stdio: "ignore", detached: true });
    proc.unref();
    const pid = proc.pid;
    if (!pid) throw new Error("SleepDriver: failed to get pid");
    const sessionId = `sleep-${opts.taskId}-${pid}`;
    this.sessions.set(sessionId, { pid, proc });
    proc.once("exit", (code, signal) => {
      const ev: DriverEvent = { type: "process_exited", pid, sessionId, exitCode: code, signal };
      for (const h of this.handlers) { try { h(ev); } catch { /* ignore */ } }
      this.sessions.delete(sessionId);
    });
    const startEv: DriverEvent = { type: "process_started", pid, sessionId, sessionPath: opts.sessionPath };
    for (const h of this.handlers) { try { h(startEv); } catch { /* ignore */ } }
    return { pid, sessionId, sessionPath: opts.sessionPath };
  }

  async inject(_sessionId: string, _message: string): Promise<void> { /* no-op */ }

  subscribe(handler: DriverEventHandler): () => void {
    this.handlers.add(handler);
    return () => { this.handlers.delete(handler); };
  }

  async kill(sessionId: string): Promise<void> {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    try { process.kill(s.pid, "SIGTERM"); } catch { /* already dead */ }
  }

  async killAll(): Promise<void> {
    for (const [sid] of this.sessions) { await this.kill(sid); }
    await new Promise<void>((r) => setTimeout(r, 100));
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function git(args: string[], cwd: string): void {
  const r = childProcess.spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
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

// ── Suite ──────────────────────────────────────────────────────────────────────

describe("[AC-S75f66b-3-3] audit pass routes: auto→merging, manual→review-ready", () => {
  let tmpDir: string;
  let repoDir: string;
  let daemon: Daemon;
  let base: string;
  let driver: SleepDriver;
  let workers: WorkerPoolHarness;

  const proj = "proj-verdict-routing";
  // taskManual: created via HTTP without review.policy → should go to review-ready on pass
  const taskManual = "task-manual-1";
  // taskAutoPolicy: created via daemon.createTask with review.policy=auto → should go to merging on pass
  const taskAutoPolicy = "task-auto-policy";

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "banto-audit-verdict-"));
    repoDir = path.join(tmpDir, "repo");
    initRepo(repoDir);

    // 監査人を起こすのは Worker Pool（決定60）。ランタイムだけ差し替える
    driver = new SleepDriver();
    workers = await startWorkerPool(driver);

    daemon = Daemon.create({
      port: 0,
      dataDir: path.join(tmpDir, "data"),
      watchIntervalMs: 99999,
      tickIntervalMs: 99999,
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

    // taskManual: create via HTTP (no review.policy set → manual by default)
    const createManual = await fetch(`${base}/api/v1/projects/${proj}/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: taskManual, title: "Manual review policy task" }),
    });
    assert.equal(createManual.status, 201, "taskManual must be created");
    // task-0069: ready を待ってから進める（queued→planning は表に無い）
    await advanceTask(base, proj, taskManual, ["queued", "planning", "implementing", "auditing"]);

    // taskAutoPolicy: create via daemon.createTask() with review.policy=auto in payload.
    // This simulates the task watcher ingesting a task file with `review: { policy: auto }` frontmatter.
    // The extra payload is spread into the task record (state-store.ts task_created handler).
    daemon.createTask(proj, taskAutoPolicy, "Auto Policy Task", {
      review: { policy: "auto" },
    });
    // task-0069: ready を待ってから進める（queued→planning は表に無い）
    await advanceTask(base, proj, taskAutoPolicy, ["queued", "planning", "implementing", "auditing"]);
  });

  after(async () => {
    await daemon.stop();
    await workers.close();
    await driver.killAll();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("[AC-S75f66b-3-3] scenario-3-api step-1: audit pass without policy → review-ready", async () => {
    // Audit session reports pass via POST /audit-report (real HTTP — Rule 2)
    const reportRes = await fetch(
      `${base}/api/v1/projects/${proj}/tasks/${taskManual}/audit-report`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ verdict: "pass", findings: [] }),
      }
    );
    assert.equal(reportRes.status, 200, "audit-report must succeed");
    const reportBody = await reportRes.json() as { ok: boolean };
    assert.ok(reportBody.ok, "audit-report must return { ok: true }");

    // Verify task status is review-ready
    const taskRes = await fetch(`${base}/api/v1/projects/${proj}/tasks/${taskManual}`);
    const { task } = await taskRes.json() as { task: { status: string } };
    assert.equal(task.status, "review-ready", "task with no policy must reach review-ready on pass");

    // Verify state_transitioned(auditing→review-ready) event
    const eventsRes = await fetch(`${base}/api/v1/projects/${proj}/tasks/${taskManual}/events`);
    const { events } = await eventsRes.json() as {
      events: Array<{ type: string; from?: string; to?: string; verdict?: string }>
    };

    const transition = events.find(
      (e) => e.type === "state_transitioned" && e.from === "auditing" && e.to === "review-ready"
    );
    assert.ok(
      transition,
      `state_transitioned(auditing→review-ready) must exist. Events: ${JSON.stringify(events.map(e => e.type))}`
    );

    // Verify audit_verdict event
    const verdictEvent = events.find((e) => e.type === "audit_verdict");
    assert.ok(verdictEvent, "audit_verdict event must be recorded");
    assert.equal((verdictEvent as { verdict: string }).verdict, "pass");
  });

  it("[AC-S75f66b-3-3] scenario-3-api step-2: audit pass with review.policy=auto → merging (skips review-ready)", async () => {
    // Audit session reports pass via POST /audit-report for the auto-policy task
    const reportRes = await fetch(
      `${base}/api/v1/projects/${proj}/tasks/${taskAutoPolicy}/audit-report`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ verdict: "pass", findings: [] }),
      }
    );
    assert.equal(reportRes.status, 200, "audit-report must succeed for auto-policy task");
    const reportBody = await reportRes.json() as { ok: boolean };
    assert.ok(reportBody.ok, "audit-report must return { ok: true }");

    // Verify task status is merging (not review-ready)
    const taskRes = await fetch(`${base}/api/v1/projects/${proj}/tasks/${taskAutoPolicy}`);
    const { task } = await taskRes.json() as { task: { status: string } };
    assert.equal(task.status, "merging", "task with review.policy=auto must reach merging on pass");

    // Verify state_transitioned(auditing→merging) and NO review-ready in the path
    const eventsRes = await fetch(`${base}/api/v1/projects/${proj}/tasks/${taskAutoPolicy}/events`);
    const { events } = await eventsRes.json() as {
      events: Array<{ type: string; from?: string; to?: string }>
    };

    const toMerging = events.find(
      (e) => e.type === "state_transitioned" && e.from === "auditing" && e.to === "merging"
    );
    assert.ok(
      toMerging,
      `state_transitioned(auditing→merging) must exist. Events: ${JSON.stringify(events.map(e => e.type))}`
    );

    // Verify the task never passed through review-ready
    const toReviewReady = events.find(
      (e) => e.type === "state_transitioned" && e.to === "review-ready"
    );
    assert.ok(
      !toReviewReady,
      "task with review.policy=auto must NOT pass through review-ready"
    );
  });
});

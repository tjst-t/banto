/**
 * [AC-S75f66b-3-1] 実行者の完了報告でタスクが auditing へ遷移すると、
 * daemonが監査セッションを自動spawnする。
 *
 * 検証内容:
 *   - implementing→auditing 遷移後に agent_spawned イベントが出る（audit marker付き）
 *   - audit_started イベントが出る（monitoring auditing status）
 *   - spawn台帳エントリが作成される
 *   - 実 daemon + CaptureDriver（実 OS プロセス、spawn を記録する）
 *
 * Entry point: HTTP API (story_type=api, Rule 2).
 * Test driver: CaptureDriver — real process that records what was spawned.
 *
 * Scenario: scenario-1-api
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as childProcess from "node:child_process";

import { Daemon } from "../../packages/banto-daemon/src/daemon.js";
import type {
  RuntimeDriver,
  SpawnOptions,
  SessionHandle,
  DriverEventHandler,
  DriverEvent,
} from "../../packages/banto-core/src/index.js";

// ── CaptureDriver ─────────────────────────────────────────────────────────────
// Spawns a real `sleep` process (real OS process) and records the SpawnOptions.
// This lets tests verify what systemPrompt/tools the daemon injected.

interface CaptureRecord {
  opts: SpawnOptions;
  pid: number;
  sessionId: string;
}

class CaptureDriver implements RuntimeDriver {
  readonly spawned: CaptureRecord[] = [];
  private readonly sessions = new Map<string, { pid: number; proc: childProcess.ChildProcess }>();
  private readonly handlers: Set<DriverEventHandler> = new Set();

  async spawn(opts: SpawnOptions): Promise<SessionHandle> {
    const proc = childProcess.spawn("sleep", ["120"], {
      stdio: "ignore",
      detached: true,
    });
    proc.unref();
    const pid = proc.pid;
    if (!pid) throw new Error("CaptureDriver: failed to get pid");

    const sessionId = `capture-${opts.taskId}-${pid}`;
    this.sessions.set(sessionId, { pid, proc });

    proc.once("exit", (code, signal) => {
      const ev: DriverEvent = {
        type: "process_exited",
        pid,
        sessionId,
        exitCode: code,
        signal,
      };
      for (const h of this.handlers) {
        try { h(ev); } catch { /* ignore */ }
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
      try { h(startEv); } catch { /* ignore */ }
    }

    this.spawned.push({ opts, pid, sessionId });
    return { pid, sessionId, sessionPath: opts.sessionPath };
  }

  async inject(_sessionId: string, _message: string): Promise<void> {
    // no-op
  }

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
    for (const [sid] of this.sessions) {
      await this.kill(sid);
    }
    await new Promise<void>((r) => setTimeout(r, 100));
  }
}

// ── Poll helper ────────────────────────────────────────────────────────────────

async function pollUntil<T>(
  fn: () => Promise<T> | T,
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

// ── git helpers ────────────────────────────────────────────────────────────────

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

describe("[AC-S75f66b-3-1] executor completion triggers audit session spawn", () => {
  let tmpDir: string;
  let repoDir: string;
  let daemon: Daemon;
  let base: string;
  let driver: CaptureDriver;
  const proj = "proj-audit-spawn";
  const taskId = "task-audit-1";

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "banto-audit-spawn-"));
    repoDir = path.join(tmpDir, "repo");
    initRepo(repoDir);

    daemon = Daemon.create({
      port: 0,
      dataDir: path.join(tmpDir, "data"),
      watchIntervalMs: 99999,
      tickIntervalMs: 99999,
      reconcileIntervalMs: 99999,
      worktreeBaseDir: path.join(tmpDir, "worktrees"),
      sessionBaseDir: path.join(tmpDir, "sessions"),
      tmuxSession: "", // disable tmux in tests
    });

    driver = new CaptureDriver();
    daemon.driverRegistry.register("pi-rpc", driver);

    await daemon.start();
    base = `http://localhost:${daemon.port}`;

    // Register project
    const projRes = await fetch(`${base}/api/v1/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: proj, repoPath: repoDir }),
    });
    assert.equal(projRes.status, 201, "project must register");
  });

  after(async () => {
    await driver.killAll();
    await daemon.stop();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("[AC-S75f66b-3-1] scenario-1-api step-1: implementing→auditing triggers audit session spawn", async () => {
    // Create task and advance to implementing via HTTP (real daemon, real HTTP — Rule 2)
    const createRes = await fetch(`${base}/api/v1/projects/${proj}/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: taskId, title: "Audit spawn test task" }),
    });
    assert.equal(createRes.status, 201, "task must be created");

    for (const to of ["queued", "planning", "implementing"]) {
      const r = await fetch(
        `${base}/api/v1/projects/${proj}/tasks/${taskId}/transition`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ to }),
        }
      );
      assert.equal(r.status, 200, `transition to ${to} must succeed`);
    }

    // Executor reports completion: POST implementing→auditing
    const auditRes = await fetch(
      `${base}/api/v1/projects/${proj}/tasks/${taskId}/transition`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ to: "auditing" }),
      }
    );
    assert.equal(auditRes.status, 200, "implementing→auditing must succeed");

    // Verify task status is auditing
    const taskRes = await fetch(`${base}/api/v1/projects/${proj}/tasks/${taskId}`);
    const { task } = await taskRes.json() as { task: { status: string } };
    assert.equal(task.status, "auditing", "task must be in auditing state");

    // Wait for the audit session spawn (async: daemon fires it after transition)
    const spawnSeen = await pollUntil(
      () => driver.spawned.length >= 1,
      (seen) => seen,
      5000
    );
    assert.ok(spawnSeen, "CaptureDriver must have recorded at least one spawn (the audit session)");

    // Verify audit_started event appears in task events
    const eventsRes = await fetch(`${base}/api/v1/projects/${proj}/tasks/${taskId}/events`);
    assert.equal(eventsRes.status, 200, "events must be retrievable");
    const { events } = await eventsRes.json() as {
      events: Array<{ type: string; sessionPath?: string; worktree?: string }>
    };

    const auditStarted = events.find((e) => e.type === "audit_started");
    assert.ok(
      auditStarted,
      `audit_started event must be present. Events seen: ${JSON.stringify(events.map(e => e.type))}`
    );

    // Verify agent_spawned event (distinguishable from executor by being after implementing→auditing)
    const agentSpawned = events.filter((e) => e.type === "agent_spawned");
    assert.ok(
      agentSpawned.length >= 1,
      `At least one agent_spawned event must be present. Events: ${JSON.stringify(events.map(e => e.type))}`
    );

    // Verify spawn-ledger entry for the audit session
    const ledgerEntries = daemon.getLedgerEntries();
    const auditLedgerEntry = ledgerEntries.find(
      (e) => e.taskId.startsWith(taskId) && e.taskId.includes("audit")
    );
    assert.ok(
      auditLedgerEntry,
      `Spawn ledger must have an audit entry for task ${taskId}. Ledger: ${JSON.stringify(ledgerEntries.map(e => e.taskId))}`
    );

    // Verify audit_started references the worktree path (spec §2.1: path ref only)
    if (auditStarted) {
      assert.ok(
        typeof auditStarted.sessionPath === "string" && auditStarted.sessionPath.length > 0,
        "audit_started must have a sessionPath"
      );
      assert.ok(
        typeof auditStarted.worktree === "string" && auditStarted.worktree.length > 0,
        "audit_started must have a worktree path"
      );
    }
  });
});

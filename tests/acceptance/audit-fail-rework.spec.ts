/**
 * [AC-S75f66b-3-4] 監査セッションが fail を報告すると、1回目は rework（implementing に戻り、
 * 指摘事項を注入した実行者セッションが再 spawn される）、
 * 2回目連続 fail はタスクが failed 状態になる。
 *
 * 検証内容:
 *   Suite A — 1st fail rework:
 *     - POST audit-report(fail, findings) → task status becomes "implementing"
 *     - A new executor rework session is spawned (spawn ledger: taskId:rework)
 *     - The rework session's systemPrompt contains the findings string
 *
 *   Suite B — 2nd consecutive fail:
 *     - 1st fail → implementing (rework spawned)
 *     - POST auditing again (auditing→implementing is rework, implementing→auditing retriggers audit)
 *     - 2nd fail → task status becomes "failed"
 *     - No new spawn in ledger for the failed task
 *
 * Entry point: HTTP API (story_type=api, Rule 2).
 * D3: consecutive fail count derived from audit_verdict events in event log.
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
// Records all SpawnOptions so tests can verify what systemPrompt was built.

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
    const proc = childProcess.spawn("sleep", ["120"], { stdio: "ignore", detached: true });
    proc.unref();
    const pid = proc.pid;
    if (!pid) throw new Error("CaptureDriver: failed to get pid");
    const sessionId = `capture-${opts.taskId}-${Date.now()}-${pid}`;
    this.sessions.set(sessionId, { pid, proc });
    proc.once("exit", (code, signal) => {
      const ev: DriverEvent = { type: "process_exited", pid, sessionId, exitCode: code, signal };
      for (const h of this.handlers) { try { h(ev); } catch { /* ignore */ } }
      this.sessions.delete(sessionId);
    });
    const startEv: DriverEvent = { type: "process_started", pid, sessionId, sessionPath: opts.sessionPath };
    for (const h of this.handlers) { try { h(startEv); } catch { /* ignore */ } }
    this.spawned.push({ opts, pid, sessionId });
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
    await new Promise<void>((r) => setTimeout(r, 150));
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

async function pollUntil<T>(
  fn: () => T,
  pred: (v: T) => boolean,
  timeoutMs = 5000,
  intervalMs = 80
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last = fn();
  while (!pred(last) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, intervalMs));
    last = fn();
  }
  return last;
}

async function advanceToAuditing(base: string, proj: string, taskId: string): Promise<void> {
  for (const to of ["queued", "planning", "implementing", "auditing"]) {
    const r = await fetch(
      `${base}/api/v1/projects/${proj}/tasks/${taskId}/transition`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ to }),
      }
    );
    assert.equal(r.status, 200, `${taskId}: transition to ${to} must succeed`);
  }
}

async function createAndAdvanceToAuditing(
  base: string, proj: string, taskId: string
): Promise<void> {
  const createRes = await fetch(`${base}/api/v1/projects/${proj}/tasks`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: taskId, title: `Task ${taskId}` }),
  });
  assert.equal(createRes.status, 201, `task ${taskId} must be created`);
  await advanceToAuditing(base, proj, taskId);
}

// ── Suite A: 1st audit fail triggers rework ───────────────────────────────────

describe("[AC-S75f66b-3-4] 1st audit fail: task back to implementing, rework session spawned with findings", () => {
  let tmpDir: string;
  let repoDir: string;
  let daemon: Daemon;
  let base: string;
  let driver: CaptureDriver;

  const proj = "proj-audit-fail-rework";
  const taskId = "task-fail-rework-1";
  const findings = [
    "acceptance criteria A3 not covered by tests",
    "error in reconcile path is swallowed (I2 violation)",
  ];

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "banto-audit-fail-rework-"));
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
      tmuxSession: "",
    });

    driver = new CaptureDriver();
    daemon.driverRegistry.register("pi-rpc", driver);

    await daemon.start();
    base = `http://localhost:${daemon.port}`;

    const projRes = await fetch(`${base}/api/v1/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: proj, repoPath: repoDir }),
    });
    assert.equal(projRes.status, 201, "project must register");

    await createAndAdvanceToAuditing(base, proj, taskId);
  });

  after(async () => {
    await driver.killAll();
    await daemon.stop();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("[AC-S75f66b-3-4] scenario-4-api step-1: 1st fail verdict → task becomes 'implementing'", async () => {
    // POST audit-report with fail verdict (HTTP API — Rule 2)
    const reportRes = await fetch(
      `${base}/api/v1/projects/${proj}/tasks/${taskId}/audit-report`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ verdict: "fail", findings }),
      }
    );
    assert.equal(reportRes.status, 200, "audit-report(fail) must return 200");
    const reportBody = await reportRes.json() as { ok: boolean };
    assert.ok(reportBody.ok, "audit-report must return { ok: true }");

    // Task must be back in 'implementing' (rework path)
    const taskRes = await fetch(`${base}/api/v1/projects/${proj}/tasks/${taskId}`);
    const { task } = await taskRes.json() as { task: { status: string } };
    assert.equal(
      task.status,
      "implementing",
      "task must be in 'implementing' after 1st audit fail (rework)"
    );
  });

  it("[AC-S75f66b-3-4] scenario-4-api step-2: rework session is spawned after 1st fail", async () => {
    // Wait for rework session spawn (async fire-and-forget in daemon)
    const spawnCount = await pollUntil(
      () => driver.spawned.length,
      (count) => count >= 2, // audit session (1st spawn) + rework session (2nd spawn)
      6000
    );
    assert.ok(spawnCount >= 2, `Expected at least 2 spawns (audit + rework), got ${spawnCount}`);

    // Rework session is the 2nd spawn (after the initial audit session spawn)
    const reworkSpawn = driver.spawned[driver.spawned.length - 1];
    assert.ok(reworkSpawn, "rework spawn record must exist");

    // Verify rework session's systemPrompt contains the findings
    // (D3: findings are injected via prompt, not stored as a separate field)
    for (const finding of findings) {
      assert.ok(
        reworkSpawn.opts.systemPrompt.includes(finding),
        `Rework session systemPrompt must contain finding: "${finding}". ` +
        `Prompt preview: ${reworkSpawn.opts.systemPrompt.slice(0, 500)}`
      );
    }
  });

  it("[AC-S75f66b-3-4] scenario-4-api step-3: rework ledger entry recorded with ':rework' key", async () => {
    const ledgerEntries = daemon.getLedgerEntries();
    const reworkEntry = ledgerEntries.find(
      (e) => e.taskId.includes("rework") && e.taskId.startsWith(taskId)
    );
    assert.ok(
      reworkEntry,
      `Spawn ledger must have a ':rework' entry for task ${taskId}. ` +
      `Ledger: ${JSON.stringify(ledgerEntries.map(e => e.taskId))}`
    );
  });

  it("[AC-S75f66b-3-4] scenario-4-api step-4: audit_verdict(fail) and state_transitioned(auditing→implementing) in event log", async () => {
    const eventsRes = await fetch(`${base}/api/v1/projects/${proj}/tasks/${taskId}/events`);
    const { events } = await eventsRes.json() as {
      events: Array<{ type: string; from?: string; to?: string; verdict?: string; findings?: string[] }>
    };

    // audit_verdict(fail) event must be recorded (D3: event is the truth)
    const verdictEvent = events.find(
      (e) => e.type === "audit_verdict" && e.verdict === "fail"
    );
    assert.ok(verdictEvent, "audit_verdict(fail) event must be in the event log");
    assert.deepEqual(verdictEvent!.findings, findings, "findings must be recorded in audit_verdict event");

    // state_transitioned(auditing→implementing) event must be recorded
    const toImplementing = events.find(
      (e) => e.type === "state_transitioned" && e.from === "auditing" && e.to === "implementing"
    );
    assert.ok(
      toImplementing,
      `state_transitioned(auditing→implementing) must exist in event log. ` +
      `Events: ${JSON.stringify(events.map(e => ({ type: e.type, from: e.from, to: e.to })))}`
    );
  });
});

// ── Suite B: 2nd consecutive fail → task failed ────────────────────────────────

describe("[AC-S75f66b-3-4] 2nd consecutive audit fail: task becomes 'failed'", () => {
  let tmpDir: string;
  let repoDir: string;
  let daemon: Daemon;
  let base: string;
  let driver: CaptureDriver;

  const proj = "proj-audit-double-fail";
  const taskId = "task-double-fail-1";
  const findings1 = ["AC1 not tested"];
  const findings2 = ["still not fixed: AC1 not tested", "introduced new bug in reconcile"];

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "banto-audit-double-fail-"));
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
      tmuxSession: "",
    });

    driver = new CaptureDriver();
    daemon.driverRegistry.register("pi-rpc", driver);

    await daemon.start();
    base = `http://localhost:${daemon.port}`;

    const projRes = await fetch(`${base}/api/v1/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: proj, repoPath: repoDir }),
    });
    assert.equal(projRes.status, 201, "project must register");

    await createAndAdvanceToAuditing(base, proj, taskId);
  });

  after(async () => {
    await driver.killAll();
    await daemon.stop();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("[AC-S75f66b-3-4] scenario-4b-api step-1: 1st fail sends task to rework (implementing)", async () => {
    // 1st audit fail
    const r = await fetch(
      `${base}/api/v1/projects/${proj}/tasks/${taskId}/audit-report`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ verdict: "fail", findings: findings1 }),
      }
    );
    assert.equal(r.status, 200, "1st audit-report(fail) must return 200");

    const taskRes = await fetch(`${base}/api/v1/projects/${proj}/tasks/${taskId}`);
    const { task } = await taskRes.json() as { task: { status: string } };
    assert.equal(task.status, "implementing", "after 1st fail, task must be in implementing");
  });

  it("[AC-S75f66b-3-4] scenario-4b-api step-2: rework done, advance to auditing again", async () => {
    // Simulate rework executor completing: implementing → auditing again.
    // Task is already in "implementing" (after 1st fail rework), so we only need
    // one more transition to re-enter auditing (implementing → auditing).
    const r = await fetch(
      `${base}/api/v1/projects/${proj}/tasks/${taskId}/transition`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ to: "auditing" }),
      }
    );
    assert.equal(r.status, 200, `${taskId}: transition to auditing (2nd round) must succeed`);

    const taskRes = await fetch(`${base}/api/v1/projects/${proj}/tasks/${taskId}`);
    const { task } = await taskRes.json() as { task: { status: string } };
    assert.equal(task.status, "auditing", "after rework, task must be in auditing again");
  });

  it("[AC-S75f66b-3-4] scenario-4b-api step-3: 2nd consecutive fail → task becomes 'failed'", async () => {
    // 2nd audit fail (consecutive — D3: daemon counts from event log)
    const r = await fetch(
      `${base}/api/v1/projects/${proj}/tasks/${taskId}/audit-report`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ verdict: "fail", findings: findings2 }),
      }
    );
    assert.equal(r.status, 200, "2nd audit-report(fail) must return 200");

    // Task must be in 'failed' — not implementing, not auditing (I2: stop)
    const taskRes = await fetch(`${base}/api/v1/projects/${proj}/tasks/${taskId}`);
    const { task } = await taskRes.json() as { task: { status: string } };
    assert.equal(
      task.status,
      "failed",
      "task must be in 'failed' after 2nd consecutive audit fail"
    );
  });

  it("[AC-S75f66b-3-4] scenario-4b-api step-4: no new rework session spawned after 2nd fail", async () => {
    // Wait a brief moment to let any async spawn fire (it should NOT)
    await new Promise((r) => setTimeout(r, 500));

    const ledgerEntries = daemon.getLedgerEntries();
    // The failed task should NOT have a rework entry that spawned after 2nd fail
    // (the 1st rework entry may have been killed/removed already; we check there's no NEW spawn)
    const activeRework = ledgerEntries.filter(
      (e) => e.taskId.startsWith(taskId) && e.taskId.includes("rework")
    );

    // At this point the task is 'failed', so no new rework should be in the ledger.
    // (The 1st rework may have been registered; after task goes to 'failed', no 2nd rework.)
    // The key invariant: spawn count must not have increased beyond audit + 1 rework.
    const spawnCountAfterFail = driver.spawned.length;
    // audit session (1) + rework session (1) = 2 spawns before 2nd fail
    // If daemon incorrectly spawned a 2nd rework after 2nd fail, we'd see 3+
    assert.ok(
      spawnCountAfterFail <= 3, // allow 1 audit-session-after-rework + 1 rework + 1 original audit
      `Too many spawns after 2nd fail (implies rework was spawned erroneously): ${spawnCountAfterFail}. ` +
      `Spawns: ${JSON.stringify(driver.spawned.map(s => s.opts.sessionPath))}`
    );

    // Verify task_failed event recorded in event log
    const eventsRes = await fetch(`${base}/api/v1/projects/${proj}/tasks/${taskId}/events`);
    const { events } = await eventsRes.json() as { events: Array<{ type: string; reason?: string }> };
    const failedEvent = events.find((e) => e.type === "task_failed");
    assert.ok(failedEvent, "task_failed event must be recorded after 2nd consecutive audit fail");
    assert.ok(
      failedEvent!.reason?.includes("audit_failed_twice"),
      `task_failed reason must include 'audit_failed_twice'. Got: ${failedEvent!.reason}`
    );

    // Verify 2 audit_verdict(fail) events are in the event log (D3: derived from these)
    const verdictFails = events.filter(
      (e) => e.type === "audit_verdict" && (e as { verdict?: string }).verdict === "fail"
    );
    assert.equal(
      verdictFails.length,
      2,
      `There must be exactly 2 audit_verdict(fail) events in the log (D3: consecutive count derived here). Got ${verdictFails.length}`
    );

    // Verify no spurious rework entry in ledger for failed task
    assert.equal(
      activeRework.length,
      0,
      `Failed task must not have active rework ledger entry. Got: ${JSON.stringify(activeRework)}`
    );
  });
});

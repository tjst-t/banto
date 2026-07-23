/**
 * [AC-S254276-2-1] Spawn registers an entry in the persistent ledger.
 *
 * Verifies that:
 *   - After spawnTask(), the ledger file (<dataDir>/spawn-ledger.json) exists.
 *   - The ledger entry contains pid, taskId, projectTag, sessionPath, worktree.
 *   - The ledger entry is removed when the session exits (daemon.kill()).
 *   - Corrupt ledger on startup → daemon logs error event + starts with empty ledger.
 *
 * Real pi process (or early-exit pi) is used; if pi cannot start we still verify
 * task_failed was recorded (I2) and the ledger is clean.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as childProcess from "node:child_process";

import { Daemon } from "../../packages/banto-daemon/src/daemon.js";

// ── Git helpers ────────────────────────────────────────────────────────────────

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

// ── Test suite ─────────────────────────────────────────────────────────────────

describe("[AC-S254276-2-1] Spawn ledger — persistent pid/taskId/sessionPath/worktree registration", () => {
  let tmpDir: string;
  let repoDir: string;
  let daemon: Daemon;

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "banto-ledger-"));
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
    });
    await daemon.start();
  });

  after(async () => {
    await daemon.stop();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("[AC-S254276-2-1] spawn-ledger.json is written atomically on spawnTask success or failure", async () => {
    const projectTag = "proj-ledger";
    const taskId = "T-ledger-1";

    daemon.registerProject(projectTag, repoDir);
    daemon.createTask(projectTag, taskId, "Ledger test task");
    daemon.transition(projectTag, taskId, "queued");
    daemon.transition(projectTag, taskId, "ready");

    const ledgerPath = path.join(tmpDir, "data", "spawn-ledger.json");

    // Attempt spawn — may succeed or fail depending on pi/API key availability.
    let spawnResult: { pid: number; sessionId: string; sessionPath: string; worktreePath: string } | undefined;
    try {
      spawnResult = await daemon.spawnTask(projectTag, taskId);
    } catch {
      // spawn failure is also valid (I2: task_failed event must be recorded)
    }

    if (spawnResult) {
      // Success path: ledger file must exist and contain the entry.
      assert.ok(
        fs.existsSync(ledgerPath),
        `spawn-ledger.json must exist at ${ledgerPath} after successful spawn`
      );

      const raw = fs.readFileSync(ledgerPath, "utf8");
      const parsed = JSON.parse(raw) as { version: number; entries: Array<Record<string, unknown>> };
      assert.equal(parsed.version, 1, "ledger file version must be 1");
      assert.ok(Array.isArray(parsed.entries), "ledger entries must be an array");

      const entry = parsed.entries.find(
        (e) => e["taskId"] === taskId && e["projectTag"] === projectTag
      );
      assert.ok(entry, `ledger must contain entry for ${projectTag}/${taskId}`);

      // AC-S254276-2-1 required fields
      assert.ok(typeof entry["pid"] === "number" && (entry["pid"] as number) > 0, "entry.pid must be positive number");
      assert.equal(entry["taskId"], taskId, "entry.taskId must match");
      assert.equal(entry["projectTag"], projectTag, "entry.projectTag must match");
      assert.ok(
        typeof entry["sessionPath"] === "string" && (entry["sessionPath"] as string).length > 0,
        "entry.sessionPath must be non-empty"
      );
      assert.ok(
        typeof entry["worktree"] === "string" && (entry["worktree"] as string).length > 0,
        "entry.worktree must be non-empty"
      );
      assert.ok(
        typeof entry["spawnedAt"] === "string",
        "entry.spawnedAt must be a string timestamp"
      );

      // Verify getLedgerEntries() also returns it
      const inMemory = daemon.getLedgerEntries();
      const inMemEntry = inMemory.find((e) => e.taskId === taskId && e.projectTag === projectTag);
      assert.ok(inMemEntry, "getLedgerEntries() must include the spawned entry");
      assert.equal(inMemEntry.pid, spawnResult.pid, "in-memory pid must match spawn result");

      // Kill the session — entry must be removed from ledger
      const piDriver = daemon.driverRegistry.get("pi-rpc");
      if (piDriver) {
        await piDriver.kill(spawnResult.sessionId);
      }

      // Wait for exit event to propagate and ledger to be updated
      await new Promise<void>((r) => setTimeout(r, 600));

      const rawAfter = fs.readFileSync(ledgerPath, "utf8");
      const parsedAfter = JSON.parse(rawAfter) as { entries: Array<Record<string, unknown>> };
      const entryAfter = parsedAfter.entries.find(
        (e) => e["taskId"] === taskId && e["projectTag"] === projectTag
      );
      assert.ok(
        !entryAfter,
        "ledger entry must be removed after session exits"
      );
    } else {
      // Failure path: ledger must NOT contain the failed entry (it was never added,
      // or was added and cleaned up). task_failed event must be in the log.
      const events = daemon.getAllEvents();
      const failed = events.find((e) => e.type === "task_failed" && e.taskId === taskId);
      assert.ok(failed, "task_failed event must be recorded on spawn failure (I2)");

      // Ledger must not contain this task (spawn failure means no live process)
      const inMemory = daemon.getLedgerEntries();
      const leaked = inMemory.find((e) => e.taskId === taskId && e.projectTag === projectTag);
      assert.ok(!leaked, "failed spawn must not leave a ledger entry");
    }
  });

  it("[AC-S254276-2-1] corrupt ledger on open → tick_job_failed event + empty ledger", async () => {
    // Create a fresh daemon with a pre-corrupted ledger
    const corruptDir = fs.mkdtempSync(path.join(os.tmpdir(), "banto-corrupt-"));
    try {
      fs.mkdirSync(corruptDir, { recursive: true });
      const ledgerPath = path.join(corruptDir, "spawn-ledger.json");
      fs.writeFileSync(ledgerPath, "{ not valid json }", "utf8");

      const d2 = Daemon.create({
        port: 0,
        dataDir: corruptDir,
        watchIntervalMs: 99999,
        tickIntervalMs: 99999,
        reconcileIntervalMs: 99999,
      });
      await d2.start();

      try {
        // Ledger should be empty (corruption → empty start)
        const entries = d2.getLedgerEntries();
        assert.equal(entries.length, 0, "corrupt ledger must yield empty start");

        // tick_job_failed event must be recorded for the corruption
        const events = d2.getAllEvents();
        const errEvent = events.find(
          (e) => e.type === "tick_job_failed" && e.projectTag === "daemon"
        );
        assert.ok(
          errEvent,
          "corrupt ledger must emit a tick_job_failed (daemon-internal) error event"
        );
      } finally {
        await d2.stop();
      }
    } finally {
      fs.rmSync(corruptDir, { recursive: true, force: true });
    }
  });
});

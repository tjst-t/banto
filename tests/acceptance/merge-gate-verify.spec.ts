/**
 * [AC-S75f66b-4-2] Merge gate verify command execution.
 *
 * story_type=library: exercises the module's public API against REAL git repos/worktrees
 * created as test fixtures (temp dirs). No mocked git, no mocked child_process.
 *
 * Scenario 2 (from scenario-S75f66b-4.json):
 *   - A real git repo + rebased worktree for the task
 *   - Task acceptance = [{ id: a1, text: '...', verify: 'sh -c "exit 1"' }] (failing command);
 *     a second passing task with verify 'sh -c "exit 0"'
 *
 *   Step 1: Consumer runs the gate for the passing task.
 *     Expected: Gate passes; execution log exists under <dataDir>/gate-logs/<taskId>/
 *
 *   Step 2: Consumer runs the gate for the failing task.
 *     Expected: Gate fails due to non-zero exit (daemon executed it directly, I1);
 *     the appended event carries gate-log PATH reference only (not log content, spec §2.1);
 *     the referenced file contains the command output.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { execFileSync } from "node:child_process";
import { runMergeGate } from "@banto/daemon";
import { EventLog, StateStore } from "@banto/core";
import type { MergeGateEvaluatedEvent } from "@banto/core";
import { hostVerifyRunner } from "./gate-verify-runner.js";

// ── Git fixture helpers ────────────────────────────────────────────────────────

/**
 * Create a minimal git repo with an initial commit on 'main' and a task branch
 * that adds a single file within scope. Returns the repo dir.
 */
function setupSimpleRepo(repoDir: string, taskId: string): { base: string; branch: string } {
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: repoDir, stdio: "pipe" });

  git("init", "-b", "main");
  git("config", "user.email", "test@banto-test.local");
  git("config", "user.name", "banto-test");

  // Initial commit on main
  fs.mkdirSync(path.join(repoDir, "src"), { recursive: true });
  fs.writeFileSync(path.join(repoDir, "src", "main.ts"), "// initial\n");
  git("add", "-A");
  git("commit", "-m", "initial");

  // Task branch: add a file within scope (src/*)
  const branchName = `${taskId}-branch`;
  git("checkout", "-b", branchName);
  fs.writeFileSync(path.join(repoDir, "src", `${taskId}.ts`), `// ${taskId}\n`);
  git("add", "-A");
  git("commit", "-m", `feat: ${taskId}`);

  return { base: "main", branch: branchName };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("[AC-S75f66b-4-2] Merge gate verify command execution (library)", () => {
  let repoPass: string;
  let repoFail: string;
  let dataDirPass: string;
  let dataDirFail: string;

  before(() => {
    repoPass = fs.mkdtempSync(path.join(os.tmpdir(), "banto-mgate-pass-repo-"));
    repoFail = fs.mkdtempSync(path.join(os.tmpdir(), "banto-mgate-fail-repo-"));
    dataDirPass = fs.mkdtempSync(path.join(os.tmpdir(), "banto-mgate-pass-data-"));
    dataDirFail = fs.mkdtempSync(path.join(os.tmpdir(), "banto-mgate-fail-data-"));
  });

  after(() => {
    for (const d of [repoPass, repoFail, dataDirPass, dataDirFail]) {
      fs.rmSync(d, { recursive: true, force: true });
    }
  });

  it("[AC-S75f66b-4-2] step 1: gate passes for task with verify='sh -c \"exit 0\"'; log dir created", async () => {
    // Setup passing repo
    const { base, branch } = setupSimpleRepo(repoPass, "task-verify-pass");
    const logPass = EventLog.open(dataDirPass);

    // Switch to task branch so worktree matches the branch commit
    execFileSync("git", ["checkout", branch], { cwd: repoPass, stdio: "pipe" });

    const task = {
      id: "task-verify-pass",
      projectTag: "proj-verify",
      status: "merging",
      title: "Passing verify task",
      scope: { paths: ["src/**"] },
      acceptance: [
        { id: "a1", text: "verify passes", verify: 'sh -c "exit 0"' },
      ],
    };

    const result = await runMergeGate(logPass, task, {
      dataDir: dataDirPass,
      repoPath: repoPass,
      base,
      branch,
      worktreePath: repoPass, // use the repo itself as the worktree
      verifyRunner: hostVerifyRunner(),
      repoPathForProfile: repoPass,
    });

    // step 1 expected: gate passes
    assert.equal(result.passed, true, "gate must pass when verify exits 0");
    assert.equal(result.reasons.length, 0, "no failure reasons when gate passes");

    // Verify the a1 result
    const a1Result = result.verifyResults.find((r) => r.acId === "a1");
    assert.ok(a1Result, "result must include a1");
    assert.equal(a1Result!.exitCode, 0, "verify a1 must exit 0");
    assert.ok(a1Result!.logDirPath !== undefined, "log dir path must be set");

    // Log dir must exist on disk
    const logDirExists = fs.existsSync(a1Result!.logDirPath!);
    assert.ok(logDirExists, `gate-logs dir must exist at ${a1Result!.logDirPath}`);

    // stdout.txt and stderr.txt must be present
    assert.ok(
      fs.existsSync(path.join(a1Result!.logDirPath!, "stdout.txt")),
      "stdout.txt must exist in log dir"
    );
    assert.ok(
      fs.existsSync(path.join(a1Result!.logDirPath!, "stderr.txt")),
      "stderr.txt must exist in log dir"
    );
  });

  it("[AC-S75f66b-4-2] step 2: gate fails for task with verify='sh -c \"exit 1\"'; event carries path only (not content)", async () => {
    // Setup failing repo
    const { base, branch } = setupSimpleRepo(repoFail, "task-verify-fail");
    const logFail = EventLog.open(dataDirFail);

    execFileSync("git", ["checkout", branch], { cwd: repoFail, stdio: "pipe" });

    const task = {
      id: "task-verify-fail",
      projectTag: "proj-verify",
      status: "merging",
      title: "Failing verify task",
      scope: { paths: ["src/**"] },
      acceptance: [
        { id: "a1", text: "verify fails", verify: 'sh -c "exit 1"' },
      ],
    };

    // Seed task_created + state_transitioned so StateStore can derive status after gate runs
    logFail.append({
      type: "task_created",
      projectTag: "proj-verify",
      taskId: "task-verify-fail",
      payload: {
        title: "Failing verify task",
        scope: { paths: ["src/**"] },
        acceptance: [{ id: "a1", text: "verify fails" }],
      },
    });
    logFail.append({
      type: "state_transitioned",
      projectTag: "proj-verify",
      taskId: "task-verify-fail",
      from: "draft",
      to: "merging",
    });

    const result = await runMergeGate(logFail, task, {
      dataDir: dataDirFail,
      repoPath: repoFail,
      base,
      branch,
      worktreePath: repoFail,
      verifyRunner: hostVerifyRunner(),
      repoPathForProfile: repoFail,
    });

    // step 2 expected: gate fails due to non-zero exit (I1: daemon executed it directly)
    assert.equal(result.passed, false, "gate must fail when verify exits 1");

    // I2 machine-verification: StateStore.replay must derive status = "failed"
    const store = StateStore.replay(logFail);
    const taskRecord = store.getTask("task-verify-fail", "proj-verify");
    assert.ok(taskRecord !== undefined, "task record must exist in StateStore after replay");
    assert.equal(
      taskRecord!.status,
      "failed",
      "task derived status must be 'failed' after gate failure (I2: StateMachine.fail called)"
    );
    const hasVerifyFailReason = result.reasons.some((r) => r.includes("verify_failed") && r.includes("a1"));
    assert.ok(hasVerifyFailReason, `reasons must mention verify_failed:a1; got: ${JSON.stringify(result.reasons)}`);

    // Log file must contain the command output (empty stdout is fine for exit 1, but file must exist)
    const a1Result = result.verifyResults.find((r) => r.acId === "a1");
    assert.ok(a1Result, "result must include a1");
    assert.ok(a1Result!.exitCode !== 0, "exit code must be non-zero (1)");
    assert.ok(a1Result!.logDirPath !== undefined, "log dir path must be set");
    assert.ok(fs.existsSync(a1Result!.logDirPath!), "log dir must exist");

    // Verify the event appended to the log
    const events = logFail.readAllEvents();
    const gateEvents = events.filter((e) => e.type === "merge_gate_evaluated");
    assert.equal(gateEvents.length, 1, "exactly one merge_gate_evaluated event must be appended");

    const gateEvt = gateEvents[0] as MergeGateEvaluatedEvent;

    // CRITICAL: event must carry path references only — NOT the log content (spec §2.1)
    // The event's logPaths must be paths, not content strings.
    assert.ok(Array.isArray(gateEvt.logPaths), "logPaths must be an array");
    assert.ok(gateEvt.logPaths.length > 0, "logPaths must contain at least one path reference");

    for (const logPath of gateEvt.logPaths) {
      // Must be an absolute path string (path reference, not embedded content)
      assert.ok(typeof logPath === "string", "logPath must be a string");
      assert.ok(path.isAbsolute(logPath), `logPath must be absolute: ${logPath}`);
      // Must NOT be a log content string (content would be multi-line with newlines or long)
      // Simple structural check: a path reference is a file system path, not log output
      assert.ok(!logPath.includes("\n"), "logPath must not contain newlines (would indicate embedded content)");
    }

    // The referenced path must exist on disk and contain the log files
    const firstLogPath = gateEvt.logPaths[0]!;
    assert.ok(fs.existsSync(firstLogPath), `referenced log path must exist on disk: ${firstLogPath}`);
    assert.ok(
      fs.existsSync(path.join(firstLogPath, "stdout.txt")) ||
      fs.existsSync(path.join(firstLogPath, "stderr.txt")),
      "referenced log directory must contain stdout.txt or stderr.txt"
    );
  });
});

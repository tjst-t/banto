/**
 * [AC-S75f66b-4-1] Merge gate scope violation check.
 *
 * story_type=library: exercises the module's public API against a REAL git repo
 * created as a test fixture (temp dir). No mocked git.
 *
 * Scenario 1 (from scenario-S75f66b-4.json):
 *   - A real git repo with mainline 'main'; task branch edits src/allowed/a.ts AND docs/forbidden.md
 *   - Task scope.paths = ['src/allowed/**']
 *   Step 1: Consumer calls checkScopeViolations → Returns fail with violations == ['docs/forbidden.md']
 *   Step 2: Consumer runs runMergeGate against EventLog → merge_gate_evaluated event appended
 *            with passed=false and violating file list; visible via EventLog.readAllEvents()
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { execFileSync } from "node:child_process";
import { checkScopeViolations, runMergeGate } from "@banto/daemon";
import { EventLog } from "@banto/core";
import { fileMatchesGlob } from "../../packages/banto-daemon/src/gate-evaluator.js";

// ── Git fixture helpers ────────────────────────────────────────────────────────

/** Create a git repo with an initial commit on 'main' and a task branch. */
function setupGitRepo(repoDir: string): { base: string; branch: string } {
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: repoDir, stdio: "pipe" });

  git("init", "-b", "main");
  git("config", "user.email", "test@banto-test.local");
  git("config", "user.name", "banto-test");

  // Initial commit on main
  fs.mkdirSync(path.join(repoDir, "src", "allowed"), { recursive: true });
  fs.mkdirSync(path.join(repoDir, "docs"), { recursive: true });
  fs.writeFileSync(path.join(repoDir, "src", "allowed", "a.ts"), "// initial\n");
  fs.writeFileSync(path.join(repoDir, "docs", "README.md"), "# docs\n");
  git("add", "-A");
  git("commit", "-m", "initial");

  // Create task branch
  git("checkout", "-b", "task-branch");

  // Edit files: one in scope, one out of scope
  fs.mkdirSync(path.join(repoDir, "docs"), { recursive: true });
  fs.writeFileSync(path.join(repoDir, "src", "allowed", "a.ts"), "// changed\n");
  fs.writeFileSync(path.join(repoDir, "docs", "forbidden.md"), "# forbidden\n");
  git("add", "-A");
  git("commit", "-m", "task: edit src/allowed/a.ts and docs/forbidden.md");

  return { base: "main", branch: "task-branch" };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("[AC-S75f66b-4-1] Merge gate scope violation check (library)", () => {
  let repoDir: string;
  let dataDir: string;
  let base: string;
  let branch: string;

  before(() => {
    repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "banto-merge-gate-scope-"));
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "banto-merge-gate-data-"));

    // Create subdirectory for docs/forbidden.md before writing
    fs.mkdirSync(path.join(repoDir, "docs"), { recursive: true });

    const refs = setupGitRepo(repoDir);
    base = refs.base;
    branch = refs.branch;
  });

  after(() => {
    fs.rmSync(repoDir, { recursive: true, force: true });
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it("[AC-S75f66b-4-1] step 1: checkScopeViolations returns fail with violations=['docs/forbidden.md']", async () => {
    // scenario step 1: call scope-check with base=main, branch=task-branch, scopePaths=['src/allowed/**']
    const result = await checkScopeViolations({
      repoPath: repoDir,
      base,
      branch,
      scopePaths: ["src/allowed/**"],
    });

    // Expected: fails, violation list contains exactly docs/forbidden.md
    assert.equal(result.passed, false, "scope check must fail (out-of-scope file present)");
    assert.deepEqual(
      result.violations.sort(),
      ["docs/forbidden.md"],
      "violation list must contain exactly docs/forbidden.md"
    );
  });

  it("[AC-S75f66b-4-1] step 2: runMergeGate appends merge_gate_evaluated event with passed=false and violation list", async () => {
    // scenario step 2: run the full gate and observe the event in EventLog

    // Create a TaskRecord matching the scenario
    const log = EventLog.open(dataDir);

    // Seed the task record via events
    log.append({
      type: "task_created",
      projectTag: "proj-scope-test",
      taskId: "task-scope-01",
      payload: {
        title: "Scope violation test task",
        scope: { paths: ["src/allowed/**"] },
        acceptance: [{ id: "a1", text: "allowed file changed" }],
      },
    });
    log.append({
      type: "state_transitioned",
      projectTag: "proj-scope-test",
      taskId: "task-scope-01",
      from: "draft",
      to: "merging",
    });

    // Construct a TaskRecord matching what StateStore would have derived
    const task = {
      id: "task-scope-01",
      projectTag: "proj-scope-test",
      status: "merging",
      title: "Scope violation test task",
      scope: { paths: ["src/allowed/**"] },
      acceptance: [{ id: "a1", text: "allowed file changed" }],
    };

    const gateResult = await runMergeGate(log, task, {
      dataDir,
      repoPath: repoDir,
      base,
      branch,
      worktreePath: repoDir,
    });

    // Gate must fail
    assert.equal(gateResult.passed, false, "runMergeGate must fail due to scope violation");

    // The reasons must mention the violation
    const hasViolationReason = gateResult.reasons.some((r) =>
      r.includes("docs/forbidden.md")
    );
    assert.ok(hasViolationReason, `reasons must mention docs/forbidden.md; got: ${JSON.stringify(gateResult.reasons)}`);

    // Verify the event was appended to the log
    const events = log.readAllEvents();
    const gateEvents = events.filter((e) => e.type === "merge_gate_evaluated");
    assert.equal(gateEvents.length, 1, "exactly one merge_gate_evaluated event must be appended");

    const gateEvt = gateEvents[0]!;
    assert.equal(gateEvt.type, "merge_gate_evaluated");
    // TypeScript narrowing via type assertion for the discriminated union member
    const gatePayload = gateEvt as Extract<typeof gateEvt, { type: "merge_gate_evaluated" }>;
    assert.equal(gatePayload.taskId, "task-scope-01");
    assert.equal(gatePayload.passed, false);
    assert.ok(
      gatePayload.reasons.some((r) => r.includes("docs/forbidden.md")),
      `event reasons must include docs/forbidden.md; got: ${JSON.stringify(gatePayload.reasons)}`
    );
  });
});

// ── F1: single-star glob must not cross directory separator ───────────────────

describe("[S75f66b-4-F1] fileMatchesGlob: single * must not cross /", () => {
  it("src/*.ts matches src/a.ts (same dir, correct extension)", () => {
    assert.equal(
      fileMatchesGlob("src/a.ts", "src/*.ts"),
      true,
      "src/*.ts must match src/a.ts"
    );
  });

  it("src/*.ts does NOT match src/a/b.ts (single * must not cross /)", () => {
    assert.equal(
      fileMatchesGlob("src/a/b.ts", "src/*.ts"),
      false,
      "src/*.ts must NOT match src/a/b.ts — single * cannot cross /"
    );
  });

  it("src/*.ts does NOT match src/a.js (wrong extension)", () => {
    assert.equal(
      fileMatchesGlob("src/a.js", "src/*.ts"),
      false,
      "src/*.ts must NOT match src/a.js — extension mismatch"
    );
  });

  it("src/** matches src/a/b.ts (** crosses directory separators)", () => {
    assert.equal(
      fileMatchesGlob("src/a/b.ts", "src/**"),
      true,
      "src/** must match src/a/b.ts — ** crosses /"
    );
  });

  it("*.md does NOT match src/deep/evil.ts (first-segment wildcard is not a catch-all)", () => {
    assert.equal(
      fileMatchesGlob("src/deep/evil.ts", "*.md"),
      false,
      "*.md is root-level .md files only — a first-segment wildcard must not cover the whole tree"
    );
    assert.equal(fileMatchesGlob("README.md", "*.md"), true, "*.md must still match root-level .md");
  });

  it("src/**/*.ts does NOT match src/a.js (segments after ** are enforced)", () => {
    assert.equal(
      fileMatchesGlob("src/a.js", "src/**/*.ts"),
      false,
      "trailing *.ts after ** must be enforced, not ignored"
    );
    assert.equal(fileMatchesGlob("src/a.ts", "src/**/*.ts"), true, "** may span zero segments");
    assert.equal(fileMatchesGlob("src/a/b/c.ts", "src/**/*.ts"), true, "** spans nested dirs");
  });
});

// ── D2: empty scope.paths → explicit fail-closed reason ──────────────────────

describe("[S75f66b-4-D2] runMergeGate: empty scope.paths fails with explicit reason", () => {
  let repoDir: string;
  let dataDir: string;

  before(() => {
    repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "banto-d2-repo-"));
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "banto-d2-data-"));

    // Minimal git repo: just an initial commit on main, no task branch needed
    const git = (...args: string[]) =>
      execFileSync("git", args, { cwd: repoDir, stdio: "pipe" });
    git("init", "-b", "main");
    git("config", "user.email", "test@banto-test.local");
    git("config", "user.name", "banto-test");
    fs.writeFileSync(path.join(repoDir, "readme.txt"), "hello\n");
    git("add", "-A");
    git("commit", "-m", "initial");
    // task branch: same as main (no diff)
    git("checkout", "-b", "empty-scope-branch");
  });

  after(() => {
    fs.rmSync(repoDir, { recursive: true, force: true });
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it("gate fails with 'scope.paths is empty' reason when task has no scope.paths", async () => {
    const log = EventLog.open(dataDir);

    const task = {
      id: "task-empty-scope",
      projectTag: "proj-d2",
      status: "merging",
      title: "Task with no scope.paths",
      scope: { paths: [] as string[] },
      acceptance: [] as Array<{ id: string; text: string }>,
    };

    const result = await runMergeGate(log, task, {
      dataDir,
      repoPath: repoDir,
      base: "main",
      branch: "empty-scope-branch",
      worktreePath: repoDir,
    });

    assert.equal(result.passed, false, "gate must fail when scope.paths is empty (fail-closed)");

    const hasEmptyReason = result.reasons.some((r) =>
      r.includes("scope.paths is empty")
    );
    assert.ok(
      hasEmptyReason,
      `reasons must include 'scope.paths is empty' fail-closed message; got: ${JSON.stringify(result.reasons)}`
    );
  });
});

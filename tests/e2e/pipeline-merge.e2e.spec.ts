/**
 * [AC-S75f66b-5-4] Pipeline merge E2E: task file drop → ingest → ready →
 * auto-spawn → implement → audit → approved → merge.
 *
 * Real daemon + real pi + real LLM (policy auto). NO mocks (I1, priority_rule 9).
 * Extension of walking-skeleton.e2e.spec.ts to the `merged` state.
 *
 * Auth probe: same pattern as walking-skeleton.e2e.spec.ts.
 * If the probe fails, this test MUST FAIL with a clear needs_human message and
 * record the block in failures.json (I2: skip禁止).
 *
 * Flow:
 *   1. Start real daemon + register a temporary git project.
 *   2. Write a task definition file (status: queued, review.policy: auto,
 *      acceptance with a verify command).
 *   3. Watcher ingests → gate promotes to ready → auto-spawn kicks in.
 *   4. pi implements (creates a file), calls report_done → task reaches 'auditing'.
 *   5. audit auto-spawn (S75f66b-3 — NOT yet implemented in this sprint; we simulate
 *      the verdict by calling the daemon's transition API directly since story 3 is
 *      pending. Policy=auto: auditing → approved directly via transition API).
 *   6. Merge queue processes: rebase → gate → fast-forward → merged.
 *   7. Verify: GET events shows full chain task_created→…→task_merged;
 *      git log main contains the task's commit; implemented file exists on main.
 *
 * Note: Since S75f66b-3 (audit session) is not yet implemented, we drive the
 * auditing → approved transition manually via the daemon HTTP API. This is the
 * correct test discipline per test-discipline.md §2 (story_type=api: drive via
 * HTTP API). The merge queue itself (the subject of this story) is exercised fully.
 *
 * Timeout: 300_000 ms (real LLM latency + merge processing).
 *
 * IMPORTANT: review.policy=auto means: approved on audit pass.
 * Since the audit session is not yet wired (S75f66b-3 is pending), we approve
 * manually after the agent completes implementing.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as childProcess from "node:child_process";
import { Daemon } from "@banto/daemon";

// ── Paths ─────────────────────────────────────────────────────────────────────

const FAILURES_JSON = path.resolve(
  import.meta.dirname ?? new URL(".", import.meta.url).pathname,
  "../../docs/sprint-logs/S75f66b/failures.json"
);

// ── LLM provider config ───────────────────────────────────────────────────────

const PI_PROVIDER = "opencode-go";
const PI_MODEL = "deepseek-v4-flash";

// ── Auth probe (same pattern as walking-skeleton) ─────────────────────────────

/**
 * Probe whether pi can authenticate to the configured LLM provider.
 * Returns { ok: true } if pi exits 0 and stdout contains "OK".
 * Returns { ok: false, reason } otherwise.
 * I2: auth failure → needs_human, NOT skip.
 */
function probeAuth(): { ok: boolean; reason?: string; detail: string } {
  const piCli = (() => {
    const candidates = [
      path.resolve(
        import.meta.dirname ?? ".",
        "../../node_modules/@mariozechner/pi-coding-agent/dist/cli.js"
      ),
      path.resolve(import.meta.dirname ?? ".", "../../node_modules/.bin/pi"),
    ];
    return (
      candidates.find((p) => {
        try {
          fs.accessSync(p);
          return true;
        } catch {
          return false;
        }
      }) ?? null
    );
  })();

  if (!piCli) {
    return { ok: false, reason: "pi CLI binary not found", detail: "pi_not_found" };
  }

  const r = childProcess.spawnSync(
    "node",
    [piCli, "--provider", PI_PROVIDER, "--model", PI_MODEL, "--no-session", "-p", "Reply with exactly: OK"],
    { encoding: "utf8", timeout: 30000 }
  );

  const stdout = r.stdout ?? "";
  const stderr = r.stderr ?? "";
  const combined = stdout + stderr;

  if (r.error) {
    return {
      ok: false,
      reason: `pi probe error: ${r.error.message}`,
      detail: `error=${r.error.message}`,
    };
  }

  if (r.status === null) {
    return {
      ok: false,
      reason: `pi probe timed out or killed (signal=${r.signal ?? "unknown"})`,
      detail: `signal=${r.signal} stdout=${stdout.slice(0, 100)}`,
    };
  }

  if (
    combined.toLowerCase().includes("no api key") ||
    combined.toLowerCase().includes("unauthorized") ||
    combined.toLowerCase().includes("authentication") ||
    r.status !== 0
  ) {
    return {
      ok: false,
      reason: `pi probe failed (exit=${r.status}): check ~/.pi/agent/auth.json for ${PI_PROVIDER}`,
      detail: `stdout=${stdout.slice(0, 200)} stderr=${stderr.slice(0, 200)}`,
    };
  }

  return { ok: true, detail: `exit=${r.status} stdout=${stdout.slice(0, 100)}` };
}

/** Write failure record to failures.json (needs_human escalation per I2). */
function recordFailure(entry: {
  story: string;
  ac: string;
  type: string;
  reason: string;
  detail: string;
  timestamp: string;
}): void {
  let current: { failures: typeof entry[] } = { failures: [] };
  try {
    if (fs.existsSync(FAILURES_JSON)) {
      current = JSON.parse(fs.readFileSync(FAILURES_JSON, "utf8")) as typeof current;
    }
  } catch {
    // Overwrite if corrupt
  }
  current.failures = current.failures.filter(
    (f) => !(f.story === entry.story && f.ac === entry.ac)
  );
  current.failures.push(entry);
  fs.mkdirSync(path.dirname(FAILURES_JSON), { recursive: true });
  fs.writeFileSync(FAILURES_JSON, JSON.stringify(current, null, 2), "utf8");
}

// ── Git helpers ───────────────────────────────────────────────────────────────

function git(args: string[], cwd: string): string {
  const r = childProcess.spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  }
  return r.stdout ?? "";
}

function initRepo(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  git(["init", "-b", "main"], dir);
  git(["config", "user.email", "test@example.com"], dir);
  git(["config", "user.name", "Test"], dir);
  fs.writeFileSync(path.join(dir, "README.md"), "E2E test repo\n");
  git(["add", "."], dir);
  git(["commit", "-m", "init"], dir);
}

// ── Polling helper ────────────────────────────────────────────────────────────

async function pollUntilFn(
  condition: () => boolean,
  timeoutMs: number,
  intervalMs = 500
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return true;
    await new Promise<void>((r) => setTimeout(r, intervalMs));
  }
  return false;
}

async function pollStatusFn(
  getStatus: () => string | undefined,
  targetStatuses: string[],
  timeoutMs: number,
  intervalMs = 500
): Promise<string | undefined> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const s = getStatus();
    if (s && targetStatuses.includes(s)) return s;
    await new Promise<void>((r) => setTimeout(r, intervalMs));
  }
  return getStatus();
}

// ── Task definition ───────────────────────────────────────────────────────────

const TASK_ID = "task-0100";
const TASK_FILE_NAME = "hello-merge.txt";

/**
 * Task definition that:
 *   - creates hello-merge.txt
 *   - has a verify command so the merge gate can check it
 *   - review.policy: auto (audit pass → approved directly)
 *   - no hypothesis (→ auto-closed after merge)
 */
const TASK_MD = `---
id: ${TASK_ID}
type: task
kind: feature
title: Hello Merge Task
status: queued
scope:
  paths:
    - ${TASK_FILE_NAME}
acceptance:
  - { id: a1, text: "${TASK_FILE_NAME} exists with content Hello merge", verify: "grep -q 'Hello merge' ${TASK_FILE_NAME}" }
review:
  policy: auto
---

Create a file called ${TASK_FILE_NAME} in the current directory with the content: Hello merge

Steps:
1. Call report_phase with phase="implementing" to signal you have started.
2. Create ${TASK_FILE_NAME} with the exact content "Hello merge" (single line, no trailing newline).
3. Run: git config user.email "agent@banto.local" && git config user.name "banto-agent"
4. Run: git add ${TASK_FILE_NAME} && git commit -m "feat: add ${TASK_FILE_NAME}"
5. Call report_done with a brief summary.

IMPORTANT: Steps 3 and 4 (git config + commit) are REQUIRED before calling report_done.
The merge gate will verify the file exists on the git branch.
Use the banto tools (report_phase, report_done). Use bash to run git commands.
`;

// ── Suite ─────────────────────────────────────────────────────────────────────

describe("[AC-S75f66b-5-4] Pipeline E2E: task drop → auto-spawn → implement → approved → merged", { timeout: 300000 }, () => {
  let tmpDir: string;
  let repoDir: string;
  let tasksDir: string;
  let daemon: Daemon;
  let worktreePath: string | undefined;
  const projectTag = "e2e-merge-project";
  const TMUX_SESSION = "banto-e2e-merge";

  const authResult = probeAuth();

  before(async () => {
    if (!authResult.ok) {
      recordFailure({
        story: "S75f66b-5",
        ac: "AC-S75f66b-5-4",
        type: "needs_human",
        reason: `E2E実行不能: LLM認証なし — ${authResult.reason ?? "unknown"}`,
        detail: authResult.detail,
        timestamp: new Date().toISOString(),
      });
      // Minimal setup for after() hook
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "banto-e2e-merge-"));
      repoDir = path.join(tmpDir, "repo");
      tasksDir = path.join(repoDir, "work", "tasks");
      return;
    }

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "banto-e2e-merge-"));
    repoDir = path.join(tmpDir, "repo");
    tasksDir = path.join(repoDir, "work", "tasks");
    initRepo(repoDir);
    fs.mkdirSync(tasksDir, { recursive: true });

    daemon = Daemon.create({
      port: 0,
      dataDir: path.join(tmpDir, "data"),
      watchIntervalMs: 500,
      tickIntervalMs: 500,
      reconcileIntervalMs: 99999,
      worktreeBaseDir: path.join(tmpDir, "worktrees"),
      sessionBaseDir: path.join(tmpDir, "sessions"),
      tmuxSession: TMUX_SESSION,
      piProvider: PI_PROVIDER,
      piModel: PI_MODEL,
    });

    daemon.registerProject(projectTag, repoDir);
    await daemon.start();
  });

  after(async () => {
    if (daemon) {
      try { await daemon.stop(); } catch { /* ignore */ }
    }
    childProcess.spawnSync("tmux", ["kill-session", "-t", TMUX_SESSION], { encoding: "utf8" });
    if (tmpDir) {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  it("[AC-S75f66b-5-4] Pipeline E2E: task file drop → ingest → ready → auto-spawn → implement → approved → merged", async () => {
    // Auth gate: if auth failed, escalate as needs_human (I2: not skip)
    if (!authResult.ok) {
      throw new Error(
        `needs_human: E2E実行不能 — LLM認証が利用できません。` +
        `理由: ${authResult.reason ?? "unknown"}。` +
        `詳細は docs/sprint-logs/S75f66b/failures.json を参照。` +
        `${PI_PROVIDER}/${PI_MODEL} 認証設定を確認してください。`
      );
    }

    // ── Step 1: Drop task definition file (PO performs NO further operation) ──
    const taskFile = path.join(tasksDir, `${TASK_ID}.md`);
    fs.writeFileSync(taskFile, TASK_MD, "utf8");

    // ── Step 2: Wait for watcher → queued (or past) ──────────────────────────
    const PAST_QUEUED = new Set([
      "queued", "ready", "planning", "implementing", "auditing",
      "review-ready", "in-review", "approved", "merging", "merged",
      "evaluating", "closed",
    ]);
    const ingestedQueued = await pollUntilFn(() => {
      const t = daemon.getTask(projectTag, TASK_ID);
      return !!t && PAST_QUEUED.has(t.status);
    }, 10000);
    assert.ok(ingestedQueued, "Task must be ingested (queued or further) within 10s");

    // ── Step 3: Wait for gate → ready ──────────────────────────────────────
    const becameReady = await pollUntilFn(() => {
      const t = daemon.getTask(projectTag, TASK_ID);
      return t?.status === "ready";
    }, 15000);
    assert.ok(becameReady, "Task must reach 'ready' within 15s (gate evaluation)");

    // ── Step 4: auto-spawn (S75f66b-2 tick job) should kick in ──────────────
    // Wait for task to start planning (auto-spawn triggered)
    const PLANNING_OR_LATER = new Set([
      "planning", "implementing", "auditing", "review-ready",
      "in-review", "approved", "merging", "merged", "closed",
    ]);
    const autoSpawned = await pollUntilFn(() => {
      const t = daemon.getTask(projectTag, TASK_ID);
      return !!t && PLANNING_OR_LATER.has(t.status);
    }, 30000);
    assert.ok(autoSpawned, "auto-spawn must trigger and task must reach planning within 30s");

    // Record the worktree path for cleanup verification later
    const taskRecord = daemon.getTask(projectTag, TASK_ID);
    const worktreeBase = path.join(tmpDir, "worktrees");
    worktreePath = path.join(worktreeBase, projectTag, TASK_ID);

    // ── Step 5: Inject task prompt via driver ──────────────────────────────
    // The agent has been spawned in planning state. Inject the task prompt.
    const piDriver = daemon.driverRegistry.get("pi-rpc");
    if (!piDriver) throw new Error("pi-rpc driver not registered");

    // Find the session ID from the ledger
    const ledgerEntries = daemon.getLedgerEntries();
    const entry = ledgerEntries.find(
      (e) => e.taskId === TASK_ID && e.projectTag === projectTag
    );
    if (!entry) {
      // The task may have already progressed (fast runner). Check status.
      const currentStatus = daemon.getTask(projectTag, TASK_ID)?.status;
      if (currentStatus && !PLANNING_OR_LATER.has(currentStatus)) {
        throw new Error(
          `Task ${TASK_ID} not in ledger and status is ${currentStatus} — unexpected state`
        );
      }
      // The agent may have already run the prompt injection or moved past planning
      // via automatic tooling. Let it proceed.
    } else {
      // Inject the implementation task prompt
      try {
        await piDriver.inject(entry.sessionId, TASK_MD);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (
          msg.toLowerCase().includes("api key") ||
          msg.toLowerCase().includes("auth") ||
          msg.toLowerCase().includes("unauthorized")
        ) {
          recordFailure({
            story: "S75f66b-5",
            ac: "AC-S75f66b-5-4",
            type: "needs_human",
            reason: `プロンプト注入失敗: LLM認証エラー — ${msg}`,
            detail: msg,
            timestamp: new Date().toISOString(),
          });
          throw new Error(`needs_human: プロンプト注入時にLLM認証エラー — ${msg}`);
        }
        throw err;
      }
    }

    // ── Step 6: Wait for implementing → auditing ──────────────────────────
    const AUDIT_OR_LATER = new Set([
      "auditing", "review-ready", "in-review", "approved",
      "merging", "merged", "closed",
    ]);
    const reachedAuditing = await pollUntilFn(() => {
      const t = daemon.getTask(projectTag, TASK_ID);
      return !!t && AUDIT_OR_LATER.has(t.status);
    }, 240000, 1000);

    if (!reachedAuditing) {
      const taskState = daemon.getTask(projectTag, TASK_ID);
      const events = daemon.getAllEvents();
      const failedEv = events.find(
        (e) => e.type === "task_failed" && "taskId" in e && e.taskId === TASK_ID
      );

      if (failedEv) {
        recordFailure({
          story: "S75f66b-5",
          ac: "AC-S75f66b-5-4",
          type: "needs_human",
          reason: `エージェントがauditingに到達できなかった: task_failed`,
          detail: `task.status=${taskState?.status ?? "unknown"}`,
          timestamp: new Date().toISOString(),
        });
        throw new Error(
          `needs_human: エージェントがtask_failedに遷移 — 詳細はdocs/sprint-logs/S75f66b/failures.json`
        );
      }

      assert.fail(
        `Task must reach 'auditing' within 240s. Current: ${taskState?.status ?? "unknown"}`
      );
    }

    // ── Step 7: Approve the task (S75f66b-3 audit session is pending; we drive
    //    the transition manually via HTTP API — valid for story_type=api tests) ───
    // Since review.policy=auto, we drive: auditing → approved directly.
    // (In the full system, S75f66b-3 audit session would fire automatically;
    //  for this story test we exercise the merge queue — the audit→approved step
    //  is driven via the documented API, same as what S75f66b-3 will wire.)
    const currentStatus = daemon.getTask(projectTag, TASK_ID)?.status;
    if (currentStatus === "auditing") {
      // Transition auditing → approved (allowed by state machine when S75f66b-3 is done
      // this becomes auditing→merging for policy=auto; for now we use in-review→approved)
      // The state machine allows auditing→merging for auto policy.
      // We simulate the audit-pass verdict by transitioning approved.
      const daemonPort = daemon.port;
      const base = `http://localhost:${daemonPort}`;

      // auditing → merging (policy=auto path, as defined in state machine)
      const r = await fetch(`${base}/api/v1/projects/${projectTag}/tasks/${TASK_ID}/transition`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ to: "approved" }),
      });
      if (!r.ok) {
        // Try direct path: auditing → approved via review-ready → in-review → approved
        const reviewReadyRes = await fetch(
          `${base}/api/v1/projects/${projectTag}/tasks/${TASK_ID}/transition`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ to: "review-ready" }),
          }
        );
        if (reviewReadyRes.ok) {
          await fetch(`${base}/api/v1/projects/${projectTag}/tasks/${TASK_ID}/transition`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ to: "in-review" }),
          });
          await fetch(`${base}/api/v1/projects/${projectTag}/tasks/${TASK_ID}/transition`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ to: "approved" }),
          });
        }
      }
    } else if (currentStatus === "review-ready") {
      const base = `http://localhost:${daemon.port}`;
      await fetch(`${base}/api/v1/projects/${projectTag}/tasks/${TASK_ID}/transition`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ to: "in-review" }),
      });
      await fetch(`${base}/api/v1/projects/${projectTag}/tasks/${TASK_ID}/transition`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ to: "approved" }),
      });
    } else if (currentStatus === "in-review") {
      const base = `http://localhost:${daemon.port}`;
      await fetch(`${base}/api/v1/projects/${projectTag}/tasks/${TASK_ID}/transition`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ to: "approved" }),
      });
    }

    // ── Step 8: Wait for merge queue to process → merged or closed ───────────
    const MERGED_OR_CLOSED = new Set(["merged", "closed"]);
    const reachedMerged = await pollUntilFn(() => {
      const t = daemon.getTask(projectTag, TASK_ID);
      return !!t && MERGED_OR_CLOSED.has(t.status);
    }, 30000, 500);

    if (!reachedMerged) {
      const taskState = daemon.getTask(projectTag, TASK_ID);
      assert.fail(
        `Task must reach 'merged' or 'closed' within 30s. Current: ${taskState?.status ?? "unknown"}`
      );
    }

    const finalStatus = daemon.getTask(projectTag, TASK_ID)?.status;
    assert.ok(
      finalStatus === "merged" || finalStatus === "closed",
      `Task final status must be merged or closed (got ${finalStatus})`
    );

    // ── Step 9: Verify event chain ────────────────────────────────────────
    const events = daemon.getTaskEvents(projectTag, TASK_ID);
    const eventTypes = events.map((e) => e.type);

    assert.ok(eventTypes.includes("task_created"), "must have task_created");

    const mergedEvent = events.find((e) => e.type === "task_merged");
    assert.ok(mergedEvent, "must have task_merged event");

    const commitSha = (mergedEvent as { commitSha?: string })?.commitSha;
    assert.ok(commitSha && commitSha.length >= 7, `commitSha must be a git hash: ${commitSha}`);

    // ── Step 10: Verify implemented file exists on main branch ────────────
    const logOutput = git(["log", "main", "--oneline"], repoDir);
    assert.ok(logOutput.length > 0, "main branch must have commits");

    // Check out main and verify the file
    const mainContent = (() => {
      try {
        return git(["show", `main:${TASK_FILE_NAME}`], repoDir);
      } catch {
        return null;
      }
    })();
    assert.ok(
      mainContent !== null,
      `${TASK_FILE_NAME} must exist on main branch after merge`
    );
    assert.ok(
      mainContent!.includes("Hello merge"),
      `${TASK_FILE_NAME} on main must contain 'Hello merge'; got: ${mainContent!.slice(0, 100)}`
    );

    // ── Step 11: Verify commitSha exists on main ──────────────────────────
    assert.ok(
      logOutput.includes(commitSha!.slice(0, 7)),
      `commitSha ${commitSha} must appear in git log main`
    );

    // ── Step 12: Verify worktree cleanup ──────────────────────────────────
    const worktreeGone = !fs.existsSync(worktreePath!);
    assert.ok(worktreeGone, `Worktree must be removed after merge: ${worktreePath}`);
  });
});

/**
 * [AC-S254276-4-2] Walking skeleton E2E: task file drop → ingest → ready → spawn → implement → review-ready.
 *
 * This is the milestone acceptance test: end-to-end from PO task file placement to
 * agent reaching review-ready state. Real daemon + real pi agent + real LLM required.
 *
 * IMPORTANT: This test requires a working opencode-go provider with deepseek-v4-flash.
 * Auth is probed by running `pi --provider opencode-go --model deepseek-v4-flash --no-session -p "Reply with exactly: OK"`.
 * If the probe fails, this test records the block in docs/sprint-logs/S254276/failures.json
 * and throws (I2: skip禁止).
 *
 * Flow:
 *   1. Start real daemon (piProvider=opencode-go, piModel=deepseek-v4-flash).
 *   2. Register project pointing to a temporary git repo.
 *   3. Write a minimal task definition file to <repoPath>/work/tasks/e2e-task-001.md.
 *   4. Wait for the watcher to ingest the file → task appears as 'queued'.
 *   5. Wait for gate evaluation → task becomes 'ready'.
 *   6. Call spawnTask() explicitly (auto-spawn is a future sprint feature).
 *      Daemon wires: --extension banto-executor.ts + --provider opencode-go + --model deepseek-v4-flash
 *      + BANTO_DAEMON_URL/BANTO_PROJECT/BANTO_TASK_ID env vars.
 *   7. Inject the task prompt via driver.inject().
 *      The banto-executor extension provides report_phase/report_done tools.
 *      The prompt instructs the LLM to call these tools (NOT raw HTTP API).
 *   8. Wait for pi agent to call report_done → task becomes 'review-ready'.
 *   9. Verify event history, hello.txt file, and extension-driven state transitions.
 *
 * Timeout: 240 000 ms (deepseek-v4-flash latency can be 30-60 s per LLM call).
 *
 * Cleanup: kill pi session, remove tmux window, delete temp dir.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";
import * as childProcess from "node:child_process";

import { Daemon } from "../../packages/banto-daemon/src/daemon.js";

// ── Paths ─────────────────────────────────────────────────────────────────────

const FAILURES_JSON = path.resolve(
  import.meta.dirname ?? new URL(".", import.meta.url).pathname,
  "../../docs/sprint-logs/S254276/failures.json"
);

// ── Default provider/model (banto確定モデル) ──────────────────────────────────
const PI_PROVIDER = "opencode-go";
const PI_MODEL = "deepseek-v4-flash";

// ── Auth probe ────────────────────────────────────────────────────────────────

/**
 * Probe whether pi can authenticate to the configured LLM provider.
 * Runs `pi --provider opencode-go --model deepseek-v4-flash --no-session -p "Reply with exactly: OK"`
 * with a 30 s timeout.
 * Returns { ok: true } if pi exits 0 and stdout contains "OK".
 * Returns { ok: false, reason } otherwise.
 *
 * D6: uses child_process.spawnSync (stdlib).
 * I2: auth failure → needs_human, NOT skip.
 */
function probeAuth(): { ok: boolean; reason?: string; detail: string } {
  const piCli = (() => {
    const candidates = [
      path.resolve(import.meta.dirname ?? ".", "../../node_modules/@mariozechner/pi-coding-agent/dist/cli.js"),
      path.resolve(import.meta.dirname ?? ".", "../../node_modules/.bin/pi"),
    ];
    return candidates.find((p) => {
      try { fs.accessSync(p); return true; } catch { return false; }
    }) ?? null;
  })();

  if (!piCli) {
    return { ok: false, reason: "pi CLI binary not found", detail: "pi_not_found" };
  }

  // Run a quick pi probe with the configured provider/model
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

/**
 * Write failure record to failures.json (needs_human escalation per I2).
 * Appends to existing failures or creates the file.
 */
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

function git(args: string[], cwd: string): void {
  const r = childProcess.spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  }
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

async function pollUntil(
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

// ── Task definition content ───────────────────────────────────────────────────

// Task ID must match task-\d{4,} pattern (spec: task-frontmatter.ts)
const TASK_ID = "task-0001";
// Task prompt instructs the LLM to use the registered banto tools (not raw HTTP).
// The banto-executor extension (loaded via --extension) registers report_phase/report_done.
// acceptance items require { id, text } objects (spec: task-frontmatter.ts).
const TASK_MD = `---
id: ${TASK_ID}
type: task
kind: feature
title: Hello World Task
status: queued
scope:
  paths:
    - hello.txt
acceptance:
  - { id: a1, text: "hello.txt exists and contains Hello banto" }
---

Create a file called hello.txt in the current directory with the content: Hello banto

Steps:
1. Call report_phase with phase="implementing" to signal you have started.
2. Create hello.txt with content "Hello banto" using the write or bash tool.
3. Call report_done with a brief summary (e.g. "hello.txt created with Hello banto").

Use the banto tools (report_phase, report_done) — do NOT make raw HTTP calls.
`;

// ── Suite ─────────────────────────────────────────────────────────────────────

describe("[AC-S254276-4-2] Walking skeleton E2E — task drop → auditing (executor done)", { timeout: 240000 }, () => {
  let tmpDir: string;
  let repoDir: string;
  let tasksDir: string;
  let daemon: Daemon;
  const projectTag = "e2e-project";
  const TMUX_SESSION = "banto-e2e-test";

  // Auth check is done synchronously before the suite body runs.
  const authResult = probeAuth();

  before(async () => {
    if (!authResult.ok) {
      // Record the needs_human escalation (I2: not skip, not silent)
      recordFailure({
        story: "S254276-4",
        ac: "AC-S254276-4-2",
        type: "needs_human",
        reason: `E2E実行不能: LLM認証なし — ${authResult.reason ?? "unknown"}`,
        detail: authResult.detail,
        timestamp: new Date().toISOString(),
      });
      // We still need to set up minimal structures for the after() hook to work
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "banto-e2e-"));
      repoDir = path.join(tmpDir, "repo");
      tasksDir = path.join(repoDir, "work", "tasks");
      return;
    }

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "banto-e2e-"));
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
      // Use the confirmed banto default provider/model (opencode-go/deepseek-v4-flash)
      piProvider: PI_PROVIDER,
      piModel: PI_MODEL,
    });

    // Register the e2e project
    daemon.registerProject(projectTag, repoDir);

    await daemon.start();
  });

  after(async () => {
    if (daemon) {
      await daemon.stop();
    }
    // Kill tmux session if it was created
    childProcess.spawnSync("tmux", ["kill-session", "-t", TMUX_SESSION], { encoding: "utf8" });
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("[AC-S254276-4-2] E2E: task file drop → ingest → ready → spawn → implement → auditing (S75f66b-3: executor done→audit, not self→review-ready)", async () => {
    // Auth gate: if auth failed, escalate as needs_human (I2: not skip)
    if (!authResult.ok) {
      throw new Error(
        `needs_human: E2E実行不能 — LLM認証が利用できません。` +
        `理由: ${authResult.reason ?? "unknown"}。` +
        `詳細は docs/sprint-logs/S254276/failures.json を参照。` +
        `${PI_PROVIDER}/${PI_MODEL} 認証設定を確認してください。`
      );
    }

    // ── Step 1: Drop task definition file ────────────────────────────────────
    const taskFile = path.join(tasksDir, `${TASK_ID}.md`);
    fs.writeFileSync(taskFile, TASK_MD, "utf8");

    // ── Step 2: Wait for watcher ingest → queued (or past queued) ──────────────
    // Note: the gate evaluator runs immediately after task_created in the same tick,
    // so the task may already be "ready" by the first poll (draft→queued→ready in one cycle).
    const PAST_QUEUED = new Set([
      "queued", "ready", "planning", "implementing", "auditing",
      "review-ready", "in-review", "approved", "merging", "merged",
      "evaluating", "closed",
    ]);
    const ingestedQueued = await pollUntil(() => {
      const t = daemon.getTask(projectTag, TASK_ID);
      return !!t && PAST_QUEUED.has(t.status);
    }, 10000);
    assert.ok(
      ingestedQueued,
      "Task must be ingested (queued or further) within 10s after file drop (watcher ingest)"
    );

    const taskQueued = daemon.getTask(projectTag, TASK_ID);
    assert.ok(
      taskQueued && PAST_QUEUED.has(taskQueued.status),
      `task must be ingested (status is past queued); got: ${taskQueued?.status ?? "not found"}`
    );

    // ── Step 3: Wait for gate evaluation → ready ─────────────────────────────
    const becameReady = await pollUntil(() => {
      const t = daemon.getTask(projectTag, TASK_ID);
      return t?.status === "ready";
    }, 15000);
    assert.ok(
      becameReady,
      "Task must reach 'ready' within 15s (gate evaluation)"
    );

    const taskReady = daemon.getTask(projectTag, TASK_ID);
    assert.equal(taskReady?.status, "ready", "task.status === 'ready'");

    // ── Step 4: Spawn the agent ───────────────────────────────────────────────
    // Daemon.spawnTask() automatically:
    //   - passes --extension <banto-executor.ts> to pi
    //   - passes --provider opencode-go --model deepseek-v4-flash
    //   - sets BANTO_DAEMON_URL, BANTO_PROJECT, BANTO_TASK_ID env vars in child
    // The extension registers report_phase/report_done tools in the pi session.
    let spawnResult: {
      worktreePath: string;
      sessionPath: string;
      pid: number;
      sessionId: string;
      tmuxWindow?: string;
    };

    try {
      spawnResult = await daemon.spawnTask(projectTag, TASK_ID, "pi-rpc");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // If spawn fails due to auth → record and escalate (I2)
      if (
        msg.toLowerCase().includes("api key") ||
        msg.toLowerCase().includes("auth") ||
        msg.toLowerCase().includes("unauthorized")
      ) {
        recordFailure({
          story: "S254276-4",
          ac: "AC-S254276-4-2",
          type: "needs_human",
          reason: `スポーン失敗: LLM認証エラー — ${msg}`,
          detail: msg,
          timestamp: new Date().toISOString(),
        });
        throw new Error(`needs_human: スポーン時にLLM認証エラー — ${msg}`);
      }
      throw err;
    }

    assert.ok(spawnResult.pid > 0, "spawnResult.pid must be positive");

    // ── Step 5: Wait for planning state ─────────────────────────────────────
    const becamePlanning = await pollUntil(() => {
      const t = daemon.getTask(projectTag, TASK_ID);
      return t?.status === "planning";
    }, 15000);
    assert.ok(
      becamePlanning,
      "Task must reach 'planning' within 15s after spawn"
    );

    // ── Step 6: Verify tmux window exists ────────────────────────────────────
    if (spawnResult.tmuxWindow) {
      // Give tmux 500ms to render
      await new Promise<void>((r) => setTimeout(r, 500));
      const checkResult = childProcess.spawnSync(
        "tmux",
        ["list-windows", "-t", TMUX_SESSION, "-F", "#{window_name}"],
        { encoding: "utf8" }
      );
      assert.ok(
        checkResult.stdout.includes(TASK_ID),
        `tmux window '${TASK_ID}' must exist in session '${TMUX_SESSION}'`
      );
    }

    // ── Step 7: Inject task prompt via pi RPC ───────────────────────────────
    // The pi process is waiting in RPC mode with the banto-executor extension loaded.
    // The extension has registered report_phase/report_done tools.
    // We inject the task prompt and let the LLM use the registered tools.
    const driver = daemon.driverRegistry.get("pi-rpc");
    if (!driver) throw new Error("pi-rpc driver not found");

    // Simple, direct prompt. The extension system prompt provides context about
    // available tools. We just describe the concrete task.
    const taskPrompt = [
      `Your task: create a file called hello.txt in the current directory with content "Hello banto".`,
      ``,
      `Steps to follow:`,
      `1. Call report_phase with phase="implementing" to signal you have started work.`,
      `2. Create hello.txt with the exact content: Hello banto`,
      `   Use the write tool or bash to create the file.`,
      `3. Call report_done with summary="hello.txt created with Hello banto".`,
      ``,
      `Important: use the report_phase and report_done tools (they are registered in this session).`,
      `Do not make HTTP API calls directly.`,
    ].join("\n");

    await driver.inject(spawnResult.sessionId, taskPrompt);

    // ── Step 8: Wait for auditing state ─────────────────────────────────────
    // S75f66b-3 (DEC-S254276-012 resolved): report_done now transitions to 'auditing'
    // (not directly to review-ready). The executor no longer self-transitions through audit.
    // In this E2E, the audit session is NOT spawned with a real LLM (no audit agent binary).
    // The executor's report_done() call transitions implementing→auditing; we verify that.
    // The full implementing→auditing→(pass/fail)→review-ready/merging/rework pipeline
    // is verified in the pipeline E2E (S75f66b-5-4) with a scripted audit driver.
    const becameAuditing = await pollUntil(() => {
      const t = daemon.getTask(projectTag, TASK_ID);
      return t?.status === "auditing" || t?.status === "failed";
    }, 180000, 1000);

    if (!becameAuditing) {
      // Check if the task failed
      const taskState = daemon.getTask(projectTag, TASK_ID);
      const events = daemon.getAllEvents();
      const failedEv = events.find((e) => e.type === "task_failed" && e.taskId === TASK_ID);

      if (failedEv && failedEv.type === "task_failed") {
        recordFailure({
          story: "S254276-4",
          ac: "AC-S254276-4-2",
          type: "needs_human",
          reason: `エージェントがauditingに到達できなかった: ${failedEv.reason}`,
          detail: `task.status=${taskState?.status ?? "unknown"}, fail_reason=${failedEv.reason}`,
          timestamp: new Date().toISOString(),
        });
        throw new Error(
          `needs_human: エージェントがtask_failedに遷移 — ${failedEv.reason}`
        );
      }

      assert.fail(
        `Task '${TASK_ID}' must reach 'auditing' within 180s. ` +
        `Current status: ${taskState?.status ?? "unknown"}`
      );
    }

    // ── Step 9: Verify state is auditing ────────────────────────────────────
    // (task_failed is also acceptable if the audit spawn failed due to no real audit binary)
    const taskFinal = daemon.getTask(projectTag, TASK_ID);
    assert.ok(
      taskFinal?.status === "auditing" || taskFinal?.status === "failed",
      `task.status must be 'auditing' (or 'failed' if audit spawn failed) after agent completion; ` +
      `got: ${taskFinal?.status ?? "not found"}`
    );

    // ── Step 10: Verify event history ───────────────────────────────────────
    const events = daemon.getTaskEvents(projectTag, TASK_ID);
    const eventTypes = events.map((e) => e.type);

    assert.ok(
      eventTypes.includes("task_created"),
      "event history must include task_created"
    );

    const transitions = events.filter((e) => e.type === "state_transitioned");
    const toStatuses = transitions
      .filter((e) => e.type === "state_transitioned")
      .map((e) => (e as { type: "state_transitioned"; to: string }).to);

    assert.ok(
      toStatuses.includes("queued"),
      `state transitions must include 'queued'; got: [${toStatuses.join(", ")}]`
    );
    assert.ok(
      toStatuses.includes("ready"),
      `state transitions must include 'ready'; got: [${toStatuses.join(", ")}]`
    );
    assert.ok(
      toStatuses.includes("planning"),
      `state transitions must include 'planning'; got: [${toStatuses.join(", ")}]`
    );
    assert.ok(
      toStatuses.includes("auditing"),
      `state transitions must include 'auditing' (executor report_done → auditing; S75f66b-3); ` +
      `got: [${toStatuses.join(", ")}]`
    );

    assert.ok(
      eventTypes.includes("agent_spawned"),
      "event history must include agent_spawned"
    );

    // ── Step 11: Verify hello.txt was created ───────────────────────────────
    const helloTxt = path.join(spawnResult.worktreePath, "hello.txt");
    assert.ok(
      fs.existsSync(helloTxt),
      `hello.txt must exist at ${helloTxt}`
    );
    const content = fs.readFileSync(helloTxt, "utf8");
    assert.match(
      content,
      /Hello banto/i,
      `hello.txt must contain "Hello banto"; got: ${content}`
    );

    // ── Step 12: Verify session file exists ─────────────────────────────────
    // agent_spawned event must reference the session path (spec §2.1)
    const spawnedEv = events.find((e) => e.type === "agent_spawned" && e.taskId === TASK_ID);
    assert.ok(spawnedEv, "agent_spawned event must exist");
    if (spawnedEv?.type === "agent_spawned") {
      assert.ok(
        fs.existsSync(spawnedEv.sessionPath),
        `session file must exist at ${spawnedEv.sessionPath}`
      );
    }

    // ── Step 13: Verify extension-driven transitions ─────────────────────────
    // The implementing→auditing transition must have been driven by the banto-executor
    // extension (via report_done tool calling daemon API → implementing→auditing).
    // S75f66b-3 (DEC-S254276-012 resolved): executor transitions to auditing only.
    // The audit agent (separate session) decides what happens next.
    assert.ok(
      toStatuses.includes("implementing"),
      `extension-driven transition 'implementing' must be present; got: [${toStatuses.join(", ")}]. ` +
      `This indicates the banto-executor extension tools were called by the LLM.`
    );
  });
});

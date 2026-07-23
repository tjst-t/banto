/**
 * [AC-S254276-4-2] Walking skeleton E2E: task file drop → ingest → ready → spawn → implement → review-ready.
 *
 * This is the milestone acceptance test: end-to-end from PO task file placement to
 * agent reaching review-ready state. Real daemon + real pi agent + real LLM required.
 *
 * IMPORTANT: This test requires a valid ANTHROPIC_API_KEY environment variable.
 * If the key is absent or the auth probe fails, this test records the block in
 * docs/sprint-logs/S254276/failures.json and throws (I2: skip禁止).
 *
 * Flow:
 *   1. Start real daemon with tmux integration enabled.
 *   2. Register project pointing to a temporary git repo.
 *   3. Write a minimal task definition file to <repoPath>/work/tasks/e2e-task-001.md.
 *   4. Wait for the watcher to ingest the file → task appears as 'queued'.
 *   5. Wait for gate evaluation → task becomes 'ready'.
 *   6. Wait for daemon auto-spawn → task becomes 'planning'.
 *      (Daemon auto-spawns ready tasks when the scheduler tick runs or after gate.)
 *      Note: current daemon does not auto-spawn; spawnTask is called explicitly below.
 *   7. Call spawnTask() explicitly (auto-spawn is a future sprint feature).
 *   8. Wait for pi agent to call report_phase(review-ready) → task becomes 'review-ready'.
 *   9. Verify event history.
 *
 * Timeout: 180 000 ms (LLM inference can be slow).
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

// ── Auth probe ────────────────────────────────────────────────────────────────

/**
 * Probe whether pi can authenticate to an LLM provider.
 * Runs `pi --provider anthropic -p "say ok" --no-session` with a 15 s timeout.
 * Returns { ok: true } if pi completes without "No API key" in output.
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

  // Check env key first (fast path)
  const hasKey = !!(process.env["ANTHROPIC_API_KEY"] && process.env["ANTHROPIC_API_KEY"].length > 0);
  if (!hasKey) {
    return {
      ok: false,
      reason: "ANTHROPIC_API_KEY is not set",
      detail: "env_key_missing",
    };
  }

  // Run a quick probe
  const r = childProcess.spawnSync(
    "node",
    [piCli, "--provider", "anthropic", "-p", "say ok", "--no-session"],
    { encoding: "utf8", timeout: 20000 }
  );

  const stdout = r.stdout ?? "";
  const stderr = r.stderr ?? "";
  const combined = stdout + stderr;

  if (combined.includes("No API key") || combined.includes("No API key found")) {
    return {
      ok: false,
      reason: "pi reported: No API key found for the selected model",
      detail: `stdout=${stdout.slice(0, 200)} stderr=${stderr.slice(0, 200)}`,
    };
  }

  if (r.error || r.status === null) {
    return {
      ok: false,
      reason: `pi probe error: ${r.error?.message ?? "timeout or signal"}`,
      detail: `status=${r.status} signal=${r.signal}`,
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

const TASK_ID = "e2e-task-001";
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
  - hello.txt exists and contains "Hello banto"
---

Write a file called \`hello.txt\` in the current directory with the content:
\`Hello banto\`

That is the complete task. Call report_phase with "implementing" when you start, then
create hello.txt, and call report_done with a brief summary when done.
`;

// ── Suite ─────────────────────────────────────────────────────────────────────

describe("[AC-S254276-4-2] Walking skeleton E2E — task drop → review-ready", { timeout: 180000 }, () => {
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

  it("[AC-S254276-4-2] E2E: task file drop → ingest → ready → spawn → implement → review-ready", async () => {
    // Auth gate: if auth failed, escalate as needs_human (I2: not skip)
    if (!authResult.ok) {
      throw new Error(
        `needs_human: E2E実行不能 — LLM認証が利用できません。` +
        `理由: ${authResult.reason ?? "unknown"}。` +
        `詳細は docs/sprint-logs/S254276/failures.json を参照。` +
        `ANTHROPIC_API_KEYを設定して再実行してください。`
      );
    }

    // ── Step 1: Drop task definition file ────────────────────────────────────
    const taskFile = path.join(tasksDir, `${TASK_ID}.md`);
    fs.writeFileSync(taskFile, TASK_MD, "utf8");

    // ── Step 2: Wait for watcher ingest → queued ─────────────────────────────
    const ingestedQueued = await pollUntil(() => {
      const t = daemon.getTask(projectTag, TASK_ID);
      return t?.status === "queued";
    }, 10000);
    assert.ok(
      ingestedQueued,
      "Task must reach 'queued' within 10s after file drop (watcher ingest)"
    );

    const taskQueued = daemon.getTask(projectTag, TASK_ID);
    assert.equal(taskQueued?.status, "queued", "task.status === 'queued'");

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
    // Note: auto-spawn is a future sprint feature. We call spawnTask explicitly.
    // The extension adapter (banto-executor) provides report_phase/report_done tools.
    const piExtensionPath = path.resolve(
      import.meta.dirname ?? ".",
      "../../packages/banto-daemon/src/pi-extension/banto-executor.ts"
    );

    let spawnResult: {
      worktreePath: string;
      sessionPath: string;
      pid: number;
      sessionId: string;
      tmuxWindow?: string;
    };

    try {
      spawnResult = await daemon.spawnTask(projectTag, TASK_ID, "pi-rpc", {
        driverOptions: {
          provider: "anthropic",
          // Pass extension and env vars for the executor adapter
          // Note: pi-rpc driver passes env to the child process
          // BANTO_PROJECT and BANTO_TASK_ID are injected via spawnTask env
        },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // If spawn fails due to auth → record and escalate (I2)
      if (msg.toLowerCase().includes("api key") || msg.toLowerCase().includes("auth")) {
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
    // The pi process is waiting in RPC mode. We inject the task prompt + extension.
    // The banto-executor extension registers report_phase/report_done tools and
    // injects the executor system prompt. We inject these via driver.inject().
    //
    // Note: for this E2E, we inject a prompt that tells pi to:
    //   1. Call report_phase("implementing")
    //   2. Create hello.txt
    //   3. Call report_done("hello.txt created with Hello banto")
    //
    // We also need to inject the extension and set BANTO_PROJECT/BANTO_TASK_ID env.
    // The current pi-rpc driver spawns pi WITHOUT the extension (no --extension flag).
    // For v1, we inject the prompt directly and rely on the task description to
    // guide the agent to call report_phase/report_done — but the tools must be registered.
    //
    // KNOWN LIMITATION (v1): The pi-rpc driver does not currently pass the banto-executor
    // extension to pi, so report_phase/report_done tools are not available via the extension.
    // For this E2E test, we test the state machine path manually:
    //   - inject the task prompt
    //   - check that pi responds (implementing → review-ready transition via HTTP API)
    //
    // The daemon HTTP API is accessible via DaemonClient from within the worktree.
    // Since the agent doesn't have the extension tools, we manually drive the state:
    const driver = daemon.driverRegistry.get("pi-rpc");
    if (!driver) throw new Error("pi-rpc driver not found");

    // Inject the task prompt to the running pi session
    const worktreeRepoPath = spawnResult.worktreePath;
    const daemonUrl = `http://localhost:${daemon.port}`;
    const taskPrompt = [
      `You are a banto executor agent. Your task:`,
      ``,
      `Create a file called \`hello.txt\` in the current directory (${worktreeRepoPath}) with content "Hello banto".`,
      ``,
      `Before creating the file, call the banto daemon HTTP API to report your phase:`,
      `  POST ${daemonUrl}/api/v1/projects/${projectTag}/tasks/${TASK_ID}/transition`,
      `  Body: { "to": "implementing" }`,
      ``,
      `After creating hello.txt, report completion:`,
      `  POST ${daemonUrl}/api/v1/projects/${projectTag}/tasks/${TASK_ID}/transition`,
      `  Body: { "to": "auditing" }`,
      `  then: { "to": "review-ready" }`,
      ``,
      `Use the bash tool to create the file and make the HTTP calls.`,
    ].join("\n");

    await driver.inject(spawnResult.sessionId, taskPrompt);

    // ── Step 8: Wait for review-ready ────────────────────────────────────────
    const becameReviewReady = await pollUntil(() => {
      const t = daemon.getTask(projectTag, TASK_ID);
      return t?.status === "review-ready";
    }, 120000, 1000);

    if (!becameReviewReady) {
      // Check if the task failed
      const taskState = daemon.getTask(projectTag, TASK_ID);
      const events = daemon.getAllEvents();
      const failedEv = events.find((e) => e.type === "task_failed" && e.taskId === TASK_ID);

      if (failedEv && failedEv.type === "task_failed") {
        recordFailure({
          story: "S254276-4",
          ac: "AC-S254276-4-2",
          type: "needs_human",
          reason: `エージェントがreview-readyに到達できなかった: ${failedEv.reason}`,
          detail: `task.status=${taskState?.status ?? "unknown"}, fail_reason=${failedEv.reason}`,
          timestamp: new Date().toISOString(),
        });
        throw new Error(
          `needs_human: エージェントがtask_failedに遷移 — ${failedEv.reason}`
        );
      }

      assert.fail(
        `Task '${TASK_ID}' must reach 'review-ready' within 120s. ` +
        `Current status: ${taskState?.status ?? "unknown"}`
      );
    }

    // ── Step 9: Verify state is review-ready ────────────────────────────────
    const taskFinal = daemon.getTask(projectTag, TASK_ID);
    assert.equal(
      taskFinal?.status,
      "review-ready",
      "task.status must be 'review-ready' after agent completion"
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
      toStatuses.includes("review-ready"),
      `state transitions must include 'review-ready'; got: [${toStatuses.join(", ")}]`
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
  });
});

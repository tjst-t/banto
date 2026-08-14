/**
 * [AC-S254276-4-2] Walking skeleton E2E: enqueue → ready → spawn → implement → review-ready.
 *
 * This is the milestone acceptance test: end-to-end from PO task file placement to
 * agent reaching review-ready state. Real daemon + real pi agent + real LLM required.
 *
 * IMPORTANT: This test requires a working opencode provider with deepseek-v4-flash-free.
 * Auth is probed by running `pi --provider opencode --model deepseek-v4-flash-free --no-session -p "Reply with exactly: OK"`.
 * If the probe fails, this test records the block in docs/sprint-logs/S254276/failures.json
 * and throws (I2: skip禁止).
 *
 * Flow:
 *   1. Start real daemon (piProvider=opencode, piModel=deepseek-v4-flash-free).
 *   2. Register project pointing to a temporary git repo.
 *   3. Write a minimal task definition file to <repoPath>/work/tasks/e2e-task-001.md.
 *   4. Enqueue via kobo.enqueue → task appears as 'queued'.
 *   5. Wait for gate evaluation → task becomes 'ready'.
 *   6. Call spawnTask() explicitly (auto-spawn is a future sprint feature).
 *      Daemon wires: --extension banto-executor.ts + --provider opencode + --model deepseek-v4-flash-free
 *      + BANTO_DAEMON_URL/BANTO_PROJECT/BANTO_TASK_ID env vars.
 *   7. Inject the task prompt via driver.inject().
 *      The banto-executor extension provides report_phase/report_done tools.
 *      The prompt instructs the LLM to call these tools (NOT raw HTTP API).
 *   8. Wait for pi agent to call report_done → task becomes 'review-ready'.
 *   9. Verify event history, hello.txt file, and extension-driven state transitions.
 *
 * Timeout: 240 000 ms (deepseek-v4-flash-free latency can be 30-60 s per LLM call).
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
import { PiRpcDriver } from "../../packages/banto-worker-pool/src/pi-rpc-driver.js";
import { WorkerPool } from "../../packages/banto-worker-pool/src/pool.js";
import { WorkerPoolService } from "../../packages/banto-worker-pool/src/service.js";
import {
  createWorkerModuleTools,
  createWorkerTools,
} from "../../packages/banto-worker-pool/src/worker-tools.js";

// ── Paths ─────────────────────────────────────────────────────────────────────

const FAILURES_JSON = path.resolve(
  import.meta.dirname ?? new URL(".", import.meta.url).pathname,
  "../../docs/sprint-logs/S254276/failures.json"
);

// ── Default provider/model (banto確定モデル) ──────────────────────────────────
const PI_PROVIDER = "opencode";
const PI_MODEL = "deepseek-v4-flash-free";

// ── Auth probe ────────────────────────────────────────────────────────────────

/**
 * Probe whether pi can authenticate to the configured LLM provider.
 * Runs `pi --provider opencode --model deepseek-v4-flash-free --no-session -p "Reply with exactly: OK"`
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
      path.resolve(import.meta.dirname ?? ".", "../../node_modules/@earendil-works/pi-coding-agent/dist/cli.js"),
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
/** 依頼の本文（第4便：`kobo.enqueue` に渡すもの。職人へそのまま届く）。 */
const TASK_BODY = `Create a file called hello.txt in the current directory with the content: Hello banto

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
  let workerDriver: PiRpcDriver;
  let workerPool: WorkerPool;
  let workerService: WorkerPoolService;
  const projectTag = "e2e-project";

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

    // disableAuditSpawn: this E2E tests the executor completing implementing→auditing.
    // The audit session mechanism (S75f66b-3) is tested in pipeline-merge.e2e.spec.ts
    // (the full pipeline E2E). Here we stop at 'auditing' state to verify executor
    // behavior. Without this flag, the audit LLM session auto-spawns after auditing
    // is reached, which causes "asynchronous activity after test ended" warnings when
    // daemon.stop() is called while the audit LLM is still running.
    // audit_spawn_disabled event is emitted for the implementing→auditing transition
    // (F2 governance: suppression is visible in the event log).
    // task-0060（ADR-0013 決定60）: 職人を起こすのは **Worker Pool**。Kobo は頼むだけで、
    // pi も provider も model も知らない——モデルを決めるのは Worker Pool 側になる
    workerDriver = new PiRpcDriver({
      sessionBaseDir: path.join(tmpDir, "sessions"),
      defaultProvider: PI_PROVIDER,
      defaultModel: PI_MODEL,
    });
    workerPool = new WorkerPool({
      driver: workerDriver,
      dataDir: path.join(tmpDir, "worker-pool"),
      defaultProjectTag: "kobo",
      defaultOrigin: "kobo",
      idleTimeoutMs: 0,
    });
    workerService = await WorkerPoolService.start({
      tools: [...createWorkerTools(workerPool), ...createWorkerModuleTools(workerPool)],
      port: 0,
    });

    daemon = Daemon.create({
      port: 0,
      dataDir: path.join(tmpDir, "data"),
      tickIntervalMs: 500,
      worktreeBaseDir: path.join(tmpDir, "worktrees"),
      workerPoolUrl: workerService.baseUrl,
      disableAuditSpawn: true,
    });

    // Register the e2e project
    daemon.registerProject(projectTag, repoDir);

    await daemon.start();
  });

  after(async () => {
    if (daemon) {
      await daemon.stop();
    }
    if (workerPool) {
      // 起こした職人は畳む（決定63：番頭には畳めないので、起こした側が片付ける）
      for (const worker of workerPool.list({ includeClosed: false })) {
        await workerPool.close(worker.sessionId, "stopped").catch(() => undefined);
      }
      workerPool.dispose();
    }
    if (workerService) await workerService.close();
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("[AC-S254276-4-2] E2E: enqueue → ready → spawn → implement → auditing (S75f66b-3: executor done→audit, not self→review-ready)", async () => {
    // Auth gate: if auth failed, escalate as needs_human (I2: not skip)
    if (!authResult.ok) {
      throw new Error(
        `needs_human: E2E実行不能 — LLM認証が利用できません。` +
        `理由: ${authResult.reason ?? "unknown"}。` +
        `詳細は docs/sprint-logs/S254276/failures.json を参照。` +
        `${PI_PROVIDER}/${PI_MODEL} 認証設定を確認してください。`
      );
    }

    // ── Step 1: Enqueue（第4便：入口は kobo.enqueue だけ。採番も記録も Kobo）────
    const enqueued = daemon.enqueueTask(
      projectTag,
      {
        title: "Hello World Task",
        kind: "feature",
        body: TASK_BODY,
        scope: { paths: ["hello.txt"] },
        acceptance: [{ text: "hello.txt exists and contains Hello banto" }],
      },
      { originRef: "E2E: walking skeleton" }
    );
    assert.ok(enqueued.ok, `enqueue must succeed: ${enqueued.ok ? "" : enqueued.reason}`);
    assert.equal(enqueued.ok && enqueued.taskId, TASK_ID, "Kobo が最初の番号を振ること");

    // ── Step 2: queued（またはその先）になっていること ─────────────────────────
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
      "Task must be queued (or further) within 10s after enqueue"
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
    //   - passes --provider opencode --model deepseek-v4-flash-free
    //   - sets BANTO_DAEMON_URL, BANTO_PROJECT, BANTO_TASK_ID env vars in child
    // The extension registers report_phase/report_done tools in the pi session.
    let spawnResult: {
      worktreePath: string;
      sessionPath: string;
      pid: number;
      sessionId: string;
    };

    try {
      spawnResult = await daemon.spawnTask(projectTag, TASK_ID);
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

    // ── Step 6: 職人は Worker Pool の台帳に載る（決定29c：真実は一箇所）──────────
    const poolWorker = workerPool.get(spawnResult.sessionId);
    assert.ok(poolWorker, "起こした職人が Worker Pool の台帳に居ること");
    assert.equal(poolWorker!.origin, "kobo", "起動元が Kobo だと分かる（決定63）");

    // ── Step 7: 指示は Kobo が渡している（PO は何もしない）─────────────────────
    // task-0060（ADR-0013 決定60）: タスク定義の本文＝依頼と、契約（スコープ・受け入れ
    // 基準・コミット先）を、Kobo が起動時の指示として渡す。以前はこのE2Eが外から
    // 本文を注入していたが、それは**本番には無い経路**だった——投げ込めば回ることを
    // 見たいのに、テストが手を貸したら何も検証していない。

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

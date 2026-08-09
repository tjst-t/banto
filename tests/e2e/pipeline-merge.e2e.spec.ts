/**
 * [AC-S75f66b-5-4] Pipeline merge E2E: task file drop → ingest → ready →
 * auto-spawn → implement → audit (REAL) → merging → merged.
 *
 * Real daemon + real pi + real LLM (review.policy: auto). NO mocks (I1, priority_rule 9).
 * S75f66b-5 reconcile with S75f66b-3: the REAL audit session now runs automatically
 * on implementing→auditing transition (S75f66b-3 disableAuditSpawn is NOT set here).
 *
 * Auth probe: same pattern as walking-skeleton.e2e.spec.ts.
 * If the probe fails, this test MUST FAIL with a clear needs_human message and
 * record the block in failures.json (I2: skip禁止).
 *
 * Flow (full pipeline with real audit):
 *   1. Start real daemon + register a temporary git project.
 *   2. Write a task definition file (status: queued, review.policy: auto,
 *      acceptance with a verify command).
 *   3. Watcher ingests → gate promotes to ready → auto-spawn kicks in.
 *   4. pi executor implements (creates a file), calls report_done → task reaches 'auditing'.
 *   5. Daemon auto-spawns a REAL audit session (S75f66b-3 mechanism):
 *      audit agent reads skills/audit-system.md + skills/audit-checklist.md,
 *      then calls audit_report tool with verdict=pass or verdict=fail.
 *   6a. verdict=pass → review.policy=auto → state_transitioned(auditing→merging).
 *   6b. verdict=fail (1st) → auditing→implementing (rework) → new executor session runs →
 *       report_done → auditing → real audit session again. Test allows at most 1 rework cycle.
 *   7. Merge queue processes: rebase → gate → fast-forward → merged (or closed).
 *   8. Verify: event chain includes audit_started, audit_verdict, task_merged;
 *      git log main contains the task's commit; implemented file exists on main.
 *
 * Rework tolerance: if the first audit verdict is fail (legitimate LLM judgment),
 * the test runs through the rework cycle and asserts eventual 'merged' or 'closed'
 * within an extended hard timeout. Asserts eventual merged, NOT that pass happens first.
 *
 * Hard overall timeout: 480_000 ms (two LLM sessions × latency + merge processing).
 * This is higher than walking-skeleton.e2e because we account for the real audit session.
 *
 * I2: auth failure → needs_human escalation, record in failures.json. Skip禁止.
 * I1: no mocks, no manual API calls after task drop (except auth probe).
 * D3: queue is derived from event log; no manual approved posting.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as childProcess from "node:child_process";
import { Daemon } from "@banto/daemon";
import {
  PiRpcDriver,
  WorkerPool,
  WorkerPoolService,
  createWorkerModuleTools,
  createWorkerTools,
} from "@banto/worker-pool";
import {
  EnvironmentPool,
  EnvironmentPoolService,
  createEnvTools,
} from "@banto/environment-pool";

// ── Paths ─────────────────────────────────────────────────────────────────────

const FAILURES_JSON = path.resolve(
  import.meta.dirname ?? new URL(".", import.meta.url).pathname,
  "../../docs/sprint-logs/S75f66b/failures.json"
);

// ── LLM provider config ───────────────────────────────────────────────────────

const PI_PROVIDER = "opencode";
const PI_MODEL = "deepseek-v4-flash-free";

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
        "../../node_modules/@earendil-works/pi-coding-agent/dist/cli.js"
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

// ── Polling helpers ───────────────────────────────────────────────────────────

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

// ── Task definition ───────────────────────────────────────────────────────────

const TASK_ID = "task-0100";
const TASK_FILE_NAME = "hello-merge.txt";

/**
 * Task definition that:
 *   - creates hello-merge.txt
 *   - has a verify command so the merge gate can check it
 *   - review.policy: auto (audit pass → merging directly, S75f66b-3)
 *   - no hypothesis (→ auto-closed after merge)
 *
 * S75f66b-5 reconcile: review.policy=auto means the REAL audit session
 * (auto-spawned by daemon on implementing→auditing) posts audit_report verdict;
 * on pass, the daemon transitions auditing→merging without any manual PO action.
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

// Hard overall timeout: 480s to accommodate two real LLM sessions (executor + auditor)
// plus rework tolerance (one rework cycle: executor again + auditor again).
describe("[AC-S75f66b-5-4] Pipeline E2E: drop → auto-spawn → implement → REAL audit → merging → merged", { timeout: 480000 }, () => {
  let tmpDir: string;
  let repoDir: string;
  let tasksDir: string;
  let daemon: Daemon;
  let workerPool: WorkerPool;
  let workerService: WorkerPoolService;
  /** この試験専用の検証環境（実機の常駐サービスには触らない。task-0066）。 */
  let envPool: EnvironmentPool | undefined;
  let envService: EnvironmentPoolService | undefined;
  let worktreePath: string | undefined;
  const projectTag = "e2e-merge-project";

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

    // task-0060（ADR-0013 決定60）: 実装者も監査人も **Worker Pool** が起こす。
    // Kobo は tier だけを渡し、モデルの解決はここ（Worker Pool 側）で行う（決定60a）
    workerPool = new WorkerPool({
      driver: new PiRpcDriver({
        sessionBaseDir: path.join(tmpDir, "sessions"),
        defaultProvider: PI_PROVIDER,
        defaultModel: PI_MODEL,
      }),
      dataDir: path.join(tmpDir, "worker-pool"),
      defaultProjectTag: "kobo",
      defaultOrigin: "kobo",
      idleTimeoutMs: 0,
    });
    workerService = await WorkerPoolService.start({
      tools: [...createWorkerTools(workerPool), ...createWorkerModuleTools(workerPool)],
      port: 0,
    });

    /**
     * **この試験は自分の Environment Pool を立てる。**
     *
     * `npm run test:e2e` は `BANTO_ENV_POOL_URL` を届かない先（`127.0.0.1:1`）に固定して
     * いる——実機の常駐サービスがテストの相手になるのを防ぐため（task-0066）。その上で
     * task-0075 が「**Kobo は検証をホストで走らせない**」と決めたので、`verify` を持つ
     * 受け入れ条件は**環境が無ければ確かめられず**、ゲートは `verify_env_unavailable` で
     * 落とす（正しい動作）。両方が正しいまま、この試験だけが取り残されていた。
     *
     * 逃げ道は2つあった：①`verify` を外す ②自分のプールを立てる。①は
     * 「ゲートが受け入れ条件を確かめる」という**この試験の主題**を削るので採らない。
     * ハーネスを立てて URL を明示的に渡すのは `host-uses-pool-services.spec.ts` が
     * 書いている作法そのもの——職人と同じ形で環境も立てる。
     */
    fs.mkdirSync(path.join(repoDir, "meta"), { recursive: true });
    fs.writeFileSync(
      path.join(repoDir, "meta", "environments.yaml"),
      [
        "profiles:",
        "  test:",
        "    driver: process",
        "    ttl: 10m",
        "    config:",
        '      cmd: "sleep 600"',
        "",
      ].join("\n")
    );
    envPool = new EnvironmentPool({ dataDir: path.join(tmpDir, "env-pool") });
    envService = await EnvironmentPoolService.start({
      tools: createEnvTools(envPool),
      port: 0,
    });

    // disableAuditSpawn is NOT set: the REAL audit session auto-spawns on
    // implementing→auditing (S75f66b-3 mechanism exercised by this E2E).
    daemon = Daemon.create({
      port: 0,
      dataDir: path.join(tmpDir, "data"),
      watchIntervalMs: 500,
      tickIntervalMs: 500,
      worktreeBaseDir: path.join(tmpDir, "worktrees"),
      workerPoolUrl: workerService.baseUrl,
      environmentPoolUrl: envService.baseUrl,
    });

    daemon.registerProject(projectTag, repoDir);
    await daemon.start();
  });

  after(async () => {
    if (daemon) {
      try { await daemon.stop(); } catch { /* ignore */ }
    }
    // I3: 立てた環境とサービスは畳む（外にプロセスを残さない）
    if (envPool) {
      for (const env of envPool.list()) {
        try { await envPool.teardown(env.envId); } catch { /* ignore */ }
      }
    }
    if (envService) {
      try { await envService.close(); } catch { /* ignore */ }
    }
    if (workerPool) {
      // 起こした職人は畳む（I3・決定63）
      for (const worker of workerPool.list({ includeClosed: false })) {
        await workerPool.close(worker.sessionId, "stopped").catch(() => undefined);
      }
      workerPool.dispose();
    }
    if (workerService) await workerService.close();
    if (tmpDir) {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  it("[AC-S75f66b-5-4] Pipeline E2E: drop → auto-spawn → implement → REAL audit → merging → merged", async () => {
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

    // ── Step 4: auto-spawn kicks in → planning ──────────────────────────────
    const PLANNING_OR_LATER = new Set([
      "planning", "implementing", "auditing", "review-ready",
      "in-review", "approved", "merging", "merged", "closed",
    ]);
    const autoSpawned = await pollUntilFn(() => {
      const t = daemon.getTask(projectTag, TASK_ID);
      return !!t && PLANNING_OR_LATER.has(t.status);
    }, 30000);
    assert.ok(autoSpawned, "auto-spawn must trigger and task must reach planning within 30s");

    // Record the worktree path for cleanup verification later.
    // **帳簿から引く**（決定60・a6：置き場所を決めるのは Kobo ではない）
    const spawnedEv = daemon
      .getTaskEvents(projectTag, TASK_ID)
      .find((e) => e.type === "agent_spawned") as { worktree?: string } | undefined;
    worktreePath = spawnedEv?.worktree ?? path.join(tmpDir, "worktrees", projectTag, TASK_ID);

    // ── Step 5: 職人には Kobo が指示を渡している（PO は何もしない）─────────────
    // task-0060（ADR-0013 決定60）: Kobo が起動時に**依頼の本文と契約**（スコープ・
    // 受け入れ基準・コミット先ブランチ）を指示として渡す。以前はこのE2Eが外から
    // タスク本文を注入しており、**本番には無い経路で辻褄が合っていた**（工場は
    // 「投げ込めば回る」のが要件なので、テストが手を貸したら検証にならない）。
    // ここで確かめるのは、頼んだ相手が実在し、Kobo 由来だと分かることだけ。
    const entry = workerPool
      .list({ includeClosed: false })
      .find((w) => w.taskId === TASK_ID && w.origin === "kobo");
    if (!entry) {
      // The task may have already progressed (fast runner). Check status.
      const currentStatus = daemon.getTask(projectTag, TASK_ID)?.status;
      if (currentStatus && !PLANNING_OR_LATER.has(currentStatus)) {
        throw new Error(
          `Task ${TASK_ID} が Worker Pool の台帳に無く、状態は ${currentStatus} — 想定外`
        );
      }
    }

    // ── Step 6: Wait for implementing → auditing (executor calls report_done) ──
    const AUDIT_OR_LATER = new Set([
      "auditing", "review-ready", "in-review", "approved",
      "merging", "merged", "closed",
    ]);
    // Allow up to 240s for executor LLM session to complete the task
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
        `Task must reach 'auditing' (or later) within 240s. Current: ${taskState?.status ?? "unknown"}`
      );
    }

    // ── Step 7: Real audit session auto-spawns and posts verdict (S75f66b-3) ──
    //
    // The daemon auto-spawns an audit session on implementing→auditing.
    // The audit LLM reads skills/audit-system.md + skills/audit-checklist.md,
    // then calls audit_report with verdict=pass or verdict=fail.
    //
    // review.policy=auto:
    //   - pass  → state_transitioned(auditing→merging) — no manual approval needed
    //   - fail  → state_transitioned(auditing→implementing) + rework executor session
    //            → rework completes → auditing again → second audit session
    //            → pass → merging   (tolerated: at most 1 rework cycle)
    //   - fail×2 → failed (I2: two consecutive fails → escalation)
    //
    // Wait up to 180s for merging/merged/closed (nominal audit pass path).
    // If still in auditing/implementing after 180s, one more 120s window for rework.
    //
    // Hard constraint: eventually reaches merged/closed within overall 480s suite timeout.

    const MERGING_OR_TERMINAL = new Set([
      "merging", "merged", "closed", "failed",
    ]);

    // First wait: nominal audit pass path (180s)
    const reachedMerging = await pollUntilFn(() => {
      const t = daemon.getTask(projectTag, TASK_ID);
      return !!t && MERGING_OR_TERMINAL.has(t.status);
    }, 180000, 1000);

    if (!reachedMerging) {
      // Still in auditing/implementing — may be in rework cycle. Wait one more window.
      const statusMid = daemon.getTask(projectTag, TASK_ID)?.status ?? "unknown";
      process.stdout.write(
        `[pipeline-e2e] Status after 180s: ${statusMid}. ` +
        `Audit verdict may have been 'fail' (rework cycle). Waiting 120s more.\n`
      );

      const reachedMergingAfterRework = await pollUntilFn(() => {
        const t = daemon.getTask(projectTag, TASK_ID);
        return !!t && MERGING_OR_TERMINAL.has(t.status);
      }, 120000, 1000);

      if (!reachedMergingAfterRework) {
        const taskState = daemon.getTask(projectTag, TASK_ID);
        const events = daemon.getAllEvents();
        const auditVerdicts = events.filter((e) => e.type === "audit_verdict" && "taskId" in e && e.taskId === TASK_ID);
        assert.fail(
          `Task must reach merging/merged/closed within 300s (including rework cycle). ` +
          `Current: ${taskState?.status ?? "unknown"}. ` +
          `Audit verdicts so far: ${JSON.stringify(auditVerdicts.map((v) => ({ verdict: (v as {verdict?: string}).verdict })))}`
        );
      }
    }

    // ── Step 8: Assert audit session ran (event log must contain audit_started + audit_verdict) ──
    const events = daemon.getAllEvents();
    const auditStarted = events.find(
      (e) => e.type === "audit_started" && "taskId" in e && e.taskId === TASK_ID
    );
    assert.ok(
      auditStarted,
      "audit_started event must be present — real audit session must have auto-spawned"
    );

    const auditVerdict = events.find(
      (e) => e.type === "audit_verdict" && "taskId" in e && e.taskId === TASK_ID
    );
    assert.ok(
      auditVerdict,
      "audit_verdict event must be present — real audit session must have posted a verdict"
    );

    const verdictValue = (auditVerdict as { verdict?: string })?.verdict;
    process.stdout.write(`[pipeline-e2e] Audit verdict: ${verdictValue}\n`);

    // ── Step 9: Wait for merge queue to process → merged or closed ───────────
    const MERGED_OR_CLOSED = new Set(["merged", "closed"]);
    const taskBeforeMergeWait = daemon.getTask(projectTag, TASK_ID);
    // If already merged/closed (fast path from step 8), skip the wait.
    if (!taskBeforeMergeWait || !MERGED_OR_CLOSED.has(taskBeforeMergeWait.status)) {
      const reachedMerged = await pollUntilFn(() => {
        const t = daemon.getTask(projectTag, TASK_ID);
        return !!t && MERGED_OR_CLOSED.has(t.status);
      }, 60000, 500);

      if (!reachedMerged) {
        const taskState = daemon.getTask(projectTag, TASK_ID);
        assert.fail(
          `Task must reach 'merged' or 'closed' within 60s after entering merging. ` +
          `Current: ${taskState?.status ?? "unknown"}`
        );
      }
    }

    const finalStatus = daemon.getTask(projectTag, TASK_ID)?.status;
    assert.ok(
      finalStatus === "merged" || finalStatus === "closed",
      `Task final status must be merged or closed (got ${finalStatus})`
    );

    // ── Step 10: Verify event chain ──────────────────────────────────────────
    const taskEvents = daemon.getTaskEvents(projectTag, TASK_ID);
    const eventTypes = taskEvents.map((e) => e.type);

    assert.ok(eventTypes.includes("task_created"), "must have task_created");

    // audit_started and audit_verdict must be in the task event chain
    assert.ok(eventTypes.includes("audit_started"), "must have audit_started in task events");
    assert.ok(eventTypes.includes("audit_verdict"), "must have audit_verdict in task events");

    const mergedEvent = taskEvents.find((e) => e.type === "task_merged");
    assert.ok(mergedEvent, "must have task_merged event");

    const commitSha = (mergedEvent as { commitSha?: string })?.commitSha;
    assert.ok(commitSha && commitSha.length >= 7, `commitSha must be a git hash: ${commitSha}`);

    // ── Step 11: Verify implemented file exists on main branch ───────────────
    const logOutput = git(["log", "main", "--oneline"], repoDir);
    assert.ok(logOutput.length > 0, "main branch must have commits");

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

    // ── Step 12: Verify commitSha exists on main ─────────────────────────────
    assert.ok(
      logOutput.includes(commitSha!.slice(0, 7)),
      `commitSha ${commitSha} must appear in git log main`
    );

    // ── Step 13: Verify worktree cleanup ──────────────────────────────────────
    const worktreeGone = !fs.existsSync(worktreePath!);
    assert.ok(worktreeGone, `Worktree must be removed after merge: ${worktreePath}`);

    process.stdout.write(
      `[pipeline-e2e] SUCCESS: task=${TASK_ID} final=${finalStatus} ` +
      `auditVerdict=${verdictValue} commitSha=${commitSha}\n`
    );
  });
});

/**
 * [AC-S75f66b-6-3] Conflict resume: resolution task merged → origin resumed and merged;
 * resolution task failed → origin chain-fails.
 *
 * story_type=api: exercises the real daemon HTTP API + real git repos.
 * No mocked daemon internals (I1).
 *
 * Case A: resolution task reaches 'merged' → origin is resumed to 'merging' and
 *   eventually reaches 'merged'. Correspondence is derived from events only (D3).
 *
 * Case B: resolution task fails → origin chain-fails (I2).
 *   Origin must not remain paused indefinitely.
 *
 * Test approach:
 *   Each case uses its own nested describe block with before()/after() hooks so
 *   that daemon teardown is scoped correctly and deferred async activity (scheduler
 *   ticks, rework spawn failures) does not cross-contaminate test results.
 *
 *   Both cases use a REAL rebase conflict to get the origin into 'paused' state.
 *
 *   Case A:
 *     After the conflict is detected, the test resets the origin task's branch to be
 *     on top of main with resolved content (simulating the conflict resolution agent).
 *     Drives conflict task through pipeline to merged → verifies origin resumes+merges.
 *
 *   Case B:
 *     Sends two consecutive audit-fail verdicts for the conflict task → it fails.
 *     Verifies origin chain-fails (I2: stop, don't swallow).
 *
 * Tags: [AC-S75f66b-6-3]
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { execFileSync } from "node:child_process";
import {
  Daemon,
  deriveOriginResolutionPairs,
  hasOpenResolutionTask,
} from "@banto/daemon";

// ── Helpers ───────────────────────────────────────────────────────────────────

async function pollUntil<T>(
  fn: () => Promise<T>,
  pred: (v: T) => boolean,
  timeoutMs = 20000,
  intervalMs = 200
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last = await fn();
  while (!pred(last) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, intervalMs));
    last = await fn();
  }
  return last;
}

async function getTask(
  base: string,
  proj: string,
  taskId: string
): Promise<{ status: string; suspendedFrom?: string; [k: string]: unknown } | null> {
  const r = await fetch(`${base}/api/v1/projects/${proj}/tasks/${taskId}`);
  if (r.status !== 200) return null;
  const body = (await r.json()) as { task?: { status: string; [k: string]: unknown } };
  return body.task as { status: string; suspendedFrom?: string; [k: string]: unknown } ?? null;
}

async function getStatus(
  base: string,
  proj: string,
  taskId: string
): Promise<string | null> {
  return (await getTask(base, proj, taskId))?.status ?? null;
}

async function getEvents(
  base: string,
  proj: string
): Promise<Array<{ type: string; taskId?: string; [k: string]: unknown }>> {
  const r = await fetch(`${base}/api/v1/projects/${proj}/events`);
  const body = (await r.json()) as { events: Array<{ type: string; taskId?: string }> };
  return body.events as Array<{ type: string; taskId?: string; [k: string]: unknown }>;
}

async function safeTransitionTo(
  base: string,
  proj: string,
  taskId: string,
  to: string
): Promise<void> {
  try {
    const r = await fetch(`${base}/api/v1/projects/${proj}/tasks/${taskId}/transition`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ to }),
    });
    void r;
  } catch {
    // ignore
  }
}

/**
 * 監査を通ったタスクを `approved` まで進める（realign 第3便）。
 *
 * ## この試験が見ているのは「**層Bに `verify.conflict_command` が無い**世界」
 *
 * このリポジトリには `meta/config.yaml` を置いていない。だから `conflict-filer` が
 * 書く解消タスクは**検査コマンドを持たず**、自動着地の条件（→ `spec-daemon-core` §2.5）
 * を満たさずに `review-ready` で止まる。**これは正しい挙動**——設定した人だけが
 * 自動復旧を得る。「検査がある世界で自動着地できる形になる」側は
 * `conflict-verify.spec.ts` が受け持つ。
 *
 * この一連の試験が見たいのはコンフリクトの再開・連鎖失敗であって着地の可否ではないので、
 * 人が通す道を通す。
 *
 * 検査を持たせて自動着地させる手もあるが、この試験には検証環境が配線されていない
 * （`BANTO_ENV_POOL_URL` は届かない先）ため、ゲートが `verify_env_unavailable` で
 * 落ちる。**確かめていないものを通す道を試験に作らない**（I1）。
 */
async function approveAfterAudit(base: string, proj: string, taskId: string): Promise<void> {
  if ((await getStatus(base, proj, taskId)) !== "review-ready") return;
  await safeTransitionTo(base, proj, taskId, "in-review");
  await safeTransitionTo(base, proj, taskId, "approved");
}

function git(cwd: string, ...args: string[]): Buffer {
  return execFileSync("git", args, { cwd, stdio: "pipe" });
}

/** Create a task branch in a worktree for a given task. */
function createTaskBranch(opts: {
  repoDir: string;
  worktreeBaseDir: string;
  proj: string;
  taskId: string;
  fileName: string;
  content: string;
}): string {
  const { repoDir, worktreeBaseDir, proj, taskId, fileName, content } = opts;
  const taskBranch = `task/${taskId}`;
  const worktreePath = path.join(worktreeBaseDir, proj, taskId);
  fs.mkdirSync(path.dirname(worktreePath), { recursive: true });

  if (!fs.existsSync(worktreePath)) {
    git(repoDir, "worktree", "add", "--detach", worktreePath);
  }
  const wgit = (...args: string[]) => git(worktreePath, ...args);
  try {
    wgit("checkout", "-B", taskBranch);
  } catch {
    wgit("checkout", taskBranch);
  }
  fs.writeFileSync(path.join(worktreePath, fileName), content);
  wgit("add", "-A");
  try {
    wgit("commit", "-m", `feat: ${taskId} — ${fileName}`);
  } catch { /* already has a commit */ }
  return worktreePath;
}

/**
 * Set up a conflict scenario and return the auto-filed conflict task ID.
 *
 * Drives anchor + origin tasks to merging via audit-pass (review.policy=auto).
 * Anchor merges first, then origin hits a rebase conflict → auto-filed conflict task.
 */
async function setupConflictScenario(opts: {
  base: string;
  proj: string;
  repoDir: string;
  worktreeBaseDir: string;
  anchorTaskId: string;
  originTaskId: string;
}): Promise<{ conflictTaskId: string; originWorktreePath: string }> {
  const { base, proj, repoDir, worktreeBaseDir, anchorTaskId, originTaskId } = opts;

  // Register project
  const projR = await fetch(`${base}/api/v1/projects`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: proj, repoPath: repoDir }),
  });
  assert.equal(projR.status, 201, `project ${proj} must register`);

  // Create git branches
  createTaskBranch({ repoDir, worktreeBaseDir, proj, taskId: anchorTaskId,
    fileName: "shared.ts", content: "// anchor\nexport const VALUE = 1;\n" });
  const originWorktreePath = createTaskBranch({ repoDir, worktreeBaseDir, proj,
    taskId: originTaskId, fileName: "shared.ts", content: "// origin\nexport const VALUE = 2;\n" });

  // Create tasks via HTTP (starts in draft)
  for (const { id, label } of [
    { id: anchorTaskId, label: `Anchor ${anchorTaskId}` },
    { id: originTaskId, label: `Origin ${originTaskId}` },
  ]) {
    const r = await fetch(`${base}/api/v1/projects/${proj}/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id, title: label,
        scope: { paths: ["shared.ts"] },
        acceptance: [{ id: "a1", text: "file must exist" }],
        review: { policy: "auto" },
      }),
    });
    assert.equal(r.status, 201, `task ${id} creation must succeed`);
  }

  // Drive both to merging: draft→queued→ready→planning→implementing→auditing→(pass)→merging
  for (const taskId of [anchorTaskId, originTaskId]) {
    for (const step of ["queued", "ready", "planning", "implementing", "auditing"]) {
      await safeTransitionTo(base, proj, taskId, step);
    }
    await pollUntil(() => getStatus(base, proj, taskId),
      (s) => s === "auditing" || s === "merging", 5000, 100);

    const verdictR = await fetch(`${base}/api/v1/projects/${proj}/tasks/${taskId}/audit-report`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ verdict: "pass", findings: [] }),
    });
    assert.equal(verdictR.status, 200, `audit pass for ${taskId} must succeed`);
    await approveAfterAudit(base, proj, taskId);
  }

  // Anchor merges first (serial queue — it entered merging first)
  const anchorFinal = await pollUntil(
    () => getStatus(base, proj, anchorTaskId),
    (s) => s === "merged" || s === "closed" || s === "failed",
    25000
  );
  assert.ok(anchorFinal === "merged" || anchorFinal === "closed",
    `anchor must merge (got ${anchorFinal})`);

  // Origin hits conflict → paused
  const originStatus = await pollUntil(
    () => getStatus(base, proj, originTaskId),
    (s) => s === "paused" || s === "failed",
    25000
  );
  assert.equal(originStatus, "paused", `origin must be paused after conflict (got ${originStatus})`);

  // Find auto-filed conflict task
  const tasksDir = path.join(repoDir, "work", "tasks");
  const conflictFile = await pollUntil(
    async () => {
      if (!fs.existsSync(tasksDir)) return null;
      const files = fs.readdirSync(tasksDir);
      return files.find((f) => f.includes("conflict") && f.endsWith(".md")) ?? null;
    },
    (f) => f !== null,
    10000, 200
  );
  assert.ok(conflictFile !== null, "conflict task file must be auto-created");

  const content = fs.readFileSync(path.join(tasksDir, conflictFile!), "utf-8");
  const idMatch = content.match(/^id:\s*(task-\d+)/m);
  assert.ok(idMatch, "conflict task file must have id field");

  return { conflictTaskId: idMatch![1]!, originWorktreePath };
}

// ── Test Case A ───────────────────────────────────────────────────────────────

describe("[AC-S75f66b-6-3-A] resolution task merged → origin resumed and reaches merged/closed", () => {
  let tmpDir: string;
  let repoDir: string;
  let worktreeBaseDir: string;
  let daemon: Daemon;
  let base: string;
  const PROJ = "proj-resume-a";

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "banto-resume-a-"));
    repoDir = path.join(tmpDir, "repo");
    worktreeBaseDir = path.join(tmpDir, "worktrees");
    fs.mkdirSync(repoDir, { recursive: true });
    git(repoDir, "init", "-b", "main");
    git(repoDir, "config", "user.email", "test@banto.local");
    git(repoDir, "config", "user.name", "banto-test");
    fs.writeFileSync(path.join(repoDir, "shared.ts"), "// initial\nexport const VALUE = 0;\n");
    git(repoDir, "add", "-A");
    git(repoDir, "commit", "-m", "initial");

    daemon = Daemon.create({
      port: 0, dataDir: path.join(tmpDir, "data"), worktreeBaseDir,
      tickIntervalMs: 200, watchIntervalMs: 200,
      disableAuditSpawn: true, maxConcurrentSessions: 0,
      // task-0060: 職人を要らないので Worker Pool に頼まない
      disableAutoSpawn: true,
    });
    await daemon.start();
    base = `http://localhost:${daemon.port}`;
  });

  after(async () => {
    // Scheduler.stop() drains any in-flight runAllJobs() before returning.
    // No sleep needed — daemon.stop() awaits the drain before closing the log.
    await daemon.stop();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("[AC-S75f66b-6-3-A] resolution merged → origin resumed and merged", async () => {
    const { conflictTaskId, originWorktreePath } = await setupConflictScenario({
      base, proj: PROJ, repoDir, worktreeBaseDir,
      anchorTaskId: "task-anch-a", originTaskId: "task-orig-a",
    });

    // Fix the origin branch: reset to main + add resolved commit.
    // Simulates what the conflict resolution agent does to the origin's branch.
    git(originWorktreePath, "reset", "--hard", "main");
    fs.writeFileSync(
      path.join(originWorktreePath, "shared.ts"),
      "// resolved (origin + anchor merged)\nexport const VALUE = 99;\n"
    );
    git(originWorktreePath, "add", "-A");
    git(originWorktreePath, "commit", "-m", "fix: resolve conflict between anchor and origin");

    // Set up the conflict task's git branch (needed for merge queue to process it)
    const conflictWorktreePath = path.join(worktreeBaseDir, PROJ, conflictTaskId);
    if (!fs.existsSync(conflictWorktreePath)) {
      git(repoDir, "worktree", "add", "--detach", conflictWorktreePath);
    }
    try { git(conflictWorktreePath, "checkout", "-B", `task/${conflictTaskId}`); }
    catch { /* already on branch */ }
    fs.writeFileSync(path.join(conflictWorktreePath, "CONFLICT_RESOLVED.txt"), "resolved\n");
    git(conflictWorktreePath, "add", "-A");
    git(conflictWorktreePath, "commit", "-m", `fix: ${conflictTaskId} — resolve`);

    // Wait for watcher to ingest conflict task
    await pollUntil(() => getTask(base, PROJ, conflictTaskId), (t) => t !== null, 10000, 200);

    // Drive conflict task through pipeline: audit-pass → merging (review.policy:auto)
    for (const step of ["queued", "ready", "planning", "implementing", "auditing"]) {
      await safeTransitionTo(base, PROJ, conflictTaskId, step);
    }
    await pollUntil(() => getStatus(base, PROJ, conflictTaskId), (s) => s === "auditing", 5000, 100);
    const auditR = await fetch(`${base}/api/v1/projects/${PROJ}/tasks/${conflictTaskId}/audit-report`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ verdict: "pass", findings: [] }),
    });
    assert.equal(auditR.status, 200, "conflict task audit pass must succeed");

    // realign 第3便: 検査を持たない契約は自動着地しない。人が通す（approveAfterAudit の注記）
    await approveAfterAudit(base, PROJ, conflictTaskId);

    // Wait for conflict task to merge
    const conflictFinal = await pollUntil(
      () => getStatus(base, PROJ, conflictTaskId),
      (s) => s === "merged" || s === "closed" || s === "failed",
      25000, 200
    );
    assert.ok(
      conflictFinal === "merged" || conflictFinal === "closed",
      `conflict task must reach merged/closed (got ${conflictFinal})`
    );

    // Wait for origin to be resumed (paused → merging)
    await pollUntil(
      () => getStatus(base, PROJ, "task-orig-a"),
      (s) => s !== "paused",
      10000, 200
    );

    // Wait for origin to merge
    const originFinal = await pollUntil(
      () => getStatus(base, PROJ, "task-orig-a"),
      (s) => s === "merged" || s === "closed" || s === "failed",
      25000, 200
    );
    assert.ok(
      originFinal === "merged" || originFinal === "closed",
      `origin task must reach merged/closed (got ${originFinal})`
    );

    // Verify event sequence
    const events = await getEvents(base, PROJ);

    const originPausedEv = events.find((e) => e.type === "task_paused" && e.taskId === "task-orig-a");
    assert.ok(originPausedEv, "origin must have task_paused event");

    const originResumedEv = events.find((e) => e.type === "task_resumed" && e.taskId === "task-orig-a");
    assert.ok(originResumedEv, "origin must have task_resumed event after conflict resolved");

    const conflictMergedEv = events.find(
      (e) => (e.type === "task_merged" || (e.type === "state_transitioned" &&
        (e["to"] === "merged" || e["to"] === "closed"))) && e.taskId === conflictTaskId
    );
    assert.ok(conflictMergedEv, "conflict task must have merged/closed event");

    const conflictMergedIdx = events.findIndex((e) => e === conflictMergedEv);
    const originResumedIdx = events.findIndex((e) => e === originResumedEv);
    assert.ok(
      conflictMergedIdx < originResumedIdx,
      `conflict merged (idx=${conflictMergedIdx}) must precede origin resume (idx=${originResumedIdx})`
    );

    // AC-S75f66b-6-3 fix 1: correlation event must record the resolution task ID
    // so the origin↔resolution linkage is explicit in the log (not just implied by ordering).
    const correlationEv = events.find(
      (e) =>
        e.type === "po_operation" &&
        (e as { operation?: string }).operation === "conflict_resolved" &&
        e.taskId === "task-orig-a" &&
        typeof (e as { payload?: { resolutionTaskId?: string } }).payload?.resolutionTaskId === "string"
    );
    assert.ok(
      correlationEv !== undefined,
      "AC-3: po_operation(conflict_resolved) with resolutionTaskId must be emitted after resume"
    );
    const corrPayload = (correlationEv as {
      payload?: { resolutionTaskId?: string; actor?: string };
    }).payload;
    assert.equal(
      corrPayload?.resolutionTaskId,
      conflictTaskId,
      `correlation event must reference the resolution task ID (${conflictTaskId})`
    );

    // inc-0063 の4: この再開は**機構がやった**。PO は何も押していないので、
    // 出所が帳簿から読めること（PO の判断と機構の自動処理を混ぜない）
    assert.equal(
      corrPayload?.actor,
      "system",
      "inc-0063: 機構の自動処理は PO 名義にしない（payload.actor で出所が判る）"
    );

    // D3: no mapping file persisted
    assert.ok(
      !fs.existsSync(path.join(tmpDir, "data", "conflict-origin-mapping.json")),
      "D3: no mapping file should be persisted"
    );
  });
});

// ── Test Case B ───────────────────────────────────────────────────────────────

describe("[AC-S75f66b-6-3-B] resolution task failed → origin chain-fails (I2)", () => {
  let tmpDir: string;
  let repoDir: string;
  let worktreeBaseDir: string;
  let daemon: Daemon;
  let base: string;
  const PROJ = "proj-resume-b";

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "banto-resume-b-"));
    repoDir = path.join(tmpDir, "repo");
    worktreeBaseDir = path.join(tmpDir, "worktrees");
    fs.mkdirSync(repoDir, { recursive: true });
    git(repoDir, "init", "-b", "main");
    git(repoDir, "config", "user.email", "test@banto.local");
    git(repoDir, "config", "user.name", "banto-test");
    fs.writeFileSync(path.join(repoDir, "shared.ts"), "// initial\nexport const VALUE = 0;\n");
    git(repoDir, "add", "-A");
    git(repoDir, "commit", "-m", "initial");

    daemon = Daemon.create({
      port: 0, dataDir: path.join(tmpDir, "data"), worktreeBaseDir,
      tickIntervalMs: 200, watchIntervalMs: 200,
      disableAuditSpawn: true, maxConcurrentSessions: 0,
      // task-0060: 職人を要らないので Worker Pool に頼まない
      disableAutoSpawn: true,
    });
    await daemon.start();
    base = `http://localhost:${daemon.port}`;
  });

  after(async () => {
    // Scheduler.stop() drains any in-flight runAllJobs() before returning.
    // No sleep needed — daemon.stop() awaits the drain before closing the log.
    await daemon.stop();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("[AC-S75f66b-6-3-B] resolution failed → origin chain-fails", async () => {
    const { conflictTaskId } = await setupConflictScenario({
      base, proj: PROJ, repoDir, worktreeBaseDir,
      anchorTaskId: "task-anch-b", originTaskId: "task-orig-b",
    });

    // Wait for watcher to ingest conflict task
    await pollUntil(() => getTask(base, PROJ, conflictTaskId), (t) => t !== null, 10000, 200);

    // Set up conflict task branch
    const conflictWorktreePath = path.join(worktreeBaseDir, PROJ, conflictTaskId);
    if (!fs.existsSync(conflictWorktreePath)) {
      git(repoDir, "worktree", "add", "--detach", conflictWorktreePath);
    }
    try { git(conflictWorktreePath, "checkout", "-B", `task/${conflictTaskId}`); }
    catch { /* already on branch */ }
    fs.writeFileSync(path.join(conflictWorktreePath, "ATTEMPT.txt"), "partial\n");
    git(conflictWorktreePath, "add", "-A");
    git(conflictWorktreePath, "commit", "-m", `wip: ${conflictTaskId}`);

    // Drive to auditing
    for (const step of ["queued", "ready", "planning", "implementing", "auditing"]) {
      await safeTransitionTo(base, PROJ, conflictTaskId, step);
    }
    await pollUntil(() => getStatus(base, PROJ, conflictTaskId), (s) => s === "auditing", 5000, 100);

    // 1st audit fail → task goes to implementing (rework path)
    const fail1R = await fetch(`${base}/api/v1/projects/${PROJ}/tasks/${conflictTaskId}/audit-report`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ verdict: "fail", findings: ["conflict not resolved"] }),
    });
    assert.equal(fail1R.status, 200, "first fail verdict must succeed");

    // After 1st fail → implementing (rework). Note: spawnReworkSession fires via setImmediate
    // but will fail immediately (pi CLI not installed) → recordTaskFailed → "failed".
    // We poll until the task reaches implementing OR failed (rework spawn fails instantly).
    const afterFail1 = await pollUntil(
      () => getStatus(base, PROJ, conflictTaskId),
      (s) => s === "implementing" || s === "failed",
      5000, 100
    );

    if (afterFail1 === "failed") {
      // Rework spawn failed immediately (pi not installed) → task is already failed.
      // This is an acceptable path: the conflict task failed → origin should chain-fail.
    } else {
      // Task is in implementing. Drive back to auditing and send 2nd fail.
      assert.equal(afterFail1, "implementing", `after 1st fail must be implementing or failed (got ${afterFail1})`);
      await safeTransitionTo(base, PROJ, conflictTaskId, "auditing");
      // **やり直しの職人を起こせずに落ちるのは、いつ届くか分からない**（pi が無い環境なので
      // 必ず落ちる）。`implementing` を見た直後に `failed` が届くことがあるので、
      // どちらに着いたかを見てから次を決める——**着いた先を確かめてから**進むので、
      // 本物の壊れ方は見逃さない（task-0083 で HTTP が速くなって顕在化した）
      const beforeFail2 = await pollUntil(
        () => getStatus(base, PROJ, conflictTaskId),
        (st) => st === "auditing" || st === "failed",
        3000, 100
      );

      if (beforeFail2 === "auditing") {
        // 2nd fail → 2 consecutive fails → task fails
        const fail2R = await fetch(`${base}/api/v1/projects/${PROJ}/tasks/${conflictTaskId}/audit-report`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ verdict: "fail", findings: ["still not resolved"] }),
        });
        assert.equal(fail2R.status, 200, "second fail verdict must succeed");
      }
      // beforeFail2 === "failed" なら、やり直しの職人を起こせずに落ちた道。
      // どちらでも「衝突タスクが failed に着く」ことは下で確かめる
    }

    // Wait for conflict task to reach failed
    const conflictFinal = await pollUntil(
      () => getStatus(base, PROJ, conflictTaskId),
      (s) => s === "failed",
      10000, 200
    );
    assert.equal(conflictFinal, "failed", `conflict task must reach failed (got ${conflictFinal})`);

    // Wait for origin to chain-fail
    const originFinal = await pollUntil(
      () => getStatus(base, PROJ, "task-orig-b"),
      (s) => s === "failed" || s === "merged" || s === "closed",
      10000, 200
    );
    assert.equal(
      originFinal, "failed",
      `origin task must chain-fail when resolution fails (got ${originFinal})`
    );

    // Verify event sequence
    const events = await getEvents(base, PROJ);

    const originPausedEv = events.find((e) => e.type === "task_paused" && e.taskId === "task-orig-b");
    assert.ok(originPausedEv, "origin must have task_paused event");

    const originFailedEv = events.find((e) => e.type === "task_failed" && e.taskId === "task-orig-b");
    assert.ok(originFailedEv, "origin must have task_failed event (chain-fail)");

    const conflictFailedIdx = events.findIndex(
      (e) => e.type === "state_transitioned" && e["to"] === "failed" && e.taskId === conflictTaskId
    );
    const originFailedIdx = events.findIndex(
      (e) => e.type === "task_failed" && e.taskId === "task-orig-b"
    );
    assert.ok(conflictFailedIdx >= 0, "conflict task must have →failed state_transitioned event");
    assert.ok(originFailedIdx >= 0, "origin must have task_failed event");
    assert.ok(
      conflictFailedIdx < originFailedIdx,
      `conflict failed (idx=${conflictFailedIdx}) must precede origin chain-fail (idx=${originFailedIdx})`
    );

    // Origin must NOT have been resumed (paused → failed path, not paused → resumed)
    const originResumedEv = events.find((e) => e.type === "task_resumed" && e.taskId === "task-orig-b");
    assert.ok(!originResumedEv, "origin must NOT have task_resumed event when resolution fails");
  });
});

// ── inc-0063: 対応づけの判定そのもの（純関数）────────────────────────────────────
//
// 周回の芯は「片付いた解消タスクが恒久的にペアの片割れになり続けること」だった。
// 判定は純関数に置いてあるので、デーモンを起こさずに直に確かめる。

describe("[inc-0063] deriveOriginResolutionPairs: 消費済みのペアは返さない", () => {
  /** task-0097（paused）↔ task-0099（closed）——本番で 1 分ごとに拾い直されていた組。 */
  const tasks = [
    {
      id: "task-0097",
      status: "paused",
      projectTag: "banto",
      suspendedFrom: "merging",
    },
    {
      id: "task-0099",
      status: "closed",
      projectTag: "banto",
      kind: "conflict",
      refs: ["task-0097"],
    },
  ];

  it("印が無ければペアは返る（初回の再開は打てる）", () => {
    const pairs = deriveOriginResolutionPairs(tasks);
    assert.equal(pairs.length, 1, "消費済みの印が無い間は1組返る");
    assert.equal(pairs[0]!.originTaskId, "task-0097");
    assert.equal(pairs[0]!.resolutionTaskId, "task-0099");
  });

  it("消費済みの印があるペアは返らない（二度目の再開を打たない）", () => {
    const pairs = deriveOriginResolutionPairs(tasks, {
      isConsumed: (p) =>
        p.originTaskId === "task-0097" && p.resolutionTaskId === "task-0099",
    });
    assert.deepEqual(pairs, [], "一度再開した組は二度と返らない（inc-0063 の周回の芯）");
  });

  it("消費済みなのは**その組だけ**——別の解消タスクは残る", () => {
    const withSecond = [
      ...tasks,
      {
        id: "task-0150",
        status: "closed",
        projectTag: "banto",
        kind: "conflict",
        refs: ["task-0097"],
      },
    ];
    const pairs = deriveOriginResolutionPairs(withSecond, {
      isConsumed: (p) => p.resolutionTaskId === "task-0099",
    });
    assert.equal(pairs.length, 1);
    assert.equal(pairs[0]!.resolutionTaskId, "task-0150");
  });
});

describe("[inc-0063] hasOpenResolutionTask: 未決着の解消タスクを数える", () => {
  const origin = {
    id: "task-0097",
    status: "merging",
    projectTag: "banto",
  };

  it("queued の解消タスクがあれば true（二本目を積まない）", () => {
    const tasks = [
      origin,
      { id: "task-0099", status: "queued", projectTag: "banto", kind: "conflict", refs: ["task-0097"] },
    ];
    assert.equal(hasOpenResolutionTask(tasks, "task-0097", "banto"), true);
  });

  it("片付いた解消タスクだけなら false（新しい衝突には新しい一本を積む）", () => {
    for (const status of ["merged", "closed", "failed", "superseded"]) {
      const tasks = [
        origin,
        { id: "task-0099", status, projectTag: "banto", kind: "conflict", refs: ["task-0097"] },
      ];
      assert.equal(
        hasOpenResolutionTask(tasks, "task-0097", "banto"),
        false,
        `${status} は未決着に数えない`
      );
    }
  });

  it("別の origin / 別のプロジェクトの解消タスクは数えない", () => {
    const tasks = [
      origin,
      { id: "task-0099", status: "queued", projectTag: "banto", kind: "conflict", refs: ["task-0090"] },
      { id: "task-0101", status: "queued", projectTag: "other", kind: "conflict", refs: ["task-0097"] },
    ];
    assert.equal(hasOpenResolutionTask(tasks, "task-0097", "banto"), false);
  });
});

// ── Test Case C: inc-0063 の周回そのもの ──────────────────────────────────────
//
// 2026-08-13 に起きた形をそのまま再現する:
//   解消タスクが片付く → origin を再開 → origin はまだ衝突する → また止まる
//   → **片付いた解消タスクをもう一度拾って、また再開する**（1 分周期の無限ループ）
//
// 直っていれば、再開は 1 回きり。origin は paused のまま止まり、ゴミタスクも増えない。

describe("[inc-0063] 片付いた解消タスクで origin を何度も再開しない", () => {
  let tmpDir: string;
  let repoDir: string;
  let worktreeBaseDir: string;
  let daemon: Daemon;
  let base: string;
  const PROJ = "proj-resume-c";
  const ORIGIN = "task-orig-c";

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "banto-resume-c-"));
    repoDir = path.join(tmpDir, "repo");
    worktreeBaseDir = path.join(tmpDir, "worktrees");
    fs.mkdirSync(repoDir, { recursive: true });
    git(repoDir, "init", "-b", "main");
    git(repoDir, "config", "user.email", "test@banto.local");
    git(repoDir, "config", "user.name", "banto-test");
    fs.writeFileSync(path.join(repoDir, "shared.ts"), "// initial\nexport const VALUE = 0;\n");
    git(repoDir, "add", "-A");
    git(repoDir, "commit", "-m", "initial");

    daemon = Daemon.create({
      port: 0, dataDir: path.join(tmpDir, "data"), worktreeBaseDir,
      tickIntervalMs: 200, watchIntervalMs: 200,
      disableAuditSpawn: true, maxConcurrentSessions: 0,
      disableAutoSpawn: true,
    });
    await daemon.start();
    base = `http://localhost:${daemon.port}`;
  });

  after(async () => {
    await daemon.stop();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("[inc-0063] 再開は解消タスク1本につき1回きり", async () => {
    const { conflictTaskId } = await setupConflictScenario({
      base, proj: PROJ, repoDir, worktreeBaseDir,
      anchorTaskId: "task-anch-c", originTaskId: ORIGIN,
    });

    // **origin のブランチは直さない**。本番と同じ形——解消タスクが片付いても
    // origin 自身はまだ main と衝突する（inc-0063 の task-0097 はこの状態だった）
    await pollUntil(() => getTask(base, PROJ, conflictTaskId), (t) => t !== null, 10000, 200);

    const conflictWorktreePath = path.join(worktreeBaseDir, PROJ, conflictTaskId);
    if (!fs.existsSync(conflictWorktreePath)) {
      git(repoDir, "worktree", "add", "--detach", conflictWorktreePath);
    }
    try { git(conflictWorktreePath, "checkout", "-B", `task/${conflictTaskId}`); }
    catch { /* already on branch */ }
    fs.writeFileSync(path.join(conflictWorktreePath, "CONFLICT_RESOLVED.txt"), "resolved\n");
    git(conflictWorktreePath, "add", "-A");
    git(conflictWorktreePath, "commit", "-m", `fix: ${conflictTaskId} — resolve`);

    for (const step of ["queued", "ready", "planning", "implementing", "auditing"]) {
      await safeTransitionTo(base, PROJ, conflictTaskId, step);
    }
    await pollUntil(() => getStatus(base, PROJ, conflictTaskId), (s) => s === "auditing", 5000, 100);
    const auditR = await fetch(`${base}/api/v1/projects/${PROJ}/tasks/${conflictTaskId}/audit-report`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ verdict: "pass", findings: [] }),
    });
    assert.equal(auditR.status, 200, "conflict task audit pass must succeed");

    // realign 第3便: 検査を持たない契約は自動着地しない。人が通す（approveAfterAudit の注記）
    await approveAfterAudit(base, PROJ, conflictTaskId);

    const conflictFinal = await pollUntil(
      () => getStatus(base, PROJ, conflictTaskId),
      (s) => s === "merged" || s === "closed" || s === "failed",
      25000, 200
    );
    assert.ok(
      conflictFinal === "merged" || conflictFinal === "closed",
      `conflict task must reach merged/closed (got ${conflictFinal})`
    );

    // 1 回目の再開が来るまで待つ（これは正しい動き）
    const afterResume = await pollUntil(
      () => getEvents(base, PROJ),
      (evs) => evs.some((e) => e.type === "task_resumed" && e.taskId === ORIGIN),
      25000, 200
    );
    assert.ok(
      afterResume.some((e) => e.type === "task_resumed" && e.taskId === ORIGIN),
      "解消タスクが片付いたら origin は1回は再開される"
    );

    // ここから先は**何も起きない**ことを確かめる。tick は 200ms なので 4 秒で 20 周。
    // 壊れていた頃はこの間に 20 回再開し、20 本のゴミタスクが積まれていた
    await new Promise((r) => setTimeout(r, 4000));

    const events = await getEvents(base, PROJ);
    const resumes = events.filter((e) => e.type === "task_resumed" && e.taskId === ORIGIN);
    assert.equal(
      resumes.length, 1,
      `origin の再開は1回きりであること（${resumes.length} 回起きた＝周回に入っている）`
    );

    const correlations = events.filter(
      (e) =>
        e.type === "po_operation" &&
        (e as { operation?: string }).operation === "conflict_resolved" &&
        e.taskId === ORIGIN
    );
    assert.equal(
      correlations.length, 1,
      `conflict_resolved の記録も1件きりであること（${correlations.length} 件あった）`
    );

    // ゴミタスクの増殖が止まっていること。
    // 1 本目＝最初の衝突、2 本目＝再開後に再び衝突したときの1本。それ以上は増えない
    const conflictFiles = fs
      .readdirSync(path.join(repoDir, "work", "tasks"))
      .filter((f) => f.includes(`conflict-resolution-for-${ORIGIN}`));
    assert.ok(
      conflictFiles.length <= 2,
      `解消タスクが増殖していないこと（${conflictFiles.length} 本: ${conflictFiles.join(", ")}）`
    );

    // 再び衝突した origin は paused で止まったまま（勝手に merging へ戻らない）
    const originStatus = await getStatus(base, PROJ, ORIGIN);
    assert.equal(
      originStatus, "paused",
      `origin は解消待ちで止まっていること（got ${originStatus}）`
    );
  });
});

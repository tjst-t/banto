/**
 * [AC-S75f66b-5-3] Queue content and processing position are pure event-log
 * derivations (D3: no separate persistence); daemon restart resumes processing.
 *
 * story_type=api: exercises the real daemon + real git repo.
 * No mocked internals.
 *
 * Scenario 3 (from scenario-S75f66b-5.json):
 *
 *   Step 1: Inspect <dataDir> for any merge-queue persistence file.
 *     Expected: No queue file — only event log segments/snapshot (D3).
 *
 *   Step 2: Two approved tasks; stop daemon mid-queue, restart it on same dataDir.
 *     Expected: After restart, the remaining task(s) are processed to 'merged'
 *     without re-approval; no task is skipped or double-merged
 *     (main contains each task's commit exactly once).
 *
 * Implementation note:
 *   We use a long verify command on task-A (sleep 0; it still passes but gives
 *   the daemon a moment to transition task-A to merging before we restart).
 *   Actually we use a simpler approach: approve two tasks, let daemon process the
 *   first one to merged, stop daemon, restart, verify the second processes.
 *   This is a clean test of restart resume without timing hacks.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { execFileSync, execSync } from "node:child_process";
import { Daemon } from "@banto/daemon";
import { deriveQueue } from "@banto/daemon";
import { hostVerifyRunner } from "./gate-verify-runner.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

async function pollUntil<T>(
  fn: () => Promise<T>,
  pred: (v: T) => boolean,
  timeoutMs = 12000,
  intervalMs = 150
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last = await fn();
  while (!pred(last) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, intervalMs));
    last = await fn();
  }
  return last;
}

async function getStatus(base: string, proj: string, taskId: string): Promise<string> {
  const r = await fetch(`${base}/api/v1/projects/${proj}/tasks/${taskId}`);
  const body = await r.json() as { task: { status: string } };
  return body.task.status;
}

async function transitionTo(base: string, proj: string, taskId: string, to: string): Promise<void> {
  const r = await fetch(`${base}/api/v1/projects/${proj}/tasks/${taskId}/transition`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ to }),
  });
  if (r.status !== 200) {
    // **工場は自分でも進む。** `queued → ready` はゲートを通った時点で tick が動かすので、
    // 状態を読んでから POST するまでの隙に機構が先に着いていることがある
    // （この spec は tick 200ms。単体で回すと機械が空いていて tick が必ず勝ち、3/3 落ちた）。
    // **判定を増やして避けるのではなく、失敗したあとに読み直して吸収する**——
    // 着きたかった先に既に居るなら成功として扱う。**機構は正しい**。
    // 読み直してなお違う先に居るなら、それは本物の遷移失敗なので見逃さない
    const now = await getStatus(base, proj, taskId);
    if (now === to) return;
    const body = await r.text();
    throw new Error(`Transition ${taskId}→'${to}' failed (${r.status}): ${body}（いまは ${now}）`);
  }
}

async function advanceTo(base: string, proj: string, taskId: string, ...steps: string[]): Promise<void> {
  for (const to of steps) {
    const current = await getStatus(base, proj, taskId);
    if (current === to) continue;
    await transitionTo(base, proj, taskId, to);
  }
}

function setupTaskBranch(opts: {
  repoDir: string;
  worktreeBaseDir: string;
  proj: string;
  taskId: string;
  fileName: string;
  content: string;
}): { taskBranch: string; worktreePath: string } {
  const { repoDir, worktreeBaseDir, proj, taskId, fileName, content } = opts;

  const taskBranch = `task/${taskId}`;
  const worktreePath = path.join(worktreeBaseDir, proj, taskId);
  fs.mkdirSync(path.dirname(worktreePath), { recursive: true });

  // Create a detached worktree at HEAD (main) to avoid "branch already in use" error
  execFileSync("git", ["worktree", "add", "--detach", worktreePath], {
    cwd: repoDir,
    stdio: "pipe",
  });

  const wgit = (...args: string[]) =>
    execFileSync("git", args, { cwd: worktreePath, stdio: "pipe" });

  wgit("checkout", "-b", taskBranch);
  fs.writeFileSync(path.join(worktreePath, fileName), content);
  wgit("add", "-A");
  wgit("commit", "-m", `feat: ${taskId} — ${fileName}`);

  return { taskBranch, worktreePath };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("[AC-S75f66b-5-3] Queue derived from event log; restart resumes processing", () => {
  let tmpDir: string;
  let repoDir: string;
  let worktreeBaseDir: string;
  let dataDir: string;
  let daemon: Daemon;
  let base: string;
  const PROJ = "proj-derive";

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "banto-mq-derive-"));
    repoDir = path.join(tmpDir, "repo");
    worktreeBaseDir = path.join(tmpDir, "worktrees");
    dataDir = path.join(tmpDir, "data");

    fs.mkdirSync(repoDir, { recursive: true });
    execFileSync("git", ["init", "-b", "main"], { cwd: repoDir, stdio: "pipe" });
    execFileSync("git", ["config", "user.email", "test@banto-test.local"], { cwd: repoDir, stdio: "pipe" });
    execFileSync("git", ["config", "user.name", "banto-test"], { cwd: repoDir, stdio: "pipe" });
    fs.writeFileSync(path.join(repoDir, "README.md"), "# test\n");
    execFileSync("git", ["add", "-A"], { cwd: repoDir, stdio: "pipe" });
    execFileSync("git", ["commit", "-m", "initial"], { cwd: repoDir, stdio: "pipe" });

    // disableAuditSpawn: this suite tests queue derivation and restart-resume logic.
    // Tasks are driven through implementing→auditing via HTTP transitions (not pi LLM).
    // audit_spawn_disabled event is emitted for each implementing→auditing transition
    // (F2 governance: suppression is visible in the event log).
    daemon = Daemon.create({
      // task-0075: 検証環境は必須。マージキューの筋道を見るのが本題なので偽物を差す
      verifyRunner: hostVerifyRunner(),
      port: 0,
      dataDir,
      worktreeBaseDir,
      tickIntervalMs: 200,
      disableAuditSpawn: true,
      // task-0060: 職人を要らないので Worker Pool に頼まない
      disableAutoSpawn: true,
    });
    await daemon.start();
    base = `http://localhost:${daemon.port}`;

    const projRes = await fetch(`${base}/api/v1/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: PROJ, repoPath: repoDir }),
    });
    assert.equal(projRes.status, 201, "project must register");

    // Set up task branches (non-conflicting: different files)
    setupTaskBranch({ repoDir, worktreeBaseDir, proj: PROJ, taskId: "task-D1", fileName: "d1.ts", content: "// d1\n" });
    setupTaskBranch({ repoDir, worktreeBaseDir, proj: PROJ, taskId: "task-D2", fileName: "d2.ts", content: "// d2\n" });

    // Create tasks in daemon
    for (const { id, file } of [{ id: "task-D1", file: "d1.ts" }, { id: "task-D2", file: "d2.ts" }]) {
      const r = await fetch(`${base}/api/v1/projects/${PROJ}/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id,
          title: `Task ${id}`,
          scope: { paths: [`${file}`] },
          acceptance: [{ id: "a1", text: "file exists", verify: `test -f ${file}` }],
        }),
      });
      assert.equal(r.status, 201, `task ${id} creation must succeed`);
    }

    // Advance both to in-review, approve both
    for (const taskId of ["task-D1", "task-D2"]) {
      await advanceTo(base, PROJ, taskId, "queued", "ready", "planning", "implementing", "auditing", "review-ready", "in-review");
    }
    await transitionTo(base, PROJ, "task-D1", "approved");
    await transitionTo(base, PROJ, "task-D2", "approved");
  });

  after(async () => {
    try { await daemon.stop(); } catch { /* already stopped */ }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("[AC-S75f66b-5-3a] No merge-queue persistence file in dataDir (D3)", () => {
    // D3: the queue is derived from event log replay only — no separate file
    const dataDirContents = fs.readdirSync(dataDir, { recursive: false }) as string[];
    const queueFile = dataDirContents.find(
      (f) => f.includes("merge-queue") || f.includes("queue.json") || f.includes("mergequeue")
    );
    assert.ok(
      queueFile === undefined,
      `No merge-queue persistence file should exist in dataDir; found: ${queueFile}`
    );
  });

  /**
   * **止まっている帳簿に当てる**（inc-0070）。
   *
   * もとは稼働中のデーモンを 400ms 待ってから覗き、**その瞬間の並び順**を主張していた。
   * `deriveQueue` は純関数なので工場は要らないのに、裏でキューが動いていると順番が
   * 変わって落ちる——realign 第3便で `merging` へ進むタスクが増えたら実際に落ちた。
   *
   * ついでに**主張が空振りしなくなる**：live な帳簿では待ち行列が0本や1本のことがあり、
   * そのとき下の2つのループは何も確かめずに通っていた。作った並びなら必ず両方入る。
   *
   * 主張そのもの（並び順と merging 優先）は変えていない。
   */
  it("[AC-S75f66b-5-3b] deriveQueue correctly derives queue from event log replay", () => {
    /** `state_transitioned` を1行作る（`deriveQueue` が見るのはこの型だけ）。 */
    const st = (taskId: string, from: string, to: string, eventId: number): never =>
      ({
        type: "state_transitioned",
        projectTag: PROJ,
        taskId,
        from,
        to,
        eventId,
        timestamp: new Date(Date.UTC(2026, 7, 14)).toISOString(),
      }) as never;

    // 3本を**わざと入り交じった順**で並べる：
    //   task-Q1  approved(10) → merging(40)   … 承認は先だが merging は後
    //   task-Q2  auditing → merging(20)       … 自動着地の道（承認を経ない）
    //   task-Q3  approved(30) のまま           … まだ merging に入っていない
    const events = [
      st("task-Q1", "in-review", "approved", 10),
      st("task-Q2", "auditing", "merging", 20),
      st("task-Q3", "in-review", "approved", 30),
      st("task-Q1", "approved", "merging", 40),
    ];

    const queue = deriveQueue(events);

    const mergingEntries = queue.filter((e) => e.status === "merging");
    const approvedEntries = queue.filter((e) => e.status === "approved");
    // 空振り防止：両方の組が入っていて初めて、下の3つが意味を持つ
    assert.ok(mergingEntries.length > 1, "merging が2本以上入っていること");
    assert.ok(approvedEntries.length > 0, "approved が入っていること");

    // Verify: merging tasks come before approved tasks
    {
      // Find last merging index (findLastIndex not available in ES2022)
      let lastMergingIdx = -1;
      for (let i = queue.length - 1; i >= 0; i--) {
        if (queue[i]!.status === "merging") {
          lastMergingIdx = i;
          break;
        }
      }
      const firstApprovedIdx = queue.findIndex((e) => e.status === "approved");
      assert.ok(
        lastMergingIdx < firstApprovedIdx,
        "merging entries must precede approved entries in queue"
      );
    }

    /**
     * Verify: 各組の中が mergingEntryEventId 順（covers both policy paths:
     * manual approved→merging and auto-audit auditing→merging, S75f66b-5 reconcile）。
     *
     * **「組をまたいで」ではない**（inc-0070 で判明）。`deriveQueue` は merging と
     * approved を**別々に整列してから連結する**ので、まだ merging に入っていない
     * approved の並び順キー（approved になった eventId）が、先に merging へ入った
     * タスクのキーより小さいことは普通に起きる——上の例では Q1 が 40、Q3 が 30。
     *
     * もとの試験はこれを**全体の整列**として主張していたが、実は待ち行列が1本以下の
     * ときしか通っていなかった（2本以上並んだ瞬間に落ちる＝間欠の正体）。ここでは
     * コードが実際に約束している「組の中の順」と「組の前後」に分けて主張する。
     */
    for (const group of [mergingEntries, approvedEntries]) {
      for (let i = 0; i < group.length - 1; i++) {
        assert.ok(
          group[i]!.mergingEntryEventId <= group[i + 1]!.mergingEntryEventId,
          `queue entries must be ordered by mergingEntryEventId (idx ${i} > ${i + 1})`
        );
      }
    }
  });

  it("[AC-S75f66b-5-3c] restart: remaining task processes without re-approval", async () => {
    // Wait for task-D1 to reach merged/closed (first merge)
    const firstStatus = await pollUntil(
      () => getStatus(base, PROJ, "task-D1"),
      (s) => s === "merged" || s === "closed" || s === "failed",
      12000
    );
    assert.ok(
      firstStatus === "merged" || firstStatus === "closed",
      `task-D1 must reach merged/closed (got ${firstStatus})`
    );

    // Stop daemon (simulate restart mid-queue while task-D2 is still in approved)
    await daemon.stop();

    // Restart on same dataDir (critical for D3 restart resume test)
    // disableAuditSpawn must be true on restart as well — tasks in approved/merging
    // state may be re-processed but should not trigger audit spawns on restart.
    daemon = Daemon.create({
      // task-0075: 検証環境は必須。マージキューの筋道を見るのが本題なので偽物を差す
      verifyRunner: hostVerifyRunner(),
      port: 0,
      dataDir,
      worktreeBaseDir,
      tickIntervalMs: 200,
      disableAuditSpawn: true,
      // task-0060: 職人を要らないので Worker Pool に頼まない
      disableAutoSpawn: true,
    });
    await daemon.start();
    base = `http://localhost:${daemon.port}`;

    // Re-register project (registry is persistent via JSON file, but in case it's needed)
    // The event log has the task_created events so state is preserved.
    // However ProjectRegistry might need re-registration if it's not persistent.
    // Check if project is still registered:
    const projsRes = await fetch(`${base}/api/v1/projects`);
    const projs = await projsRes.json() as { projects: Array<{ id: string }> };
    if (!projs.projects.find((p) => p.id === PROJ)) {
      // Re-register (registry is persistent but may be in a fresh data dir)
      const projRes = await fetch(`${base}/api/v1/projects`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: PROJ, repoPath: repoDir }),
      });
      // 201 or 409 (already exists) both OK
      assert.ok([201, 409].includes(projRes.status), `re-registration status: ${projRes.status}`);
    }

    // After restart, task-D2 should process without re-approval.
    // Check current D2 status — the first daemon might have already merged it (fast CI).
    const d2StatusBeforeRestart = await getStatus(base, PROJ, "task-D2");
    const d2AlreadyDone = d2StatusBeforeRestart === "merged" || d2StatusBeforeRestart === "closed";

    if (!d2AlreadyDone) {
      // D2 still in approved/merging — the restarted daemon should pick it up from
      // the event log without re-approval (D3 restart resume).
      // Worktree should still exist if the branch hasn't been processed yet.
      const d2WorktreeExists = fs.existsSync(path.join(worktreeBaseDir, PROJ, "task-D2"));
      if (!d2WorktreeExists) {
        // Edge case: worktree was removed mid-way but branch commit may exist.
        // Recreate only if branch doesn't exist yet (i.e., cleanup ran but branch is gone).
        let branchExists = false;
        try {
          execFileSync("git", ["rev-parse", "--verify", "task/task-D2"], {
            cwd: repoDir,
            stdio: "pipe",
          });
          branchExists = true;
        } catch { branchExists = false; }
        if (!branchExists) {
          // Branch was cleaned up; recreate worktree+branch from scratch on a fresh commit
          setupTaskBranch({ repoDir, worktreeBaseDir, proj: PROJ, taskId: "task-D2", fileName: "d2-retry.ts", content: "// d2 retry\n" });
        }
        // If branch exists but worktree doesn't, re-add worktree pointing at existing branch
        else {
          fs.mkdirSync(path.dirname(path.join(worktreeBaseDir, PROJ, "task-D2")), { recursive: true });
          execFileSync("git", ["worktree", "add", "--detach", path.join(worktreeBaseDir, PROJ, "task-D2"), "task/task-D2"], {
            cwd: repoDir,
            stdio: "pipe",
          });
        }
      }
    }

    // Wait for task-D2 to reach merged/closed after restart
    const d2FinalStatus = await pollUntil(
      () => getStatus(base, PROJ, "task-D2"),
      (s) => s === "merged" || s === "closed" || s === "failed",
      15000
    );
    assert.ok(
      d2FinalStatus === "merged" || d2FinalStatus === "closed",
      `task-D2 must reach merged/closed after restart (got ${d2FinalStatus})`
    );

    // Verify no double-merge: git log main should contain task-D2's commit exactly once.
    //
    // **Match subjects only, not `--oneline`.** The old check also accepted `l.includes("d2")`
    // against `--oneline` output, which includes the abbreviated hash — so any unrelated
    // commit whose hash happened to contain "d2" was counted as a second merge.
    // It fired for real (2026-08-05): `39c6d28 feat: task-D1 — d1.ts` matched on its hash
    // and failed the run. The flake is in the check, not in the merge queue.
    const subjects = execSync("git log main --format=%s", { cwd: repoDir }).toString();
    // The commit message from setupTaskBranch is "feat: task-D2 — d2.ts"
    const d2Lines = subjects.split("\n").filter((l) => l.includes("task-D2"));
    // There should be exactly one such commit
    assert.equal(
      d2Lines.length,
      1,
      `task-D2 commit must appear exactly once in git log main; found ${d2Lines.length} lines: ${d2Lines.join(", ")}`
    );
  });
});

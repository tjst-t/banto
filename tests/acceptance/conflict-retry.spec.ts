/**
 * 第4便：**コンフリクトは「同じ契約の次の試行」**（PO 採用 2026-08-14）。
 *
 * 以前は rebase が衝突すると機構が `kind: conflict` の新しいタスクを起票し、origin を
 * paused にしていた。やめた——**機構は契約を作らない**。同じタスクを implementing へ
 * 戻し、衝突の中身を指摘として渡して解かせる。2回目の衝突で failed。
 *
 * ここで確かめるのは4つ:
 *   1. 衝突した origin は `implementing` へ戻る（paused ではない）
 *   2. **新しいタスクは1本も生まれない**（記録ファイルも増えない）
 *   3. 直列キューは詰まらない（後続の task-C は通る）
 *   4. 2回目の衝突で `failed`（同じところを何度も叩かない・P6）
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { execFileSync } from "node:child_process";
import { Daemon } from "@banto/daemon";
import { validateTaskFrontmatter } from "@banto/core";

// ── Helpers ───────────────────────────────────────────────────────────────────

async function pollUntil<T>(
  fn: () => Promise<T>,
  pred: (v: T) => boolean,
  timeoutMs = 15000,
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

async function getTask(
  base: string,
  proj: string,
  taskId: string
): Promise<{ status: string; suspendedFrom?: string; [k: string]: unknown }> {
  const r = await fetch(`${base}/api/v1/projects/${proj}/tasks/${taskId}`);
  const body = (await r.json()) as {
    task: { status: string; [k: string]: unknown };
  };
  return body.task as { status: string; suspendedFrom?: string; [k: string]: unknown };
}

async function getStatus(
  base: string,
  proj: string,
  taskId: string
): Promise<string> {
  return (await getTask(base, proj, taskId)).status;
}

async function transitionTo(
  base: string,
  proj: string,
  taskId: string,
  to: string
): Promise<void> {
  const r = await fetch(
    `${base}/api/v1/projects/${proj}/tasks/${taskId}/transition`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ to }),
    }
  );
  if (r.status !== 200) {
    // **工場は自分でも進む。** `queued → ready` はゲートを通った時点で tick が動かすので、
    // 状態を読んでから POST するまでの隙に機構が先に着いていることがある
    // （task-0083 で番頭ホストの HTTP が速くなったら顕在化した。**機構は正しい**）。
    // 着きたかった先に既に居るなら、それは成功として扱う——**着いたことを確かめてから**
    // 通すので、本物の遷移失敗は見逃さない
    const now = await getStatus(base, proj, taskId);
    if (now === to) return;
    const body = await r.text();
    throw new Error(
      `Transition ${taskId}→'${to}' failed (${r.status}): ${body}`
    );
  }
}

async function advanceTo(
  base: string,
  proj: string,
  taskId: string,
  ...steps: string[]
): Promise<void> {
  for (const to of steps) {
    const current = await getStatus(base, proj, taskId);
    if (current === to) continue;
    await transitionTo(base, proj, taskId, to);
  }
}

/**
 * Set up a git worktree for a task, committing a file with specific content.
 */
function setupTaskBranch(opts: {
  repoDir: string;
  worktreeBaseDir: string;
  proj: string;
  taskId: string;
  fileName: string;
  content: string;
}): void {
  const { repoDir, worktreeBaseDir, proj, taskId, fileName, content } = opts;
  const taskBranch = `task/${taskId}`;
  const worktreePath = path.join(worktreeBaseDir, proj, taskId);
  fs.mkdirSync(path.dirname(worktreePath), { recursive: true });

  execFileSync("git", ["worktree", "add", "--detach", worktreePath], {
    cwd: repoDir,
    stdio: "pipe",
  });

  const wgit = (...args: string[]) =>
    execFileSync("git", args, { cwd: worktreePath, stdio: "pipe" });

  wgit("checkout", "-b", taskBranch);
  fs.writeFileSync(path.join(worktreePath, fileName), content);
  wgit("add", "-A");
  wgit("commit", "-m", `feat: ${taskId} — update ${fileName}`);
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("[第4便] rebase の衝突は同じタスクの次の試行になる", () => {
  let tmpDir: string;
  let repoDir: string;
  let worktreeBaseDir: string;
  let daemon: Daemon;
  let base: string;
  const PROJ = "proj-conflict-retry";

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "banto-conflict-retry-"));
    repoDir = path.join(tmpDir, "repo");
    worktreeBaseDir = path.join(tmpDir, "worktrees");

    fs.mkdirSync(repoDir, { recursive: true });
    execFileSync("git", ["init", "-b", "main"], { cwd: repoDir, stdio: "pipe" });
    execFileSync("git", ["config", "user.email", "test@banto-conflict-test.local"], {
      cwd: repoDir,
      stdio: "pipe",
    });
    execFileSync("git", ["config", "user.name", "banto-conflict-test"], {
      cwd: repoDir,
      stdio: "pipe",
    });

    fs.writeFileSync(
      path.join(repoDir, "shared.ts"),
      "// shared.ts\nexport const VERSION = 0;\n"
    );
    execFileSync("git", ["add", "-A"], { cwd: repoDir, stdio: "pipe" });
    execFileSync("git", ["commit", "-m", "initial"], { cwd: repoDir, stdio: "pipe" });

    daemon = Daemon.create({
      port: 0,
      dataDir: path.join(tmpDir, "data"),
      worktreeBaseDir,
      tickIntervalMs: 200,
      disableAuditSpawn: true,
      // 職人は要らない（衝突の戻しは状態遷移で確かめる）
      disableAutoSpawn: true,
    });
    await daemon.start();
    base = `http://localhost:${daemon.port}`;

    const projRes = await fetch(`${base}/api/v1/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: PROJ, repoPath: repoDir }),
    });
    assert.equal(projRes.status, 201, "project registration must succeed");
  });

  after(async () => {
    await daemon.stop();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("衝突した origin は implementing へ戻り、新しいタスクは生まれない。後続は通る", async () => {
    setupTaskBranch({
      repoDir,
      worktreeBaseDir,
      proj: PROJ,
      taskId: "task-A",
      fileName: "shared.ts",
      content: "// shared.ts\nexport const VERSION = 1; // task-A\n",
    });
    setupTaskBranch({
      repoDir,
      worktreeBaseDir,
      proj: PROJ,
      taskId: "task-B",
      fileName: "shared.ts",
      content: "// shared.ts\nexport const VERSION = 2; // task-B\n",
    });
    setupTaskBranch({
      repoDir,
      worktreeBaseDir,
      proj: PROJ,
      taskId: "task-C",
      fileName: "unrelated.ts",
      content: "// unrelated\n",
    });

    for (const { id, file } of [
      { id: "task-A", file: "shared.ts" },
      { id: "task-B", file: "shared.ts" },
      { id: "task-C", file: "unrelated.ts" },
    ]) {
      const r = await fetch(`${base}/api/v1/projects/${PROJ}/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id,
          title: `Task ${id}`,
          scope: { paths: [file] },
          acceptance: [{ id: "a1", text: "file exists" }],
        }),
      });
      assert.equal(r.status, 201, `task ${id} creation must succeed`);
    }

    for (const taskId of ["task-A", "task-B", "task-C"]) {
      await advanceTo(
        base,
        PROJ,
        taskId,
        "queued",
        "ready",
        "planning",
        "implementing",
        "auditing",
        "review-ready",
        "in-review"
      );
    }

    await transitionTo(base, PROJ, "task-A", "approved");
    await transitionTo(base, PROJ, "task-B", "approved");
    await transitionTo(base, PROJ, "task-C", "approved");

    const finalA = await pollUntil(
      () => getStatus(base, PROJ, "task-A"),
      (s) => s === "merged" || s === "closed" || s === "failed",
      15000
    );
    assert.ok(finalA === "merged" || finalA === "closed", `task-A must merge (got ${finalA})`);

    // ── 1. task-B は implementing へ戻る（paused ではない）────────────────────
    const afterConflict = await pollUntil(
      () => getStatus(base, PROJ, "task-B"),
      (s) => s === "implementing" || s === "paused" || s === "failed",
      15000
    );
    assert.equal(
      afterConflict,
      "implementing",
      `衝突した task-B は implementing へ戻ること（got ${afterConflict}）`
    );

    // 戻した理由が帳簿に残っていること（**新しいイベント型は足していない**）
    const eventsRes = await fetch(`${base}/api/v1/projects/${PROJ}/tasks/task-B/events`);
    const events = ((await eventsRes.json()) as { events: Array<Record<string, unknown>> }).events;
    const retry = events.find(
      (e) =>
        e["type"] === "state_transitioned" &&
        e["to"] === "implementing" &&
        String(e["reason"] ?? "").startsWith("rebase_conflict")
    );
    assert.ok(retry, "state_transitioned(→implementing, reason: rebase_conflict…) が残ること");
    assert.match(String(retry?.["reason"]), /shared\.ts/, "どのファイルが衝突したかが読めること");

    // ── 2. 新しいタスクは生まれない（機構は契約を作らない）────────────────────
    const listRes = await fetch(`${base}/api/v1/projects/${PROJ}/tasks`);
    const tasks = ((await listRes.json()) as { tasks: Array<{ id: string }> }).tasks;
    assert.deepEqual(
      tasks.map((t) => t.id).sort(),
      ["task-A", "task-B", "task-C"],
      "解消タスクが起票されていないこと"
    );
    const tasksDir = path.join(repoDir, "work", "tasks");
    const written = fs.existsSync(tasksDir) ? fs.readdirSync(tasksDir) : [];
    assert.deepEqual(written, [], "記録ファイルも増えていないこと（機構は書かない）");

    // ── 3. 直列キューは詰まらない ───────────────────────────────────────────
    const finalC = await pollUntil(
      () => getStatus(base, PROJ, "task-C"),
      (s) => s === "merged" || s === "closed" || s === "failed",
      15000
    );
    assert.ok(
      finalC === "merged" || finalC === "closed",
      `task-C must merge/close（task-B の衝突でキューが詰まらないこと; got ${finalC}）`
    );

    // ── 4. 2回目の衝突で failed（同じところを何度も叩かない・P6）─────────────
    // 職人が直さないまま merging へ戻すと、同じ衝突がもう一度起きる
    await advanceTo(base, PROJ, "task-B", "auditing", "review-ready", "in-review", "approved");
    const twice = await pollUntil(
      () => getStatus(base, PROJ, "task-B"),
      (s) => s === "failed" || s === "merged" || s === "closed",
      20000
    );
    assert.equal(twice, "failed", `2回目の衝突は failed で止まること（got ${twice}）`);

    const gitLog = execFileSync("git", ["log", "main", "--oneline"], { cwd: repoDir })
      .toString()
      .trim();
    assert.ok(!gitLog.includes("task-B"), `task-B は main に入っていないこと (got: ${gitLog})`);
  });
});

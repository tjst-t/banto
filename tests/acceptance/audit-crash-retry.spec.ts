/**
 * task-0070: 監査人が**判定を出さずに落ちた**ら、Kobo が起こし直す（PO報告 2026-08-07）。
 *
 * ## 何が起きていたか（実機・loamium/task-0001）
 *
 * ```
 * 03:01:57 audit_started / agent_spawned
 * 03:19:47 agent_exited
 * 03:19:47 state_transitioned — auditing → failed
 * 03:19:47 task_failed — audit_session_exited_without_verdict
 * ```
 *
 * **1回落ちただけで failed。** しかも監査が `fail` の判定を*出した*ときは1回やり直させる
 * （`countConsecutiveAuditFails`）——粘る回数が**逆**になっていた。判定を出さずに落ちるのは
 * 「判断」ではなく「事故」なので、もう一度起こせば通ることが多い。
 *
 * さらに、この `task_failed` は**番頭にも届いていなかった**（→ `kobo-notice-orphan.spec.ts`）。
 * 落ちて、握り潰されて、誰も知らない、が揃っていた。
 *
 * I2: 止まったことを黙らせない。ただし「1回で諦めた」と「粘って駄目だった」は別の話なので、
 *     何回試したのかを理由に残す。
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as childProcess from "node:child_process";

import { Daemon } from "../../packages/banto-daemon/src/daemon.js";
import { FakeRuntimeDriver, startWorkerPool, type WorkerPoolHarness } from "./worker-pool-harness.js";

function git(args: string[], cwd: string): void {
  const r = childProcess.spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
}

function initRepo(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  git(["init", "-b", "main"], dir);
  git(["config", "user.email", "test@example.com"], dir);
  git(["config", "user.name", "Test"], dir);
  fs.writeFileSync(path.join(dir, "README.md"), "test\n");
  git(["add", "."], dir);
  git(["commit", "-m", "init"], dir);
}

async function until(check: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("待っていた状態にならなかった");
}

let tmpDir: string;
let daemon: Daemon;
let workers: WorkerPoolHarness;
let driver: FakeRuntimeDriver;
const proj = "audit-retry-proj";

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "audit-retry-"));
  const repoDir = path.join(tmpDir, "repo");
  initRepo(repoDir);

  driver = new FakeRuntimeDriver();
  workers = await startWorkerPool(driver);

  daemon = Daemon.create({
    port: 0,
    dataDir: path.join(tmpDir, "data"),
    watchIntervalMs: 99999,
    // 職人のイベントは tick で引き取る（決定29c）
    tickIntervalMs: 200,
    worktreeBaseDir: path.join(tmpDir, "worktrees"),
    workerPoolUrl: workers.url,
    disableAutoSpawn: true,
  });
  await daemon.start();
  daemon.registerProject(proj, repoDir);
});

after(async () => {
  await daemon.stop();
  await workers.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** auditing まで進めたタスクを1つ用意する（監査人が起きる）。 */
async function taskInAuditing(taskId: string): Promise<void> {
  daemon.createTask(proj, taskId, `作業 ${taskId}`, {
    kind: "feature",
    scope: { paths: [`src/${taskId}/**`] },
    acceptance: [{ id: "a1", text: "動くこと", verify: "npm test" }],
  });
  daemon.transition(proj, taskId, "queued", "test");
  daemon.transition(proj, taskId, "ready", "test");
  await daemon.spawnTask(proj, taskId);
  daemon.transition(proj, taskId, "implementing", "test");
  daemon.transition(proj, taskId, "auditing", "test");
  // 監査人が起きるのは次の tick（fire-and-forget）
  await until(() => auditStartedCount(taskId) >= 1);
}

function auditStartedCount(taskId: string): number {
  return daemon.getTaskEvents(proj, taskId).filter((e) => e.type === "audit_started").length;
}

/** いま生きている監査人の sessionId（帳簿の最後の agent_spawned）。 */
function latestAuditSession(taskId: string): string {
  const spawned = daemon
    .getTaskEvents(proj, taskId)
    .filter((e) => e.type === "agent_spawned") as Array<{ sessionId?: string }>;
  const last = spawned[spawned.length - 1]?.sessionId;
  assert.ok(last, "監査人が起きていない");
  return last!;
}

describe("[task-0070] 監査人が判定を出さずに落ちたら、もう一度起こす", () => {
  it("1回落ちても failed にしない——起こし直す", async () => {
    const taskId = "task-crash-1";
    await taskInAuditing(taskId);
    assert.equal(auditStartedCount(taskId), 1);

    // 監査人が判定を出さずに落ちる（外から SIGKILL された等）
    driver.exit(latestAuditSession(taskId), null, "SIGKILL");

    // **2人目が起きる**（1人目の事故で諦めない）
    await until(() => auditStartedCount(taskId) === 2);
    assert.equal(
      daemon.getTask(proj, taskId)?.status,
      "auditing",
      "起こし直している間は auditing のまま（勝手に failed にしない）"
    );
  });

  it("上限まで落ちたら failed にし、何回試したかを理由に残す（I2）", async () => {
    const taskId = "task-crash-2";
    await taskInAuditing(taskId);

    // 1人目が落ちる → 2人目が起きる
    driver.exit(latestAuditSession(taskId), null, "SIGKILL");
    await until(() => auditStartedCount(taskId) === 2);

    // 2人目も落ちる → ここで諦める
    driver.exit(latestAuditSession(taskId), null, "SIGKILL");
    await until(() => daemon.getTask(proj, taskId)?.status === "failed");

    const failed = daemon
      .getTaskEvents(proj, taskId)
      .find((e) => e.type === "task_failed") as { reason?: string } | undefined;
    assert.match(failed?.reason ?? "", /audit_session_exited_without_verdict/);
    assert.match(
      failed?.reason ?? "",
      /2回試行/,
      "「1回で諦めた」と「粘って駄目だった」は別の話。回数が残らないと区別できない"
    );
    // 際限なく起こし続けない
    assert.equal(auditStartedCount(taskId), 2, "上限を超えて起こしている");
  });

  it("やり直し後の再監査では、試行回数が数え直される", async () => {
    const taskId = "task-crash-3";
    await taskInAuditing(taskId);

    // 1回目の auditing で1人落とす（残り1回）
    driver.exit(latestAuditSession(taskId), null, "SIGKILL");
    await until(() => auditStartedCount(taskId) === 2);

    // 監査が fail の判定を出して、やり直しへ（auditing → implementing → auditing）
    daemon.transition(proj, taskId, "implementing", "rework");
    daemon.transition(proj, taskId, "auditing", "rework done");
    await until(() => auditStartedCount(taskId) === 3);

    // **この回はまだ1人目**。前の回の事故を持ち越すと、ここで即 failed になってしまう
    driver.exit(latestAuditSession(taskId), null, "SIGKILL");
    await until(() => auditStartedCount(taskId) === 4);
    assert.equal(
      daemon.getTask(proj, taskId)?.status,
      "auditing",
      "前の回の試行回数を持ち越している（別の回の事故で諦めてはいけない）"
    );
  });

  /**
   * 起こし直すと、工房が同じ taskId の前の1人を畳む。その終了も Kobo へ届くので、
   * **1回の事故で2人起こしてしまう**（最初そう書いて、帳簿を見て気づいた）。
   * 数えるのは「いま動いている監査人」の分だけ。
   */
  it("置き換えられた古い監査人の終了で、余分に起こさない", async () => {
    const taskId = "task-crash-4";
    await taskInAuditing(taskId);

    driver.exit(latestAuditSession(taskId), null, "SIGKILL");
    await until(() => auditStartedCount(taskId) === 2);

    // 落ち着くのを待ってから数える（余分な起こし直しがあれば 3 以上になる）
    await new Promise((r) => setTimeout(r, 800));
    assert.equal(
      auditStartedCount(taskId),
      2,
      "1回の事故に対して監査人が2人起きている（古い1人の終了まで数えている）"
    );
  });
});

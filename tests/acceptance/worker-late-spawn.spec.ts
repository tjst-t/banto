/**
 * task-0072: **遅れて生まれた職人を取りこぼさない。**
 *
 * ## 何が起きていたか
 *
 * 職人を起こすのは非同期で、`closeWorkerFor` と `worker.delegate_toolkit` の HTTP 往復を
 * 挟む。その間にタスクが先へ進む（あるいは失敗して終端に着く）ことがあり、そうなると
 * **出来上がった職人を誰も畳まない**——終端に着いたときの後始末は「いま居る職人」を
 * 畳むので、まだ生まれていなかった職人は取りこぼす。
 *
 * 実際に起きていた形：2回目の監査不通過でタスクが `failed` になったあと、1回目の不通過で
 * 頼んでいた rework の職人が**遅れて生まれ**、工房の安全弁（既定15分）まで走り続ける。
 *
 * ## なぜ気づきにくかったか
 *
 * 混んでいるときだけ出る。`audit-fail-rework.spec.ts` が全体テストで**まれに落ちる**という
 * 形で見えていたが、単体では通るので「テストが遅いだけ」と読まれていた。
 * **落ちていたのは機構の方**だった。
 *
 * ここでは時間ではなく**仕掛け**で再現する（`FakeRuntimeDriver.spawnDelayMs`）。
 *
 * I3: 放っておくと外で走り続ける。気づけない壊れ方なので機構で塞ぐ。
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
const proj = "late-spawn-proj";

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "late-spawn-"));
  const repoDir = path.join(tmpDir, "repo");
  initRepo(repoDir);

  driver = new FakeRuntimeDriver();
  workers = await startWorkerPool(driver);

  daemon = Daemon.create({
    port: 0,
    dataDir: path.join(tmpDir, "data"),
    watchIntervalMs: 99999,
    tickIntervalMs: 200,
    worktreeBaseDir: path.join(tmpDir, "worktrees"),
    workerPoolUrl: workers.url,
    disableAutoSpawn: true,
  });
  await daemon.start();
  daemon.registerProject(proj, repoDir);
});

after(async () => {
  driver.spawnDelayMs = 0;
  await daemon.stop();
  await workers.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** その役目で生きている職人。 */
function liveWorkers(taskId: string, role: string): unknown[] {
  return workers.pool
    .list({ includeClosed: false })
    .filter((w) => w.taskId === `${taskId}:${role}` && w.state !== "closed");
}

describe("[task-0072] 起こしている間にタスクが先へ進んだら、生まれた職人を畳む", () => {
  it("failed に着いたあとに生まれた rework の職人が、走り続けない（I3）", async () => {
    const taskId = "task-late-rework";
    daemon.createTask(proj, taskId, "遅れて生まれる検体", {
      kind: "feature",
      scope: { paths: ["src/**"] },
      acceptance: [{ id: "a1", text: "動くこと" }],
    });
    daemon.transition(proj, taskId, "queued", "test");
    daemon.transition(proj, taskId, "ready", "test");
    await daemon.spawnTask(proj, taskId);
    daemon.transition(proj, taskId, "implementing", "test");
    daemon.transition(proj, taskId, "auditing", "test");

    // **ここから職人は遅れて生まれる**（混んでいる機械の再現）
    driver.spawnDelayMs = 1500;

    // 1回目の監査不通過 → rework を頼む（遅れて生まれる）
    daemon.handleAuditVerdict(proj, taskId, "fail", ["直してください"]);
    assert.equal(daemon.getTask(proj, taskId)?.status, "implementing");

    // 生まれる前にタスクが終端へ着く（2回目の不通過に相当）
    daemon.transition(proj, taskId, "failed", "test: 先に終端へ着く");
    assert.equal(daemon.getTask(proj, taskId)?.status, "failed");

    // 遅れて生まれてくるのを待つ
    await new Promise((r) => setTimeout(r, 2500));
    driver.spawnDelayMs = 0;

    // **生まれた職人は畳まれていること。** 畳まれないと工房の安全弁（既定15分）まで走る
    await until(() => liveWorkers(taskId, "rework").length === 0, 8000);

    // 帳簿にも「使っている職人」として載らない（誰も使っていない）
    const spawned = daemon
      .getTaskEvents(proj, taskId)
      .filter((e) => e.type === "agent_spawned") as Array<{ sessionId?: string }>;
    assert.equal(
      spawned.length,
      1,
      "使わずに畳んだ職人を帳簿へ載せている（実装者の1人だけのはず）"
    );
  });

  it("auditing を抜けたあとに生まれた監査人も畳む。**やり直しの回数を食わない**", async () => {
    const taskId = "task-late-audit";
    daemon.createTask(proj, taskId, "遅れて生まれる監査人", {
      kind: "feature",
      scope: { paths: ["src/**"] },
      acceptance: [{ id: "a1", text: "動くこと" }],
    });
    daemon.transition(proj, taskId, "queued", "test");
    daemon.transition(proj, taskId, "ready", "test");
    await daemon.spawnTask(proj, taskId);
    daemon.transition(proj, taskId, "implementing", "test");

    driver.spawnDelayMs = 1500;
    // auditing へ入ると監査人を頼む（遅れて生まれる）
    daemon.transition(proj, taskId, "auditing", "test");
    // 生まれる前に終端へ
    daemon.transition(proj, taskId, "failed", "test: 先に終端へ着く");

    await new Promise((r) => setTimeout(r, 2500));
    driver.spawnDelayMs = 0;

    await until(() => liveWorkers(taskId, "audit").length === 0, 8000);
    // **audit_started を積まない**。積むと、誰も使っていない職人の分だけ
    // やり直しの回数（countAuditAttempts）が減る
    assert.equal(
      daemon.getTaskEvents(proj, taskId).filter((e) => e.type === "audit_started").length,
      0,
      "使わずに畳んだ監査人を試行回数に数えている"
    );
  });

  it("先へ進んでいなければ、いままでどおり職人は残る（畳みすぎない）", async () => {
    const taskId = "task-normal";
    daemon.createTask(proj, taskId, "普通に進む検体", {
      kind: "feature",
      scope: { paths: ["src/**"] },
      acceptance: [{ id: "a1", text: "動くこと" }],
    });
    daemon.transition(proj, taskId, "queued", "test");
    daemon.transition(proj, taskId, "ready", "test");
    await daemon.spawnTask(proj, taskId);
    daemon.transition(proj, taskId, "implementing", "test");
    daemon.transition(proj, taskId, "auditing", "test");

    // 監査人が起き、auditing のままなので残る
    await until(() =>
      daemon.getTaskEvents(proj, taskId).some((e) => e.type === "audit_started")
    );
    assert.equal(liveWorkers(taskId, "audit").length, 1, "普通の経路で監査人が畳まれている");
  });
});

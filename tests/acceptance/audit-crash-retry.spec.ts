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

/**
 * task-0296: Scheduler の周期 tick を、実時間の setInterval 任せにせず試験が
 * 任意のタイミングで起こせるようにする（task-0291「壁時計依存を断つ」と同じ筋）。
 *
 * ## 何が起きていたか
 * 直していた `until()` は「本物の200ms周期 tick が、10秒の壁時計予算の中で
 * 実際に発火するか」に賭けていた。試験側の50msポーリングと Scheduler 側の
 * 200ms周期という、**独立した2つの実時間タイマー**が両方ともイベントループの
 * 混雑で遅延し得る状態で、片方の予算にもう片方の発火が間に合うことを祈って
 * いた——一式2839本と職人が同時に走る負荷下では収まらない。数字を上げても
 * 負荷が上がればまた破れる（task-0267, task-0269 と同じ轍）。
 *
 * ## 採った筋
 * `Daemon.start()` が `Scheduler.start()` を呼ぶ、その一瞬だけ global.setInterval
 * を横取りし、Scheduler が登録した周期コールバックそのものを掴んで、実インター
 * バルは一度も発火させない（ダミーの Timeout を返すだけ）。以後、周期 tick は
 * 試験が `fireSchedulerTick()` を呼んだ瞬間にだけ起こる——「本物の非同期処理が
 * N 秒以内に終わるか」を実時間で測るのをやめ、「起こしたい瞬間に試験自身が
 * 起こす」形にした。窓は `daemon.start()` の呼び出しだけに絞ってあるので、
 * Worker Pool など他の setInterval 利用者には触れない。
 *
 * tick を起こした後に残る「本物の非同期処理（HTTP・プロセス起動）が片づくのを
 * 待つ」部分だけは、なお実時間の短いポーリングが要る。ここは壁時計の**予算**
 * ではなくポーリング**回数**で打ち切るようにした——1回あたりの実時間が負荷で
 * 伸びても、打ち切りの根拠が経過時間ではなく試行回数なので、負荷そのもので
 * 失敗しない（回数が尽きるのは本物のハングだけ）。
 */
let schedulerTick: (() => void) | undefined;

/** `daemon.start()` の間だけ Scheduler の setInterval コールバックを奪う。 */
async function startDaemonCapturingSchedulerTick(d: Daemon): Promise<void> {
  const realSetInterval = global.setInterval;
  global.setInterval = ((fn: (...args: unknown[]) => void, _ms?: number) => {
    schedulerTick = fn as () => void;
    return { unref() {}, ref() {} } as unknown as NodeJS.Timeout;
  }) as unknown as typeof setInterval;
  try {
    await d.start();
  } finally {
    global.setInterval = realSetInterval;
  }
}

/** 周期 tick を、実インターバルの発火を待たずにいま起こす。 */
function fireSchedulerTick(): void {
  schedulerTick?.();
}

async function until(check: () => boolean, maxAttempts = 400): Promise<void> {
  for (let i = 0; i < maxAttempts; i++) {
    if (check()) return;
    fireSchedulerTick();
    // tick で起こした本物の非同期処理（HTTP・プロセス起動）が片づくのを、
    // ごく短い実時間だけ待って次の周に回す。打ち切りは回数（maxAttempts）で
    // 行うので、この一回一回が負荷で伸びても失敗の理由にはならない。
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`待っていた状態にならなかった（${maxAttempts}回 tick を強制しても進まなかった）`);
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
    // 職人のイベントは tick で引き取る（決定29c）。実インターバルは
    // startDaemonCapturingSchedulerTick が奪うので、この数値そのものは
    // 使われない（試験は fireSchedulerTick() で明示的に起こす）
    tickIntervalMs: 200,
    worktreeBaseDir: path.join(tmpDir, "worktrees"),
    workerPoolUrl: workers.url,
    disableAutoSpawn: true,
  });
  await startDaemonCapturingSchedulerTick(daemon);
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

  /**
   * task-0287・ADR-0027: **上限まで落ちても failed にしない（フェイルオープン）。**
   * 監査は補助の目にした——判定を出さずに落ちるのを尽くしてもタスクを止めない方が、
   * 忘れ・事故による工程停止を根絶する PO の狙いに合う（承知の上のリスク、
   * PO 裁定 2026-08-20）。見張りは `audit_verdict.byDefault` の印（a4）。
   */
  it("上限まで落ちても failed にせず既定で通し、何回試したかを理由に残す（I2）", async () => {
    const taskId = "task-crash-2";
    await taskInAuditing(taskId);

    // 1人目が落ちる → 2人目が起きる
    driver.exit(latestAuditSession(taskId), null, "SIGKILL");
    await until(() => auditStartedCount(taskId) === 2);

    // 2人目も落ちる → ここで諦めるが、failed にはしない
    driver.exit(latestAuditSession(taskId), null, "SIGKILL");
    await until(() => daemon.getTask(proj, taskId)?.status !== "auditing");

    const task = daemon.getTask(proj, taskId);
    assert.ok(
      task?.status === "merging" || task?.status === "review-ready",
      `既定通過後の状態が想定外: ${task?.status}`
    );
    assert.equal(
      daemon.getTaskEvents(proj, taskId).some((e) => e.type === "task_failed"),
      false,
      "再試行を使い切っても failed にしてはいけない（ADR-0027）"
    );

    const verdict = daemon
      .getTaskEvents(proj, taskId)
      .findLast((e) => e.type === "audit_verdict") as
      | { verdict?: string; byDefault?: boolean; defaultReason?: string }
      | undefined;
    assert.equal(verdict?.verdict, "pass");
    assert.equal(verdict?.byDefault, true, "既定通過の印（a4）が付いていない");
    assert.match(verdict?.defaultReason ?? "", /audit_session_exited_without_verdict/);
    assert.match(
      verdict?.defaultReason ?? "",
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

    // task-0296: 「落ち着くのを待つ」を実時間の 800ms 待ちに賭けない。余分な
    // 起こし直しがあるなら tick を重ねるほど顕在化する——強制的に何度も機会を
    // 与える方が、漫然と実時間で待つより確かめる力が強く、負荷にも左右されない
    for (let i = 0; i < 5; i++) {
      fireSchedulerTick();
      await new Promise((r) => setTimeout(r, 25));
    }
    assert.equal(
      auditStartedCount(taskId),
      2,
      "1回の事故に対して監査人が2人起きている（古い1人の終了まで数えている）"
    );
  });
});

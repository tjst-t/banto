/**
 * task-0215: **「声が届かなかった」を「中身が悪くて落ちた」と同じ failed にしない。**
 *
 * ## 何が起きていたか（実機・2026-08-16）
 *
 * `banto-worker-pool.service` が OOM で7回揺れ、その最中に Kobo の操作がモジュールへ
 * 届かず、タスクが `failed` になった。
 *
 * ```
 * 03:54:58 worker-pool が OOM で落ちる
 * 03:55:22 task_failed — Failed to reach module "worker-pool" ... read ECONNRESET  （+24秒）
 * 04:06:33 worker-pool が OOM で落ちる
 * 04:07:20 task_failed — 同上                                                      （+47秒）
 * ```
 *
 * **中身は何も悪くない。声が届かなかっただけ**で、数十秒後には同じ操作が通っている。
 * それでも帳簿には「中身が悪くて落ちた」と同じ `failed` としか残らないので、読む側
 * （番頭・PO・次に見る人）が毎回「何が悪かったのか」を調べ直すことになっていた。
 *
 * 読む人が次にやることは、2つで違う:
 *   - 中身が悪くて落ちた → **直す**（rework・契約の訂正・原因の調査）
 *   - 声が届かなかった   → **待てばよい**（相手が起き直れば同じ操作が通る）
 *
 * ## ここで確かめること
 *
 * - [a1] 届かなかったことで終わった試行が、**帳簿を読むだけで**中身の失敗と区別できる
 * - [a2] 区別するのは「届かなかった」だけ。**ツールが返したエラー**（HTTP のエラー応答）は
 *        相手に届いているので中身の失敗のまま
 * - [a3] 経緯・知らせの文面から、調べ直さずに「待てばよい」と分かる
 * - [a4] 届かなかったことを握り潰して成功に見せていない（I2）
 * - [a5] 既存の `failed` の扱い（一覧・集計・再開）が壊れていない。これまで failed として
 *        数えていたものが黙って数から消えない
 *
 * **振る舞いは変えていない**（自動の再試行・自動の復帰は別の話）。ここは見え方だけ。
 *
 * Entry point: Daemon の API（story_type=api）。Worker Pool は立てず、
 *   ①誰も居ない口（届かない）②必ず 500 を返す口（届いて断られた）の2通りを差し替える。
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as http from "node:http";
import * as childProcess from "node:child_process";

import { Daemon, unreachableModuleOf } from "../../packages/banto-daemon/src/daemon.js";
import type { TaskRecord } from "../../packages/banto-core/src/index.js";

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

/** 誰も待っていない口（listen して即座に閉じた番号）＝「声が届かない」相手。 */
async function deadUrl(moduleName: string): Promise<string> {
  const server = http.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return `http://127.0.0.1:${port}/api/${moduleName}`;
}

/** 届いてはいるが、必ず断る口＝「ツールが返したエラー」。 */
async function rejectingModule(): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    req.resume();
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "袋が足りません（職人を起こせません）" }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${port}/api/worker-pool`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

let tmpDir: string;
/** 誰も居ない Worker Pool を向いた Kobo。 */
let unreachableDaemon: Daemon;
/** 必ず 500 を返す Worker Pool を向いた Kobo。 */
let rejectingDaemon: Daemon;
let rejecting: { url: string; close: () => Promise<void> };

const proj = "unreachable-proj";

/** 職人を起こそうとして落ちるところまで進める。**起こせないので必ず失敗する**。 */
async function failWhileSpawning(daemon: Daemon, taskId: string): Promise<void> {
  daemon.createTask(proj, taskId, `作業 ${taskId}`, {
    kind: "feature",
    scope: { paths: [`src/${taskId}/**`] },
    acceptance: [{ id: "a1", text: "動くこと", verify: "npm test" }],
  });
  daemon.transition(proj, taskId, "queued", "test");
  daemon.transition(proj, taskId, "ready", "test");
  // I2: 起こせなかったことは投げて伝わる（黙って成功にしない）
  await assert.rejects(() => daemon.spawnTask(proj, taskId));
}

/** 帳簿に残った直近の失敗理由（＝ `kobo.task` の経緯に出るもの）。 */
function lastFailureReason(daemon: Daemon, taskId: string): string {
  const events = daemon.getTaskEvents(proj, taskId);
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.type === "task_failed") return e.reason;
  }
  throw new Error(`${taskId} の task_failed が帳簿にありません`);
}

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "unreachable-"));
  const repoDir = path.join(tmpDir, "repo");
  initRepo(repoDir);

  rejecting = await rejectingModule();
  const dead = await deadUrl("worker-pool");
  // Environment Pool も誰も居ない口へ向ける。**この試験は実機の環境台帳に触らない**
  const deadEnv = await deadUrl("environment-pool");

  unreachableDaemon = Daemon.create({
    port: 0,
    dataDir: path.join(tmpDir, "data-unreachable"),
    worktreeBaseDir: path.join(tmpDir, "worktrees-unreachable"),
    workerPoolUrl: dead,
    environmentPoolUrl: deadEnv,
    disableAutoSpawn: true,
  });
  await unreachableDaemon.start();
  unreachableDaemon.registerProject(proj, repoDir);

  rejectingDaemon = Daemon.create({
    port: 0,
    dataDir: path.join(tmpDir, "data-rejecting"),
    worktreeBaseDir: path.join(tmpDir, "worktrees-rejecting"),
    workerPoolUrl: rejecting.url,
    environmentPoolUrl: deadEnv,
    disableAutoSpawn: true,
  });
  await rejectingDaemon.start();
  rejectingDaemon.registerProject(proj, repoDir);
});

after(async () => {
  await unreachableDaemon.stop();
  await rejectingDaemon.stop();
  await rejecting.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("届かなかった failed と、中身が悪い failed を帳簿で見分ける（task-0215）", () => {
  it("[a1] 届かなかったことで落ちた試行は、帳簿の理由だけで機械が見分けられる", async () => {
    await failWhileSpawning(unreachableDaemon, "task-unreach-1");

    const reason = lastFailureReason(unreachableDaemon, "task-unreach-1");
    assert.equal(
      unreachableModuleOf(reason),
      "worker-pool",
      `届かなかった相手が理由から読めること: ${reason}`
    );
    // 元の文言は消していない（I2・既にこの文言で拾っている読み手を壊さない）
    assert.match(reason, /Failed to reach module "worker-pool"/);
    assert.match(reason, /spawn failed/);
  });

  it("[a2] ツールが返したエラー（HTTP のエラー応答）は中身の失敗のまま", async () => {
    await failWhileSpawning(rejectingDaemon, "task-reject-1");

    const reason = lastFailureReason(rejectingDaemon, "task-reject-1");
    // 相手には**届いている**。断られたのだから、待っても直らない
    assert.equal(
      unreachableModuleOf(reason),
      null,
      `断られた失敗に「届かなかった」の印を付けないこと: ${reason}`
    );
    assert.ok(
      !reason.startsWith("unreachable:"),
      `断られた失敗を待てばよい扱いにしないこと: ${reason}`
    );
    assert.match(reason, /袋が足りません|failed \(500\)/);
  });

  it("[a3] 経緯・知らせの文面から、調べ直さずに「待てばよい」と分かる", async () => {
    await failWhileSpawning(unreachableDaemon, "task-unreach-2");

    // `kobo.task` の経緯も、失敗の知らせ（kobo-notice）も、この理由をそのまま出す
    const reason = lastFailureReason(unreachableDaemon, "task-unreach-2");
    assert.match(reason, /届きません/, `届かなかったと日本語で読めること: ${reason}`);
    assert.match(reason, /中身の失敗ではありません/, `中身は無罪だと読めること: ${reason}`);
    assert.match(reason, /kobo\.reopen/, `次にやること（待って動かし直す）が書いてあること: ${reason}`);

    // 番頭が失敗の詳細を引く道（failureDetail → kobo.reopen の手前）でも同じものが読める
    const detail = unreachableDaemon.failureDetail(proj, "task-unreach-2");
    assert.equal(unreachableModuleOf(detail.reason ?? ""), "worker-pool");
  });

  it("[a4] 届かなかったことを握り潰して成功に見せていない（I2）", () => {
    const task = unreachableDaemon.getTask(proj, "task-unreach-1");
    assert.equal(task?.status, "failed", "止まったことは止まったこととして残る");
    const events = unreachableDaemon.getTaskEvents(proj, "task-unreach-1");
    assert.ok(
      events.some((e) => e.type === "state_transitioned" && e.to === "failed"),
      "状態も帳簿も failed のまま（印は理由の側にだけ足す）"
    );
    assert.ok(events.some((e) => e.type === "task_failed"), "task_failed が積まれている");
    assert.ok(
      !events.some((e) => e.type === "agent_spawned"),
      "起こせていないのに「起こした」ことにしない"
    );
  });

  it("[a5] 一覧・集計から消えない。失敗として数え続ける", () => {
    const tasks: TaskRecord[] = unreachableDaemon.getTasksByProject(proj);
    const failed = tasks.filter((t) => t.status === "failed").map((t) => t.id);
    assert.deepEqual(
      failed.sort(),
      ["task-unreach-1", "task-unreach-2"],
      "印が付いても一覧・集計では今まで通り failed"
    );
    // 別の Kobo 側（断られた方）も同じく failed として数える
    const rejected = rejectingDaemon
      .getTasksByProject(proj)
      .filter((t) => t.status === "failed")
      .map((t) => t.id);
    assert.deepEqual(rejected, ["task-reject-1"]);
  });

  it("[a5] 再開（kobo.reopen）の道が塞がっていない", async () => {
    const taskId = "task-unreach-1";
    const result = await unreachableDaemon.reopenTask(proj, taskId, {
      by: "banto",
      reason: "worker-pool が起き直ったので動かし直す",
      mode: "rework",
    });

    // 相手はまだ居ないので、起こし直しはまた落ちる。**それを成功に見せない**（I2）
    assert.equal(result.ok, false);

    // それでも「failed から戻す」道は通っている（戻した記録が帳簿に残る）
    const detail = unreachableDaemon.failureDetail(proj, taskId);
    assert.ok(detail.reopenCount >= 1, "failed から戻した回数が数えられる");

    // 2度目の失敗にも印が付く（起こし直しの経路も同じ見分けができる）
    const reason = lastFailureReason(unreachableDaemon, taskId);
    assert.equal(unreachableModuleOf(reason), "worker-pool", reason);
    assert.match(reason, /rework session spawn failed/);
    assert.equal(unreachableDaemon.getTask(proj, taskId)?.status, "failed");
  });
});

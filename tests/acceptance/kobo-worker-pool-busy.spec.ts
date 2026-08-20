/**
 * task-0222: **工房が「満杯」で断ったタスクを failed にしない。**
 *
 * ## 何が起きていたか（実機・2026-08-16）
 *
 * task-0216 で工房（Worker Pool）に同時本数の栓が入り、上限に達すると
 * `BANTO_WORKER_LIMIT:<running>/<limit>` の合印つきで**断る**ようになった。
 * 断りは HTTP 500 で返るので、Kobo からは「中身が悪くて落ちた」と同じ形に見え、
 * task-0215 で入った `unreachable:`（声が届かなかった）の印にも掛からない
 * ——**満杯になるほど「中身は無罪なのに failed」が増える**。同じ日に7本が巻き添えになった。
 *
 * **満杯は「あとでもう一度」であって、失敗ではない。**
 *
 * ## ここで確かめること
 *
 * - [a1] 実装の職人を起こせなかった理由が満杯なら、タスクは `ready` のまま残り、
 *        帳簿に `task_failed` が書かれない（巡回が次の周回で拾い直せる）
 * - [a2] 満杯で見送ったことが黙って消えず、本数／上限と共に読める
 * - [a3] 監査・やり直しの起こし損ないが満杯のときは、理由の先頭に「待てばよい」と
 *        読める印が付き、元の文言も残る（I2）
 * - [a4] 判定は工房の `WORKER_LIMIT_CODE` と**同じ合印**で行われる。ずれたらここが落ちる
 *
 * **状態も新しいイベント型も足していない**（task-0215 と同じ理由・D9）。区別は理由の側だけ。
 *
 * Entry point: Daemon の API（story_type=api）。工房は立てず、**必ず満杯の断りを返す口**へ
 *   差し替える。環境台帳も誰も居ない口へ向ける（**実機の台帳に触らない**）。
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as http from "node:http";
import * as childProcess from "node:child_process";

import {
  Daemon,
  unreachableModuleOf,
  workerPoolBusyOf,
  WORKER_POOL_BUSY_CODE,
} from "../../packages/banto-daemon/src/daemon.js";
// a4: 合印の**正**は工房側。Kobo は文字列で照合しているので、ずれたらここで落ちる
// （工房が Kobo を読み込まない依存の向き（task-0216 a6）は壊さない——読むのは試験だけ）
import { WORKER_LIMIT_CODE } from "../../packages/banto-worker-pool/src/pool.js";

/** 実機の断りと同じ形（合印つきの1行目＋人が読む本文）。 */
const RUNNING = 3;
const LIMIT = 3;
const BUSY_MESSAGE =
  `${WORKER_LIMIT_CODE}:${RUNNING}/${LIMIT}\n` +
  `同時に走れる職人は ${LIMIT} 本までで、いま ${RUNNING} 本走っています。`;

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

/** 満杯で必ず断る工房（届いてはいる＝HTTP 500 で返す）。 */
async function busyWorkerPool(): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    req.resume();
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: BUSY_MESSAGE }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${port}/api/worker-pool`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** 誰も待っていない口（listen して即座に閉じた番号）。環境台帳をここへ向ける。 */
async function deadUrl(moduleName: string): Promise<string> {
  const server = http.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return `http://127.0.0.1:${port}/api/${moduleName}`;
}

async function until(check: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("待っていた状態にならなかった");
}

/**
 * Kobo が標準出力へ書いた行を、その間だけ写し取る（見送りのログを読むため）。
 *
 * **握り潰さずに素通しする**——横取りしたまま捨てると、試験の走者（reporter）が
 * その隙に書いた「どの試験が通ったか」の行まで消える（実際に消えて、6本走ったのに
 * 5本に見えていた）。写しを取るだけにして、書き込みは元の口へそのまま流す。
 *
 * 読むのは `[banto-daemon]` の行だけ。走者の行を拾って**まぐれで**通らないようにする。
 */
async function captureDaemonLog(fn: () => Promise<void>): Promise<string> {
  const chunks: string[] = [];
  const original = process.stdout.write;
  process.stdout.write = ((...args: Parameters<typeof process.stdout.write>): boolean => {
    const chunk = args[0];
    chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return original.apply(process.stdout, args);
  }) as typeof process.stdout.write;
  try {
    await fn();
  } finally {
    process.stdout.write = original;
  }
  return chunks
    .join("")
    .split("\n")
    .filter((line) => line.includes("[banto-daemon]"))
    .join("\n");
}

let tmpDir: string;
let daemon: Daemon;
let pool: { url: string; close: () => Promise<void> };

const proj = "busy-proj";

function createReadyTask(taskId: string): void {
  daemon.createTask(proj, taskId, `作業 ${taskId}`, {
    kind: "feature",
    scope: { paths: [`src/${taskId}/**`] },
    acceptance: [{ id: "a1", text: "動くこと", verify: "npm test" }],
  });
  daemon.transition(proj, taskId, "queued", "test");
  daemon.transition(proj, taskId, "ready", "test");
}

/** 帳簿に残った直近の失敗理由。 */
function lastFailureReason(taskId: string): string {
  const events = daemon.getTaskEvents(proj, taskId);
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.type === "task_failed") return e.reason;
  }
  throw new Error(`${taskId} の task_failed が帳簿にありません`);
}

function failedCount(taskId: string): number {
  return daemon.getTaskEvents(proj, taskId).filter((e) => e.type === "task_failed").length;
}

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "busy-pool-"));
  const repoDir = path.join(tmpDir, "repo");
  initRepo(repoDir);

  pool = await busyWorkerPool();
  const deadEnv = await deadUrl("environment-pool");

  daemon = Daemon.create({
    port: 0,
    dataDir: path.join(tmpDir, "data"),
    worktreeBaseDir: path.join(tmpDir, "worktrees"),
    workerPoolUrl: pool.url,
    environmentPoolUrl: deadEnv,
    // 自動の巡回は止める（起こし直しは試験が明示的に呼ぶ）
    disableAutoSpawn: true,
  });
  await daemon.start();
  daemon.registerProject(proj, repoDir);
});

after(async () => {
  await daemon.stop();
  await pool.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("工房が満杯で断ったタスクを failed にしない（task-0222）", () => {
  it("[a4] 判定は工房の WORKER_LIMIT_CODE と同じ合印で行う", () => {
    assert.equal(
      WORKER_POOL_BUSY_CODE,
      WORKER_LIMIT_CODE,
      "Kobo が探す合印と工房が出す合印がずれている（どちらかを直したら両方直す）"
    );
    assert.deepEqual(
      workerPoolBusyOf(BUSY_MESSAGE),
      { running: RUNNING, limit: LIMIT },
      "合印から本数／上限が読めること"
    );
    // 日本語の言い回しでは判定しない（文面を直した日に黙って壊れないこと）
    assert.equal(
      workerPoolBusyOf("同時に走れる職人は 3 本までで、いま 3 本走っています。"),
      null,
      "合印の無い文面を満杯と読まないこと"
    );
    // 満杯以外の断り（中身の失敗）は今まで通り
    assert.equal(
      workerPoolBusyOf('Module "worker-pool" tool "worker.spawn" failed (500): 袋が足りません'),
      null
    );
  });

  it("[a1] 満杯で起こせなかった実装のタスクは ready のまま残り、task_failed が積まれない", async () => {
    const taskId = "task-busy-1";
    createReadyTask(taskId);

    // I2: 起こせなかったことは投げて伝わる（黙って成功にしない）
    await assert.rejects(() => daemon.spawnTask(proj, taskId));

    assert.equal(daemon.getTask(proj, taskId)?.status, "ready", "ready のまま残ること");
    const events = daemon.getTaskEvents(proj, taskId);
    assert.ok(
      !events.some((e) => e.type === "task_failed"),
      `満杯は失敗ではない——task_failed を積まないこと: ${JSON.stringify(events.map((e) => e.type))}`
    );
    assert.ok(
      !events.some((e) => e.type === "state_transitioned" && e.to === "failed"),
      "状態も failed に落とさないこと（落とすと巡回が二度と拾わない）"
    );
    assert.ok(
      !events.some((e) => e.type === "agent_spawned"),
      "起こせていないのに「起こした」ことにしない（I2）"
    );
  });

  it("[a1] 次の周回でそのまま拾い直せる（ready の一覧に残っている）", async () => {
    const taskId = "task-busy-1";
    const ready = daemon
      .getTasksByProject(proj)
      .filter((t) => t.status === "ready")
      .map((t) => t.id);
    assert.ok(ready.includes(taskId), `巡回が拾う ready の一覧に残ること: ${ready.join(",")}`);

    // 2度目も「ready でないから起こせない」ではなく、また満杯で断られるだけ
    await assert.rejects(
      () => daemon.spawnTask(proj, taskId),
      (err: Error) => {
        assert.ok(workerPoolBusyOf(err.message), `断りの合印が伝わること: ${err.message}`);
        return true;
      }
    );
    assert.equal(daemon.getTask(proj, taskId)?.status, "ready");
    assert.equal(failedCount(taskId), 0, "何周回しても帳簿は汚れない");
  });

  it("[a2] 満杯で見送ったことが、本数／上限と共にログに残る", async () => {
    const taskId = "task-busy-2";
    createReadyTask(taskId);

    const out = await captureDaemonLog(async () => {
      await assert.rejects(() => daemon.spawnTask(proj, taskId));
    });

    assert.match(out, new RegExp(taskId), `どのタスクを見送ったか読めること: ${out}`);
    assert.match(out, /満杯/, `満杯で見送ったと読めること: ${out}`);
    assert.match(
      out,
      new RegExp(`${RUNNING}/${LIMIT} 本`),
      `本数／上限が読めること（黙って見送らない）: ${out}`
    );
    assert.match(out, /ready/, `次の周回で起こし直すと読めること: ${out}`);
  });

  /**
   * task-0287・ADR-0027（PO裁定 2026-08-20）: **監査の spawn 失敗は満杯のときも既定で
   * 通す。** 「満杯なら task_failed にして `kobo.reopen` を待つ」という task-0222 の
   * 旧挙動は、「監査のせいで工程が止まる」の一種として、ここでは反転した——実装に
   * 問題は無いのに、番頭が手動で戻すまで永久に動かないのは a2 が消しにいった失敗型と
   * 同じ形である。**満杯だった事実そのものは消さない**（`taskFailureReason` の
   * `busy:worker-pool ` 印は `audit_verdict.defaultReason` にそのまま乗る）。
   */
  it("[a3] 監査を起こせなかったときも、満杯だった事実を残したまま既定で通す（ADR-0027）", async () => {
    const taskId = "task-busy-audit";
    createReadyTask(taskId);
    // 職人は起こせないので、状態だけ auditing まで進めて監査の起こし損ないを作る
    daemon.transition(proj, taskId, "planning", "test");
    daemon.transition(proj, taskId, "implementing", "test");
    daemon.transition(proj, taskId, "auditing", "test");

    // 監査人が起きるのは次の tick（fire-and-forget）——既定で通るまで待つ
    await until(() => daemon.getTask(proj, taskId)?.status !== "auditing");

    const task = daemon.getTask(proj, taskId);
    assert.ok(
      task?.status === "merging" || task?.status === "review-ready",
      `既定通過後の状態が想定外: ${task?.status}`
    );
    assert.equal(failedCount(taskId), 0, "満杯で failed にしてはいけない（ADR-0027）");

    const verdict = daemon
      .getTaskEvents(proj, taskId)
      .findLast((e) => e.type === "audit_verdict") as
      | { verdict?: string; byDefault?: boolean; defaultReason?: string }
      | undefined;
    assert.equal(verdict?.verdict, "pass");
    assert.equal(verdict?.byDefault, true, "既定通過の印が付いていない");
    const reason = verdict?.defaultReason ?? "";
    assert.ok(
      reason.startsWith("busy:worker-pool "),
      `理由の先頭に印が付くこと（機械が見分けられる）: ${reason}`
    );
    assert.deepEqual(workerPoolBusyOf(reason), { running: RUNNING, limit: LIMIT });
    // 元の文言は消していない（I2・既にこの文言で拾っている読み手を壊さない）
    assert.match(reason, /audit session spawn failed/, reason);
    assert.match(reason, new RegExp(WORKER_LIMIT_CODE), reason);
    // 人が読んで、満杯だっただけと分かる（既定で通ったので kobo.reopen の案内文は
    // もう要らないが、taskFailureReason の元の文言は変えていない）
    assert.match(reason, /中身の失敗ではありません/, reason);
    assert.match(reason, new RegExp(`${RUNNING}/${LIMIT} 本`), `本数／上限が残ること: ${reason}`);
    // 「届かなかった」とは別物（相手には届いている）
    assert.equal(unreachableModuleOf(reason), null, reason);
  });

  /**
   * **やり直し（rework）の spawn 失敗は、このタスクのスコープ外**（task-0287:
   * 「職人（実装役）への指示は変えない。触るのは監査役の側だけ」）。task-0222 の旧挙動
   * （満杯なら failed のまま・`kobo.reopen` 待ち）をそのまま確かめる——ここは変えていない。
   */
  it("[a3] やり直しを起こせなかったときは、これまでどおり failed のまま・同じ印が付く", async () => {
    const taskId = "task-busy-rework";
    createReadyTask(taskId);
    // rework の起こし損ないを試すための前提：まず failed にしておく（実装は変えないので、
    // 満杯以外の理由で落とす——ここでは直接 failed へ遷移させて、辿り着き方には依らない）
    daemon.transition(proj, taskId, "planning", "test");
    daemon.transition(proj, taskId, "implementing", "test");
    daemon.transition(proj, taskId, "failed", "テスト：やり直しの起こし損ないを試す前提");

    const result = await daemon.reopenTask(proj, taskId, {
      by: "banto",
      reason: "工房が空いたので動かし直す",
      mode: "rework",
    });

    // 工房はまだ満杯なので、起こし直しはまた落ちる。**それを成功に見せない**（I2）
    assert.equal(result.ok, false);

    const reason = lastFailureReason(taskId);
    assert.ok(reason.startsWith("busy:worker-pool "), reason);
    assert.match(reason, /rework session spawn failed/, reason);
    assert.deepEqual(workerPoolBusyOf(reason), { running: RUNNING, limit: LIMIT });
    assert.match(reason, /kobo\.reopen/, reason);
    assert.equal(daemon.getTask(proj, taskId)?.status, "failed");
  });
});

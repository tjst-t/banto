/**
 * task-0060: Kobo は職人を **Worker Pool へ頼む**（ADR-0013 決定60・63）。
 *
 * 旧 `spawn-pi` / `spawn-ledger` / `spawn-reconcile` / `tmux-attach` の置き換え。
 * 職人そのものの振る舞い（台帳・畳み・起こし直し・ライブアタッチ）は
 * `banto-worker-pool.spec.ts` が見る。**ここで見るのは「Kobo が worker.* を正しく使うか」**
 * ——統治の都合が5つある：
 *
 *   1. ready のタスクに職人を1人つけ、planning へ進める
 *   2. **台帳を持たない**（決定29c：職人の真実は Worker Pool に一箇所）。起こした職人は
 *      番頭の worker.list にも並び、起動元が kobo だと分かる（a2・a3）
 *   3. 自分の道具立て（banto-executor 拡張・指示・等級）が届く（a5・a8）
 *   4. 職人が黙って終わったら、統治として止まる（I2。旧・照合 tick の役目）
 *   5. 済んだ職人は Kobo が畳む（I3。番頭には畳めない・決定63）
 *
 * Worker Pool は**本物**を独立サービスとして立てる（偽物では決定27b の経路を検査できない）。
 * 差し替えるのは pi の代わりのランタイムだけで、最後の1本は**本物の pi** を起こす。
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as childProcess from "node:child_process";

import { Daemon } from "../../packages/banto-daemon/src/daemon.js";
import { PiRpcDriver } from "../../packages/banto-worker-pool/src/pi-rpc-driver.js";
import {
  FakeRuntimeDriver,
  startWorkerPool,
  type WorkerPoolHarness,
} from "./worker-pool-harness.js";

// ── git helpers ───────────────────────────────────────────────────────────────

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

async function until(check: () => boolean, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("待っていた状態にならなかった");
}

// ── Harness ───────────────────────────────────────────────────────────────────

interface Harness {
  daemon: Daemon;
  workers: WorkerPoolHarness;
  driver: FakeRuntimeDriver;
  dataDir: string;
  repoDir: string;
  tmpDir: string;
  proj: string;
}

async function harness(options: { tickIntervalMs?: number } = {}): Promise<Harness> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kobo-worker-"));
  const repoDir = path.join(tmpDir, "repo");
  initRepo(repoDir);
  const dataDir = path.join(tmpDir, "data");

  const driver = new FakeRuntimeDriver();
  const workers = await startWorkerPool(driver);

  const daemon = Daemon.create({
    port: 0,
    dataDir,
    watchIntervalMs: 99999,
    tickIntervalMs: options.tickIntervalMs ?? 99999,
    // 明示の置き場（テスト用リポジトリにはリモートが無く gwq が場所を決められない）
    worktreeBaseDir: path.join(tmpDir, "worktrees"),
    workerPoolUrl: workers.url,
    disableAutoSpawn: true,
  });
  await daemon.start();

  const proj = "kobo-worker-proj";
  daemon.registerProject(proj, repoDir);
  return { daemon, workers, driver, dataDir, repoDir, tmpDir, proj };
}

async function teardown(h: Harness): Promise<void> {
  await h.daemon.stop();
  await h.workers.close();
  fs.rmSync(h.tmpDir, { recursive: true, force: true });
}

/** ready まで進めたタスクを1つ用意する。 */
function readyTask(
  h: Harness,
  taskId: string,
  extra: Record<string, unknown> = {}
): void {
  h.daemon.createTask(h.proj, taskId, `作業 ${taskId}`, {
    kind: "feature",
    scope: { paths: [`src/${taskId}/**`] },
    acceptance: [{ id: "a1", text: "動くこと", verify: "npm test" }],
    ...extra,
  });
  h.daemon.transition(h.proj, taskId, "queued", "test");
  h.daemon.transition(h.proj, taskId, "ready", "test");
}

// ── a1 / a2 / a3: 職人は Worker Pool が持つ ──────────────────────────────────

describe("[task-0060/a1,a2,a3] Kobo は職人を Worker Pool へ頼み、自分の台帳を持たない", () => {
  let h: Harness;
  before(async () => {
    h = await harness();
  });
  after(async () => {
    await teardown(h);
  });

  it("ready のタスクに職人が1人つき、planning へ進む", async () => {
    readyTask(h, "task-0001");
    const session = await h.daemon.spawnTask(h.proj, "task-0001");

    assert.ok(session.sessionId.length > 0, "職人のセッションが返る");
    assert.equal(h.daemon.getTask(h.proj, "task-0001")?.status, "planning");

    const spawned = h.daemon
      .getTaskEvents(h.proj, "task-0001")
      .find((e) => e.type === "agent_spawned");
    assert.ok(spawned, "帳簿に agent_spawned が残る");
    assert.equal(
      (spawned as { sessionId?: string }).sessionId,
      session.sessionId,
      "どの職人を起こしたかが残り、職人ビューアへ辿れる（決定18）"
    );
    assert.ok(
      fs.existsSync(session.worktreePath),
      `ワークツリーが用意される: ${session.worktreePath}`
    );
  });

  it("[a2] Kobo は spawn 台帳を開かない（台帳は Worker Pool に一箇所）", () => {
    assert.equal(
      fs.existsSync(path.join(h.dataDir, "spawn-ledger.json")),
      false,
      "Kobo のデータ置き場に職人の台帳ができないこと（D3：真実が割れない）"
    );
    const poolWorkers = h.workers.pool.list({ includeClosed: false });
    assert.equal(poolWorkers.length, 1, "Worker Pool の台帳に1人だけ居る");
    assert.equal(poolWorkers[0]!.taskId, "task-0001");
  });

  it("[a3] 番頭の worker.list に並び、起動元で Kobo 由来と分かる", async () => {
    // 番頭が見るのと同じ口（決定27b の `{baseUrl}/tools/{名前}`）を通す
    const res = await fetch(`${h.workers.url}/tools/worker.list`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ args: { includeClosed: false } }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      details: { workers: Array<{ taskId: string; origin: string; worktree: string }> };
    };
    const found = body.details.workers.find((w) => w.taskId === "task-0001");
    assert.ok(found, "Kobo が起こした職人が番頭の一覧にも出る");
    assert.equal(found.origin, "kobo", "起動元で Kobo 由来と分かる（決定63 の判定材料）");
  });

  it("[a5] Kobo の道具立て（executor 拡張・到達先）が職人へ届く", () => {
    const session = h.driver.byTaskId("task-0001");
    assert.ok(session, "偽ランタイムに起動が届いている");
    const extensions = session.driverOptions["extensionPaths"] as string[] | undefined;
    assert.ok(
      extensions?.some((p) => p.endsWith("banto-executor.ts")),
      `banto-executor 拡張が載ること。載ったのは: ${JSON.stringify(extensions)}`
    );
    assert.match(
      String(session.driverOptions["daemonUrl"] ?? ""),
      /^http:\/\/localhost:\d+$/,
      "職人が Kobo へ報告するための到達先が渡る"
    );
    assert.equal(session.driverOptions["projectTag"], h.proj);
  });

  it("[a5] 指示にタスクの契約が書き切ってある（職人は記憶を持たない・D11）", () => {
    const session = h.driver.byTaskId("task-0001");
    const instruction = session!.injected[0] ?? "";
    assert.match(instruction, /task-0001/);
    assert.match(instruction, /src\/task-0001\/\*\*/, "スコープが渡る");
    assert.match(instruction, /動くこと/, "受け入れ基準が渡る");
    assert.match(instruction, /npm test/, "検証コマンドが渡る");
    assert.match(instruction, /task\/task-0001/, "コミット先のブランチが渡る");
    assert.match(instruction, /report_done/, "完了の合図の呼び方が渡る");
  });

  it("[a8] 渡すのは tier だけ。モデル名も provider も渡らない（決定60a）", () => {
    const session = h.driver.byTaskId("task-0001");
    assert.equal(session!.modelTier, "standard", "既定の等級");
    assert.equal(session!.driverOptions["model"], undefined, "モデル名を渡さない");
    assert.equal(session!.driverOptions["provider"], undefined, "provider を渡さない");
    const serialized = JSON.stringify(session!.driverOptions);
    assert.ok(
      !serialized.includes("deepseek") && !serialized.includes("opencode"),
      `具体のモデルが混ざらないこと: ${serialized}`
    );
  });

  it("[a8] タスクの model_tier がそのまま渡る", async () => {
    readyTask(h, "task-0002", { model_tier: "reasoning" });
    await h.daemon.spawnTask(h.proj, "task-0002");
    assert.equal(h.driver.byTaskId("task-0002")!.modelTier, "reasoning");
  });

  it("ready でないタスク・居ないタスクには職人をつけない", async () => {
    await assert.rejects(() => h.daemon.spawnTask(h.proj, "task-nonexistent"), /not found/i);
    await assert.rejects(() => h.daemon.spawnTask(h.proj, "task-0001"), /ready/i);
  });
});

// ── 職人が黙って終わったら統治として止まる（旧・照合 tick）────────────────────

describe("[task-0060/a1] 職人が報告せずに終わったら、Kobo が止まる（I2）", () => {
  let h: Harness;
  before(async () => {
    h = await harness({ tickIntervalMs: 200 });
  });
  after(async () => {
    await teardown(h);
  });

  it("職人が落ちると agent_exited が残り、タスクは failed になる", async () => {
    readyTask(h, "task-0010");
    const session = await h.daemon.spawnTask(h.proj, "task-0010");
    assert.equal(h.daemon.getTask(h.proj, "task-0010")?.status, "planning");

    // 生きている職人を、tick が何回か回っても落とさない（旧・照合 tick の裏返し）
    await new Promise((r) => setTimeout(r, 500));
    assert.equal(
      h.daemon.getTask(h.proj, "task-0010")?.status,
      "planning",
      "動いている職人のタスクを勝手に failed にしない"
    );

    // 職人のプロセスが落ちる（外から SIGKILL された等）
    h.driver.exit(session.sessionId, null, "SIGKILL");

    // Kobo は職人のイベントを tick で引き取る（決定29c）
    await until(() =>
      h.daemon.getTaskEvents(h.proj, "task-0010").some((e) => e.type === "agent_exited")
    );
    await until(() => h.daemon.getTask(h.proj, "task-0010")?.status === "failed");

    const failed = h.daemon
      .getTaskEvents(h.proj, "task-0010")
      .find((e) => e.type === "task_failed") as { reason?: string } | undefined;
    assert.match(
      failed?.reason ?? "",
      /agent_exited_without_report/,
      "止まった理由が残る（黙って planning のまま残さない）"
    );
  });

  it("同じ出来事を二度書かない（起動時に読み直しても増えない）", async () => {
    const before = h.daemon
      .getTaskEvents(h.proj, "task-0010")
      .filter((e) => e.type === "agent_exited").length;
    await new Promise((r) => setTimeout(r, 600));
    const after = h.daemon
      .getTaskEvents(h.proj, "task-0010")
      .filter((e) => e.type === "agent_exited").length;
    assert.equal(after, before, "agent_exited は1回だけ（帳簿から重複を弾く）");
  });
});

// ── Kobo が落ちている間の出来事を取りこぼさない（旧・孤児回収）──────────────

describe("[task-0060/a1] Kobo の再起動：職人は畳まず、落ちている間の出来事に追いつく", () => {
  let h: Harness;
  after(async () => {
    await teardown(h);
  });

  it("止まっている間に終わった職人を、起動後の tick が拾う", async () => {
    h = await harness({ tickIntervalMs: 200 });
    readyTask(h, "task-0040");
    const session = await h.daemon.spawnTask(h.proj, "task-0040");

    // Kobo だけを止める。**職人は畳まない**（決定63：面倒を見るのは Worker Pool）
    await h.daemon.stop();
    assert.equal(
      h.workers.pool.get(session.sessionId)?.alive,
      true,
      "Kobo を止めても職人は生きている（以前は再起動時に SIGTERM で畳んでいた）"
    );

    // 止まっている間に職人が落ちる
    h.driver.exit(session.sessionId, null, "SIGKILL");

    // 同じデータ置き場で起動し直す
    const restarted = Daemon.create({
      port: 0,
      dataDir: h.dataDir,
      watchIntervalMs: 99999,
      tickIntervalMs: 200,
      worktreeBaseDir: path.join(h.tmpDir, "worktrees"),
      workerPoolUrl: h.workers.url,
      disableAutoSpawn: true,
    });
    await restarted.start();
    h.daemon = restarted;

    await until(() =>
      restarted.getTaskEvents(h.proj, "task-0040").some((e) => e.type === "agent_exited")
    );
    await until(() => restarted.getTask(h.proj, "task-0040")?.status === "failed");
  });
});

// ── 済んだ職人は Kobo が畳む（I3・決定63）────────────────────────────────────

describe("[task-0060/a1] 役目を終えた職人は Kobo が畳む（番頭には畳めない）", () => {
  let h: Harness;
  before(async () => {
    h = await harness();
  });
  after(async () => {
    await teardown(h);
  });

  it("監査に入ると実装の職人は畳まれ、監査人が起こされる", async () => {
    readyTask(h, "task-0020");
    const executor = await h.daemon.spawnTask(h.proj, "task-0020");
    h.daemon.transition(h.proj, "task-0020", "implementing", "test");
    h.daemon.transition(h.proj, "task-0020", "auditing", "test");

    await until(() => h.driver.byTaskId("task-0020:audit") !== undefined);

    const executorWorker = h.workers.pool.get(executor.sessionId);
    assert.equal(
      executorWorker?.state,
      "closed",
      "実装の職人は畳まれる（放っておくと安全弁の時間までプロセスが残る）"
    );

    const audit = h.driver.byTaskId("task-0020:audit")!;
    assert.equal(audit.modelTier, "reasoning", "監査は一段上の等級（spec §3.5）");
    const extensions = audit.driverOptions["extensionPaths"] as string[] | undefined;
    assert.ok(
      extensions?.some((p) => p.endsWith("banto-auditor.ts")),
      "監査人には banto-auditor 拡張が載る"
    );
    assert.equal(
      audit.worktreePath,
      executor.worktreePath,
      "監査は実装者と同じワークツリーを見る（作り直すと見るものが無い）"
    );
  });

  it("[a9] 監査に落ちると、rework は一段上の等級で起こされる（失敗駆動の昇格）", async () => {
    h.daemon.handleAuditVerdict(h.proj, "task-0020", "fail", ["a1 が検証されていない"]);
    await until(() => h.driver.byTaskId("task-0020:rework") !== undefined);

    const rework = h.driver.byTaskId("task-0020:rework")!;
    assert.equal(
      rework.modelTier,
      "reasoning",
      "既定 standard の1段上。Kobo が変えるのは tier の文字列だけ（決定60a）"
    );
    assert.match(
      rework.injected[0] ?? "",
      /a1 が検証されていない/,
      "監査の指摘が指示に書き切ってある（職人は記憶を持たない）"
    );

    const auditWorker = h.workers.pool
      .list()
      .find((w) => w.taskId === "task-0020:audit");
    assert.equal(auditWorker?.state, "closed", "監査人は役目を終えたので畳まれる");
  });
});

// ── 本物の pi で1本通す（偽ドライバだけで済ませない）─────────────────────────

describe("[task-0060/a1] 本物の pi を Worker Pool 越しに起こす", () => {
  let h: Omit<Harness, "driver"> & { driver: PiRpcDriver };

  before(async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kobo-worker-real-"));
    const repoDir = path.join(tmpDir, "repo");
    initRepo(repoDir);
    const dataDir = path.join(tmpDir, "data");
    // 本物の pi を RPC モードで起こす（LLM は呼ばない——起動と受け渡しだけを見る）
    const driver = new PiRpcDriver({ sessionBaseDir: path.join(tmpDir, "sessions") });
    const workers = await startWorkerPool(driver);
    const daemon = Daemon.create({
      port: 0,
      dataDir,
      watchIntervalMs: 99999,
      tickIntervalMs: 99999,
      worktreeBaseDir: path.join(tmpDir, "worktrees"),
      workerPoolUrl: workers.url,
      disableAutoSpawn: true,
    });
    await daemon.start();
    const proj = "kobo-worker-real";
    daemon.registerProject(proj, repoDir);
    h = { daemon, workers, driver, dataDir, repoDir, tmpDir, proj };
  });

  after(async () => {
    await h.daemon.stop();
    await h.workers.close();
    fs.rmSync(h.tmpDir, { recursive: true, force: true });
  });

  it("実プロセスの職人が Worker Pool の台帳に載り、Kobo の帳簿と一致する", async () => {
    readyTask(h as unknown as Harness, "task-0030");

    let session: { sessionId: string; pid: number } | undefined;
    try {
      session = await h.daemon.spawnTask(h.proj, "task-0030");
    } catch (err) {
      // I2: 起こせなかったなら、そのことが帳簿に残っていること（黙って planning に残さない）
      const failed = h.daemon
        .getTaskEvents(h.proj, "task-0030")
        .find((e) => e.type === "task_failed");
      assert.ok(failed, `pi を起こせなかったが task_failed も無い: ${String(err)}`);
      return;
    }

    assert.ok(session.pid > 0, "実プロセスの pid が返る");
    const worker = h.workers.pool.get(session.sessionId);
    assert.ok(worker, "Worker Pool の台帳に載る");
    assert.equal(worker.origin, "kobo");
    assert.equal(worker.pid, session.pid, "Kobo が帳簿に残した pid と台帳が一致する");

    // 起こした者が片付ける（I3）
    await h.workers.pool.close(session.sessionId, "done");
  });
});

/**
 * task-0063: 費用の上限は Kobo が持ち、**積む時点で拒否**する（ADR-0013 決定67）。
 *
 * **黙って丸めない**のが要点。上限を超えたタスクを黙って `fast` へ落とすと、PO は
 * 「安く速く終わった」と読み、実際には要求水準を満たしていない成果を受け取る——
 * 拒否すれば、上限を上げるか要求を下げるかを人が決められる（決定34f と同じ形）。
 *
 * **監査も他の役と同じように上限に従う（ADR-0027 決定140、task-0292 で改訂）**。
 * 監査はもう合否の門（検査）ではなく補助の目で、実装の正しさを担保するのはマージ前
 * ゲートの機械検証——「監査だけ上限の対象外」にする理由は無い。名指し
 * （`roleAssignments.audit`）があればそちらが最優先なのは変えていない。
 * 上限が既定等級を下げるときは、そのことを起動時に言う。
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import * as childProcess from "node:child_process";

import { Daemon } from "../../packages/banto-daemon/src/daemon.js";
import { loadProjectConfig } from "../../packages/banto-daemon/src/review-policy.js";
import {
  FakeRuntimeDriver,
  startWorkerPool,
  type WorkerPoolHarness,
} from "./worker-pool-harness.js";
import type {
  RuntimeDriver,
  SpawnOptions,
  SessionHandle,
  DriverEventHandler,
  DriverEvent,
} from "../../packages/banto-core/src/index.js";

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const address = s.address();
      if (address === null || typeof address === "string") {
        reject(new Error("no port"));
        return;
      }
      const { port } = address;
      s.close(() => resolve(port));
    });
  });
}

function git(args: string[], cwd: string): void {
  const r = childProcess.spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
}

interface Harness {
  daemon: Daemon;
  repoDir: string;
  tmpDir: string;
  proj: string;
}

async function harness(config: string): Promise<Harness> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kobo-ceiling-"));
  const repoDir = path.join(tmpDir, "repo");
  fs.mkdirSync(path.join(repoDir, "work", "tasks"), { recursive: true });
  fs.mkdirSync(path.join(repoDir, "meta"), { recursive: true });
  fs.writeFileSync(path.join(repoDir, "meta", "config.yaml"), config, "utf-8");
  git(["init", "-b", "main"], repoDir);
  git(["config", "user.email", "t@e"], repoDir);
  git(["config", "user.name", "t"], repoDir);
  fs.writeFileSync(path.join(repoDir, "README.md"), "x\n");
  git(["add", "."], repoDir);
  git(["commit", "-m", "init"], repoDir);

  const daemon = Daemon.create({
    port: await freePort(),
    dataDir: path.join(tmpDir, "data"),
    tickIntervalMs: 99999,
    disableAutoSpawn: true,
    disableAuditSpawn: true,
  });
  await daemon.start();
  const proj = "ceiling-proj";
  daemon.registerProject(proj, repoDir);
  return { daemon, repoDir, tmpDir, proj };
}

async function teardown(h: Harness): Promise<void> {
  await h.daemon.stop();
  fs.rmSync(h.tmpDir, { recursive: true, force: true });
}

/**
 * 第4便：積むのは道具の入力から。**定義ファイルを先に書く経路は無くなった**
 * （Kobo が採番して記録を書く）ので、等級だけを渡して積む。
 */
function enqueue(h: Harness, tier?: string): ReturnType<Daemon["enqueueTask"]> {
  return h.daemon.enqueueTask(
    h.proj,
    {
      title: "上限の確認",
      kind: "fix",
      body: "等級の上限を確かめる。",
      scope: { paths: ["src/**"] },
      acceptance: [{ text: "確かめられる" }],
      ...(tier ? { model_tier: tier as "reasoning" | "standard" | "fast" } : {}),
    },
    { originRef: "試験" }
  );
}

/**
 * 監査の実 spawn を見る試験用の器（task-0292）。
 *
 * 上の `harness()` は Worker Pool を持たない（積む時点の拒否だけを見るので要らない）。
 * ここでは「監査が実際にどの等級で起こされるか」を、`kobo-worker-integration.spec.ts` と
 * 同じ形（本物の Worker Pool ＋ 偽ランタイム）で確かめる——ソースの字面ではなく振る舞いで
 * 縛る方が、無関係な整形やリファクタで壊れない。
 */
interface WorkerHarness extends Harness {
  workers: WorkerPoolHarness;
  driver: FakeRuntimeDriver;
}

async function harnessWithWorkers(config: string): Promise<WorkerHarness> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kobo-ceiling-audit-"));
  const repoDir = path.join(tmpDir, "repo");
  fs.mkdirSync(path.join(repoDir, "work", "tasks"), { recursive: true });
  fs.mkdirSync(path.join(repoDir, "meta"), { recursive: true });
  fs.writeFileSync(path.join(repoDir, "meta", "config.yaml"), config, "utf-8");
  git(["init", "-b", "main"], repoDir);
  git(["config", "user.email", "t@e"], repoDir);
  git(["config", "user.name", "t"], repoDir);
  fs.writeFileSync(path.join(repoDir, "README.md"), "x\n");
  git(["add", "."], repoDir);
  git(["commit", "-m", "init"], repoDir);

  const driver = new FakeRuntimeDriver();
  const workers = await startWorkerPool(driver);

  const daemon = Daemon.create({
    port: await freePort(),
    dataDir: path.join(tmpDir, "data"),
    tickIntervalMs: 99999,
    worktreeBaseDir: path.join(tmpDir, "worktrees"),
    workerPoolUrl: workers.url,
    disableAutoSpawn: true,
  });
  await daemon.start();
  const proj = "ceiling-audit-proj";
  daemon.registerProject(proj, repoDir);
  return { daemon, repoDir, tmpDir, proj, workers, driver };
}

async function teardownWithWorkers(h: WorkerHarness): Promise<void> {
  await h.daemon.stop();
  await h.workers.close();
  fs.rmSync(h.tmpDir, { recursive: true, force: true });
}

async function until(check: () => boolean, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("待っていた状態にならなかった");
}

/** タスクを ready → planning → implementing → auditing まで進め、監査人が起こされるのを待つ。 */
async function advanceToAuditing(h: WorkerHarness, taskId: string): Promise<void> {
  h.daemon.transition(h.proj, taskId, "ready", "test");
  await h.daemon.spawnTask(h.proj, taskId);
  h.daemon.transition(h.proj, taskId, "implementing", "test");
  h.daemon.transition(h.proj, taskId, "auditing", "test");
  await until(() => h.driver.byTaskId(`${taskId}:audit`) !== undefined);
}

describe("[task-0063] 等級の上限（決定67）", () => {
  let h: Harness;
  before(async () => {
    h = await harness("limits:\n  max_model_tier: standard\n  max_concurrent_sessions: 2\n");
  });
  after(async () => {
    await teardown(h);
  });

  it("[a1] 同時実行数の上限が層B設定から読める", () => {
    assert.equal(h.daemon.maxConcurrentSessions(h.proj), 2, "プロジェクトの設定が効く");
    assert.equal(loadProjectConfig(h.repoDir).limits.maxConcurrentSessions, 2);
  });

  it("[a2] 上限を超える model_tier のタスクは**拒否**される。黙って丸めない", () => {
    const result = enqueue(h, "reasoning");
    assert.equal(result.ok, false);
    assert.match(
      (result as { reason: string }).reason,
      /上限は standard/,
      "何が超えているかが分かる"
    );
    assert.match(
      (result as { reason: string }).reason,
      /黙って丸めません/,
      "下の等級で勝手に走らせないことが分かる"
    );
    assert.equal(h.daemon.getTasksByProject(h.proj).length, 0, "積まれていないこと");
  });

  it("[a3] 拒否の理由は呼び出し側に返る（積んだのに動かない、が黙って起きない）", () => {
    // enqueue の返りがそのまま kobo.enqueue の例外になる（Tool 側で throw する）
    const result = enqueue(h, "reasoning");
    assert.equal(result.ok, false);
    assert.ok((result as { reason: string }).reason.length > 20, "理由が具体的であること");
  });

  it("上限の内側なら通る", () => {
    assert.equal(enqueue(h, "standard").ok, true);
    assert.equal(enqueue(h, "fast").ok, true);
  });

  it("[a5] 設定に現れるのは数と等級だけ（Kobo はモデル名も金額も知らない）", () => {
    const config = fs.readFileSync(path.join(h.repoDir, "meta", "config.yaml"), "utf-8");
    assert.doesNotMatch(config, /provider|model:|api|token|\$|円/i);
    const limits = loadProjectConfig(h.repoDir).limits;
    assert.deepEqual(Object.keys(limits).sort(), ["maxConcurrentSessions", "maxModelTier"]);
  });

  it("壊れた上限は黙って無視しない（I2）", async () => {
    const bad = await harness("limits:\n  max_model_tier: ちょうすごいやつ\n");
    try {
      assert.throws(() => loadProjectConfig(bad.repoDir), /fast \/ standard \/ reasoning/);
    } finally {
      await teardown(bad);
    }
  });
});

describe("[task-0292/ADR-0027 決定140] 監査も等級の上限に従う", () => {
  it("[a1] 上限が standard なら、監査の既定等級（reasoning）も standard へ下がる", async () => {
    const h = await harnessWithWorkers("limits:\n  max_model_tier: standard\n");
    try {
      const result = enqueue(h, "fast");
      assert.equal(result.ok, true);
      const taskId = (result as { taskId: string }).taskId;
      await advanceToAuditing(h, taskId);

      // ソースの字面ではなく、実際に起こした監査人へ渡った等級を見る（振る舞いで縛る）。
      // 監査は合否の門ではなく補助の目で、実装の正しさを担保するのはマージ前ゲートの
      // 機械検証——「監査だけ上限の対象外」にする理由は無い（ADR-0027 決定140）。
      const audit = h.driver.byTaskId(`${taskId}:audit`);
      assert.ok(audit, "監査人が起こされていること");
      assert.equal(
        audit!.modelTier,
        "standard",
        "監査も他の役と同じように上限まで下がること"
      );
    } finally {
      await teardownWithWorkers(h);
    }
  });

  it("上限が無ければ、監査は既定の reasoning のまま回る", async () => {
    const h = await harnessWithWorkers("limits:\n  max_concurrent_sessions: 5\n");
    try {
      const result = enqueue(h, "fast");
      assert.equal(result.ok, true);
      const taskId = (result as { taskId: string }).taskId;
      await advanceToAuditing(h, taskId);

      const audit = h.driver.byTaskId(`${taskId}:audit`);
      assert.equal(audit?.modelTier, "reasoning", "上限が無いプロジェクトでは既定のまま");
    } finally {
      await teardownWithWorkers(h);
    }
  });

  it("[a2] 名指し（roleAssignments.audit）があれば、上限より優先する（優先順は変えていない）", async () => {
    const h = await harnessWithWorkers("limits:\n  max_model_tier: standard\n");
    try {
      h.daemon.setRoleAssignments({ audit: { tier: "reasoning" } });
      const result = enqueue(h, "fast");
      assert.equal(result.ok, true);
      const taskId = (result as { taskId: string }).taskId;
      await advanceToAuditing(h, taskId);

      const audit = h.driver.byTaskId(`${taskId}:audit`);
      assert.equal(
        audit?.modelTier,
        "reasoning",
        "名指し > 等級 > 既定の順は変えていない（決定67・PO裁定2026-08-10）"
      );
    } finally {
      await teardownWithWorkers(h);
    }
  });

  it("失敗駆動の昇格は上限で据え置かれる（積んだ後に止めない）", async () => {
    const h = await harness("limits:\n  max_model_tier: standard\n");
    try {
      assert.equal(enqueue(h, "standard").ok, true);
      // 昇格の判断は rework の起こし方に効く。上限を超える昇格は据え置く（拒否ではない）
      // ——積む時点で上限内だったタスクを途中で止めるのは筋が違う
      assert.equal(h.daemon.projectConfig(h.proj).limits.maxModelTier, "standard");
    } finally {
      await teardown(h);
    }
  });
});

/**
 * task-0295: `maxConcurrentSessions()` は全プロジェクトを回って最小値を採っていたため、
 * 1プロジェクトの低い上限が工場全体を絞っていた。同時実行数の上限も「いま何人動いて
 * いるか」も**そのプロジェクトのものだけ**を見る（決定67の趣旨はプロジェクト単位の
 * 自己規律であって、工場全体への波及ではない）。
 */

// SleepDriver: 実プロセス（sleep）を起こす本物のランタイム（auto-spawn-quota.spec.ts と同じ形）。
// pi バイナリも LLM 呼び出しも要らない——起こす／畳むの事実だけを見る。
class SleepDriver implements RuntimeDriver {
  private readonly sessions = new Map<
    string,
    { pid: number; proc: childProcess.ChildProcess }
  >();
  private readonly handlers: Set<DriverEventHandler> = new Set();

  async spawn(opts: SpawnOptions): Promise<SessionHandle> {
    const proc = childProcess.spawn("sleep", ["120"], { stdio: "ignore", detached: true });
    proc.unref();
    const pid = proc.pid;
    if (!pid) throw new Error("SleepDriver: failed to get pid");
    const sessionId = `${opts.taskId}-${pid}`;
    this.sessions.set(sessionId, { pid, proc });
    proc.once("exit", (code, signal) => {
      const exitEv: DriverEvent = { type: "process_exited", pid, sessionId, exitCode: code, signal };
      for (const h of this.handlers) {
        try {
          h(exitEv);
        } catch {
          /* ignore handler errors */
        }
      }
      this.sessions.delete(sessionId);
    });
    const startEv: DriverEvent = { type: "process_started", pid, sessionId, sessionPath: opts.sessionPath };
    for (const h of this.handlers) {
      try {
        h(startEv);
      } catch {
        /* ignore */
      }
    }
    return { pid, sessionId, sessionPath: opts.sessionPath };
  }

  async inject(_sessionId: string, _message: string): Promise<void> {
    // no-op
  }

  subscribe(handler: DriverEventHandler): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  async kill(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    try {
      process.kill(session.pid, "SIGTERM");
    } catch {
      /* already dead */
    }
  }

  async killAll(): Promise<void> {
    for (const [sid] of this.sessions) {
      await this.kill(sid);
    }
    await new Promise<void>((r) => setTimeout(r, 200));
  }
}

async function pollUntil<T>(
  fn: () => T,
  pred: (v: T) => boolean,
  timeoutMs = 6000,
  intervalMs = 50
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last = fn();
  while (!pred(last) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, intervalMs));
    last = fn();
  }
  return last;
}

/** Kobo が `[banto-daemon]` として stderr へ書いた行だけを、その間だけ写し取る。 */
async function captureDaemonStderr(fn: () => Promise<void>): Promise<string> {
  const chunks: string[] = [];
  const original = process.stderr.write;
  process.stderr.write = ((...args: Parameters<typeof process.stderr.write>): boolean => {
    const chunk = args[0];
    chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return original.apply(process.stderr, args);
  }) as typeof process.stderr.write;
  try {
    await fn();
  } finally {
    process.stderr.write = original;
  }
  return chunks
    .join("")
    .split("\n")
    .filter((line) => line.includes("[banto-daemon]"))
    .join("\n");
}

function initCeilingRepo(dir: string, config: string): void {
  fs.mkdirSync(path.join(dir, "work", "tasks"), { recursive: true });
  fs.mkdirSync(path.join(dir, "meta"), { recursive: true });
  fs.writeFileSync(path.join(dir, "meta", "config.yaml"), config, "utf-8");
  git(["init", "-b", "main"], dir);
  git(["config", "user.email", "t@e"], dir);
  git(["config", "user.name", "t"], dir);
  fs.writeFileSync(path.join(dir, "README.md"), "x\n");
  git(["add", "."], dir);
  git(["commit", "-m", "init"], dir);
}

function createReadyTask(daemon: Daemon, proj: string, taskId: string): void {
  daemon.createTask(proj, taskId, `作業 ${taskId}`, {
    kind: "feature",
    scope: { paths: [`src/${taskId}/**`] },
    acceptance: [{ id: "a1", text: "動くこと", verify: "npm test" }],
  });
  daemon.transition(proj, taskId, "queued", "test");
  daemon.transition(proj, taskId, "ready", "test");
}

describe("[task-0295] 同時上限はプロジェクトごとに見る", () => {
  let tmpDir: string;
  let daemon: Daemon;
  let driver: SleepDriver;
  let pool: WorkerPoolHarness;
  const projTight = "ceiling-tight";
  const projLoose = "ceiling-loose";

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kobo-ceiling-proj-"));
    const repoTight = path.join(tmpDir, "repo-tight");
    const repoLoose = path.join(tmpDir, "repo-loose");
    // tight は自分の層B設定で1本に絞る。loose は層B設定を持たない（Kobo の既定に従う）
    initCeilingRepo(repoTight, "limits:\n  max_concurrent_sessions: 1\n");
    initCeilingRepo(repoLoose, "");

    driver = new SleepDriver();
    pool = await startWorkerPool(driver);

    daemon = Daemon.create({
      port: await freePort(),
      dataDir: path.join(tmpDir, "data"),
      tickIntervalMs: 100,
      workerPoolUrl: pool.url,
      disableAuditSpawn: true,
    });
    await daemon.start();
    daemon.registerProject(projTight, repoTight);
    daemon.registerProject(projLoose, repoLoose);
  });

  after(async () => {
    await daemon.stop();
    await pool.close();
    await driver.killAll();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("[a1] 上限は、そのプロジェクトの層B設定だけを見る（他プロジェクトに引きずられない）", () => {
    assert.equal(daemon.maxConcurrentSessions(projTight), 1, "絞っている側はその値");
    assert.equal(
      daemon.maxConcurrentSessions(projLoose),
      5,
      "設定を持たない側は Kobo の既定のまま（tight の 1 に引きずられない）"
    );
  });

  it("[a2][a3][a4] 一方が上限に達しても他方の ready は進み、見送りはログに残る", async () => {
    const out = await captureDaemonStderr(async () => {
      createReadyTask(daemon, projTight, "tight-1");
      createReadyTask(daemon, projTight, "tight-2");
      createReadyTask(daemon, projLoose, "loose-1");

      // [a2] tight-1 が tight の唯一の席を使って着手する
      await pollUntil(
        () => daemon.getTask(projTight, "tight-1")?.status,
        (status) => status === "planning"
      );
      // [a3] tight が埋まっていても、loose は掃引を打ち切られず着手する
      await pollUntil(
        () => daemon.getTask(projLoose, "loose-1")?.status,
        (status) => status === "planning"
      );
      // tight-2 が見送られたことがログに残るまで、もう一巡回らせる
      await new Promise((r) => setTimeout(r, 250));
    });

    assert.equal(daemon.getTask(projTight, "tight-1")?.status, "planning");
    assert.equal(
      daemon.getTask(projTight, "tight-2")?.status,
      "ready",
      "[a2] tight は席が無いので tight-2 は着手できず ready のまま残る"
    );
    assert.equal(
      daemon.getTask(projLoose, "loose-1")?.status,
      "planning",
      "[a3] 他プロジェクトの ready は見送られたプロジェクトに引きずられない"
    );

    // [a4] 黙って return しない——どのプロジェクトが・何人動いていて・上限がいくつだから
    // 見送ったのかが、ログから読めること
    assert.match(out, new RegExp(projTight), `見送ったプロジェクト名が読めること: ${out}`);
    assert.match(out, /1\/1/, `稼働数と上限が読めること: ${out}`);
    assert.match(out, /上限/, `上限に当たったことが読めること: ${out}`);
  });
});

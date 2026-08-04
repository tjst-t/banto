/**
 * ホスト再起動後の職人の復帰（task-0057 / imp-0017 / inc-0018・0019）。
 *
 * ここで守りたいのは3つ。
 *   - **畳んだ職人は起き直さない。** 番頭が意図して閉じたものを、再起動のたびに
 *     起こすのは意図に反する
 *   - **落ちる前に生きていた職人だけ起こす。** ホストが落ちると配下の職人は
 *     cgroup ごと落ちるので、畳んだ記録が無くプロセスも居ないものがそれにあたる
 *   - **再起動ループに餌をやらない。** 復帰した職人がホストを再起動すると、
 *     起こす→落ちる→また起こす、で無限ループになる（inc-0018）
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as childProcess from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { RuntimeDriver, SessionHandle, SpawnOptions, DriverEventHandler } from "@banto/core";
import { WorkerPool, resumeWorkers } from "@banto/worker-pool";

/** 起こす／殺すだけの偽ドライバ。プロセスの生死を本物で作るために sleep を使う。 */
class FakeDriver implements RuntimeDriver {
  injected: Array<{ sessionId: string; message: string }> = [];
  private counter = 0;
  private readonly children: childProcess.ChildProcess[] = [];
  private readonly sessionIdByPath = new Map<string, string>();

  async spawn(opts: SpawnOptions): Promise<SessionHandle> {
    this.counter++;
    const resume = opts.driverOptions?.["resumeSessionPath"];
    const sessionId =
      typeof resume === "string"
        ? (this.sessionIdByPath.get(resume) ?? `fake-${this.counter}`)
        : `fake-${this.counter}`;
    fs.mkdirSync(path.dirname(opts.sessionPath), { recursive: true });
    fs.writeFileSync(opts.sessionPath, "");
    const child = childProcess.spawn("sleep", ["30"], { stdio: "ignore", detached: false });
    this.children.push(child);
    this.sessionIdByPath.set(opts.sessionPath, sessionId);
    return { pid: child.pid!, sessionId, sessionPath: opts.sessionPath };
  }

  async inject(sessionId: string, message: string): Promise<void> {
    this.injected.push({ sessionId, message });
  }

  async kill(): Promise<void> {}
  subscribe(_handler: DriverEventHandler): () => void {
    return () => {};
  }

  /** ホストが落ちたときの再現。cgroup ごと落とされる形にならって SIGKILL する。 */
  killAllProcesses(): void {
    for (const child of this.children) {
      if (child.pid !== undefined && !child.killed) {
        try {
          process.kill(child.pid, "SIGKILL");
        } catch {
          // 既に終わっていれば何もしない
        }
      }
    }
  }

  cleanup(): void {
    this.killAllProcesses();
    this.children.length = 0;
  }
}

let dir: string;
let driver: FakeDriver;
let pool: WorkerPool;

const JOB = { taskId: "task-0042", worktreePath: "/tmp/wt", instruction: "調べて直して" };

/**
 * 復帰でメッセージが届いた数。
 *
 * `delegate` は最初の指示を inject するので、件数そのものでは判定できない
 * ——復帰の前後の差を見る。
 */
function wakeCount(before: number): number {
  return driver.injected.length - before;
}

/** プロセスが本当に落ちるまで待つ（state の導出が pid の生存を見るため）。 */
async function settle(): Promise<void> {
  await new Promise((r) => setTimeout(r, 150));
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "banto-resume-"));
  driver = new FakeDriver();
  pool = new WorkerPool({ driver, dataDir: dir, defaultProjectTag: "test" });
});

afterEach(() => {
  driver.cleanup();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("職人の復帰 — 落ちる前に生きていた職人だけ起こす", () => {
  it("ホストごと落ちた職人は起き直す", async () => {
    await pool.delegate(JOB);
    driver.killAllProcesses();
    await settle();

    const worker = pool.list({ includeClosed: true })[0]!;
    assert.equal(worker.state, "exited", "畳んだ記録が無くプロセスが居ない＝落ちる前は生きていた");

    const before = driver.injected.length;
    const results = await resumeWorkers({ pool, stateDir: dir, log: () => {} });
    assert.equal(results.length, 1);
    assert.equal(results[0]!.detail, "復帰");
    assert.equal(wakeCount(before), 1, "起こし直しのメッセージが届く");
  });

  it("畳んだ職人は起き直さない", async () => {
    const { sessionId } = await pool.delegate(JOB);
    await pool.close(sessionId, "stopped");
    driver.killAllProcesses();
    await settle();

    assert.equal(pool.list({ includeClosed: true })[0]!.state, "closed");

    const before = driver.injected.length;
    const results = await resumeWorkers({ pool, stateDir: dir, log: () => {} });
    assert.deepEqual(results, [], "畳んだものは対象にすら入らない");
    assert.equal(wakeCount(before), 0, "起こし直しのメッセージは飛ばない");
  });

  it("ホストを再起動しうるタスクは起き直さない", async () => {
    await pool.delegate({ ...JOB, taskId: "task-0124-self-restart" });
    driver.killAllProcesses();
    await settle();

    const before = driver.injected.length;
    const results = await resumeWorkers({ pool, stateDir: dir, log: () => {} });
    assert.equal(results.length, 1);
    assert.match(results[0]!.detail, /見送り/);
    assert.equal(wakeCount(before), 0);
  });

  it("検証用ワークツリーの職人は起き直さない", async () => {
    await pool.delegate({ ...JOB, worktreePath: "/home/x/worktrees/banto/feat-a" });
    driver.killAllProcesses();
    await settle();

    const before = driver.injected.length;
    const results = await resumeWorkers({ pool, stateDir: dir, log: () => {} });
    assert.match(results[0]!.detail, /見送り/);
    assert.equal(wakeCount(before), 0);
  });
});

describe("職人の復帰 — 再起動ループに餌をやらない", () => {
  it("前回の起動から間もないときは、復帰を丸ごと見送る", async () => {
    await pool.delegate(JOB);
    driver.killAllProcesses();
    await settle();

    // 1回目：前回の起動が記録されていないので普通に復帰する
    const first = await resumeWorkers({ pool, stateDir: dir, log: () => {} });
    assert.equal(first.length, 1);

    // 2回目：直後に起き直した＝ループの中。対象が居ても手を出さない
    const second = await resumeWorkers({ pool, stateDir: dir, log: () => {} });
    assert.deepEqual(second, [], "起動間隔で断つ。taskId では捕まえられない経路にも効く");
  });

  it("十分に間が空いていれば、次の起動では復帰する", async () => {
    await pool.delegate(JOB);
    driver.killAllProcesses();
    await settle();

    await resumeWorkers({ pool, stateDir: dir, log: () => {} });
    // 復帰すると職人は生き返るので、次の「ホスト再起動」を作るには落とし直す
    driver.killAllProcesses();
    await settle();

    // 猶予をゼロにすると「間が空いた」扱いになる
    const again = await resumeWorkers({ pool, stateDir: dir, restartLoopWindowMs: 0, log: () => {} });
    assert.equal(again.length, 1, "ループでないなら復帰は止めない");
    assert.equal(again[0]!.detail, "復帰");
  });
});

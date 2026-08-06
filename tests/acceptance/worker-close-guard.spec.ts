/**
 * task-0060 a4（ADR-0013 決定63）: **番頭は自分が起こしていない職人を畳めない。**
 *
 * Kobo が起こした職人を番頭が畳むと、Kobo の状態機械と実態が食い違う——Kobo は
 * 「実装中」のつもりで、実際には職人が居ない。畳むのは起こした側の仕事（I3）。
 *
 * **砦の置き場所は Tool を束ねる層**（`guardPathArg` と同じ）で、Worker Pool 側ではない。
 * Worker Pool は呼び出し元を区別できない——`worker.close` を叩いているのが番頭なのか
 * Kobo 自身なのかは、束ねている側にしか分からない。中核がモジュール名（"kobo"）を
 * 知る必要も無くなる：**自分の origin と違えば拒む**、それだけで足りる。
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { guardWorkerOrigin } from "../../packages/banto-host/src/worker-guard.js";
import { threadOrigin } from "../../packages/banto-host/src/worker-notice.js";
import type { NamespacedToolDefinition } from "../../packages/banto-host/src/tool-registry.js";
import { WorkerPool } from "../../packages/banto-worker-pool/src/pool.js";
import { createWorkerTools } from "../../packages/banto-worker-pool/src/worker-tools.js";
import { FakeRuntimeDriver } from "./worker-pool-harness.js";

const THREAD = "thread-abc";

describe("[task-0060/a4] 起こしていない職人は畳めない（決定63）", () => {
  let dataDir: string;
  let workDir: string;
  let pool: WorkerPool;
  let driver: FakeRuntimeDriver;
  let close: NamespacedToolDefinition;
  let stop: NamespacedToolDefinition;

  before(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "worker-guard-"));
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), "worker-guard-wt-"));
    driver = new FakeRuntimeDriver();
    pool = new WorkerPool({
      driver,
      dataDir,
      defaultProjectTag: "banto",
      defaultOrigin: "banto",
      idleTimeoutMs: 0,
    });

    // 番頭の会話に配られるのと同じ形で束ねる（bin.ts の Tool 束ね層と同じ）
    const tools = createWorkerTools(pool);
    const wrap = (name: string): NamespacedToolDefinition =>
      guardWorkerOrigin(
        tools.find((t) => t.name === name)!,
        threadOrigin(THREAD),
        async (sessionId) => pool.get(sessionId)
      );
    close = wrap("worker.close");
    stop = wrap("worker.stop");
  });

  after(async () => {
    for (const worker of pool.list({ includeClosed: false })) {
      await pool.close(worker.sessionId, "stopped").catch(() => undefined);
    }
    pool.dispose();
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(workDir, { recursive: true, force: true });
  });

  it("Kobo が起こした職人は畳めない。理由が呼び出し側に返る（I2）", async () => {
    const worker = await pool.delegate({
      taskId: "task-0001",
      origin: "kobo",
      worktreePath: workDir,
      instruction: "実装する",
    });

    await assert.rejects(
      () => close.execute({ sessionId: worker.sessionId }, { toolCallId: "t1" }),
      /起こした職人ではありません[\s\S]*kobo/,
      "拒む理由と、誰が起こしたかが返る"
    );
    await assert.rejects(
      () => stop.execute({ sessionId: worker.sessionId }, { toolCallId: "t2" }),
      /起こした職人ではありません/,
      "worker.stop も同じ（強制停止でも実態は消える）"
    );

    assert.equal(
      pool.get(worker.sessionId)?.state,
      "running",
      "拒んだのだから、職人は動いたまま"
    );
  });

  it("自分の会話で起こした職人は畳める", async () => {
    const worker = await pool.delegate({
      taskId: "task-0002",
      origin: threadOrigin(THREAD),
      worktreePath: workDir,
      instruction: "調べる",
    });

    await close.execute({ sessionId: worker.sessionId }, { toolCallId: "t3" });
    assert.equal(pool.get(worker.sessionId)?.state, "closed");
  });

  it("別の会話で起こした職人も畳めない（宛先はスレッド粒度・決定35a）", async () => {
    const worker = await pool.delegate({
      taskId: "task-0003",
      origin: threadOrigin("thread-xyz"),
      worktreePath: workDir,
      instruction: "調べる",
    });

    await assert.rejects(
      () => close.execute({ sessionId: worker.sessionId }, { toolCallId: "t4" }),
      /起こした職人ではありません/
    );
  });

  it("知らない職人は砦で判定しない（不在の説明は Worker Pool の方が正確）", async () => {
    await assert.rejects(
      () => close.execute({ sessionId: "no-such-session" }, { toolCallId: "t5" }),
      /Unknown worker/,
      "砦のメッセージではなく、Worker Pool の「知らない職人」が返る"
    );
  });
});

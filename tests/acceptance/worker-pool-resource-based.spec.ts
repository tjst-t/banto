/**
 * **Worker Pool 並行制御のリソースベース化**（設計書 2026-08-17・タスクC / E）。
 *
 * 本数の枠はそのまま**絶対の安全弁**として残し、**さらに空きメモリの判定**を加える。
 * 「重いランタイム（Claude）は空きに応じて抑え、軽い Pi は多数起動できる」ことを固定する。
 *
 * ここで固定するのは:
 *   a1 軽い Pi は空きメモリの許す範囲で多数起動でき、超えた分は断られる
 *   a2 重いランタイムは空きが小さいうちは抑えられ、軽いものはその後も通る
 *   a3 断りにはリソースの事情（想定消費の合計・空き）と直し方（切替え）が載る
 *   a4 `BANTO_WORKER_RESOURCE_BASED=0` で本数のみ判定に戻る（リソースのせいでは断らない）
 *   a5 環境変数の解決が I2 に従う（読めない値は黙って既定に落ちない）
 *
 * 実ホストの空きメモリは測るたびに変わるので、この試験では `resourceReader` に**固定値**を
 * 差し替えて確かめる（設計書 タスクA が求める差し替え口）。
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  WorkerPool,
  RESOURCE_BASED_ENV,
  DEFAULT_RESOURCE_BASED,
  resolveResourceBased,
  WORKER_LIMIT_CODE,
} from "../../packages/banto-worker-pool/src/pool.js";
import { CLAUDE_AGENT_DRIVER_ID } from "../../packages/banto-worker-pool/src/claude-agent/naming.js";
import { FakeRuntimeDriver } from "./worker-pool-harness.js";

describe("[リソースベース並行制御] 空きメモリで職人を起こす（設計書 タスクC）", () => {
  let dataDir: string;
  let workDir: string;
  let pool: WorkerPool;
  let claudeDriver: FakeRuntimeDriver;

  /**
   * 指定の空きメモリで工房を立てる。最大本数は大きくして、**本数では切らせずに
   * リソースのせいで切れる**形を作る。pi は既定 300 MiB 扱い。
   *
   * `resourceBased` を false にすれば本数のみ判定に戻る（a4）。
   */
  const start = (
    availableMiB: number,
    options: { resourceBased?: boolean; maxConcurrentWorkers?: number } = {}
  ): void => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "worker-res-"));
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), "worker-res-wt-"));
    const piDriver = new FakeRuntimeDriver();
    claudeDriver = new FakeRuntimeDriver();
    pool = new WorkerPool({
      driver: piDriver,
      runtimes: {
        [CLAUDE_AGENT_DRIVER_ID]: {
          driver: claudeDriver,
          title: "Claude Code",
          // 既定値（PO 確定）: Pi 300 / Claude 1200
          assumedResources: { memoryMiB: 1200 },
        },
      },
      dataDir,
      defaultProjectTag: "banto",
      defaultOrigin: "banto",
      idleTimeoutMs: 0,
      maxConcurrentWorkers: options.maxConcurrentWorkers ?? 20,
      resourceBased: options.resourceBased ?? true,
      resourceReader: () => ({ memoryMiB: availableMiB }),
    });
  };

  const stop = async (): Promise<void> => {
    for (const worker of pool.list({ includeClosed: false })) {
      await pool.close(worker.sessionId, "stopped").catch(() => undefined);
    }
    pool.dispose();
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(workDir, { recursive: true, force: true });
  };

  const delegatePi = (taskId: string): Promise<unknown> =>
    pool.delegate({ taskId, worktreePath: workDir, instruction: `${taskId} をやる` });

  const delegateClaude = (taskId: string): Promise<unknown> =>
    pool.delegate({
      taskId,
      worktreePath: workDir,
      instruction: `${taskId} をやる`,
      runtime: CLAUDE_AGENT_DRIVER_ID,
    });

  describe("a1: 軽い Pi は空きの範囲で多数起動でき、超えた分は断られる", () => {
    beforeEach(() => start(1000));
    afterEach(stop);

    it("Pi 300MiB × 3 本までは起き、4本目はリソースで断られる", async () => {
      for (const id of ["task-0001", "task-0002", "task-0003"]) {
        await delegatePi(id);
      }
      assert.equal(pool.concurrency().running, 3, "1000MiB ÷ 300MiB で3本は収まる");
      assert.equal(pool.concurrency().assumedMemoryMiB, 900, "想定消費の合計も数えている");

      const err = (await delegatePi("task-0004").then(
        () => undefined,
        (e: Error) => e
      )) as Error;
      assert.ok(err, "4本目は断られる");
      assert.match(err.message, new RegExp(WORKER_LIMIT_CODE + ":resource"), "リソースのせいで断った合印");
      assert.equal(pool.concurrency().running, 3, "断っても増えない（枠は返っている）");
    });
  });

  describe("a2: 重いランタイムは空きが小さいと抑えられ、軽いものはその後も通る", () => {
    beforeEach(() => start(1500));
    afterEach(stop);

    it("Claude 1200MiB は1本まで。Pi 300MiB はその後も起きられる", async () => {
      await delegateClaude("task-0101");
      assert.equal(pool.concurrency().running, 1);
      const err2 = (await delegateClaude("task-0102").then(
        () => undefined,
        (e: Error) => e
      )) as Error | undefined;
      assert.ok(err2, "2本目の Claude は断られる");
      assert.match(err2.message, /:\s*resource/);

      // 重いのが1本（1200）居ても、軽い Pi（300）は合計 1500 で収まる
      await delegatePi("task-0102-pi");
      assert.equal(pool.concurrency().running, 2, "軽いものは空きリソース内で通る");
    });
  });

  describe("a3: 断りにリソースの事情と直し方が載る", () => {
    beforeEach(() => start(600));
    afterEach(stop);

    it("本数は空いていても、空きメモリの理由と切替え方が読める", async () => {
      await delegatePi("task-0201"); // 300 MiB
      const err = (await delegateClaude("task-0202").then(
        () => undefined,
        (e: Error) => e
      )) as Error | undefined;
      assert.ok(err, "重い Claude が空きを超えて断られる");
      assert.match(err.message, /空きメモリが足りません/, "リソースの事情を言う");
      assert.match(err.message, /300 MiB/, "想定消費の合計が出る");
      assert.match(err.message, /ホストの空きは 600 MiB/, "空きが出る");
      assert.match(err.message, new RegExp(RESOURCE_BASED_ENV), "直し方（切替えられる）");
      // 本数はまだ空いている（= リソースのせいで断った）ことが分かる
      assert.match(err.message, /本数はまだ空いています（1\/20/, "本数のせいではないと明示");
    });
  });

  describe("a4: BANTO_WORKER_RESOURCE_BASED=0 で本数のみ判定に戻る", () => {
    it("空きが想定消費より小さくても、本数のせいでしか断らない", async () => {
      start(100, { resourceBased: false, maxConcurrentWorkers: 2 });
      try {
        await delegatePi("task-0301");
        await delegatePi("task-0302");
        // 空き 100MiB なのに Pi 300MiB を2本起こせている＝リソース判定が効いていない
        assert.equal(pool.concurrency().running, 2);
        const err = (await delegatePi("task-0303").catch((e: Error) => e)) as Error | undefined;
        assert.ok(err);
        assert.match(err.message, new RegExp(WORKER_LIMIT_CODE + ":"));
        assert.doesNotMatch(err.message, /空きメモリが足りません/, "本数のせいで断る（リソースでない）");
      } finally {
        await stop();
      }
    });
  });

  describe("a5: 環境変数の解決は I2 に従う", () => {
    it("既定は有効。0/false で無効、読めない値は断る", () => {
      assert.equal(resolveResourceBased({}), DEFAULT_RESOURCE_BASED);
      assert.equal(resolveResourceBased({ [RESOURCE_BASED_ENV]: "" }), DEFAULT_RESOURCE_BASED);
      assert.equal(resolveResourceBased({ [RESOURCE_BASED_ENV]: "0" }), false);
      assert.equal(resolveResourceBased({ [RESOURCE_BASED_ENV]: "false" }), false);
      assert.equal(resolveResourceBased({ [RESOURCE_BASED_ENV]: "1" }), true);
      for (const bad of ["はい", "2", "-1"]) {
        assert.throws(
          () => resolveResourceBased({ [RESOURCE_BASED_ENV]: bad }),
          new RegExp(RESOURCE_BASED_ENV),
          `"${bad}" は読めない値として断る`
        );
      }
    });
  });
});

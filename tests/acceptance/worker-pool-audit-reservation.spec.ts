/**
 * task-0230（task-0223 をスコープ訂正して置き換え）:
 * **同時本数の上限に、監査・判定のための席を確保する（早い者勝ちにしない）。**
 *
 * task-0216 で工房に同時本数の栓（既定6本）が入ったが、`reserveSlot` は**誰の依頼かを
 * 見ていない**——完全な早い者勝ちだった。そのため実装の職人が上限まで埋めると監査の
 * 職人が起こせず、タスクは `auditing` から出られない。レビューにも着地にも進めないまま、
 * 実装だけが席を取り続ける。2026-08-16 は「監査が起動できない」で3回落ちており、
 * 上限がある限り、早い者勝ちのままではこれが**恒常化する**（一時的な混雑ではない）。
 *
 * Kobo は役（`executor` / `audit` / `rework`）を知っているのに、工房へ渡していなかった
 * （a3）。それを直しても、**入口（`bin.ts`）が環境変数を読んで工房へ渡さなければ
 * 予約席は既定 0 のまま立ち、稼働では1ミリも効かない**——task-0223 はその配線を
 * スコープ外に置いたまま着地し、稼働で3回落ちた（PO裁定・取次 in-491f752a）。
 * task-0230 はその配線（`bin.ts`）をスコープに入れて置き換える。
 *
 * ここで固定するのは6つ:
 *
 *   a1 実装の職人だけで埋めても、監査（auditor）の職人は起こせる
 *   a2 実装は「上限 − 予約席」で断られ、断りに**どちらの枠で断ったか**が載る
 *   a3 役を渡さない依頼は実装（executor）として数えられる
 *   a4 予約席は環境変数で変えられ、読めない値は黙って既定に落ちない（I2）
 *   a5 入口（`bin.ts`）が予約席を読んで工房へ渡している（配線漏れの再発防止）
 *   a6 `worker.list` から実装と判定の内訳が読める
 *
 * **この試験は Kobo も worker-pool の独立プロセスも1つも立てない**（決定23・task-0216
 * の a6）。席の配分は工房（`WorkerPool`）が単体で持つもので、それを確かめるのに Kobo や
 * 独立プロセスを立てないと確かめられないなら依存の向きが壊れている。Kobo 側（役を渡して
 * いる）と入口側（環境変数を渡している）はどちらも工房から起こせないので、源（ソースの
 * 文字列）で確かめる。
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import {
  WorkerPool,
  AUDIT_RESERVED_ENV,
  DEFAULT_AUDIT_RESERVED_WORKERS,
  DEFAULT_MAX_CONCURRENT_WORKERS,
  WORKER_LIMIT_CODE,
  resolveAuditReservedWorkers,
} from "../../packages/banto-worker-pool/src/pool.js";
import {
  createWorkerModuleTools,
  createWorkerTools,
} from "../../packages/banto-worker-pool/src/worker-tools.js";
import { FakeRuntimeDriver } from "./worker-pool-harness.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const POOL_SOURCE = path.join(HERE, "../../packages/banto-worker-pool/src/pool.ts");
const DAEMON_SOURCE = path.join(HERE, "../../packages/banto-daemon/src/daemon.ts");
const BIN_SOURCE = path.join(HERE, "../../packages/banto-worker-pool/src/bin.ts");

describe("[task-0230] 同時本数の上限に、監査・判定のための席を確保する", () => {
  let dataDir: string;
  let workDir: string;
  let pool: WorkerPool;
  let driver: FakeRuntimeDriver;

  /**
   * 上限 4 本・予約席 2 の工房を立てる（実装は 2 本まで）。
   *
   * 小さい方が「実装の枠だけ満杯」を素直に作れる。既定（6 本・予約 2）と同じ形で、
   * 数だけ小さい。
   */
  const start = (maxConcurrentWorkers = 4, auditReservedWorkers = 2): void => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "worker-audit-seat-"));
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), "worker-audit-seat-wt-"));
    driver = new FakeRuntimeDriver();
    pool = new WorkerPool({
      driver,
      dataDir,
      defaultProjectTag: "banto",
      defaultOrigin: "banto",
      // 安全弁は切る（task-0221 の掃除は別の試験の担当）
      idleTimeoutMs: 0,
      maxConcurrentWorkers,
      auditReservedWorkers,
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

  /** 実装の職人を頼む（役を明示する）。 */
  const executor = (taskId: string): Promise<unknown> =>
    pool.delegate({ taskId, worktreePath: workDir, instruction: `${taskId} を実装する`, role: "executor" });

  /** 監査の職人を頼む。 */
  const auditor = (taskId: string): Promise<unknown> =>
    pool.delegate({ taskId, worktreePath: workDir, instruction: `${taskId} を監査する`, role: "auditor" });

  /** 役を渡さずに頼む（番頭が直に起こす形）。 */
  const anonymous = (taskId: string): Promise<unknown> =>
    pool.delegate({ taskId, worktreePath: workDir, instruction: `${taskId} をやる` });

  describe("a1: 実装だけで埋めても、監査の職人は起こせる", () => {
    beforeEach(() => start(4, 2));
    afterEach(stop);

    it("実装は上限 − 予約席 で頭打ちになり、そのあとでも監査は通る", async () => {
      await executor("task-0001");
      await executor("task-0002");
      assert.equal(pool.concurrency().byRole.executor, 2, "実装の取り分（4 − 2）まで埋まった");

      // **ここが task-0223 の本体**：合計はまだ 2/4 なのに、実装はもう取れない
      await assert.rejects(() => executor("task-0003"), new RegExp(WORKER_LIMIT_CODE));
      assert.equal(pool.concurrency().running, 2, "断っても本数は増えない（枠は返っている）");

      // 監査は取り置かれた席で起きられる——早い者勝ちならここで起きられなかった
      await auditor("task-0001-audit");
      await auditor("task-0002-audit");
      assert.deepEqual(
        { executor: pool.concurrency().byRole.executor, auditor: pool.concurrency().byRole.auditor },
        { executor: 2, auditor: 2 },
        "実装2本・監査2本で上限ぴったり"
      );
    });

    it("監査でも合計の上限は超えない（予約席は上限を増やす仕掛けではない）", async () => {
      await executor("task-0101");
      await executor("task-0102");
      await auditor("task-0101-audit");
      await auditor("task-0102-audit");
      assert.equal(pool.concurrency().running, 4, "上限まで走っている");

      await assert.rejects(() => auditor("task-0103-audit"), new RegExp(WORKER_LIMIT_CODE));
      assert.equal(pool.concurrency().running, 4, "監査でも上限は超えない");
    });

    it("監査が予約席より多く座っていても、合計の上限までで断られる", async () => {
      // 監査が 3 本（予約席 2 より多い）＋実装 1 本＝4 本。実装の取り分（2）は
      // 余っているが、合計は満杯——ここで通すと上限が意味を失う
      await auditor("task-0201-audit");
      await auditor("task-0202-audit");
      await auditor("task-0203-audit");
      await executor("task-0204");
      assert.equal(pool.concurrency().running, 4);

      const err = await executor("task-0205").catch((e: Error) => e);
      assert.ok(err instanceof Error, "断られる");
      assert.match(err.message, new RegExp(WORKER_LIMIT_CODE));
      assert.match(
        err.message,
        /同時に走れる職人は 4 本まで/,
        "実装の枠ではなく、合計の上限で断ったことが分かる"
      );
    });

    it("畳めば席は返る（実装の枠も監査の枠も）", async () => {
      await executor("task-0301");
      await executor("task-0302");
      await assert.rejects(() => executor("task-0303"), new RegExp(WORKER_LIMIT_CODE));

      const first = pool.list({ includeClosed: false })[0]!;
      await pool.close(first.sessionId, "stopped");
      assert.equal(pool.concurrency().byRole.executor, 1, "畳んだ分は実装の枠から減る");

      await executor("task-0303");
      assert.equal(pool.concurrency().byRole.executor, 2, "空いた席にはまた座れる");
    });
  });

  describe("a2: 断りに、どちらの枠で断ったかが載る", () => {
    beforeEach(() => start(4, 2));
    afterEach(stop);

    it("実装の枠で断ったときは、監査なら通ることまで読める", async () => {
      await executor("task-0401");
      await executor("task-0402");
      const err = await executor("task-0403").catch((e: Error) => e);
      assert.ok(err instanceof Error);
      const message = err.message;

      assert.match(message, new RegExp(`${WORKER_LIMIT_CODE}:2/2`), "合印は実装の枠の 本数/上限");
      assert.match(message, /実装の枠が埋まっています（2\/2/, "どちらの枠で断ったか");
      assert.match(message, /監査・判定用に 2 席空けてあります/, "なぜ合計に空きがあるのに断るのか");
      assert.match(message, /合計は 2\/4 本/, "合計の本数も読める");
      assert.match(message, /role: auditor/, "次の手（監査なら通る）が読める");
      assert.match(message, new RegExp(AUDIT_RESERVED_ENV), "予約席の変え方");
      assert.match(message, /task-0401/, "誰が座っているか（畳む相手を選べる）");
    });

    it("合計の上限で断ったときは、実装と監査の内訳が載る", async () => {
      await executor("task-0501");
      await executor("task-0502");
      await auditor("task-0501-audit");
      await auditor("task-0502-audit");
      const err = await auditor("task-0503-audit").catch((e: Error) => e);
      assert.ok(err instanceof Error);

      assert.match(err.message, new RegExp(`${WORKER_LIMIT_CODE}:4/4`), "合印は合計の 本数/上限");
      assert.match(err.message, /内訳: 実装 2 本 \/ 監査・判定 2 本/, "どちらで埋まっているか");
      assert.doesNotMatch(
        err.message,
        /実装の枠が埋まっています/,
        "監査を実装の枠のせいにしない（読んだ番頭が実装を畳んでも通らない）"
      );
    });

    it("一覧に載る職人には役の印が付く（畳む相手を役で選べる）", async () => {
      await executor("task-0601");
      await executor("task-0602");
      const err = await executor("task-0603").catch((e: Error) => e);
      assert.ok(err instanceof Error);
      assert.match(err.message, /\[実装\] task-0601/, "実装の職人だと分かる");
    });
  });

  describe("a3: 役を渡さない依頼は実装として数える", () => {
    beforeEach(() => start(4, 2));
    afterEach(stop);

    it("番頭が直に起こした職人も実装の枠を使う", async () => {
      await anonymous("task-0701");
      await anonymous("task-0702");
      assert.equal(pool.concurrency().byRole.executor, 2, "役を渡さない分も実装として数える");
      assert.equal(pool.concurrency().slots[0]!.role, "executor", "枠にも役が載る");

      // 数えていなければ、番頭が起こした職人の分だけ監査の席が黙って食われる
      await assert.rejects(() => anonymous("task-0703"), new RegExp(WORKER_LIMIT_CODE));
    });

    it("`worker.delegate_toolkit` は役を工房まで運ぶ（起動元 → 席の配分）", async () => {
      const tools = createWorkerModuleTools(pool);
      const delegate = tools.find((t) => t.name === "worker.delegate_toolkit");
      assert.ok(delegate, "worker.delegate_toolkit がある");

      await delegate.execute(
        { taskId: "task-0801", worktreePath: workDir, instruction: "実装する" },
        { toolCallId: "t1" }
      );
      await delegate.execute(
        { taskId: "task-0802", worktreePath: workDir, instruction: "実装する" },
        { toolCallId: "t2" }
      );
      // 役を渡さない呼び出しは実装。ここで実装の枠が埋まる
      assert.equal(pool.concurrency().byRole.executor, 2);

      await delegate.execute(
        {
          taskId: "task-0801-audit",
          worktreePath: workDir,
          instruction: "監査する",
          role: "auditor",
        },
        { toolCallId: "t3" }
      );
      assert.equal(pool.concurrency().byRole.auditor, 1, "auditor として席を取れた");
    });

    it("Kobo は自分が持っている役を工房へ渡している（依存の向きは変えない）", () => {
      /**
       * Kobo を立てずに確かめるので、ここは**源の確認**にする。
       * 工房から Kobo を import すると決定23 が壊れるため、実物を動かすのは
       * Kobo 側の試験の担当。ここが押さえるのは「渡し忘れ」だけ。
       */
      const source = fs.readFileSync(DAEMON_SOURCE, "utf-8");
      const at = source.indexOf('"worker.delegate_toolkit"');
      assert.ok(at > 0, "Kobo は worker.delegate_toolkit で職人を起こす");
      const call = source.slice(at, at + 2000);
      assert.match(call, /role:/, "役を渡している");
      assert.match(call, /"auditor"/, "監査は auditor として渡る");
    });
  });

  describe("a4: 予約席は環境変数で変えられ、読めない値は黙って落ちない（I2）", () => {
    it("既定は 2 席。空・未設定は既定に戻る", () => {
      assert.equal(DEFAULT_AUDIT_RESERVED_WORKERS, 2);
      assert.equal(resolveAuditReservedWorkers({}), DEFAULT_AUDIT_RESERVED_WORKERS);
      assert.equal(
        resolveAuditReservedWorkers({ [AUDIT_RESERVED_ENV]: "" }),
        DEFAULT_AUDIT_RESERVED_WORKERS
      );
    });

    it("数で変えられる（0 は取り置かない）", () => {
      assert.equal(resolveAuditReservedWorkers({ [AUDIT_RESERVED_ENV]: "1" }), 1);
      assert.equal(resolveAuditReservedWorkers({ [AUDIT_RESERVED_ENV]: " 3 " }), 3);
      assert.equal(resolveAuditReservedWorkers({ [AUDIT_RESERVED_ENV]: "0" }), 0, "0 は取り置かない");
    });

    it("読めない値は例外にする（黙って既定に落とすと「変えたつもりで効いていない」が残る）", () => {
      for (const bad of ["two", "-1", "1.5", "1 2"]) {
        assert.throws(
          () => resolveAuditReservedWorkers({ [AUDIT_RESERVED_ENV]: bad }),
          new RegExp(AUDIT_RESERVED_ENV),
          `"${bad}" は読み取れない値として断る`
        );
      }
    });

    it("予約席が上限以上なら工房が立たない（実装が1本も起こせない設定を黙って許さない）", () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "worker-audit-seat-bad-"));
      try {
        assert.throws(
          () =>
            new WorkerPool({
              driver: new FakeRuntimeDriver(),
              dataDir: dir,
              defaultProjectTag: "banto",
              maxConcurrentWorkers: 2,
              auditReservedWorkers: 2,
            }),
          new RegExp(AUDIT_RESERVED_ENV)
        );
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    it("予約席 0 なら task-0216 のまま（枠は1つ・断りも従来の言い方）", async () => {
      start(2, 0);
      try {
        await executor("task-0901");
        await auditor("task-0902");
        const err = await executor("task-0903").catch((e: Error) => e);
        assert.ok(err instanceof Error);
        assert.match(err.message, new RegExp(`${WORKER_LIMIT_CODE}:2/2`));
        assert.match(err.message, /同時に走れる職人は 2 本まで/);
        assert.doesNotMatch(
          err.message,
          /実装の枠が埋まっています/,
          "枠が1つしかないのに枠の話をしない"
        );
      } finally {
        await stop();
      }
    });

    it("既定の 6 本の内訳が、役を入れた形で書き直されている", () => {
      // 数字だけ置かないための記録（task-0216 a3 と同じ流儀）。予約席を入れた以上、
      // 「Kobo の5本＋番頭の1本」という内訳はもう実態と合わない
      const source = fs.readFileSync(POOL_SOURCE, "utf-8");
      const doc = source.slice(0, source.indexOf("export const DEFAULT_MAX_CONCURRENT_WORKERS"));
      const rationale = doc.slice(doc.lastIndexOf("/**"));
      assert.equal(DEFAULT_MAX_CONCURRENT_WORKERS, 6, "上限そのものは上げない");
      assert.match(rationale, /内訳/, "6 の内訳が書いてある");
      assert.match(rationale, /監査/, "監査の取り分に触れている");
      assert.match(rationale, /task-0223/, "いつ書き直したかが辿れる");
    });
  });

  describe("a5: 入口（bin.ts）が予約席を読んで工房へ渡している", () => {
    it("BANTO_WORKER_AUDIT_RESERVED を読んで WorkerPool へ渡している（配線漏れの再発防止）", () => {
      /**
       * 実物の独立プロセスは起こさない（ファイル冒頭の通り、ここは配線の有無を確かめる
       * 場）。この配線が抜けたまま2026-08-16に3回稼働に出て、予約席が既定 0 のまま
       * 立った（task-0223→task-0230）。次に同じ抜けが起きても検知できるよう、源で
       * 確かめる。
       */
      const source = fs.readFileSync(BIN_SOURCE, "utf-8");
      assert.match(
        source,
        /resolveAuditReservedWorkers\(process\.env\)/,
        "入口が環境変数を読んでいる"
      );

      const poolAt = source.indexOf("new WorkerPool({");
      assert.ok(poolAt > 0, "工房を組み立てている");
      const construction = source.slice(poolAt, source.indexOf("});", poolAt));
      assert.match(
        construction,
        /auditReservedWorkers,/,
        "読んだ値を WorkerPool へ渡している——渡さないと既定 0 のまま立ち、予約席が1ミリも効かない"
      );
    });
  });

  describe("a6: worker.list から実装と判定の内訳が読める", () => {
    beforeEach(() => start(4, 2));
    afterEach(stop);

    it("合計だけでなく、実装の取り分と監査の本数が一覧の末尾に出る", async () => {
      await executor("task-1001");
      await auditor("task-1001-audit");

      const tools = createWorkerTools(pool);
      const list = tools.find((t) => t.name === "worker.list");
      assert.ok(list, "worker.list がある");
      const result = await list.execute({}, { toolCallId: "t1" });
      const text = result.content[0]!.text!;

      assert.match(text, /同時に走っている職人: 2 \/ 4 本/, "合計は従来どおり読める");
      assert.match(text, /実装（executor）: 1 \/ 2 本/, "実装は取り分つきで読める");
      assert.match(text, /監査・判定（auditor）: 1 本/, "監査の本数も読める");
      assert.match(text, new RegExp(AUDIT_RESERVED_ENV), "予約席の変え方も読める");

      const details = result.details as {
        concurrency: {
          byRole: { executor: number; auditor: number };
          executorLimit: number;
          auditReserved: number;
        };
      };
      assert.deepEqual(details.concurrency.byRole, { executor: 1, auditor: 1 });
      assert.equal(details.concurrency.executorLimit, 2);
      assert.equal(details.concurrency.auditReserved, 2);
    });

    it("実装の枠が満杯なら、一覧の時点で「監査なら通る」と分かる", async () => {
      await executor("task-1101");
      await executor("task-1102");

      const tools = createWorkerTools(pool);
      const list = tools.find((t) => t.name === "worker.list")!;
      const result = await list.execute({}, { toolCallId: "t1" });
      const text = result.content[0]!.text!;

      // 合計は 2/4 なので「満杯です」は出ない。**内訳を見ないと断られる理由が分からない**
      assert.doesNotMatch(text, /\*\*満杯です\*\*/);
      assert.match(text, /実装（executor）: 2 \/ 2 本（\*\*この枠は満杯\*\*/);
    });
  });

  describe("a7: リソース不足の断りと worker.list の空きメモリ・想定消費表示（task-0255）", () => {
    /**
     * 空きメモリを固定して立てる（実際にメモリを消費せず「少ない」を決定的に作る）。
     *
     * リソース不足の断りはホストの空きメモリに依存するため、実機の空きに左右されると
     * 間欠的に落ちる（P6）。{@link WorkerPoolOptions.resourceReader} で固定して再現する。
     */
    const startResource = (maxConcurrentWorkers: number, availableMemoryMiB: number): void => {
      dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "worker-resource-"));
      workDir = fs.mkdtempSync(path.join(os.tmpdir(), "worker-resource-wt-"));
      driver = new FakeRuntimeDriver();
      pool = new WorkerPool({
        driver,
        dataDir,
        defaultProjectTag: "banto",
        defaultOrigin: "banto",
        idleTimeoutMs: 0,
        maxConcurrentWorkers,
        auditReservedWorkers: 2,
        resourceReader: () => ({ memoryMiB: availableMemoryMiB }),
      });
    };
    afterEach(stop);

    it("空きメモリが足りないと、その理由（空き・想定消費・合印）が文面に載って断る", async () => {
      startResource(4, 500);
      await executor("task-r1"); // 想定 300 → 空き 500 にはまだ収まる（本数は 1/4）

      // 本数の上限（4）には余りがあるのに、想定消費 300+300=600 が空き 500 を超える
      const err = await executor("task-r2").catch((e: Error) => e);
      assert.ok(err instanceof Error, "断られる");
      // 機械が見分けるための合印。本数の断り（`本数/上限`）と別に、`:resource` を使う
      assert.match(err.message, new RegExp(`${WORKER_LIMIT_CODE}:resource`));
      // 人が読んで次の手を選ぶための中身
      assert.match(err.message, /空きメモリが足りません/, "理由がリソース不足だと分かる");
      assert.ok(err.message.includes("task-r2"), "起こせなかったのは誰か");
      assert.equal(pool.concurrency().running, 1, "断っても本数は増えない（枠は返っている）");
    });

    it("worker.list に空きメモリと想定消費合計が載る（断られる前に読める）", async () => {
      startResource(4, 500);
      await executor("task-r1");

      const tools = createWorkerTools(pool);
      const list = tools.find((t) => t.name === "worker.list")!;
      const result = await list.execute({}, { toolCallId: "t1" });
      const text = result.content[0]!.text!;
      assert.match(text, /ホストの空き 500 MiB/);
      assert.match(text, /職人の想定消費の合計 300 MiB/);
    });
  });
});

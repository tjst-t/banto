/**
 * task-0216: **同時に走る職人の本数に上限を持たせる（Worker Pool 自身が断る）。**
 *
 * 2026-08-16、9本の職人が同時に走り、工房（`banto-worker-pool.service`）が1日で少なくとも
 * 7回 OOM で揺れた。職人1本ごとに 2 GiB の袋（cgroup）が貼られていて、`memory.oom.group`
 * に当たるとその職人の袋ごと全プロセスが死ぬ——巻き添えで「中身は無罪なのに落ちた」
 * タスクが7本出ている。原因は単純で、**「何本まで走ってよいか」を誰も決めていなかった**。
 *
 * Kobo には同時セッション数の上限があるが、それは Kobo が回すセッションの数で、
 * **番頭が直に起こす職人（`worker.delegate`）は数えていない**。そして決定23（ADR-0010）が
 * 課す制約——「Worker Pool は Kobo から独立していて、Kobo 無しでも成立する」——により、
 * 上限は**工房自身が持たなければならない**。Kobo に持たせると独立性が壊れる。
 *
 * ここで固定するのは6つ:
 *
 *   a1 上限に達したら spawn は断られる（転ばず・黙って待たせず）
 *   a2 断りの文面に、本数・上限・それぞれの taskId と起動時刻が載る
 *   a3 上限は環境変数で変えられ、既定値とその根拠が実装に明記されている
 *   a4 数えるのは生きている職人だけ（畳んだ・落ちた・安全弁で畳まれた分は減る）
 *   a5 いま何本走っていて上限が何本かが、既存の覗き窓（`worker.list`）から読める
 *   a6 上限の判定は Kobo に依存せず Worker Pool 単体で成立する（決定23）
 */

import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import {
  WorkerPool,
  DEFAULT_MAX_CONCURRENT_WORKERS,
  MAX_CONCURRENT_ENV,
  WORKER_LIMIT_CODE,
  resolveMaxConcurrentWorkers,
} from "../../packages/banto-worker-pool/src/pool.js";
import { createWorkerTools } from "../../packages/banto-worker-pool/src/worker-tools.js";
import { FakeRuntimeDriver } from "./worker-pool-harness.js";

const POOL_SOURCE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../packages/banto-worker-pool/src/pool.ts"
);

describe("[task-0216] 同時に走る職人の本数に上限を持たせる", () => {
  let dataDir: string;
  let workDir: string;
  let pool: WorkerPool;
  let driver: FakeRuntimeDriver;

  /** 上限 2 本の工房を立てる。少ない方が「満杯」を素直に作れる。 */
  const start = (maxConcurrentWorkers: number): void => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "worker-limit-"));
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), "worker-limit-wt-"));
    driver = new FakeRuntimeDriver();
    pool = new WorkerPool({
      driver,
      dataDir,
      defaultProjectTag: "banto",
      defaultOrigin: "banto",
      // 安全弁は切っておく。畳まれるのを試すところでは `sweepIdle` を直に呼ぶ
      idleTimeoutMs: 0,
      maxConcurrentWorkers,
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

  const sleep = (ms: number): Promise<void> =>
    new Promise((resolve) => {
      setTimeout(resolve, ms);
    });

  const delegate = (taskId: string): Promise<unknown> =>
    pool.delegate({ taskId, worktreePath: workDir, instruction: `${taskId} をやる` });

  describe("a1/a2: 上限に達したら、次の手が選べる断り方で断る", () => {
    beforeEach(() => start(2));
    afterEach(stop);

    it("上限までは通り、超えた分は転ばずに断られる（待ち行列は作らない）", async () => {
      await delegate("task-0001");
      await delegate("task-0002");
      assert.equal(pool.concurrency().running, 2, "2本走っている");

      const startedAt = Date.now();
      await assert.rejects(
        () => delegate("task-0003"),
        (err: Error) => {
          assert.match(err.message, /同時に走れる職人は 2 本まで/, "断りであって、内部の転びではない");
          return true;
        }
      );
      // **黙って待たせない**：待ち行列を作っていたら、ここは即座には返らない
      assert.ok(Date.now() - startedAt < 3000, "断りは即座に返る（待たされていない）");

      assert.equal(driver.sessions.length, 2, "断った分のセッションは作られていない");
      assert.equal(pool.concurrency().running, 2, "断っても本数は増えない（枠は返っている）");
    });

    it("断りには、本数・上限・誰が・いつから が載る（a2）", async () => {
      const first = (await pool.delegate({
        taskId: "task-0101",
        worktreePath: workDir,
        instruction: "調べる",
      })) as { spawnedAt: string };
      const second = (await pool.delegate({
        taskId: "task-0102",
        projectTag: "kobo",
        worktreePath: workDir,
        instruction: "直す",
      })) as { spawnedAt: string };

      const err = await delegate("task-0103").then(
        () => undefined,
        (e: Error) => e
      );
      assert.ok(err, "断られる");
      const message = err.message;

      // 機械が見分けるための合印（文言を直した日に黙って壊れないため）
      assert.match(message, new RegExp(`${WORKER_LIMIT_CODE}:2/2`), "合印に 本数/上限 が載る");
      // 人が読んで次の手を選ぶための中身
      assert.match(message, /いま 2 本走っています/, "いま何本走っているか");
      assert.match(message, /同時に走れる職人は 2 本まで/, "上限が何本か");
      assert.match(message, /task-0103/, "起こせなかったのは誰か");
      for (const [taskId, worker] of [
        ["task-0101", first],
        ["task-0102", second],
      ] as const) {
        assert.match(message, new RegExp(taskId), `走っている ${taskId} が名指しされる`);
        assert.ok(
          message.includes(worker.spawnedAt),
          `${taskId} の起動時刻（${worker.spawnedAt}）が載る`
        );
      }
      assert.match(message, /\[kobo\]/, "どの利用者の職人かも載る（畳んでよいか判断できる）");
      assert.match(message, /worker\.close/, "次の手（何をすればよいか）が書いてある");
      assert.match(message, new RegExp(MAX_CONCURRENT_ENV), "上限の変え方も書いてある");
    });

    it("同時に頼まれても上限を超えない（台帳に載る前の枠も数える）", async () => {
      await delegate("task-0201");
      // 起こすのに時間がかかる状況を、時間ではなく仕掛けで作る（残り枠は1本）
      driver.spawnDelayMs = 200;

      const results = await Promise.allSettled([delegate("task-0202"), delegate("task-0203")]);
      const ok = results.filter((r) => r.status === "fulfilled");
      const ng = results.filter((r) => r.status === "rejected");

      assert.equal(ok.length, 1, "通るのは1本だけ");
      assert.equal(ng.length, 1, "もう1本は断られる");
      assert.match(
        (ng[0] as PromiseRejectedResult).reason.message,
        new RegExp(WORKER_LIMIT_CODE),
        "断りの理由は上限（別の失敗にすり替わっていない）"
      );
      assert.equal(pool.concurrency().running, 2, "上限を超えて走っていない");
      driver.spawnDelayMs = 0;
    });
  });

  describe("a4: 数えるのは生きている職人だけ", () => {
    beforeEach(() => start(2));
    afterEach(stop);

    it("畳んだ職人は数から減り、また起こせる", async () => {
      const first = (await pool.delegate({
        taskId: "task-0301",
        worktreePath: workDir,
        instruction: "やる",
      })) as { sessionId: string };
      await delegate("task-0302");
      await assert.rejects(() => delegate("task-0303"), new RegExp(WORKER_LIMIT_CODE));

      await pool.close(first.sessionId, "done");
      assert.equal(pool.concurrency().running, 1, "畳んだ分は減る");
      // 畳んだ職人は一覧には残る（決定30c）が、**数には入らない**
      assert.ok(
        pool.list({ includeClosed: true }).some((w) => w.sessionId === first.sessionId),
        "畳んでも履歴からは消えない"
      );

      await delegate("task-0303");
      assert.equal(pool.concurrency().running, 2, "畳んだ後はまた起こせる");
    });

    it("落ちた職人は数から減る（中身が無罪でも落ちるときは落ちる）", async () => {
      await delegate("task-0401");
      await delegate("task-0402");
      await assert.rejects(() => delegate("task-0403"), new RegExp(WORKER_LIMIT_CODE));

      // 実プロセスごと落とす（イベントだけ流して台帳では生きている、を作らない）
      driver.exit(driver.sessions[0]!.sessionId, 137, "SIGKILL");
      await new Promise((r) => setTimeout(r, 50));

      assert.equal(pool.concurrency().running, 1, "落ちた分は減る");
      await delegate("task-0403");
      assert.equal(pool.concurrency().running, 2);
    });

    it("アイドル安全弁で畳まれた分も減る", async () => {
      await delegate("task-0501");
      await delegate("task-0502");
      assert.equal(pool.concurrency().running, 2);

      // 安全弁を入れ、十分に先の時刻で点検させる（時間を待たずに同じ経路を通す）
      pool.setIdleTimeout(60_000, 60_000);
      const closed = await pool.sweepIdle(Date.now() + 10 * 60_000);
      assert.equal(closed, 2, "2本とも安全弁で畳まれた");
      assert.equal(pool.concurrency().running, 0, "安全弁で畳まれた分も減る");

      pool.setIdleTimeout(0);
      await delegate("task-0503");
      assert.equal(pool.concurrency().running, 1, "畳まれた後はまた起こせる");
    });
  });

  describe("a5: いま何本走っていて上限が何本かが覗き窓から読める", () => {
    beforeEach(() => start(2));
    afterEach(stop);

    it("worker.list に本数と上限が出る（満杯なら満杯と出る）", async () => {
      const list = createWorkerTools(pool).find((t) => t.name === "worker.list")!;

      const empty = await list.execute({}, { toolCallId: "t0" });
      assert.match(
        empty.content[0]!.text!,
        /同時に走っている職人: 0 \/ 2 本/,
        "1人も居なくても、あと何本頼めるかが読める"
      );

      await delegate("task-0601");
      const one = await list.execute({}, { toolCallId: "t1" });
      assert.match(one.content[0]!.text!, /同時に走っている職人: 1 \/ 2 本/);
      assert.doesNotMatch(one.content[0]!.text!, /満杯/, "まだ余っている");

      await delegate("task-0602");
      const full = await list.execute({}, { toolCallId: "t2" });
      assert.match(full.content[0]!.text!, /同時に走っている職人: 2 \/ 2 本/);
      assert.match(full.content[0]!.text!, /満杯/, "断られる前に満杯だと分かる");
      assert.match(full.content[0]!.text!, new RegExp(MAX_CONCURRENT_ENV), "変え方も読める");

      // 画面（GUI）も同じ値を読めるように、構造でも返す
      const details = full.details as { concurrency: { running: number; limit: number } };
      assert.equal(details.concurrency.running, 2);
      assert.equal(details.concurrency.limit, 2);
    });
  });

  describe("a3: 上限は環境変数で変えられ、既定と根拠が実装に書いてある", () => {
    it("環境変数が上限を決める（未設定なら既定・0 で上限なし）", () => {
      assert.equal(resolveMaxConcurrentWorkers({}), DEFAULT_MAX_CONCURRENT_WORKERS);
      assert.equal(resolveMaxConcurrentWorkers({ [MAX_CONCURRENT_ENV]: "" }), DEFAULT_MAX_CONCURRENT_WORKERS);
      assert.equal(resolveMaxConcurrentWorkers({ [MAX_CONCURRENT_ENV]: "3" }), 3);
      assert.equal(resolveMaxConcurrentWorkers({ [MAX_CONCURRENT_ENV]: " 12 " }), 12);
      assert.equal(resolveMaxConcurrentWorkers({ [MAX_CONCURRENT_ENV]: "0" }), 0, "0 は上限なし");
    });

    it("読めない値は黙って既定に落ちない（I2）", () => {
      for (const bad of ["いっぱい", "-1", "2.5", "6本"]) {
        assert.throws(
          () => resolveMaxConcurrentWorkers({ [MAX_CONCURRENT_ENV]: bad }),
          new RegExp(MAX_CONCURRENT_ENV),
          `"${bad}" は断る（変えたつもりで効いていない、を作らない）`
        );
      }
    });

    it("0 を渡した工房は上限なしで走る（試験・単発の道具立て）", async () => {
      start(0);
      try {
        for (const id of ["task-0701", "task-0702", "task-0703"]) await delegate(id);
        assert.equal(pool.concurrency().running, 3);
        assert.equal(pool.concurrency().limit, 0, "0 は上限なしの意味");
      } finally {
        await stop();
      }
    });

    it("既定は事故のあった本数より下で、根拠が数字だけで置かれていない", () => {
      assert.ok(
        DEFAULT_MAX_CONCURRENT_WORKERS > 0 && DEFAULT_MAX_CONCURRENT_WORKERS < 9,
        `既定（${DEFAULT_MAX_CONCURRENT_WORKERS}）は、事故のあった 9 本より下にある`
      );
      const source = fs.readFileSync(POOL_SOURCE, "utf-8");
      const doc = source.slice(0, source.indexOf("export const DEFAULT_MAX_CONCURRENT_WORKERS"));
      const rationale = doc.slice(doc.lastIndexOf("/**"));
      // 「最悪値で置く」と「実測で置く」のどちらを採ったかが書いてあること（数字だけ置かない）
      assert.match(rationale, /実測/, "実測に触れている");
      assert.match(rationale, /2 GiB/, "職人1本の袋の上限に触れている");
      assert.match(rationale, /採った/, "どちらの考え方を採ったかが書いてある");
    });
  });

  describe("a6: 上限の判定は Kobo に依存しない（決定23）", () => {
    it("Kobo を1つも立てずに、上限が効く", async () => {
      // この試験は最初から最後まで Kobo（banto-daemon）を立てていない。
      // 立てずに断れることが、そのまま「工房単体で成立する」ことの証拠になる
      start(1);
      try {
        await delegate("task-0801");
        await assert.rejects(() => delegate("task-0802"), new RegExp(WORKER_LIMIT_CODE));
        assert.deepEqual(
          { running: pool.concurrency().running, limit: pool.concurrency().limit },
          { running: 1, limit: 1 }
        );
      } finally {
        await stop();
      }
    });

    it("工房の中核は Kobo を読み込んでいない（依存の向きを固定する）", () => {
      const source = fs.readFileSync(POOL_SOURCE, "utf-8");
      const imports = source
        .split("\n")
        .filter((line) => /^\s*import\b/.test(line) || /\bfrom "/.test(line));
      for (const line of imports) {
        assert.doesNotMatch(
          line,
          /banto-daemon/,
          `工房が Kobo を読み込むと決定23 が壊れる: ${line.trim()}`
        );
      }
    });
  });

  describe("既定のまま立てた工房", () => {
    before(() => start(DEFAULT_MAX_CONCURRENT_WORKERS));
    after(stop);

    it("既定の本数までは断らない（栓であって、仕事を止める道具ではない）", async () => {
      for (let i = 0; i < DEFAULT_MAX_CONCURRENT_WORKERS; i++) {
        await delegate(`task-09${String(i).padStart(2, "0")}`);
      }
      assert.equal(pool.concurrency().running, DEFAULT_MAX_CONCURRENT_WORKERS);
      await assert.rejects(() => delegate("task-0999"), new RegExp(WORKER_LIMIT_CODE));
    });
  });

  /**
   * task-0221: **満杯で断る前に、アイドルの職人を畳んで席を作る（断りも帳簿に残す）。**
   *
   * 工房には15分の安全弁（`sweepIdle`）が元からあるが、点検は `idleTimeoutMs / 4` ごとの
   * `setInterval` でしか回らない。`reserveSlot` がそれを呼ばないので、「15分以上触られて
   * いない職人が席を占めているのに次が断られる」窓が構造的に開いていた（実際に 2026-08-16、
   * 待機中の職人が1本 約300MB を掴んだまま残っていた）。加えて、断りは例外を投げるだけで
   * 工房の記録に何も残らず、呼び出し側が文言を捨てれば「なぜ遅いのか」が読めなくなる。
   *
   *   b1 満杯でもアイドルが居れば、畳んでから起こす（断らない）
   *   b2 掃いても空かなければ、従来どおり合印つきで断る（待ち行列は作らない）
   *   b3 断ったことが記録に残り、いつ・どのタスクを・何本／上限何本で断ったかが読める
   *   b4 満杯でないときは掃かない（普段の delegate を重くしない）
   */
  describe("[task-0221] 満杯で断る前に、アイドルの職人を畳んで席を作る", () => {
    beforeEach(() => start(2));
    afterEach(stop);

    it("b1: アイドルが居れば、その場で畳んでから起こす（断らない）", async () => {
      await delegate("task-1101");
      await delegate("task-1102");
      assert.equal(pool.concurrency().running, 2, "満杯にした");

      // 安全弁を入れる。点検の interval は十分先にして、**掃くのは delegate 自身だけ**にする
      // （1ms に対して 50ms 待つので、時刻の揺らぎで判定が変わる幅ではない）
      pool.setIdleTimeout(1, 60_000);
      await sleep(50);

      const worker = (await delegate("task-1103")) as { taskId: string };
      assert.equal(worker.taskId, "task-1103", "断られずに起きた");
      assert.deepEqual(
        pool.list({ includeClosed: false }).map((w) => w.taskId),
        ["task-1103"],
        "アイドル2本は畳まれ、新しい1本だけが走っている"
      );
      assert.equal(pool.concurrency().running, 1, "席は作られ、上限も超えていない");
    });

    it("b2: 掃いても空かなければ、従来どおり合印つきで断る（待ち行列は作らない）", async () => {
      await delegate("task-1201");
      await delegate("task-1202");

      // 安全弁は入っているが、どれもまだ 10 分は経っていない＝1本も掃けない
      pool.setIdleTimeout(10 * 60_000, 60_000);

      const startedAt = Date.now();
      await assert.rejects(() => delegate("task-1203"), new RegExp(`${WORKER_LIMIT_CODE}:2/2`));
      assert.ok(Date.now() - startedAt < 3000, "断りは即座に返る（待ち行列を作っていない）");
      assert.equal(pool.concurrency().running, 2, "掃けていないし、増えてもいない");
      assert.deepEqual(
        pool.list({ includeClosed: false }).map((w) => w.taskId),
        ["task-1201", "task-1202"],
        "掃く条件を満たさない職人が巻き添えで畳まれていない"
      );
    });

    it("b3: 断ったことが記録に残る（いつ・どのタスクを・何本／上限何本で）", async () => {
      await delegate("task-1301");
      await delegate("task-1302");

      const recorded: string[] = [];
      const realError = console.error;
      console.error = (...args: unknown[]): void => {
        recorded.push(args.map((a) => String(a)).join(" "));
      };
      try {
        await delegate("task-1303").catch(() => undefined);
      } finally {
        console.error = realError;
      }

      const line = recorded.find((l) => l.includes("task-1303"));
      assert.ok(line, `断りが記録に残る（残っていたのは ${JSON.stringify(recorded)}）`);
      assert.match(line, new RegExp(`${WORKER_LIMIT_CODE}:2/2`), "何本／上限何本で断ったか");
      assert.match(line, /\d{4}-\d{2}-\d{2}T[\d:.]+Z/, "いつ断ったか");
    });

    it("b4: 満杯でないときは掃かない（普段の delegate を重くしない）", async () => {
      let sweeps = 0;
      const realSweep = pool.sweepIdle.bind(pool);
      pool.sweepIdle = async (now) => {
        sweeps++;
        return realSweep(now);
      };

      await delegate("task-1401");
      assert.equal(sweeps, 0, "空きがあるうちは掃かない");
      await delegate("task-1402");
      assert.equal(sweeps, 0, "上限ちょうどまで埋めるところでも掃かない");

      await delegate("task-1403").catch(() => undefined);
      assert.equal(sweeps, 1, "満杯になって初めて、1回だけ掃く");
    });
  });
});

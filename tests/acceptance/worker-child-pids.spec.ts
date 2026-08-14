/**
 * inc-0066: 職人の下で動いている**実プロセスの pid** を台帳に載せる。
 *
 * 2026-08-14 未明の OOM で 11GB を抱えていたのは、台帳に載っている node のホストではなく、
 * その下でランタイムが起こした `claude` CLI だった。子の pid がどこにも記録されて
 * いなかったため、ダンプの pid から**どの職人だったか**を引けずに終わった。
 *
 * ここで確かめるのは「pid から逆引きできること」だけ。
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as childProcess from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type {
  DriverEventHandler,
  RuntimeDriver,
  SessionHandle,
  SpawnOptions,
} from "@banto/core";
import {
  WorkerPool,
  probeChildPids,
  descendantsOf,
  parseProcStat,
  SpawnLedger,
} from "@banto/worker-pool";

/** 子を1つ持つ本物のプロセス。`sh` のあとに `:` を足して、exec で置き換わらせない。 */
function spawnParentWithChild(): childProcess.ChildProcess {
  return childProcess.spawn("/bin/sh", ["-c", "sleep 30; :"], { stdio: "ignore" });
}

describe("[inc-0066] 職人の下の実プロセスを pid で同定できる", () => {
  describe("実プロセスを走査する", () => {
    let parent: childProcess.ChildProcess;

    before(() => {
      parent = spawnParentWithChild();
    });

    after(() => {
      try {
        parent.kill("SIGKILL");
      } catch {
        // 既に終わっている
      }
    });

    it("親の pid から子の pid を突き止められる（SDK の内側で起きた子でも辿れる形）", async () => {
      const found = await probeChildPids(parent.pid!, { timeoutMs: 5000, intervalMs: 100 });
      assert.equal(found.error, undefined, `走査に失敗した: ${found.error ?? ""}`);
      assert.ok(found.children.length >= 1, "子プロセスを1つも見つけられていない");
      const sleep = found.children.find((c) => c.comm.includes("sleep"));
      assert.ok(sleep, `sleep が居ない: ${JSON.stringify(found.children)}`);
      assert.equal(sleep!.ppid, parent.pid, "親が台帳の pid と繋がっていること");
      assert.ok(sleep!.firstSeenAt.length > 0, "いつ見つけたかが残ること");
    });
  });

  it("見つけられなかったときは理由が残る（空配列で誤魔化さない・I2）", async () => {
    // 自分自身は子を持たない（テストランナーの子は自分の子ではない）ので、
    // 走査は空で終わる。そのとき error が付くことが要点
    const orphanPid = 2 ** 22 - 1; // 居ないはずの pid
    const found = await probeChildPids(orphanPid, { timeoutMs: 300, intervalMs: 100 });
    assert.equal(found.children.length, 0);
    assert.ok(
      found.error && found.error.includes(String(orphanPid)),
      `見つけられなかった理由が残っていない: ${JSON.stringify(found)}`
    );
  });

  it("打ち切りの合図で止まる（工房を終うときに待たせない）", async () => {
    const aborter = new AbortController();
    aborter.abort();
    const found = await probeChildPids(1, {
      timeoutMs: 60_000,
      intervalMs: 100,
      signal: aborter.signal,
    });
    // 60 秒待たずに戻ってくること自体が検査（待てば試験が時間切れになる）
    assert.ok(found.at.length > 0);
  });

  it("comm に空白や括弧が入っても ppid を取り違えない（/proc/<pid>/stat の落とし穴）", () => {
    const row = parseProcStat("4242 (node --import tsx) S 4200 4242 4200 0 -1 4194304");
    assert.deepEqual(row, { pid: 4242, ppid: 4200, comm: "node --import tsx" });
  });

  it("孫も辿る（ランタイムがラッパを1枚挟んでも同定できる）", () => {
    const rows = [
      { pid: 100, ppid: 1, comm: "host" },
      { pid: 200, ppid: 100, comm: "wrapper" },
      { pid: 300, ppid: 200, comm: "claude" },
      { pid: 400, ppid: 1, comm: "無関係" },
    ];
    assert.deepEqual(
      descendantsOf(100, rows).map((r) => r.pid),
      [200, 300]
    );
  });

  /**
   * **打ち切りの条件**（inc-0066 の続き）。
   *
   * 職人は起きてから `esbuild` や `claude` を**次々に**作る。「子が1つ見つかって、
   * 増えない走査が2回続いたら畳む」だと、いちばん最初に現れた1枚だけを記録して
   * 終わりかねない——それでは OOM のときに「誰が食べていたか」を答えられず、
   * inc-0066 の目的を果たさない。
   *
   * **ここは時間ではなく筋書きで確かめる。** 本物のプロセスで「孫が遅れて現れる」を
   * 作ると、現れる時刻が盤面の混み具合で動く。実際それで全量4回中1回落ちていた
   * （単体では10回中0回＝「単体では通る」は無罪の証拠にならない）。プロセス表と
   * 時計の両方を台本にすれば、負荷に関係なく同じ結果になる。
   */
  describe("走査を畳む条件", () => {
    const ROOT = 1000;
    const SH = { pid: 1001, ppid: ROOT, comm: "sh" };
    const SLEEP = { pid: 1002, ppid: 1001, comm: "sleep" };

    /**
     * 台本つきのプロセス表と時計。
     *
     * `appearAtCall` 回目の走査で初めて孫が見える。走査1回ごとに時計を `tickMs` 進める
     * ——実際の経過時間は見ない（見たら負荷で結果が変わる）。
     */
    function scripted(appearAtCall: number, tickMs: number) {
      let calls = 0;
      let clock = 0;
      return {
        calls: () => calls,
        now: () => clock,
        readTable: () => {
          calls++;
          const rows = calls >= appearAtCall ? [SH, SLEEP] : [SH];
          clock += tickMs;
          return { rows };
        },
      };
    }

    it("先に見つかった子で畳まず、遅れて現れる孫まで待つ", async () => {
      // 子は最初から見えているが、孫は4回目の走査でようやく現れる。
      // 「増えない回が2回続いたら畳む」だと3回目で畳んでしまい、孫を取り落とす
      const script = scripted(4, 100);

      const found = await probeChildPids(ROOT, {
        intervalMs: 0,
        timeoutMs: 20_000,
        readTable: script.readTable,
        now: script.now,
      });

      assert.equal(found.error, undefined, `走査に失敗した: ${found.error ?? ""}`);
      assert.deepEqual(
        found.children.map((c) => c.comm).sort(),
        ["sh", "sleep"],
        "遅れて現れた孫を取り落としている（子1枚で畳んだ）"
      );
    });

    it("落ち着いたら畳む（いつまでも走査し続けない）", async () => {
      // 孫が現れない筋書き。それでも待ち続けるなら、この試験は timeoutMs で終わる
      const script = scripted(Number.MAX_SAFE_INTEGER, 100);

      const found = await probeChildPids(ROOT, {
        intervalMs: 0,
        timeoutMs: 20_000,
        readTable: script.readTable,
        now: script.now,
      });

      assert.deepEqual(found.children.map((c) => c.comm), ["sh"]);
      // 20秒ぶんの 200 回ではなく、落ち着きを見た時点で畳んでいること
      assert.ok(
        script.calls() < 50,
        `打ち切っていない（${script.calls()} 回も走査した）`
      );
    });

    it("畳むまでの猶予は走査の間隔に引きずられない（速めても弱くならない）", async () => {
      // **間欠の真因**。猶予を「回数」で持つと、試験や呼び出し側が intervalMs を
      // 速めただけで猶予まで縮む——500ms×2回＝1秒のつもりが、100ms にすると 200ms に
      // なっていた。猶予は時間で持つ
      const fast = scripted(4, 10); // 1回 10ms（速い）
      const slow = scripted(4, 100); // 1回 100ms（遅い）

      const a = await probeChildPids(ROOT, {
        intervalMs: 0,
        readTable: fast.readTable,
        now: fast.now,
      });
      const b = await probeChildPids(ROOT, {
        intervalMs: 0,
        readTable: slow.readTable,
        now: slow.now,
      });

      // どちらも孫まで拾えていること（間隔を速めた方だけ取り落とす、にしない）
      assert.deepEqual(a.children.map((c) => c.comm).sort(), ["sh", "sleep"]);
      assert.deepEqual(b.children.map((c) => c.comm).sort(), ["sh", "sleep"]);
    });
  });

  describe("台帳と観測経路から引ける", () => {
    let dir: string;
    let pool: WorkerPool;
    let driver: TwoTierDriver;

    before(() => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), "banto-childpid-"));
      driver = new TwoTierDriver();
      pool = new WorkerPool({
        driver,
        dataDir: dir,
        defaultProjectTag: "test",
        // 試験を待たせないため速める。既定（20秒・500ms）でも同じ道を通る。
        // **`intervalMs` を速めても猶予（`settleMs`）は縮まない**——ここを 100ms に
        // したせいで猶予が 200ms になり、孫の `sleep` が現れる前に走査が畳まれて
        // 全量4回中1回落ちていた。猶予を時間で持つようにして切り離してある
        childPidProbe: { timeoutMs: 5000, intervalMs: 100 },
      });
    });

    after(() => {
      pool.dispose();
      driver.cleanup();
      fs.rmSync(dir, { recursive: true, force: true });
    });

    it("worker.list（＝pool.get）と台帳の両方に子の pid が載る", async () => {
      const worker = await pool.delegate({
        taskId: "t-child",
        worktreePath: dir,
        instruction: "何もしない",
      });

      // 走査は起動を止めない＝この時点ではまだ載っていなくてよい。載るまで待つ
      const found = await waitFor(() => pool.get(worker.sessionId)?.childProcesses);
      assert.equal(found.error, undefined, `走査に失敗した: ${found.error ?? ""}`);
      const sleep = found.children.find((c) => c.comm.includes("sleep"));
      assert.ok(sleep, `子の pid が載っていない: ${JSON.stringify(found)}`);

      // 台帳（ファイル）にも書かれている——事故のあとに人が grep で引ける形（inc-0066）
      const { ledger } = SpawnLedger.open(dir);
      const entry = ledger.get("test", "t-child");
      assert.ok(entry, "台帳に居ること");
      assert.deepEqual(
        entry!.childProcesses?.children.map((c) => c.pid),
        found.children.map((c) => c.pid)
      );

      // worker.events からも引ける（畳んで台帳から消えたあとの逆引き用・決定30c）
      const event = pool.events().find((e) => e.type === "worker_child_pids");
      assert.ok(event, "worker_child_pids が積まれていること");
      assert.equal(event!.data["pid"], worker.pid, "ホストの pid も一緒に残ること");
      assert.deepEqual(
        (event!.data["children"] as { pid: number }[]).map((c) => c.pid),
        found.children.map((c) => c.pid)
      );
    });
  });
});

/** 載るまで待つ（走査は非同期。待たずに読むのは「間に合ったか」を試すことになる）。 */
async function waitFor<T>(read: () => T | undefined, timeoutMs = 8000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (value !== undefined) return value;
    if (Date.now() >= deadline) throw new Error("待っても現れなかった");
    await new Promise((r) => setTimeout(r, 50));
  }
}

/**
 * 職人の2階建てを模したドライバ。
 *
 * 実運用と同じ形——工房が握るのは親（ここでは `sh`）の pid だけで、実処理を抱える子
 * （`sleep`。実物では `claude` CLI）の pid はドライバから見えない。
 */
class TwoTierDriver implements RuntimeDriver {
  private readonly procs: childProcess.ChildProcess[] = [];
  private readonly handlers = new Set<DriverEventHandler>();

  async spawn(opts: SpawnOptions): Promise<SessionHandle> {
    const proc = spawnParentWithChild();
    this.procs.push(proc);
    const sessionPath = path.join(opts.worktreePath, `${opts.taskId}.jsonl`);
    fs.writeFileSync(sessionPath, "");
    return { pid: proc.pid!, sessionId: `s-${opts.taskId}`, sessionPath };
  }
  async inject(): Promise<void> {}
  subscribe(handler: DriverEventHandler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }
  async kill(): Promise<void> {}
  cleanup(): void {
    for (const proc of this.procs) {
      try {
        proc.kill("SIGKILL");
      } catch {
        // 既に終わっている
      }
    }
  }
}

import { test } from "node:test";
import assert from "node:assert/strict";
import { LivenessMonitor, type Pingable } from "./liveness.js";

const OPTS = { intervalMs: 20, timeoutMs: 15, failureThreshold: 2 };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 答える・黙る を切り替えられる相手。黙っている間は ping が返らない（上限で失敗になる）。 */
class FakeModule implements Pingable {
  silent = false;
  pings = 0;
  async ping(options?: { timeout?: number }) {
    this.pings += 1;
    if (!this.silent) return {};
    await sleep(options?.timeout ?? 0);
    throw new Error("Request timed out");
  }
}

test("答えている間は何もしない", async () => {
  const dead: string[] = [];
  const m = new LivenessMonitor(OPTS, (name) => dead.push(name));
  const mod = new FakeModule();
  m.watch("shell-p1", mod);
  await sleep(150);
  m.stop();
  assert.ok(mod.pings >= 3, `確かめている（${mod.pings} 回）`);
  assert.deepEqual(dead, []);
});

test("続けて答えなければ、1回だけ知らせて見るのをやめる", async () => {
  const dead: Array<{ name: string; reason: string }> = [];
  const m = new LivenessMonitor(OPTS, (name, _client, reason) => dead.push({ name, reason }));
  const mod = new FakeModule();
  mod.silent = true;
  m.watch("shell-p1", mod);
  await sleep(250);
  m.stop();
  assert.equal(dead.length, 1, "二度知らせない");
  assert.equal(dead[0]!.name, "shell-p1");
  assert.match(dead[0]!.reason, /2 回続けて答えませんでした（Request timed out）/);
});

test("1回だけの取りこぼしでは止まったとみなさない", async () => {
  const dead: string[] = [];
  const m = new LivenessMonitor(OPTS, (name) => dead.push(name));
  const mod = new FakeModule();
  let n = 0;
  mod.ping = async () => {
    n += 1;
    if (n === 2) throw new Error("一度だけ");
    return {};
  };
  m.watch("m", mod);
  await sleep(150);
  m.stop();
  assert.deepEqual(dead, []);
});

test("外したら、黙っていても知らせない（畳んだ Module を起こし直さない）", async () => {
  const dead: string[] = [];
  const m = new LivenessMonitor(OPTS, (name) => dead.push(name));
  const mod = new FakeModule();
  mod.silent = true;
  m.watch("m", mod);
  await sleep(25);
  m.unwatch("m");
  await sleep(150);
  assert.deepEqual(dead, []);
});

// --- banto 本体が止まっていた間の時間切れ（追加・2026-10-09） ---

/** 本体の event loop を ms だけ止める（同期で回り続ける）。 */
function blockLoop(ms: number): void {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    // 止める
  }
}

/**
 * 本物の MCP の ping と同じ順番で答える相手：返事は入力（I/O）として届くので、本体が止まっていて
 * 再開したときは、期限の来た時間切れのタイマーが先に回り、返事はそのあとに来る。setImmediate で
 * 「タイマーのあと」を作る。
 */
class AnsweringModule implements Pingable {
  pings = 0;
  /** 送った直後に本体を止める回数（止める長さ ms） */
  constructor(private blocks: number, private blockMs: number) {}
  ping(options?: { timeout?: number }): Promise<unknown> {
    this.pings += 1;
    const block = this.blocks > 0;
    if (block) this.blocks -= 1;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Request timed out")), options?.timeout ?? 0);
      const answer = () => setImmediate(() => { clearTimeout(timeout); resolve({}); });
      // 止めるときは、返事を止まりの**あと**に届ける（本物の返事は止まっている間に溜まった入力）。止める前に返事の
      // タイマーを仕掛けると、loop が 2ms 以上遅れたとき（機械が混んでいる）返事が止まりの前に期限を迎え、時間切れより
      // 先に回って再現が崩れた（2026-10-10、100 回中 17 回）
      if (block) setTimeout(() => { blockLoop(this.blockMs); setTimeout(answer, 0); }, 0);
      else setTimeout(answer, 2);
    });
  }
}

test("本体が止まっていた間の時間切れは数えず、もう一度確かめる（答えている Module を落とさない）", async () => {
  const { HostStallMeter } = await import("../host-stall.js");
  const meter = new HostStallMeter({ tickMs: 5, minStallMs: 10, keepMs: 60_000, logStallMs: 1_000 });
  meter.start();
  const dead: string[] = [];
  const inconclusive: Array<{ stalled: number; elapsed: number }> = [];
  const opts = { intervalMs: 30, timeoutMs: 20, failureThreshold: 2 };
  const m = new LivenessMonitor(opts, (name) => dead.push(name), meter, (_n, stalled, elapsed) =>
    inconclusive.push({ stalled, elapsed }),
  );
  // ping を送った直後に本体を止める、を4回続ける（直す前は2回目で「止まった」になっていた）
  const mod = new AnsweringModule(4, 80);
  m.watch("shell-p1", mod);
  await sleep(600);
  m.stop();
  meter.stop();
  assert.deepEqual(dead, [], "答えていた Module を落とさない");
  assert.ok(inconclusive.length >= 2, `数えなかった回がある（${inconclusive.length} 回）`);
  assert.ok(inconclusive.every((x) => x.stalled > 0 && x.elapsed - x.stalled < opts.timeoutMs));
});

test("本体が止まっていなければ、答えない Module は今までどおり止まったとみなす", async () => {
  const { HostStallMeter } = await import("../host-stall.js");
  const meter = new HostStallMeter({ tickMs: 5, minStallMs: 10, keepMs: 60_000, logStallMs: 1_000 });
  meter.start();
  const dead: string[] = [];
  const m = new LivenessMonitor(OPTS, (name) => dead.push(name), meter);
  const mod = new FakeModule();
  mod.silent = true;
  m.watch("m", mod);
  await sleep(250);
  m.stop();
  meter.stop();
  assert.deepEqual(dead, ["m"]);
});

test("直す前の形（本体の止まりを測らない）では、答えている Module を落としていた", async () => {
  const dead: string[] = [];
  const opts = { intervalMs: 30, timeoutMs: 20, failureThreshold: 2 };
  const m = new LivenessMonitor(opts, (name) => dead.push(name));
  m.watch("shell-p1", new AnsweringModule(4, 80));
  await sleep(600);
  m.stop();
  assert.deepEqual(dead, ["shell-p1"], "再現：時間切れが先に回って、遅れた返事が捨てられる");
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { HostStallMeter } from "./host-stall.js";

const OPTS = { tickMs: 250, minStallMs: 100, keepMs: 60_000, logStallMs: 1_000 };

test("タイマーが遅れて来た分を止まりとして残し、短い揺れは残さない", () => {
  let t = 1_000_000;
  const logged: number[] = [];
  const m = new HostStallMeter(OPTS, (s) => logged.push(s.ms), () => t);
  m.start();
  m.stop();
  t += 250 + 50; // 揺れ
  m.tick();
  t += 250 + 12_000; // 12 秒止まった
  m.tick();
  assert.deepEqual(m.recent(5), [{ endedAt: t, ms: 12_000 }]);
  assert.deepEqual(logged, [12_000], "1 秒以上はログに出す");
  assert.equal(m.maxWithin(10_000), 12_000);
});

test("範囲と重なる分だけを合計する", () => {
  let t = 0;
  const m = new HostStallMeter(OPTS, undefined, () => t);
  m.record({ endedAt: 20_000, ms: 10_000 }); // 10〜20 秒
  m.record({ endedAt: 40_000, ms: 5_000 }); // 35〜40 秒
  assert.equal(m.stalledBetween(15_000, 25_000), 5_000);
  assert.equal(m.stalledBetween(0, 50_000), 15_000);
  assert.equal(m.stalledBetween(21_000, 34_000), 0);
  t = 40_000;
  assert.equal(m.maxWithin(10_000), 5_000);
});

test("古い止まりは忘れる", () => {
  const m = new HostStallMeter({ ...OPTS, keepMs: 1_000 }, undefined, () => 0);
  m.record({ endedAt: 1_000, ms: 500 });
  m.record({ endedAt: 5_000, ms: 500 });
  assert.equal(m.recent(10).length, 1);
});

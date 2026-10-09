import { test } from "node:test";
import assert from "node:assert/strict";
import { collectHostHealth, parseMeminfo, parsePressure, timestampConsole } from "./host-health.js";
import { HostStallMeter } from "./host-stall.js";

test("/proc/pressure を読む", () => {
  const p = parsePressure(
    "some avg10=40.53 avg60=18.63 avg300=12.95 total=24777568823\nfull avg10=10.47 avg60=4.40 avg300=2.76 total=6693825450\n",
  );
  assert.deepEqual(p, { some: { avg10: 40.53, avg60: 18.63 }, full: { avg10: 10.47, avg60: 4.4 } });
});

test("/proc/meminfo の MemAvailable と MemTotal をバイトで読む", () => {
  assert.deepEqual(parseMeminfo("MemTotal:       12182528 kB\nMemFree: 1 kB\nMemAvailable:    8384039 kB\n"), {
    total: 12182528 * 1024,
    available: 8384039 * 1024,
  });
});

test("本体の止まりと host の詰まり具合をまとめる（読めないものは出さない）", () => {
  let t = 100_000;
  const meter = new HostStallMeter(undefined, undefined, () => t);
  meter.record({ endedAt: 30_000, ms: 2_000 });
  meter.record({ endedAt: 95_000, ms: 12_000 });
  const files: Record<string, string> = { "/proc/pressure/cpu": "some avg10=1.00 avg60=2.00 avg300=0 total=0\n" };
  const h = collectHostHealth(meter, (p) => files[p], () => new Date(t));
  assert.equal(h.stall.max10s, 12_000);
  assert.equal(h.stall.max60s, 12_000);
  assert.deepEqual(h.stall.recent, [
    { at: new Date(83_000).toISOString(), ms: 12_000 },
    { at: new Date(28_000).toISOString(), ms: 2_000 },
  ]);
  assert.deepEqual(h.pressure, { cpu: { some: { avg10: 1, avg60: 2 } } });
  assert.equal(h.memAvailableBytes, undefined);
  t = 200_000;
});

test("ログの行の頭に時刻を付ける（書式の文字列は壊さない）", () => {
  const lines: unknown[][] = [];
  const fake = { log: (...a: unknown[]) => lines.push(a), info: () => {}, warn: (...a: unknown[]) => lines.push(a), error: () => {} } as unknown as Console;
  timestampConsole(fake, () => new Date("2026-10-09T01:02:03.456Z"));
  fake.log("[host] %s を起こし直しました", "shell");
  fake.warn({ a: 1 });
  assert.deepEqual(lines, [
    ["2026-10-09T01:02:03.456Z [host] %s を起こし直しました", "shell"],
    ["2026-10-09T01:02:03.456Z", { a: 1 }],
  ]);
});

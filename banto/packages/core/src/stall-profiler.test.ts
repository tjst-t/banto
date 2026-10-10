import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HostStallMeter } from "./host-stall.js";
import { StallProfiler } from "./stall-profiler.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 名前の付いた関数で本体を止める——記録にこの名前が出ることを見る */
function busyLoopForStallProfilerTest(ms: number): void {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    // 止める
  }
}

test("窓の間に本体が止まったら、何をしていたかの CPU の記録を残す", async () => {
  const dir = mkdtempSync(join(tmpdir(), "stall-prof-"));
  const meter = new HostStallMeter({ tickMs: 20, minStallMs: 50, keepMs: 60_000, logStallMs: 100_000 });
  meter.start();
  const p = new StallProfiler({ dir, stalledBetween: (a, b) => meter.stalledBetween(a, b), windowMs: 1_500, keepIfStalledMs: 500 });
  await p.capture("turn-test");
  await sleep(50);
  busyLoopForStallProfilerTest(800);
  await sleep(2_000);
  meter.stop();
  const files = readdirSync(dir);
  assert.equal(files.length, 1, `残した: ${files.join(",")}`);
  assert.match(files[0]!, /turn-test\.cpuprofile$/);
  const profile = JSON.parse(readFileSync(join(dir, files[0]!), "utf8")) as { nodes: Array<{ callFrame: { functionName: string } }> };
  assert.ok(profile.nodes.some((n) => n.callFrame.functionName === "busyLoopForStallProfilerTest"), "止めた関数が記録にある");
});

test("止まらなければ残さない", async () => {
  const dir = mkdtempSync(join(tmpdir(), "stall-prof-"));
  const p = new StallProfiler({ dir, stalledBetween: () => 0, windowMs: 300 });
  await p.capture("turn-calm");
  await sleep(700);
  assert.deepEqual(readdirSync(dir), []);
});

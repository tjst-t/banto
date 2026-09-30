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

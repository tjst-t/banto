import { test } from "node:test";
import assert from "node:assert/strict";
import { ConnectBackoff } from "./connect-backoff.js";

function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

const OPTS = { baseMs: 5_000, maxMs: 60_000, stableMs: 600_000 };

test("失敗したら、次の時刻までは試さない。時刻を過ぎたら試す", () => {
  const c = clock();
  const b = new ConnectBackoff({ ...OPTS, now: c.now });
  assert.equal(b.blocked("shell-p1", "v1"), undefined, "覚えていなければ試す");
  b.recordFailure("shell-p1", "v1", "Shutting down");
  assert.equal(b.blocked("shell-p1", "v1"), "Shutting down");
  c.advance(4_999);
  assert.equal(b.blocked("shell-p1", "v1"), "Shutting down");
  c.advance(1);
  assert.equal(b.blocked("shell-p1", "v1"), undefined, "5 秒たったら試す——あきらめない");
});

test("続けて失敗するほど間が倍になり、上限で止まる", () => {
  const c = clock();
  const b = new ConnectBackoff({ ...OPTS, now: c.now });
  const delays: number[] = [];
  for (let i = 0; i < 6; i++) {
    b.recordFailure("m", "v1", "x");
    delays.push(b.retryAt("m") - c.now());
    c.advance(b.retryAt("m") - c.now());
  }
  assert.deepEqual(delays, [5_000, 10_000, 20_000, 40_000, 60_000, 60_000]);
});

test("宣言が変わったら、待たずにすぐ試す（人が直したのに壊れていると言い続けない）", () => {
  const b = new ConnectBackoff({ ...OPTS, now: clock().now });
  b.recordFailure("m", "v1", "設定の誤り");
  assert.equal(b.blocked("m", "v2"), undefined);
  assert.equal(b.failure("m"), undefined, "前の宣言の失敗は捨てる");
});

test("人に知らせるのは、続いた失敗の最初の1回だけ。繋がったら数え直す", () => {
  const b = new ConnectBackoff({ ...OPTS, now: clock().now });
  assert.equal(b.recordFailure("m", "v1", "a"), true);
  assert.equal(b.recordFailure("m", "v1", "a"), false, "同じ失敗が続く間は知らせ直さない");
  b.recordConnected("m", "v1");
  assert.equal(b.failure("m"), undefined, "繋がったら理由は消える");
  b.recordLost("m", "v1", "応答なし");
  assert.equal(b.recordFailure("m", "v1", "起こせない"), true, "一度繋がった後の新しい失敗は知らせる");
});

test("止まってばかりなら間が伸び、しばらく動き続けたら数え直す", () => {
  const c = clock();
  const b = new ConnectBackoff({ ...OPTS, now: c.now });
  b.recordConnected("m", "v1");
  b.recordLost("m", "v1", "落ちた");
  assert.equal(b.retryAt("m") - c.now(), 5_000);
  b.recordConnected("m", "v1");
  c.advance(1_000);
  b.recordLost("m", "v1", "すぐ落ちた");
  assert.equal(b.retryAt("m") - c.now(), 10_000, "起こしてすぐ落ちるなら間を伸ばす");
  b.recordConnected("m", "v1");
  c.advance(600_000);
  b.recordLost("m", "v1", "久しぶりに落ちた");
  assert.equal(b.retryAt("m") - c.now(), 5_000, "10 分動き続けたら最初の間に戻る");
});

test("同じ1回の試みを待っていた数だけ失敗が届いても、1回として数える（Backlog #370）", () => {
  const c = clock();
  const b = new ConnectBackoff({ ...OPTS, now: c.now });
  // 1回目の試み：4か所が同じ起動を待っていて、同じ失敗が4回届く
  const first = c.now();
  c.advance(9_000); // SSH の接続の時間切れまで
  const notified = [0, 1, 2, 3].map(() => b.recordFailure("shell-p1", "v1", "Connection timed out", { attemptStartedAt: first }));
  assert.deepEqual(notified, [true, false, false, false], "知らせるのも最初の1回だけ");
  assert.equal(b.streak("shell-p1"), 1);
  assert.equal(b.retryAt("shell-p1") - c.now(), 5_000, "間は 5 秒のまま（以前は 40 秒まで伸びた）");
  // 次の試みはその失敗のあとに始まるので、ふつうに数える
  c.advance(5_000);
  const second = c.now();
  c.advance(9_000);
  b.recordFailure("shell-p1", "v1", "Connection timed out", { attemptStartedAt: second });
  b.recordFailure("shell-p1", "v1", "Connection timed out", { attemptStartedAt: second });
  assert.equal(b.streak("shell-p1"), 2);
  assert.equal(b.retryAt("shell-p1") - c.now(), 10_000);
});

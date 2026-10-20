import { test } from "node:test";
import assert from "node:assert/strict";
import type { AccountUsage } from "./accounts.js";
import { blockedBy, chooseAccount, chooseBalanced, DEFAULT_THRESHOLDS, earliestRecovery, headroomRatio, PENDING_PIN_WEIGHT } from "./select.js";

const NOW = new Date("2026-10-18T00:00:00Z");
const at = (minutes: number) => new Date(NOW.getTime() + minutes * 60_000).toISOString();
const usage = (u: Partial<AccountUsage>): AccountUsage => ({ readAt: NOW.toISOString(), ...u });

test("並びの先頭から、5時間・週の率が閾値未満で rejected でない最初のものを選ぶ", () => {
  const table: Record<string, AccountUsage | undefined> = {
    a: usage({ fiveHour: { utilization: 0.96, resetsAt: at(30) } }),
    b: usage({ sevenDay: { utilization: 0.95, resetsAt: at(600) } }),
    c: usage({ fiveHour: { utilization: 0.2, resetsAt: at(30) }, status: "rejected", statusResetsAt: at(10) }),
    d: usage({ fiveHour: { utilization: 0.94, resetsAt: at(30) }, sevenDay: { utilization: 0.1 } }),
  };
  assert.deepEqual(chooseAccount(["a", "b", "c", "d"], (id) => table[id], DEFAULT_THRESHOLDS, NOW), { accountId: "d", allOver: false });
  // 分からない（一度も使っていない）ものは使える扱い
  assert.deepEqual(chooseAccount(["a", "e"], (id) => table[id], DEFAULT_THRESHOLDS, NOW), { accountId: "e", allOver: false });
  // 閾値は5時間と週で別々
  assert.deepEqual(chooseAccount(["a", "d"], (id) => table[id], { fiveHour: 0.97, sevenDay: 0.95 }, NOW), { accountId: "a", allOver: false });
  // この要求でもう断られたものは選ばない
  assert.deepEqual(chooseAccount(["d", "e"], (id) => table[id], DEFAULT_THRESHOLDS, NOW, new Set(["d"])), { accountId: "e", allOver: false });
  assert.equal(chooseAccount(["d"], (id) => table[id], DEFAULT_THRESHOLDS, NOW, new Set(["d"])), undefined);
  assert.equal(chooseAccount([], () => undefined, DEFAULT_THRESHOLDS, NOW), undefined);
});

test("リセットの時刻を過ぎた率・status は分からない＝使える扱いに戻る", () => {
  const a = usage({ fiveHour: { utilization: 0.99, resetsAt: at(30) }, status: "rejected", statusResetsAt: at(30) });
  assert.equal(blockedBy(a, DEFAULT_THRESHOLDS, NOW)?.kind, "rejected");
  assert.equal(blockedBy(a, DEFAULT_THRESHOLDS, new Date(NOW.getTime() + 31 * 60_000)), undefined);
  assert.deepEqual(blockedBy(usage({ sevenDay: { utilization: 0.97, resetsAt: at(60) } }), DEFAULT_THRESHOLDS, NOW), {
    kind: "threshold",
    window: "7d",
    utilization: 0.97,
    resetsAt: at(60),
  });
});

test("全部が越えたら、一番早く使えるようになるもので続ける（越えた窓が全部リセットされる時刻で比べる）", () => {
  const table: Record<string, AccountUsage> = {
    // 5時間は30分後に戻るが、週も越えていて戻るのは10時間後
    a: usage({ fiveHour: { utilization: 0.99, resetsAt: at(30) }, sevenDay: { utilization: 0.99, resetsAt: at(600) } }),
    b: usage({ fiveHour: { utilization: 0.97, resetsAt: at(120) } }),
    // rejected は `-reset` の時刻
    c: usage({ status: "rejected", statusResetsAt: at(60) }),
    // リセットの時刻が分からないものは一番遅い扱い
    d: usage({ fiveHour: { utilization: 0.99 } }),
  };
  const of = (id: string) => table[id];
  assert.deepEqual(chooseAccount(["a", "b", "c", "d"], of, DEFAULT_THRESHOLDS, NOW), { accountId: "c", allOver: true });
  assert.deepEqual(chooseAccount(["d", "a", "b"], of, DEFAULT_THRESHOLDS, NOW), { accountId: "b", allOver: true });
  assert.deepEqual(chooseAccount(["d"], of, DEFAULT_THRESHOLDS, NOW), { accountId: "d", allOver: true });
  assert.equal(earliestRecovery(["a", "b", "c", "d"], of, DEFAULT_THRESHOLDS, NOW), Date.parse(at(60)));
  assert.equal(earliestRecovery(["d"], of, DEFAULT_THRESHOLDS, NOW), undefined);
});

test("均す：閾値の下のうち余裕の比 r=max(5h率/閾値, 週率/閾値) が一番小さいもの。分からない窓は 0、同じなら並びの前", () => {
  const table: Record<string, AccountUsage | undefined> = {
    // r = max(0.5/0.95, 0.1/0.95) ≈ 0.526
    a: usage({ fiveHour: { utilization: 0.5, resetsAt: at(30) }, sevenDay: { utilization: 0.1, resetsAt: at(600) } }),
    // r = max(0.2/0.95, 0.6/0.95) ≈ 0.632——5時間は低いが週が高い
    b: usage({ fiveHour: { utilization: 0.2, resetsAt: at(30) }, sevenDay: { utilization: 0.6, resetsAt: at(600) } }),
    // 閾値越えは候補にしない（r は一番小さく見えても）
    c: usage({ status: "rejected", statusResetsAt: at(10) }),
    // 5時間の窓はリセットを過ぎた（0 とみなす）。週 0.3 → r ≈ 0.316
    d: usage({ fiveHour: { utilization: 0.9, resetsAt: at(-1) }, sevenDay: { utilization: 0.3, resetsAt: at(600) } }),
  };
  const of = (id: string) => table[id];
  const none = () => 0;
  assert.deepEqual(chooseBalanced(["a", "b", "c", "d"], of, DEFAULT_THRESHOLDS, NOW, none), { accountId: "d", allOver: false });
  assert.deepEqual(chooseBalanced(["b", "a"], of, DEFAULT_THRESHOLDS, NOW, none), { accountId: "a", allOver: false });
  // 閾値は5時間と週で別々（週の閾値を上げると b の r が下がる）
  assert.deepEqual(chooseBalanced(["a", "b"], of, { fiveHour: 0.95, sevenDay: 1 }, NOW, none), { accountId: "a", allOver: false });
  assert.ok(Math.abs(headroomRatio(of("b"), DEFAULT_THRESHOLDS, NOW) - 0.6 / 0.95) < 1e-9);
  assert.equal(headroomRatio(undefined, DEFAULT_THRESHOLDS, NOW), 0);
  // 分からないもの同士は並びの前
  assert.deepEqual(chooseBalanced(["x", "y"], of, DEFAULT_THRESHOLDS, NOW, none), { accountId: "x", allOver: false });
  // skip
  assert.deepEqual(chooseBalanced(["a", "d"], of, DEFAULT_THRESHOLDS, NOW, none, new Set(["d"])), { accountId: "a", allOver: false });
  assert.equal(chooseBalanced([], of, DEFAULT_THRESHOLDS, NOW, none), undefined);
  // 全部が越えたら上から順にと同じ（一番早く使えるようになるもの）
  assert.deepEqual(chooseBalanced(["c"], of, DEFAULT_THRESHOLDS, NOW, none), { accountId: "c", allOver: true });
});

test("均す：まだ返事の来ていない固定1つにつき r に 0.01 を足す（同時に始まったセッションを寄せない）", () => {
  const of = () => undefined;
  const pending: Record<string, number> = { x: 1 };
  assert.deepEqual(chooseBalanced(["x", "y"], of, DEFAULT_THRESHOLDS, NOW, (id) => pending[id] ?? 0), { accountId: "y", allOver: false });
  pending.y = 1;
  assert.deepEqual(chooseBalanced(["x", "y"], of, DEFAULT_THRESHOLDS, NOW, (id) => pending[id] ?? 0), { accountId: "x", allOver: false });
  assert.equal(PENDING_PIN_WEIGHT, 0.01);
  // 重みは使用率の差より小さい：x が 5% 少なければ、返事待ちが2つあっても x
  const table: Record<string, AccountUsage> = { x: usage({ fiveHour: { utilization: 0.1, resetsAt: at(30) } }), y: usage({ fiveHour: { utilization: 0.15, resetsAt: at(30) } }) };
  assert.deepEqual(chooseBalanced(["y", "x"], (id) => table[id], DEFAULT_THRESHOLDS, NOW, (id) => (id === "x" ? 2 : 0)), { accountId: "x", allOver: false });
});

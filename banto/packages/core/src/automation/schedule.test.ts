// アーキ仕様 §4.3「時計」——次に動かす時刻の計算（タイムゾーン・夏時間・壁時計の格子・cron の式）
import { test } from "node:test";
import assert from "node:assert/strict";
import type { AutomationRepeat } from "./fold.js";
import { cronExpressionProblem, dueFireTimes, nextFireAt } from "./schedule.js";

const next = (repeat: AutomationRepeat, timeZone: string, after: string): string | undefined =>
  nextFireAt(repeat, timeZone, new Date(after))?.toISOString();

test("平日 9:00（東京）：木曜の 9:00 を過ぎたら金曜、金曜の 9:00 を過ぎたら月曜", () => {
  const weekdays: AutomationRepeat = { kind: "weekdays", time: "9:00" };
  // 2026-10-15 は木曜。東京の 9:00 は UTC の 0:00
  assert.equal(next(weekdays, "Asia/Tokyo", "2026-10-15T00:30:00Z"), "2026-10-16T00:00:00.000Z");
  // 金曜の 8:59（東京）——UTC ではまだ木曜
  assert.equal(next(weekdays, "Asia/Tokyo", "2026-10-15T23:59:00Z"), "2026-10-16T00:00:00.000Z");
  // ちょうどその時刻のあとは次の平日（土日を飛ばす）
  assert.equal(next(weekdays, "Asia/Tokyo", "2026-10-16T00:00:00Z"), "2026-10-19T00:00:00.000Z");
});

test("毎日・毎週はその土地の暦で数える", () => {
  assert.equal(next({ kind: "daily", time: "23:30" }, "Asia/Tokyo", "2026-10-15T15:00:00Z"), "2026-10-16T14:30:00.000Z");
  // 毎週日曜 7:05（東京）。2026-10-18 が日曜
  assert.equal(next({ kind: "weekly", day: 0, time: "7:05" }, "Asia/Tokyo", "2026-10-15T00:00:00Z"), "2026-10-17T22:05:00.000Z");
  assert.equal(next({ kind: "weekly", day: 0, time: "7:05" }, "Asia/Tokyo", "2026-10-17T22:05:00Z"), "2026-10-24T22:05:00.000Z");
});

test("夏時間のあるタイムゾーン：時差が変わっても壁時計の時刻に動く。飛びは飛んだ直後、重なりは早いほう1回だけ", () => {
  const ny = "America/New_York";
  // 2026-03-08 の 2:00 に夏時間が始まる（EST −5 → EDT −4）。毎日 9:00 は前の日は 14:00Z、当日は 13:00Z
  assert.equal(next({ kind: "daily", time: "9:00" }, ny, "2026-03-07T00:00:00Z"), "2026-03-07T14:00:00.000Z");
  assert.equal(next({ kind: "daily", time: "9:00" }, ny, "2026-03-07T14:00:00Z"), "2026-03-08T13:00:00.000Z");
  // 2:30 はその日には無い——飛んだ直後（3:00 EDT）
  assert.equal(next({ kind: "daily", time: "2:30" }, ny, "2026-03-07T12:00:00Z"), "2026-03-08T07:00:00.000Z");
  assert.equal(next({ kind: "daily", time: "2:30" }, ny, "2026-03-08T07:00:00Z"), "2026-03-09T06:30:00.000Z");
  // 2026-11-01 の 2:00 に夏時間が終わる（1:00〜2:00 が2回来る）。1:30 は早いほう（EDT）の1回だけ
  assert.equal(next({ kind: "daily", time: "1:30" }, ny, "2026-10-31T12:00:00Z"), "2026-11-01T05:30:00.000Z");
  assert.equal(next({ kind: "daily", time: "1:30" }, ny, "2026-11-01T05:30:00Z"), "2026-11-02T06:30:00.000Z");
  // 南半球（シドニー、2026-10-04 に夏時間が始まる）
  assert.equal(next({ kind: "daily", time: "9:00" }, "Australia/Sydney", "2026-10-02T12:00:00Z"), "2026-10-02T23:00:00.000Z");
  assert.equal(next({ kind: "daily", time: "9:00" }, "Australia/Sydney", "2026-10-03T12:00:00Z"), "2026-10-03T22:00:00.000Z");
});

test("N 時間ごと：前に動いた時刻＋N ではなく壁時計の格子に揃う", () => {
  const every3: AutomationRepeat = { kind: "interval", hours: 3 };
  // 10:10（東京）のあとは 12:00。遅れて 10:59 に動いても 12:00（ずれ続けない）
  assert.equal(next(every3, "Asia/Tokyo", "2026-10-15T01:10:00Z"), "2026-10-15T03:00:00.000Z");
  assert.equal(next(every3, "Asia/Tokyo", "2026-10-15T01:59:00Z"), "2026-10-15T03:00:00.000Z");
  // 21:00 の次は翌日の 0:00
  assert.equal(next(every3, "Asia/Tokyo", "2026-10-15T12:00:00Z"), "2026-10-15T15:00:00.000Z");
  // 夏時間：2:00 が無い日は飛んだ直後の 3:00、その次は 4:00。重なる日の 1:00 は1回だけ（次は 2:00 EST）
  const hourly: AutomationRepeat = { kind: "interval", hours: 1 };
  const ny = "America/New_York";
  assert.equal(next(hourly, ny, "2026-03-08T06:30:00Z"), "2026-03-08T07:00:00.000Z");
  assert.equal(next(hourly, ny, "2026-03-08T07:00:00Z"), "2026-03-08T08:00:00.000Z");
  assert.equal(next(hourly, ny, "2026-11-01T05:00:00Z"), "2026-11-01T07:00:00.000Z");
  // 6時間ごとは夏時間をまたいでも壁時計の 0・6・12・18 時
  assert.equal(next({ kind: "interval", hours: 6 }, ny, "2026-03-08T05:00:00Z"), "2026-03-08T10:00:00.000Z");
});

test("cron の式：その土地の時刻で次の回。夏時間をまたいでも壁時計に動く", () => {
  // 平日 9:30（東京）。金曜 10:00 のあとは月曜
  assert.equal(next({ kind: "cron", expr: "30 9 * * 1-5" }, "Asia/Tokyo", "2026-10-16T01:00:00Z"), "2026-10-19T00:30:00.000Z");
  assert.equal(next({ kind: "cron", expr: "0 9 * * *" }, "America/New_York", "2026-03-07T14:00:00Z"), "2026-03-08T13:00:00.000Z");
  // 15分ごと
  assert.equal(next({ kind: "cron", expr: "*/15 * * * *" }, "UTC", "2026-10-15T00:16:00Z"), "2026-10-15T00:30:00.000Z");
});

test("cron の式の確かめ：5つの欄・読める・間隔は15分以上", () => {
  const now = new Date("2026-10-15T00:00:00Z");
  assert.equal(cronExpressionProblem("0 9 * * 1-5", "Asia/Tokyo", now), undefined);
  assert.equal(cronExpressionProblem("*/15 * * * *", "UTC", now), undefined);
  assert.match(cronExpressionProblem("*/10 * * * *", "UTC", now) ?? "", /15分/);
  // 1日に2回だけ近い（9:00 と 9:05）
  assert.match(cronExpressionProblem("0,5 9 * * *", "UTC", now) ?? "", /15分/);
  assert.match(cronExpressionProblem("0 9 * *", "UTC", now) ?? "", /5つの欄/);
  assert.match(cronExpressionProblem("0 0 9 * * *", "UTC", now) ?? "", /5つの欄/);
  assert.match(cronExpressionProblem("99 * * * *", "UTC", now) ?? "", /読めません/);
});

test("止まっていた間の時刻を数え、一番最近の1回を返す", () => {
  const daily: AutomationRepeat = { kind: "daily", time: "9:00" };
  // 3日止まっていた：10/13・14・15 の 9:00（東京）
  const found = dueFireTimes(daily, "Asia/Tokyo", new Date("2026-10-12T00:00:00Z"), new Date("2026-10-15T03:00:00Z"));
  assert.deepEqual(
    { latest: found?.latest.toISOString(), earliest: found?.earliest.toISOString(), count: found?.count, capped: found?.capped },
    { latest: "2026-10-15T00:00:00.000Z", earliest: "2026-10-13T00:00:00.000Z", count: 3, capped: false },
  );
  // まだ来ていなければ無い
  assert.equal(dueFireTimes(daily, "Asia/Tokyo", new Date("2026-10-15T00:00:00Z"), new Date("2026-10-15T23:59:00Z")), undefined);
  // 数える上限を超えても、一番最近の回は正しい（15分ごとを1年分）
  const many = dueFireTimes({ kind: "cron", expr: "*/15 * * * *" }, "UTC", new Date("2025-10-15T00:00:00Z"), new Date("2026-10-15T10:07:00Z"), 100);
  assert.equal(many?.capped, true);
  assert.equal(many?.latest.toISOString(), "2026-10-15T10:00:00.000Z");
});

// docs/specs/v4-architecture.md §4.3「時計」——**次に動かす時刻を計算する**（時計を持たない純粋な計算）。
//
// - 毎日・平日・毎週はタイムゾーンつきの暦（`Intl`）。夏時間の飛び・重なりは「その日の最初の該当時刻」——重なり（同じ
//   壁時計が2回来る）は早いほう、飛び（その壁時計が無い）は飛んだ直後の時刻
// - N 時間ごとは前に動いた時刻＋N ではなく**壁時計の格子**（その土地の 1970-01-01 0:00 から N 時間刻み。N が 24 の約数なら
//   毎日 0:00・N:00・…）。飛ばした回のあとずれ続けない
// - cron の式は `croner`（依存を1つ足した理由：Node 標準に式を読む部品が無い。croner は依存が0で、タイムゾーンを `Intl`
//   で扱う——cron-parser は luxon を連れてくる）。5つの欄（分 時 日 月 曜日）だけ受ける
// - 間隔は最短15分（cron の式は先の回を並べて確かめる）

import { Cron } from "croner";
import type { AutomationRepeat } from "./fold.js";

/** 間隔の最短（アーキ仕様 §4.3「形」） */
export const AUTOMATION_MIN_INTERVAL_MS = 15 * 60_000;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** 次に動かす時刻（`after` より後で一番早いもの）。来ないなら undefined（cron の式で該当日が無い等） */
export function nextFireAt(repeat: AutomationRepeat, timeZone: string, after: Date): Date | undefined {
  switch (repeat.kind) {
    case "daily":
    case "weekdays":
    case "weekly": {
      const [hour, minute] = repeat.time.split(":").map(Number) as [number, number];
      const today = localFields(after, timeZone);
      // 前の日から見る（その土地の日付と UTC の日付がずれていても取りこぼさない）。毎週でも8日先までに必ず来る
      for (let i = -1; i <= 8; i++) {
        const day = new Date(Date.UTC(today.year, today.month - 1, today.day + i));
        const dow = day.getUTCDay();
        if (repeat.kind === "weekdays" && (dow === 0 || dow === 6)) continue;
        if (repeat.kind === "weekly" && dow !== repeat.day) continue;
        const at = localToInstant(timeZone, day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), hour, minute);
        if (at.getTime() > after.getTime()) return at;
      }
      return undefined;
    }
    case "interval": {
      const step = repeat.hours * HOUR;
      const wall = localWallMs(after, timeZone);
      // 格子の点を壁時計で並べ、実際の時刻に直す。夏時間で壁時計が戻ると、直した時刻が after より前になることがある
      for (let k = Math.floor(wall / step); k <= Math.floor(wall / step) + 4; k++) {
        const f = new Date(k * step);
        const at = localToInstant(timeZone, f.getUTCFullYear(), f.getUTCMonth() + 1, f.getUTCDate(), f.getUTCHours(), f.getUTCMinutes());
        if (at.getTime() > after.getTime()) return at;
      }
      return undefined;
    }
    case "cron":
      return new Cron(repeat.expr, { timezone: timeZone, paused: true }).nextRun(after) ?? undefined;
  }
}

/**
 * `after` より後・`upTo` 以下に入る時刻を数え、一番最近のものを返す（止まっていた間の取り戻し）。数えるのは
 * `limit` 件まで——1分ごとの刻みの外で何年も止まっていても、数えるのに時間を使わない
 */
export function dueFireTimes(
  repeat: AutomationRepeat,
  timeZone: string,
  after: Date,
  upTo: Date,
  limit = 10_000,
): { latest: Date; earliest: Date; count: number; capped: boolean } | undefined {
  let next = nextFireAt(repeat, timeZone, after);
  if (!next || next.getTime() > upTo.getTime()) return undefined;
  const earliest = next;
  let latest = next;
  let count = 0;
  while (next && next.getTime() <= upTo.getTime()) {
    latest = next;
    count++;
    if (count >= limit) {
      // 残りは数えずに、upTo の直前の回だけ探す
      const tail = lastFireAtOrBefore(repeat, timeZone, upTo, latest);
      return { latest: tail ?? latest, earliest, count, capped: true };
    }
    next = nextFireAt(repeat, timeZone, next);
  }
  return { latest, earliest, count, capped: false };
}

/** `upTo` 以下で一番最近の回（`floor` より前は見ない） */
function lastFireAtOrBefore(repeat: AutomationRepeat, timeZone: string, upTo: Date, floor: Date): Date | undefined {
  // 1週間ずつ戻って、その間の最後の回を探す（どの繰り返しも1週間に1回は来る。cron の式は来ないこともある）
  for (let from = upTo.getTime() - 8 * DAY; from + 8 * DAY > floor.getTime(); from -= 8 * DAY) {
    let at = nextFireAt(repeat, timeZone, new Date(Math.max(from, floor.getTime())));
    let last: Date | undefined;
    while (at && at.getTime() <= upTo.getTime()) {
      last = at;
      at = nextFireAt(repeat, timeZone, at);
    }
    if (last) return last;
  }
  return undefined;
}

/**
 * **cron の式を確かめる**（台帳に入れる前。読めない式・15分より短い間隔を残さない——規則2）。理由（人が読める文）を返す
 */
export function cronExpressionProblem(expr: string, timeZone: string, now: Date = new Date()): string | undefined {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) return "cron の式は5つの欄（分 時 日 月 曜日）で書いてください（例 0 9 * * 1-5）";
  let cron: Cron;
  try {
    cron = new Cron(fields.join(" "), { timezone: timeZone, paused: true });
  } catch (err) {
    return `cron の式が読めません：${err instanceof Error ? err.message : String(err)}`;
  }
  // 先の回を並べて、間が15分より短いところが無いか見る（1年ぶん・最大 2000 回）
  let prev = cron.nextRun(now);
  if (!prev) return "cron の式に該当する時刻がありません";
  for (let i = 0; i < 2000 && prev.getTime() - now.getTime() < 366 * DAY; i++) {
    const at = cron.nextRun(prev);
    if (!at) break;
    if (at.getTime() - prev.getTime() < AUTOMATION_MIN_INTERVAL_MS) return "間隔は15分より短くできません";
    prev = at;
  }
  return undefined;
}

interface LocalFields {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
    });
    formatters.set(timeZone, f);
  }
  return f;
}

/** その時刻の、その土地の壁時計 */
function localFields(at: Date, timeZone: string): LocalFields {
  const parts: Record<string, number> = {};
  for (const p of formatter(timeZone).formatToParts(at)) {
    if (p.type !== "literal") parts[p.type] = Number(p.value);
  }
  return { year: parts.year!, month: parts.month!, day: parts.day!, hour: parts.hour!, minute: parts.minute! };
}

/** 壁時計を UTC とみなしたミリ秒（分まで） */
function localWallMs(at: Date, timeZone: string): number {
  const f = localFields(at, timeZone);
  return Date.UTC(f.year, f.month - 1, f.day, f.hour, f.minute);
}

/**
 * その土地の壁時計 → 実際の時刻。重なり（夏時間の終わり）は早いほう、飛び（夏時間の始まりで無い時刻）は飛んだ直後
 */
function localToInstant(timeZone: string, year: number, month: number, day: number, hour: number, minute: number): Date {
  const wall = Date.UTC(year, month - 1, day, hour, minute);
  // 前後半日の時差を候補にする（切り替わりはその間に高々1回）
  const offsets = new Set([wall - 12 * HOUR, wall + 12 * HOUR].map((t) => localWallMs(new Date(t), timeZone) - Math.floor(t / MINUTE) * MINUTE));
  const hits = [...offsets].map((o) => wall - o).filter((t) => localWallMs(new Date(t), timeZone) === wall);
  if (hits.length > 0) return new Date(Math.min(...hits));
  // 飛び：壁時計がその時刻を越える最初の分を探す（飛びは高々数時間）
  const earliest = Math.min(...[...offsets].map((o) => wall - o));
  for (let t = earliest - 3 * HOUR; t <= earliest + 3 * HOUR; t += MINUTE) {
    if (localWallMs(new Date(t), timeZone) >= wall) return new Date(t);
  }
  throw new Error(`${timeZone} の ${year}-${month}-${day} ${hour}:${minute} を時刻に直せませんでした`);
}

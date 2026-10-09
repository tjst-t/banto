// **banto 本体の止まり具合と host の詰まり具合**（決定・2026-10-09、ユーザー。
// `docs/specs/v4-architecture.md` §5.4-0、`GET /api/admin/host-health`）。資源の画面がこれを読む。

import { readFileSync } from "node:fs";
import type { HostStallMeter, Stall } from "./host-stall.js";

export interface PressureLine {
  avg10: number;
  avg60: number;
}

export interface Pressure {
  some?: PressureLine;
  full?: PressureLine;
}

export interface HostHealth {
  /** 測った時刻（ISO 8601） */
  at: string;
  /** banto 本体（host のプロセス）の止まり（ms） */
  stall: { max10s: number; max60s: number; recent: Array<{ at: string; ms: number }> };
  /** host の詰まり具合（`/proc/pressure/*`、%）。読めなければ無い */
  pressure: { cpu?: Pressure; memory?: Pressure; io?: Pressure };
  /** host の `MemAvailable`（バイト）。読めなければ無い */
  memAvailableBytes?: number;
  memTotalBytes?: number;
}

/** `/proc/pressure/*` の中身を読む。 */
export function parsePressure(text: string): Pressure {
  const out: Pressure = {};
  for (const line of text.split("\n")) {
    const m = /^(some|full)\s+avg10=([\d.]+)\s+avg60=([\d.]+)/.exec(line.trim());
    if (m) out[m[1] as "some" | "full"] = { avg10: Number(m[2]), avg60: Number(m[3]) };
  }
  return out;
}

/** `/proc/meminfo` から MemAvailable と MemTotal（バイト）。 */
export function parseMeminfo(text: string): { available?: number; total?: number } {
  const kb = (key: string) => {
    const m = new RegExp(`^${key}:\\s+(\\d+) kB`, "m").exec(text);
    return m ? Number(m[1]) * 1024 : undefined;
  };
  return { available: kb("MemAvailable"), total: kb("MemTotal") };
}

function readOr(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

export function collectHostHealth(
  meter: Pick<HostStallMeter, "maxWithin" | "recent">,
  read: (path: string) => string | undefined = readOr,
  now: () => Date = () => new Date(),
): HostHealth {
  const pressure: HostHealth["pressure"] = {};
  for (const kind of ["cpu", "memory", "io"] as const) {
    const text = read(`/proc/pressure/${kind}`);
    if (text !== undefined) pressure[kind] = parsePressure(text);
  }
  const mem = parseMeminfo(read("/proc/meminfo") ?? "");
  return {
    at: now().toISOString(),
    stall: {
      max10s: meter.maxWithin(10_000),
      max60s: meter.maxWithin(60_000),
      recent: meter.recent(20).map((s: Stall) => ({ at: new Date(s.endedAt - s.ms).toISOString(), ms: s.ms })),
    },
    pressure,
    ...(mem.available !== undefined ? { memAvailableBytes: mem.available } : {}),
    ...(mem.total !== undefined ? { memTotalBytes: mem.total } : {}),
  };
}

/**
 * **`~/banto-host.log` の行に時刻を付ける**（決定・2026-10-09）。systemd は標準出力をファイルに足すだけで
 * 時刻を付けない。`console.log`・`info`・`warn`・`error` の頭に ISO 8601（UTC、ミリ秒まで）を付ける。
 * 書式の文字列（`%s` 等）を壊さないよう、頭が文字列ならそこに足す。
 */
export function timestampConsole(target: Console = console, now: () => Date = () => new Date()): void {
  for (const method of ["log", "info", "warn", "error"] as const) {
    const original = target[method].bind(target);
    target[method] = (...args: unknown[]) => {
      const ts = now().toISOString();
      if (typeof args[0] === "string") original(`${ts} ${args[0]}`, ...args.slice(1));
      else original(ts, ...args);
    };
  }
}

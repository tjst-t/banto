/**
 * ホストの空きリソースを読む（リソースベース並行制御・work/reports/2026-08-17 設計書 タスクA）。
 *
 * 初版は**メモリのみ**（設計書 決定2：CPU は第2段）。職人を起こすかどうかの判定材料を
 * 「空きメモリ」で測る。
 *
 * - **計測は判定のたびに**（軽い `/proc` 読みなので問題無い）
 * - **読めなかったときは分からないと言う**（I2）——主たる判定（本数）はそれとは独立に
 *   動くので、ここで落ちることはない（fallback に `os.freemem()`）
 *
 * D6: 依存は node 標準のみ。
 */

import * as fs from "node:fs";
import * as os from "node:os";

/** ホストの空きリソースの写し。初版はメモリのみ（CPU は第2段）。 */
export interface HostResources {
  /** 空きメモリ（MiB）。読めなかったときは `os.freemem()` の値（負にならない）。 */
  memoryMiB: number;
}

/**
 * `/proc/meminfo` の本文から `MemAvailable`（MiB）を抜き出す（純粋・試験用）。
 *
 * `MemAvailable` は kB の行（`MemAvailable: 1234567 kB`）。無い行は `undefined`
 * （「分かる値で埋めない」・I2）。
 */
export function parseMemAvailableMiB(meminfo: string): number | undefined {
  for (const line of meminfo.split("\n")) {
    const m = /^MemAvailable:\s*([0-9]+)\s*kB\s*$/.exec(line);
    if (m) return Math.round(Number(m[1]) / 1024);
  }
  return undefined;
}

/**
 * ホストの空きメモリを読む。
 *
 * まず `/proc/meminfo` の `MemAvailable` を読む（Linux）。読めない環境では
 * `os.freemem()` へ落ちる——読めないことを黙って 0 にしない（I2）。
 */
export function readHostResources(osMemFreeMiB?: number, meminfo?: string): HostResources {
  if (meminfo !== undefined) {
    const fromProc = parseMemAvailableMiB(meminfo);
    if (fromProc !== undefined) return { memoryMiB: fromProc };
  }
  try {
    const proc = meminfo ?? fs.readFileSync("/proc/meminfo", "utf8");
    const fromProc = parseMemAvailableMiB(proc);
    if (fromProc !== undefined) return { memoryMiB: fromProc };
  } catch {
    // /proc を読めない環境（非Linux）は os.freemem() へ落とす
  }
  const free = osMemFreeMiB ?? Math.floor(os.freemem() / 1024 / 1024);
  return { memoryMiB: Math.max(0, free) };
}

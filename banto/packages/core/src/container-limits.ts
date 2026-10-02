// **Project のコンテナの資源の上限の設定**（決定・2026-10-02、ユーザー。`docs/specs/v4-security.md` §1）。
//
// 計算そのものは `@banto/container`（`limitCeiling`・`effectiveLimitNumbers`）。ここは runtime config との
// 受け渡しと、画面から来た値の検査だけ：
// - banto 全体（instance 既定）：host に残すメモリ（MiB）・host に残す CPU（コア）・1台あたりのプロセス数
// - Project ごと（Project 上書き）：メモリ（MiB）・CPU（コア）・プロセス数。**天井より下げることだけ**できる
//   （上げた値は天井で止まる——計算側が丸める）
//
// banto 全体の値と Project ごとの値は**別の鍵**にする。同じ鍵にすると、カスケードで Project の値が banto 全体の値を
// 置き換え、「残す量」と「上限」という意味の違うものが混ざる
import {
  DEFAULT_LIMIT_POLICY,
  effectiveLimitNumbers,
  limitCeiling,
  type ContainerLimitOverride,
  type ContainerLimitPolicy,
  type HostResources,
  type LimitNumbers,
} from "@banto/container";
import type { RuntimeConfigStore } from "./config/runtime.js";

export const POLICY_KEYS = {
  hostReserveMemoryMiB: "container.limits.hostReserveMemoryMiB",
  hostReserveCpus: "container.limits.hostReserveCpus",
  processes: "container.limits.processes",
} as const satisfies Record<keyof ContainerLimitPolicy, string>;

export const OVERRIDE_KEYS = {
  memoryMiB: "container.limits.project.memoryMiB",
  cpus: "container.limits.project.cpus",
  processes: "container.limits.project.processes",
} as const satisfies Record<keyof ContainerLimitOverride, string>;

type Config = Pick<RuntimeConfigStore, "layerValue">;

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

export function readLimitPolicy(config: Config | undefined): ContainerLimitPolicy {
  const out = { ...DEFAULT_LIMIT_POLICY };
  for (const k of Object.keys(POLICY_KEYS) as (keyof ContainerLimitPolicy)[]) {
    const v = num(config?.layerValue(POLICY_KEYS[k]));
    if (v !== undefined) out[k] = v;
  }
  return out;
}

export function readLimitOverride(config: Config | undefined, projectId: string): ContainerLimitOverride {
  const out: ContainerLimitOverride = {};
  for (const k of Object.keys(OVERRIDE_KEYS) as (keyof ContainerLimitOverride)[]) {
    const v = num(config?.layerValue(OVERRIDE_KEYS[k], projectId));
    if (v !== undefined) out[k] = v;
  }
  return out;
}

export interface ContainerLimitsView {
  host: { memoryMiB: number; cpus: number };
  policy: ContainerLimitPolicy;
  defaults: ContainerLimitPolicy;
  /** banto 全体の天井（Project ごとの値はこれより下げることだけできる） */
  ceiling: LimitNumbers;
  /** Project を指したときだけ */
  override?: ContainerLimitOverride;
  effective?: LimitNumbers;
}

export function describeLimits(config: Config | undefined, host: HostResources, projectId?: string): ContainerLimitsView {
  const policy = readLimitPolicy(config);
  const ceiling = limitCeiling(host, policy);
  const view: ContainerLimitsView = {
    host: { memoryMiB: Math.floor(host.memoryBytes / 1024 ** 2), cpus: host.cpus },
    policy,
    defaults: DEFAULT_LIMIT_POLICY,
    ceiling,
  };
  if (projectId !== undefined) {
    view.override = readLimitOverride(config, projectId);
    view.effective = effectiveLimitNumbers(ceiling, view.override);
  }
  return view;
}

/** その Project（または banto 全体用のコンテナの id）に付ける上限の数 */
export function limitNumbersFor(config: Config | undefined, host: HostResources, projectId: string): LimitNumbers {
  return effectiveLimitNumbers(limitCeiling(host, readLimitPolicy(config)), readLimitOverride(config, projectId));
}

/** 画面から来た banto 全体の値を検査する。壊れた値は投げる（黙って既定へ落とさない） */
export function parsePolicyBody(body: unknown): ContainerLimitPolicy {
  const b = (body ?? {}) as Record<string, unknown>;
  const mem = num(b["hostReserveMemoryMiB"]);
  const cpu = num(b["hostReserveCpus"]);
  const proc = num(b["processes"]);
  if (mem === undefined || mem < 0 || !Number.isInteger(mem)) throw new Error("host に残すメモリは 0 以上の整数（MiB）で渡してください");
  if (cpu === undefined || cpu < 0) throw new Error("host に残す CPU は 0 以上の数（コア）で渡してください");
  if (proc === undefined || proc < 256 || !Number.isInteger(proc)) throw new Error("プロセス数は 256 以上の整数で渡してください");
  return { hostReserveMemoryMiB: mem, hostReserveCpus: cpu, processes: proc };
}

/** 画面から来た Project ごとの値を検査する。null は「上書きをやめる（banto 全体のまま）」 */
export function parseOverrideBody(body: unknown): { [K in keyof ContainerLimitOverride]-?: number | null } {
  const b = (body ?? {}) as Record<string, unknown>;
  const field = (key: string, ok: (v: number) => boolean, msg: string): number | null => {
    const v = b[key];
    if (v === null || v === undefined) return null;
    const n = num(v);
    if (n === undefined || !ok(n)) throw new Error(msg);
    return n;
  };
  return {
    memoryMiB: field("memoryMiB", (n) => Number.isInteger(n) && n >= 256, "メモリは 256 以上の整数（MiB）で渡してください"),
    cpus: field("cpus", (n) => n >= 0.1, "CPU は 0.1 以上の数（コア）で渡してください"),
    processes: field("processes", (n) => Number.isInteger(n) && n >= 256, "プロセス数は 256 以上の整数で渡してください"),
  };
}

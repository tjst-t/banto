// **進める自動化の全体の上限**（決定・2026-10-24、ユーザー。アーキ仕様 §4.3「判断役の一般化」の 4.）。
//
// 番頭の `runsPerHour`・`instructionsPerHour`・`factoryConcurrent` を、`canAdvanceProject` を持つ自動化すべての合計の上限に一般化した。
// 鍵は `supervisor.limits.*` から `automation.advance.limits.*` に付け替える。全部の合計なので、番頭と同じく全体の層（instance）だけを読む
// ——Project で変えると数えが割れる。
//
// 旧鍵からの読み替えは起動のときに一度だけ（`migrateAdvanceLimitKeys`）：新しい鍵が無く旧鍵があれば写し、済んだ印を残す。印が
// あれば二度と写さない（人が新しい鍵を変えたあとに、旧鍵で上書きしない）。旧鍵は番頭の実装がまだ読むので消さない。
//
// 任せる行い（`supervisor.delegate`）・止まったと見なす時間（`supervisor.idleHours`）・1日の数えのタイムゾーン（`supervisor.timeZone`）は
// まだ付け替えない——Project の方針として番頭と共有する（アーキ仕様 §4.3「release 既定の違いの決着」）

import type { RuntimeConfigStore, RuntimeConfigValue } from "../config/runtime.js";
import { SUPERVISOR_DEFAULTS, SUPERVISOR_KEYS, supervisorPolicy } from "../supervisor/policy.js";
import type { AdvancePolicy } from "./advance.js";

export const ADVANCE_LIMIT_KEYS = {
  runsPerHour: "automation.advance.limits.runsPerHour",
  instructionsPerHour: "automation.advance.limits.instructionsPerHour",
  factoryConcurrent: "automation.advance.limits.factoryConcurrent",
} as const;

/** 旧鍵からの読み替えを済ませた印（instance の層） */
export const ADVANCE_LIMITS_MIGRATED_KEY = "automation.advance.limits.migratedFromSupervisor";

/** 上限の既定（番頭と同じ値） */
export const ADVANCE_LIMIT_DEFAULTS = {
  runsPerHour: SUPERVISOR_DEFAULTS.runsPerHour,
  instructionsPerHour: SUPERVISOR_DEFAULTS.instructionsPerHour,
  factoryConcurrent: SUPERVISOR_DEFAULTS.factoryConcurrent,
} as const;

/** 旧鍵と新しい鍵の組（読み替えの順） */
const RENAMES = [
  [SUPERVISOR_KEYS.runsPerHour, ADVANCE_LIMIT_KEYS.runsPerHour],
  [SUPERVISOR_KEYS.instructionsPerHour, ADVANCE_LIMIT_KEYS.instructionsPerHour],
  [SUPERVISOR_KEYS.factoryConcurrent, ADVANCE_LIMIT_KEYS.factoryConcurrent],
] as const;

function positiveNumber(value: RuntimeConfigValue | undefined, fallback: number, key: string, problems: string[]): number {
  if (value === undefined) return fallback;
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
  problems.push(`${key} が正の数ではありません（既定の ${fallback} を使います）`);
  return fallback;
}

/**
 * **その Project の、進める自動化の方針**。上限は `automation.advance.limits.*`（全体の層だけ）、任せる行い・止まったと見なす時間・
 * タイムゾーンは Project の方針（`supervisor.*`、全体＋Project の差分）
 */
export function advancePolicy(
  config: Pick<RuntimeConfigStore, "layerValue"> | undefined,
  projectId: string,
): AdvancePolicy & { problems: string[] } {
  const base = supervisorPolicy(config, projectId);
  const problems = [...base.problems];
  const instance = (key: string) => config?.layerValue(key);
  return {
    delegate: base.delegate,
    idleHours: base.idleHours,
    ...(base.timeZone ? { timeZone: base.timeZone } : {}),
    limits: {
      runsPerHour: positiveNumber(instance(ADVANCE_LIMIT_KEYS.runsPerHour), ADVANCE_LIMIT_DEFAULTS.runsPerHour, ADVANCE_LIMIT_KEYS.runsPerHour, problems),
      instructionsPerHour: positiveNumber(
        instance(ADVANCE_LIMIT_KEYS.instructionsPerHour),
        ADVANCE_LIMIT_DEFAULTS.instructionsPerHour,
        ADVANCE_LIMIT_KEYS.instructionsPerHour,
        problems,
      ),
      factoryConcurrent: positiveNumber(
        instance(ADVANCE_LIMIT_KEYS.factoryConcurrent),
        ADVANCE_LIMIT_DEFAULTS.factoryConcurrent,
        ADVANCE_LIMIT_KEYS.factoryConcurrent,
        problems,
      ),
    },
    problems,
  };
}

/**
 * **旧鍵（`supervisor.limits.*`）からの読み替えを一度だけ行う**（起動のとき）。済んだ印があれば何もしない。新しい鍵が無く旧鍵が
 * あるものだけ写す。写した鍵を返す
 */
export async function migrateAdvanceLimitKeys(config: Pick<RuntimeConfigStore, "layerValue" | "setInstanceDefault">): Promise<string[]> {
  if (config.layerValue(ADVANCE_LIMITS_MIGRATED_KEY) === true) return [];
  const copied: string[] = [];
  for (const [from, to] of RENAMES) {
    const old = config.layerValue(from);
    if (old === undefined || config.layerValue(to) !== undefined) continue;
    await config.setInstanceDefault(to, old);
    copied.push(to);
  }
  await config.setInstanceDefault(ADVANCE_LIMITS_MIGRATED_KEY, true);
  return copied;
}

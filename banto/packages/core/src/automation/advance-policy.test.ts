// アーキ仕様 §4.3「判断役の一般化」の 4.——進める自動化の全体の上限は `automation.advance.limits.*`（全体の層だけ）。旧鍵
// `supervisor.limits.*` からは起動のときに一度だけ読み替える。数えは全部の進める自動化の合計
import { test } from "node:test";
import assert from "node:assert/strict";
import type { RuntimeConfigValue } from "../config/runtime.js";
import { SUPERVISOR_KEYS } from "../supervisor/policy.js";
import type { Automation, AutomationRun } from "./fold.js";
import { ADVANCE_LIMIT_DEFAULTS, ADVANCE_LIMIT_KEYS, ADVANCE_LIMITS_MIGRATED_KEY, advancePolicy, migrateAdvanceLimitKeys } from "./advance-policy.js";
import { advanceInstructionLimitReason, advanceRunLimitReason } from "./advance.js";

function config(instance: Record<string, RuntimeConfigValue> = {}, projects: Record<string, Record<string, RuntimeConfigValue>> = {}) {
  const map = new Map(Object.entries(instance));
  return {
    map,
    layerValue: (key: string, projectId?: string) => (projectId ? projects[projectId]?.[key] : map.get(key)),
    setInstanceDefault: async (key: string, value: RuntimeConfigValue) => void map.set(key, value),
  };
}

test("上限は automation.advance.limits.* を全体の層だけから読む。旧鍵は読まない。無ければ既定", () => {
  const c = config(
    { [ADVANCE_LIMIT_KEYS.runsPerHour]: 3, [SUPERVISOR_KEYS.instructionsPerHour]: 99, [ADVANCE_LIMIT_KEYS.factoryConcurrent]: -1 },
    { p: { [ADVANCE_LIMIT_KEYS.runsPerHour]: 100 } },
  );
  const p = advancePolicy(c, "p");
  assert.deepEqual(p.limits, { runsPerHour: 3, instructionsPerHour: ADVANCE_LIMIT_DEFAULTS.instructionsPerHour, factoryConcurrent: ADVANCE_LIMIT_DEFAULTS.factoryConcurrent });
  assert.ok(p.problems.some((x) => x.includes(ADVANCE_LIMIT_KEYS.factoryConcurrent)), "読めない値は黙らずに出す");
  // 任せる行いは Project の方針（release は既定で任されない）
  assert.equal(p.delegate.includes("release"), false);
});

test("旧鍵からの読み替えは一度だけ：新しい鍵の無いものだけ写し、印があれば二度と写さない", async () => {
  const c = config({ [SUPERVISOR_KEYS.runsPerHour]: 5, [SUPERVISOR_KEYS.factoryConcurrent]: 4, [ADVANCE_LIMIT_KEYS.factoryConcurrent]: 1 });
  assert.deepEqual(await migrateAdvanceLimitKeys(c), [ADVANCE_LIMIT_KEYS.runsPerHour]);
  assert.equal(c.map.get(ADVANCE_LIMIT_KEYS.runsPerHour), 5);
  assert.equal(c.map.get(ADVANCE_LIMIT_KEYS.factoryConcurrent), 1, "人が決めた新しい鍵を旧鍵で上書きしない");
  assert.equal(c.map.has(ADVANCE_LIMIT_KEYS.instructionsPerHour), false, "旧鍵が無いものは写さない");
  assert.equal(c.map.get(ADVANCE_LIMITS_MIGRATED_KEY), true);
  assert.equal(c.map.get(SUPERVISOR_KEYS.runsPerHour), 5, "旧鍵は番頭がまだ読むので消さない");
  // 人が新しい鍵を変えたあとに起こし直しても、旧鍵で戻さない
  c.map.set(ADVANCE_LIMIT_KEYS.runsPerHour, 20);
  c.map.delete(ADVANCE_LIMIT_KEYS.factoryConcurrent);
  assert.deepEqual(await migrateAdvanceLimitKeys(c), []);
  assert.equal(c.map.get(ADVANCE_LIMIT_KEYS.runsPerHour), 20);
  assert.equal(c.map.has(ADVANCE_LIMIT_KEYS.factoryConcurrent), false);
  // 旧鍵が何も無い banto でも印だけ残す
  const empty = config();
  assert.deepEqual(await migrateAdvanceLimitKeys(empty), []);
  assert.equal(empty.map.get(ADVANCE_LIMITS_MIGRATED_KEY), true);
});

test("回と指示の上限は、全部の Project の進める自動化を合算して数える（飛ばした回・欄の無い自動化・番頭は数えない）", () => {
  const now = new Date("2026-10-24T12:00:00Z");
  const run = (at: string, result: AutomationRun["result"] = "done"): AutomationRun => ({ runId: at, at, cause: "clock", result });
  const auto = (over: Partial<Automation>): Automation => ({ runs: [], received: [], ...over }) as Automation;
  const automations = {
    listAll: () => [
      auto({ id: "a", projectId: "p1", canAdvanceProject: true, runs: [run("2026-10-24T11:30:00Z"), run("2026-10-24T11:40:00Z", "skipped")] }),
      auto({ id: "b", projectId: "p2", canAdvanceProject: true, runs: [run("2026-10-24T11:50:00Z"), run("2026-10-24T10:00:00Z")] }),
      auto({ id: "c", projectId: "p1", runs: [run("2026-10-24T11:55:00Z")] }),
      auto({ id: "d", projectId: "p1", mode: "supervisor", canAdvanceProject: true, runs: [run("2026-10-24T11:55:00Z")] }),
      auto({
        id: "e",
        projectId: "p2",
        delegateKinds: ["continue"],
        advanceActs: [{ at: "2026-10-24T11:10:00Z", kind: "instructed", threadId: "t", reason: "x" }],
      }),
    ],
  };
  assert.equal(advanceRunLimitReason(automations, { runsPerHour: 3 }, now), undefined);
  assert.match(advanceRunLimitReason(automations, { runsPerHour: 2 }, now) ?? "", /2 回までです（いま 2 回）/);
  assert.equal(advanceInstructionLimitReason(automations, { instructionsPerHour: 2 }, now), undefined);
  assert.match(advanceInstructionLimitReason(automations, { instructionsPerHour: 1 }, now) ?? "", /1 件までです（いま 1 件）/);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import type { RuntimeConfigValue } from "../config/runtime.js";
import { decisionsOf } from "../automation/turn-decisions.js";
import {
  DEFAULT_DELEGATE,
  SUPERVISOR_DEFAULTS,
  SUPERVISOR_KEYS,
  serializeInstanceDelegate,
  serializeProjectDelegate,
  supervisorMayAnswer,
  supervisorPolicy,
} from "./policy.js";

function config(instance: Record<string, RuntimeConfigValue>, projects: Record<string, Record<string, RuntimeConfigValue>> = {}) {
  return {
    layerValue: (key: string, projectId?: string) => (projectId ? projects[projectId]?.[key] : instance[key]),
  };
}

test("値が無ければ既定：release 以外の行いを任せ、間隔・上限は既定の値", () => {
  const p = supervisorPolicy(config({}), "p1");
  assert.deepEqual(p.delegate, [...DEFAULT_DELEGATE]);
  assert.ok(!p.delegate.includes("release"));
  assert.equal(p.patrolHours, SUPERVISOR_DEFAULTS.patrolHours);
  assert.deepEqual(p.limits, { runsPerHour: 12, instructionsPerHour: 10, factoryConcurrent: 2 });
  assert.equal(p.note, "");
  assert.deepEqual(p.problems, []);
});

test("Project は全体に差分を重ねる（banto開発は release を足す、本番インフラは merge・push を外す）。文は全体に追記", () => {
  const c = config(
    { [SUPERVISOR_KEYS.delegate]: serializeInstanceDelegate(["continue", "merge", "push", "rerun-tests"]), [SUPERVISOR_KEYS.note]: "全体の方針" },
    {
      dev: { [SUPERVISOR_KEYS.delegate]: serializeProjectDelegate({ add: ["release"] }), [SUPERVISOR_KEYS.note]: "banto開発の注意" },
      infra: { [SUPERVISOR_KEYS.delegate]: serializeProjectDelegate({ remove: ["merge", "push"] }) },
    },
  );
  assert.deepEqual(supervisorPolicy(c, "dev").delegate, ["continue", "rerun-tests", "merge", "push", "release"]);
  assert.equal(supervisorPolicy(c, "dev").note, "全体の方針\n\nbanto開発の注意");
  assert.deepEqual(supervisorPolicy(c, "infra").delegate, ["continue", "rerun-tests"]);
  assert.deepEqual(supervisorPolicy(c, "other").delegate, ["continue", "rerun-tests", "merge", "push"]);
});

test("人に回す種類は方針に書いても任せられない。読めない値は任せない側に倒し、黙らずに problems に書く", () => {
  const c = config(
    { [SUPERVISOR_KEYS.delegate]: JSON.stringify(["continue", "spec", "unknown"]), [SUPERVISOR_KEYS.patrolHours]: -1 },
    { bad: { [SUPERVISOR_KEYS.delegate]: "{壊れている" }, sneaky: { [SUPERVISOR_KEYS.delegate]: JSON.stringify({ add: ["publish", "money"] }) } },
  );
  const p = supervisorPolicy(c, "x");
  assert.deepEqual(p.delegate, ["continue"]);
  assert.equal(p.patrolHours, SUPERVISOR_DEFAULTS.patrolHours);
  assert.equal(p.problems.length, 3);
  assert.deepEqual(supervisorPolicy(c, "bad").delegate, []);
  assert.deepEqual(supervisorPolicy(c, "sneaky").delegate, ["continue"]);
  assert.equal(supervisorPolicy(config({ [SUPERVISOR_KEYS.delegate]: "壊れている" }), "x").delegate.length, 0);
});

test("数の設定とタイムゾーンは全体の層だけを読む（上限は全部の番頭の合計）", () => {
  const c = config(
    { [SUPERVISOR_KEYS.factoryConcurrent]: 3, [SUPERVISOR_KEYS.timeZone]: "Asia/Tokyo" },
    { p: { [SUPERVISOR_KEYS.factoryConcurrent]: 50, [SUPERVISOR_KEYS.timeZone]: "UTC" } },
  );
  const p = supervisorPolicy(c, "p");
  assert.equal(p.limits.factoryConcurrent, 3);
  assert.equal(p.timeZone, "Asia/Tokyo");
});

test("番頭が答えてよいのは、その Project で任せる行いの種類の問いだけ", () => {
  const policy = { delegate: [...DEFAULT_DELEGATE] };
  assert.deepEqual(supervisorMayAnswer("rerun-tests", policy), { ok: true });
  assert.deepEqual(supervisorMayAnswer("minor-design", policy), { ok: true });
  for (const kind of [undefined, "spec", "publish", "money", "destructive", "release", "nonsense"]) {
    const r = supervisorMayAnswer(kind, policy);
    assert.equal(r.ok, false, String(kind));
  }
  assert.match((supervisorMayAnswer("spec", policy) as { reason: string }).reason, /人が決めます/);
  assert.match((supervisorMayAnswer(undefined, policy) as { reason: string }).reason, /書かれていない/);
  assert.deepEqual(supervisorMayAnswer("release", { delegate: ["release"] }), { ok: true });
});

test("まとめの決めることの種類を読む（知らない値・無いものは持たない）", () => {
  const options = [
    { label: "A", reply: "A で" },
    { label: "B", reply: "B で" },
  ];
  const ds = decisionsOf({
    decisions: [
      { question: "release に入れますか", kind: "release", options },
      { question: "設計を変えますか", kind: "spec", options },
      { question: "どれ？", kind: "bogus", options },
      { question: "どれ？", options },
    ],
  });
  assert.deepEqual(
    ds.map((d) => d.kind),
    ["release", "spec", undefined, undefined],
  );
});

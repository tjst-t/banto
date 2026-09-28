import { test } from "node:test";
import assert from "node:assert/strict";
import {
  classifyMetaDifference,
  parseModuleMeta,
  ModuleMetaError,
  visibilityOf,
  stripBantoMeta,
  reconcileModuleMeta,
  assertAllVisibilityExplicit,
  assertVisibilityValues,
  CALL_ID_META_KEY,
  CALLER_META_KEY,
  callIdOf,
  callerOf,
} from "./meta.js";

test("parses a valid module meta", () => {
  const meta = parseModuleMeta(
    {
      satisfies: ["shell"],
      dependsOn: [{ role: "vault", required: true }],
      isolation: "subprocess",
      handlesSecrets: false,
      scope: "project",
      confinement: { kind: "landlock", root: "project" },
    },
    "test",
  );
  assert.equal(meta.scope, "project");
  assert.equal(meta.dependsOn[0]?.role, "vault");
});

test("rejects handlesSecrets + in-process", () => {
  assert.throws(
    () =>
      parseModuleMeta(
        { satisfies: [], dependsOn: [], isolation: "in-process", handlesSecrets: true },
        "test",
      ),
    ModuleMetaError,
  );
});

test("rejects confinement without project scope", () => {
  assert.throws(
    () =>
      parseModuleMeta(
        {
          satisfies: [],
          dependsOn: [],
          isolation: "subprocess",
          confinement: { kind: "landlock", root: "project" },
        },
        "test",
      ),
    ModuleMetaError,
  );
});

test("visibility defaults to agent", () => {
  assert.equal(visibilityOf({}), "agent");
  assert.equal(visibilityOf({ _meta: { "dev.banto/visibility": "module" } }), "module");
});

test("stripBantoMeta keeps other vendors", () => {
  const stripped = stripBantoMeta({
    _meta: { "dev.banto/visibility": "agent", "com.example/foo": "bar" },
  });
  assert.deepEqual(stripped._meta, { "com.example/foo": "bar" });
});

test("reconcile flags spawn-shape mismatches for respawn", () => {
  const staticMeta = parseModuleMeta(
    { satisfies: ["shell"], dependsOn: [], isolation: "in-process", scope: "instance" },
    "static",
  );
  const dynamicMeta = parseModuleMeta(
    { satisfies: ["shell"], dependsOn: [], isolation: "subprocess", scope: "project" },
    "dynamic",
  );
  const result = reconcileModuleMeta(staticMeta, dynamicMeta);
  assert.equal(result.requiresRespawn, true);
  assert.ok(result.changedFields.includes("isolation"));
  assert.ok(result.changedFields.includes("scope"));
});

test("assertAllVisibilityExplicit rejects missing visibility", () => {
  assert.throws(() =>
    assertAllVisibilityExplicit([{ name: "resolveAlias", meta: {} }], "vault"),
  );
  assert.doesNotThrow(() =>
    assertAllVisibilityExplicit(
      [{ name: "resolveAlias", meta: { "dev.banto/visibility": "module" } }],
      "vault",
    ),
  );
});

// 宣言（Config）と自己申告（Module）の食い違いを、**方向で**分ける
// （決定・2026-09-06）。Module の申告は「より厳しくする方向にだけ効く情報」で、
// banto の隔離を緩める権限は無い——Module は他人が書いたものでありうるので、
// 「私は秘密を扱いません、閉じ込め不要です」を鵜呑みにして起動してはいけない。
test("Module がより厳しい形を申告したら、厳しい側として拾う", () => {
  const declared = parseModuleMeta(
    { satisfies: ["x"], dependsOn: [], isolation: "subprocess", scope: "instance" },
    "declared",
  );
  const reported = parseModuleMeta(
    { satisfies: ["x"], dependsOn: [], isolation: "subprocess", scope: "project", handlesSecrets: true },
    "reported",
  );
  const diff = classifyMetaDifference(declared, reported);
  assert.deepEqual(diff.stricter.sort(), ["handlesSecrets", "scope"]);
  assert.deepEqual(diff.looser, []);
});

test("Module がより緩い形を申告したら、緩い側として拾う（自動では従わない）", () => {
  const declared = parseModuleMeta(
    {
      satisfies: ["x"],
      dependsOn: [],
      isolation: "subprocess",
      scope: "project",
      confinement: { kind: "landlock", root: "project" },
    },
    "declared",
  );
  const reported = parseModuleMeta(
    { satisfies: ["x"], dependsOn: [], isolation: "in-process", scope: "instance" },
    "reported",
  );
  const diff = classifyMetaDifference(declared, reported);
  assert.deepEqual(diff.looser.sort(), ["confinement", "isolation", "scope"]);
  assert.deepEqual(diff.stricter, []);
});

test("起動の形に関わらない差分は、厳しい/緩いのどちらでもない", () => {
  const declared = parseModuleMeta({ satisfies: ["x"], dependsOn: [], isolation: "subprocess" }, "d");
  const reported = parseModuleMeta({ satisfies: ["x", "y"], dependsOn: [], isolation: "subprocess" }, "r");
  const diff = classifyMetaDifference(declared, reported);
  assert.deepEqual(diff.stricter, []);
  assert.deepEqual(diff.looser, []);
  assert.deepEqual(diff.other, ["satisfies"]);
});

test("同じなら差分なし", () => {
  const meta = { satisfies: ["x"], dependsOn: [], isolation: "subprocess", scope: "project", confinement: { kind: "landlock", root: "project" } };
  const diff = classifyMetaDifference(parseModuleMeta(meta, "d"), parseModuleMeta(meta, "r"));
  assert.deepEqual(diff, { stricter: [], looser: [], other: [] });
});

// **書き間違いを「無指定」と同じに扱わない**（決定・2026-09-10、`module-meta-strict-values`）。
// 既定は「キーが無いとき」の話。値が壊れているときに緩い側へ落ちると、
// Module 専用のつもりの道具が AI に見え、秘密を扱う Module が in-process で立つ。

test("scope の書き間違いは instance に落とさず、拒否する", () => {
  assert.throws(
    () => parseModuleMeta({ satisfies: ["x"], isolation: "subprocess", scope: "projekt" }, "typo"),
    /scope は instance か project/,
  );
});

test("handlesSecrets の型違いは false に落とさず、拒否する", () => {
  assert.throws(
    () => parseModuleMeta({ satisfies: ["x"], isolation: "subprocess", handlesSecrets: "true" }, "typo"),
    /handlesSecrets は true か false/,
  );
});

test("無指定は今までどおり既定（instance / false）", () => {
  const meta = parseModuleMeta({ satisfies: ["x"], isolation: "subprocess" }, "default");
  assert.equal(meta.scope, "instance");
  assert.equal(meta.handlesSecrets, false);
});

test("visibility の書き間違いは、いちばん緩い側ではなく狭い側へ倒れる", () => {
  // 既定（キーが無い）は agent のまま
  assert.equal(visibilityOf({}), "agent");
  // 壊れた値は module（AI にも画面にも出ない）
  assert.equal(visibilityOf({ _meta: { "dev.banto/visibility": "modle" } }), "module");
  assert.equal(visibilityOf({ _meta: { "dev.banto/visibility": 3 } }), "module");
});

test("壊れた visibility を持つ Module は、そもそも繋がせない", () => {
  assert.throws(
    () =>
      assertVisibilityValues(
        [
          { name: "ok", meta: { "dev.banto/visibility": "admin" } },
          { name: "無指定でよい" },
          { name: "こわれ", meta: { "dev.banto/visibility": "modle" } },
        ],
        "vault",
      ),
    /こわれ="modle"/,
  );
});

test("値が正しい／無指定だけなら通る", () => {
  assert.doesNotThrow(() =>
    assertVisibilityValues([{ name: "a", meta: { "dev.banto/visibility": "module" } }, { name: "b" }], "x"),
  );
});

// **Skill の印**（決定・2026-09-23、アーキ仕様 §5.6）。`true` 以外は名乗っていない
test("Skill の印は true のときだけ効く", async () => {
  const { isSkillResource } = await import("./meta.js");
  assert.equal(isSkillResource({ _meta: { "dev.banto/skill": true } }), true);
  assert.equal(isSkillResource({ _meta: { "dev.banto/skill": "yes" } }), false);
  assert.equal(isSkillResource({}), false);
});

// 名前と説明の形は Agent Skills の仕様の写し（banto の独自の制約ではない）
test("Skill の名前と説明が仕様の形に収まっているかを言う", async () => {
  const { skillEntryProblem } = await import("./meta.js");
  assert.equal(skillEntryProblem("pdf-processing", "PDF を扱う"), undefined);
  assert.match(skillEntryProblem("PDF", "x") ?? "", /形に合いません/);
  assert.match(skillEntryProblem("-pdf", "x") ?? "", /形に合いません/);
  assert.match(skillEntryProblem("pdf--x", "x") ?? "", /形に合いません/);
  assert.match(skillEntryProblem("a".repeat(65), "x") ?? "", /64 字/);
  assert.match(skillEntryProblem("pdf", "") ?? "", /説明がありません/);
  assert.match(skillEntryProblem("pdf", "x".repeat(1025)) ?? "", /1024 字/);
  assert.match(skillEntryProblem(undefined, "x") ?? "", /名前がありません/);
});

// **人の刻印に Project を併記する形**（追加・2026-09-28）。名前を `forProject` にしてあるので、今までの受け手
// （`"project" in stamp` で Project の刻印かを見る）には人の刻印のままにしか見えない
test("callerOf：人の刻印に併記した forProject を読み、Project の刻印には化けない", () => {
  const stamp = callerOf({ [CALLER_META_KEY]: { admin: true, forProject: "pA" } });
  assert.deepEqual(stamp, { admin: true, forProject: "pA" });
  assert.ok(stamp && "admin" in stamp && !("project" in stamp));
  assert.deepEqual(callerOf({ [CALLER_META_KEY]: { admin: true, forProject: "" } }), { admin: true });
  assert.deepEqual(callerOf({ [CALLER_META_KEY]: { admin: true } }), { admin: true });
  assert.equal(callIdOf({ [CALL_ID_META_KEY]: "abc" }), "abc");
  assert.equal(callIdOf({ [CALL_ID_META_KEY]: 1 }), undefined);
});

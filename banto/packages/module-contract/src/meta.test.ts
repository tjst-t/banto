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

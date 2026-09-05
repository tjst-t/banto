import { test } from "node:test";
import assert from "node:assert/strict";
import {
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

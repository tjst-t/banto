import { test } from "node:test";
import assert from "node:assert/strict";
import { assertRulesetIsSafe, UnsafeRulesetError } from "./guard.js";
import type { LandlockRulesetFile } from "./ruleset.js";

const opts = { dataDir: "/home/x/.local/share/banto", configDir: "/home/x/.config/banto" };

function ruleset(rules: LandlockRulesetFile["rules"]): LandlockRulesetFile {
  return { version: 1, requireAbi: 4, rules };
}

test("safe ruleset passes", () => {
  assert.doesNotThrow(() =>
    assertRulesetIsSafe(ruleset([{ path: "/tmp/project", access: ["read_file"] }]), opts),
  );
});

test("rejects root path", () => {
  assert.throws(
    () => assertRulesetIsSafe(ruleset([{ path: "/", access: ["read_file"] }]), opts),
    UnsafeRulesetError,
  );
});

test("rejects dataDir ancestor", () => {
  assert.throws(
    () =>
      assertRulesetIsSafe(ruleset([{ path: "/home/x/.local/share", access: ["read_file"] }]), opts),
    UnsafeRulesetError,
  );
});

test("allows dataDir itself", () => {
  assert.doesNotThrow(() =>
    assertRulesetIsSafe(ruleset([{ path: opts.dataDir, access: ["read_file"] }]), opts),
  );
});

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

// **`/proc` は許可リストに入れない**（決定・2026-09-10、`relay-proc-allowlist`）。
// 入れると、AI の書いたコマンドが親（Module）の `/proc/<pid>/environ` から
// 中継トークンを読める——子プロセスに env を渡さないようにしても、ここから漏れる。
test("derive は /proc を許可しない", async () => {
  const { deriveProjectRuleset } = await import("./derive.js");
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const root = mkdtempSync(join(tmpdir(), "banto-derive-proc-"));
  for (const profile of ["exec", "files-only"] as const) {
    const { ruleset } = deriveProjectRuleset({
      projectRoot: root,
      pathEntries: (process.env.PATH ?? "").split(":").filter(Boolean),
      profile,
      nodeExecPath: process.execPath,
    });
    const paths = ruleset.rules.map((r) => r.path);
    assert.equal(paths.includes("/proc"), false, `${profile}: /proc が許可リストに入っている`);
    // 壊していないこと——実行に要るものは残っている
    assert.ok(paths.includes("/etc"), `${profile}: /etc まで落ちている`);
    assert.ok(paths.some((p) => p === root), `${profile}: Project の根が入っていない`);
  }
});

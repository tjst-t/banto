import { test } from "node:test";
import assert from "node:assert/strict";
import { homedir } from "node:os";
import { assertRulesetIsSafe, UnsafeRulesetError } from "./guard.js";
import { deriveProjectRuleset } from "./derive.js";
import type { LandlockRulesetFile } from "./ruleset.js";

const opts = { dataDir: "/home/x/.local/share/banto", configDir: "/home/x/.config/banto" };

function ruleset(rules: LandlockRulesetFile["rules"]): LandlockRulesetFile {
  return { version: 1, requireAbi: 4, rules };
}

// **人が選んだ根は通す**（改訂・2026-09-11、ユーザー決定）。以前は home を
// 根にすると起動ごと止めていたが、「home で AI に色々やらせたい」を banto が
// 止める理由は無い——伝えるのは画面の警告で行う（v4-security.md）。
// 捕まえたいのは**導出が勝手に広がった場合**なので、そちらは変わらず弾く。

test("人が選んだ根が home でも通す（選んだものは事故ではない）", () => {
  assert.doesNotThrow(() =>
    assertRulesetIsSafe(ruleset([{ path: "/home/x", access: ["read_file", "write_file"] }]), {
      ...opts,
      projectRoot: "/home/x",
    }),
  );
});

test("根の中のものも通す（根を選んだ時点で中は見える）", () => {
  assert.doesNotThrow(() =>
    assertRulesetIsSafe(ruleset([{ path: "/home/x/.claude", access: ["read_file"] }]), {
      ...opts,
      projectRoot: "/home/x",
    }),
  );
});

test("根ではないのに home が入っていたら、いまも弾く（導出が広がった）", () => {
  assert.throws(
    () =>
      assertRulesetIsSafe(ruleset([{ path: "/home/x", access: ["read_file"] }]), {
        ...opts,
        projectRoot: "/tmp/project",
      }),
    UnsafeRulesetError,
  );
});

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

// **根の無い閉じ込め**（追加・2026-09-15）。banto 全体に1本の Module 用
// ——Project の根が無くても、`~/.claude` や banto の置き場は読ませない。
test("根が無くても組める——そして home も dataDir も許さない", () => {
  const { ruleset } = deriveProjectRuleset({
    pathEntries: [],
    profile: "files-only",
    nodeExecPath: process.execPath,
  });
  const paths = ruleset.rules.map((r) => r.path);
  assert.ok(paths.length > 0, "何も許していない（node すら動かない）");
  const home = homedir();
  assert.equal(paths.includes(home), false, "home を許している");
  assert.equal(
    paths.some((p) => p.startsWith(`${home}/.claude`)),
    false,
    "資格情報の置き場を許している",
  );
});

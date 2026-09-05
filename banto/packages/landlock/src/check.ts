// 起動時に1回、ABI版が足りているかを確認する。
// docs/specs/v4-security.md「ABI 版が足りなければ断る」の実装。

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REQUIRE_ABI, type LandlockRulesetFile } from "./ruleset.js";
import { assertLauncherAvailable, resolveLauncherBinPath, writeRulesetFile, parseLauncherStderr } from "./spawn.js";

export interface AbiCheckResult {
  ok: boolean;
  abi: number;
  ruleCount: number;
  raw: string;
}

/**
 * 実際に最小のルールセットで `--check-only` を走らせ、このカーネルで
 * 要求ABIのLandlockルールセットを作れるか確かめる。「たぶん動く」で
 * 済ませない（規則1）——起動時に1回だけ実測する。
 */
export function checkAbi(): AbiCheckResult {
  assertLauncherAvailable();

  const probe: LandlockRulesetFile = {
    version: 1,
    requireAbi: REQUIRE_ABI,
    rules: [{ path: "/tmp", access: ["read_file", "read_dir"] }],
  };

  const dir = mkdtempSync(join(tmpdir(), "banto-landlock-check-"));
  try {
    const rulesetFile = writeRulesetFile(dir, "check", probe);
    try {
      const stdout = execFileSync(
        resolveLauncherBinPath(),
        ["--ruleset-file", rulesetFile, "--check-only"],
        { stdio: ["ignore", "pipe", "pipe"] },
      );
      // check-only は stdout に何も書かない契約。念のため空であることを確認する。
      if (stdout.length > 0) {
        throw new Error("banto-landlock-exec が --check-only で stdout に書き込んだ（契約違反）");
      }
      return { ok: true, abi: REQUIRE_ABI, ruleCount: probe.rules.length, raw: "" };
    } catch (e) {
      const stderrText =
        e && typeof e === "object" && "stderr" in e
          ? String((e as { stderr: unknown }).stderr)
          : "";
      const lines = parseLauncherStderr(stderrText);
      return { ok: false, abi: 0, ruleCount: 0, raw: lines.map((l) => l.message ?? l.code).join("; ") };
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

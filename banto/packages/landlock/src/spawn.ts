// banto-landlock-exec の解決・呼び出しの薄いラッパー。
// 「バイナリが無い/実行不可なら、Landlock対象のModuleを一切起動しない」
// という不変条件はここではなく呼び出し側（core側のsupervisor）が守る——
// このファイルはバイナリが無ければ単に例外を投げるだけ。

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { accessSync, constants, mkdirSync, writeFileSync } from "node:fs";
import type { LandlockRulesetFile } from "./ruleset.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

export function resolveLauncherBinPath(): string {
  return join(__dirname, "..", "rust-launcher", "target", "release", "banto-landlock-exec");
}

export class LauncherUnavailableError extends Error {}

export function assertLauncherAvailable(binPath = resolveLauncherBinPath()): void {
  try {
    accessSync(binPath, constants.X_OK);
  } catch (e) {
    throw new LauncherUnavailableError(
      `banto-landlock-exec が見つからないか実行できません（${binPath}）。` +
        `Landlock対象のModuleは起動しません——unconfinedへのフォールバックはしない。`,
    );
  }
}

export function writeRulesetFile(runDir: string, name: string, ruleset: LandlockRulesetFile): string {
  mkdirSync(runDir, { recursive: true, mode: 0o700 });
  const path = join(runDir, `${name}.landlock.json`);
  writeFileSync(path, JSON.stringify(ruleset), { mode: 0o600 });
  return path;
}

export interface WrappedCommand {
  command: string;
  args: string[];
}

/** 元の command/args を banto-landlock-exec 経由の呼び出しに書き換える。 */
export function wrapCommand(
  rulesetFilePath: string,
  original: { command: string; args: string[] },
  binPath = resolveLauncherBinPath(),
): WrappedCommand {
  return {
    command: binPath,
    args: ["--ruleset-file", rulesetFilePath, "--", original.command, ...original.args],
  };
}

export interface LauncherLogLine {
  src: string;
  level: "info" | "error";
  code: string;
  message?: string;
  [key: string]: unknown;
}

/** launcher の stderr（1行1JSON）をパースする。パースできない行は無視する。 */
export function parseLauncherStderr(stderrText: string): LauncherLogLine[] {
  const lines: LauncherLogLine[] = [];
  for (const raw of stderrText.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    try {
      const parsed = JSON.parse(line) as unknown;
      if (
        typeof parsed === "object" &&
        parsed !== null &&
        "src" in parsed &&
        (parsed as { src?: unknown }).src === "banto-landlock-exec"
      ) {
        lines.push(parsed as LauncherLogLine);
      }
    } catch {
      // launcher以外のstderr出力（例: node側のwarning）。無視する。
    }
  }
  return lines;
}

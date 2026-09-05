// ルールセットを書き出す前の最後の防波堤。poc/07の「許可リストが静かに
// 広がった」事故（symlink実体の親ディレクトリごと許可に紛れ込んだ）を、
// 機械的なチェックとして再発防止する。

import { homedir } from "node:os";
import { realpathSync } from "node:fs";
import type { LandlockRulesetFile } from "./ruleset.js";

export class UnsafeRulesetError extends Error {}

function isAncestorOrSelf(candidate: string, of: string): boolean {
  return of === candidate || of.startsWith(candidate.endsWith("/") ? candidate : candidate + "/");
}

function tryRealpath(p: string): string | undefined {
  try {
    return realpathSync(p);
  } catch {
    return undefined;
  }
}

export interface GuardOptions {
  dataDir: string;
  configDir: string;
}

/**
 * 危険な形のルールセットを機械的に拒否する。違反したら投げる——
 * 黙って弱いまま書き出さない（規則2）。
 */
export function assertRulesetIsSafe(ruleset: LandlockRulesetFile, opts: GuardOptions): void {
  const home = tryRealpath(homedir()) ?? homedir();
  const dataDir = tryRealpath(opts.dataDir) ?? opts.dataDir;
  const configDir = tryRealpath(opts.configDir) ?? opts.configDir;
  const credentialsFile = tryRealpath(`${home}/.claude/.credentials.json`);

  const forbidden = ["/", home];

  for (const rule of ruleset.rules) {
    for (const f of forbidden) {
      if (rule.path === f) {
        throw new UnsafeRulesetError(
          `ルールセットが禁止パスを直接許可しています: ${rule.path}`,
        );
      }
    }
    if (isAncestorOrSelf(rule.path, dataDir) && rule.path !== dataDir) {
      throw new UnsafeRulesetError(
        `ルールセットが dataDir の祖先を許可しています: ${rule.path} ⊇ ${dataDir}`,
      );
    }
    if (isAncestorOrSelf(rule.path, configDir) && rule.path !== configDir) {
      throw new UnsafeRulesetError(
        `ルールセットが configDir の祖先を許可しています: ${rule.path} ⊇ ${configDir}`,
      );
    }
    if (credentialsFile && isAncestorOrSelf(rule.path, credentialsFile)) {
      throw new UnsafeRulesetError(
        `ルールセットが資格情報ファイルを含むディレクトリを許可しています: ${rule.path}`,
      );
    }
  }
}

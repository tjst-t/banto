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
  /**
   * **人が選んだ Project の根**（改訂・2026-09-11、ユーザー決定）。
   *
   * この検査は「導出が静かに広がった」事故を捕まえるためのもの（poc/07——
   * PATH の realpath の親がまるごと紛れ込んだ）。**人が自分で指定した根は、
   * 事故ではない**。home を根にして AI に色々やらせたい、という使い方を
   * banto が止める理由は無い（ユーザー決定・2026-09-11）——伝えるなら
   * 「選ばせない」ではなく「選ぶ前に、何が見えるようになるかを見せる」
   * （画面の警告、`docs/specs/v4-security.md`）。
   */
  projectRoot?: string;
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

  const projectRoot = opts.projectRoot ? (tryRealpath(opts.projectRoot) ?? opts.projectRoot) : undefined;

  for (const rule of ruleset.rules) {
    // **人が選んだ根は、そのまま通す**（改訂・2026-09-11、ユーザー決定）。
    // 広い根（home 等）を選べば閉じ込めは効かなくなるが、それは**選ぶ前に
    // 画面で伝える**ことにした——ここで起動ごと止めない。導出が勝手に
    // 広がった場合（PATH の親が紛れ込む等）はこの免除に入らないので、
    // これまでどおり捕まる
    if (projectRoot && isAncestorOrSelf(projectRoot, rule.path)) continue;
    if (rule.path === "/" || rule.path === home) {
      throw new UnsafeRulesetError(
        `ルールセットが ${rule.path} を許可しています（Project の根ではないのに、導出が広がっています）`,
      );
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

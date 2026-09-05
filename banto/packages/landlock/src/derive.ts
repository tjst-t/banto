// docs/specs/v4-security.md「許可リストの組み方」の実装。
// host がProjectごとに1回だけ計算し、Shell・FileSystemの両方に同じ根・同じ
// 導出関数を通す（規則3——構造的に「片方だけ守られた」状態を防ぐ）。
//
// 固定リストは環境（nvm・asdf・Homebrew・snap等でPATHがホーム配下や/opt/snapを
// 指す場合）で壊れる（poc/07で実測）。PATHから動的に組む。

import { existsSync, realpathSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  type AccessFsName,
  type LandlockRule,
  type LandlockRulesetFile,
  READ_EXEC,
  READ_ONLY,
  READ_WRITE,
  DEV_READ_WRITE,
  REQUIRE_ABI,
} from "./ruleset.js";
import { listLdSoConfPaths } from "./ldso.js";

export type ConfinementProfile = "exec" | "files-only";

export interface DeriveProjectRulesetInput {
  /** Project の根。realpath 解決済みであることを呼び出し側が保証する。 */
  projectRoot: string;
  /** host が起動時に凍結した PATH（Module の実行時 env から読み直さない）。 */
  pathEntries: string[];
  profile: ConfinementProfile;
  /** 通常 process.execPath。launcher 自身が execve する対象の実行ファイル。 */
  nodeExecPath: string;
  /**
   * Module自身のインストール先（例：dist/を含むパッケージのルート）。
   * 実測で発見（2026-09-03）：Node は自分が実行するエントリスクリプト
   * （server.js等）を読めないと起動すらできない——これはProjectの根にも
   * システムのライブラリパスにも含まれない、banto自身のプログラムファイル
   * という第3の場所。指定しないとModuleプロセス自体が起動しない。
   */
  moduleInstallDirs?: string[];
}

export interface OmittedPath {
  path: string;
  reason: string;
}

export interface DeriveProjectRulesetResult {
  ruleset: LandlockRulesetFile;
  omitted: OmittedPath[];
}

const SIBLING_LIB_DIRS = ["lib", "lib64", "libexec", "share"];

function dedupeRules(rules: LandlockRule[]): LandlockRule[] {
  const byPath = new Map<string, Set<AccessFsName>>();
  for (const rule of rules) {
    const set = byPath.get(rule.path) ?? new Set<AccessFsName>();
    for (const a of rule.access) set.add(a);
    byPath.set(rule.path, set);
  }
  return Array.from(byPath.entries())
    .map(([path, access]) => ({ path, access: Array.from(access) }))
    .sort((a, b) => a.path.localeCompare(b.path));
}

function tryRealpath(path: string): string | undefined {
  try {
    return realpathSync(path);
  } catch {
    return undefined;
  }
}

function pushIfExists(
  target: LandlockRule[],
  omitted: OmittedPath[],
  path: string,
  access: AccessFsName[],
  reasonIfMissing = "ENOENT",
): void {
  const real = tryRealpath(path);
  if (real === undefined) {
    omitted.push({ path, reason: reasonIfMissing });
    return;
  }
  if (!existsSync(real) || !statSync(real).isDirectory()) {
    omitted.push({ path, reason: "not a directory" });
    return;
  }
  target.push({ path: real, access });
}

/**
 * Project の根・PATH・profile から Landlock ルールセットを組む。
 * poc/07 で踏んだ罠（`dirname(realpath('/usr/bin/X11'))` が `/usr` 全体を
 * 静かに含んでしまう）を避けるため、シンボリックリンクの実体解決の結果を
 * そのまま「兄弟ディレクトリ探索」の入力にはしない——realpath 後の
 * ディレクトリ自身の兄弟だけを見る。
 */
export function deriveProjectRuleset(input: DeriveProjectRulesetInput): DeriveProjectRulesetResult {
  const rules: LandlockRule[] = [];
  const omitted: OmittedPath[] = [];

  // launcher 自身が node へ execve するために、node バイナリのディレクトリは
  // 常に EXECUTE が要る（profile に関わらず）。
  const nodeReal = tryRealpath(input.nodeExecPath);
  if (nodeReal === undefined) {
    omitted.push({ path: input.nodeExecPath, reason: "node実行ファイルが見つからない" });
  } else {
    pushIfExists(rules, omitted, dirname(nodeReal), READ_EXEC);
  }

  // 動的リンカが要るパス（node自身の共有ライブラリ解決にも要る、profile共通）。
  // EXECUTE も要る——ELFインタプリタ（ld-linux*.so、実測では
  // /usr/lib/x86_64-linux-gnu/ld-linux-x86-64.so.2）はカーネルが直接execする
  // ため、read権限だけでは動的リンクされたバイナリのexecve自体が失敗する
  // （実測で発見：/bin/shの起動がPermission deniedになった）。
  for (const p of listLdSoConfPaths()) {
    pushIfExists(rules, omitted, p, READ_EXEC);
  }

  if (input.profile === "exec") {
    for (const dir of input.pathEntries) {
      pushIfExists(rules, omitted, dir, READ_EXEC);
      for (const sibling of SIBLING_LIB_DIRS) {
        const siblingPath = join(dir, "..", sibling);
        // 兄弟は「存在すれば足す」——無いのが普通なので reason は詳細に残さない
        const real = tryRealpath(siblingPath);
        if (real !== undefined && statSync(real).isDirectory()) {
          rules.push({ path: real, access: READ_ONLY });
        }
      }
    }
    // git が /dev/null を O_RDWR で開く（実測、poc/07）。
    pushIfExists(rules, omitted, "/dev", DEV_READ_WRITE);
  } else {
    // FileSystem は他プロセスを実行しないので PATH 実行権は要らない。
    pushIfExists(rules, omitted, "/dev", READ_ONLY);
  }

  pushIfExists(rules, omitted, "/etc", READ_ONLY);
  pushIfExists(rules, omitted, "/proc", READ_ONLY);

  // Module自身のプログラムファイル（例：dist/server.js）——Project根でも
  // システムのライブラリパスでもない第3の場所（実機テストで発見）。
  for (const dir of input.moduleInstallDirs ?? []) {
    pushIfExists(rules, omitted, dir, READ_ONLY, "Module install dirが存在しない");
  }

  // Project の根——ここだけ書き込み可。
  pushIfExists(rules, omitted, input.projectRoot, READ_WRITE, "Project根が存在しない");

  return {
    ruleset: {
      version: 1,
      requireAbi: REQUIRE_ABI,
      rules: dedupeRules(rules),
    },
    omitted,
  };
}

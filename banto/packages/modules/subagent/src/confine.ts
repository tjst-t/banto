// サブエージェントを自分の Landlock ドメインで起こす（docs/specs/v4-security.md
// 「サブエージェントは自分のドメインで起こす」）。
//
// 許すもの：Project の根（読み書き）・専用ホーム（読み書き）・エージェント本体の置き場（実行）・
// PATH（profile exec）・`/proc`（読み取り）。**導出は Shell と同じ `deriveProjectRuleset`**
// ——同じ根に同じ関数を通す（規則3）。足すのは本体の置き場と `/proc` だけ。

import { randomUUID } from "node:crypto";
import { mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import {
  assertLauncherAvailable,
  assertRulesetIsSafe,
  deriveProjectRuleset,
  READ_EXEC,
  READ_ONLY,
  wrapCommand,
  writeRulesetFile,
  type GuardOptions,
} from "@banto/landlock";
import type { AgentDefinition } from "./agents.js";

export interface ConfineInput {
  agent: AgentDefinition;
  projectRoot: string;
  /** その エージェントの専用ホーム（`HOME`・`TMPDIR`・XDG をここへ向ける） */
  home: string;
  /** ルールセットを書き出す置き場（Module のデータ置き場の下） */
  runDir: string;
  /** Module が起動したときの PATH（実行時に読み直さない） */
  pathEntries: string[];
  guard: GuardOptions;
}

export interface Confined {
  command: string;
  args: string[];
  /** 専用ホームに向けた環境変数 */
  env: Record<string, string>;
}

export function confineAgent(input: ConfineInput): Confined {
  // **閉じ込められないなら起こさない**——閉じ込め無しへ落ちない（規則2）
  assertLauncherAvailable();
  const home = realpathOrCreate(input.home);
  const tmp = join(home, "tmp");
  mkdirSync(tmp, { recursive: true });

  const { ruleset } = deriveProjectRuleset({
    projectRoot: realpathSync(input.projectRoot),
    pathEntries: input.pathEntries,
    profile: "exec",
    nodeExecPath: process.execPath,
    moduleDataDir: home,
    moduleInstallDirs: [],
  });
  for (const dir of input.agent.installDirs) ruleset.rules.push({ path: realpathSync(dir), access: READ_EXEC });
  // Bun の単体実行ファイルは `/proc` が読めないと起動しない。**他のドメインの environ は
  // Landlock が拒む**ので、読めるのはこのドメインの中だけ（実測、poc/08-subagent-acp/）
  ruleset.rules.push({ path: "/proc", access: READ_ONLY });
  // 書き出す前の最後の防波堤——banto の置き場・資格情報を含む許可なら止める
  assertRulesetIsSafe(ruleset, { ...input.guard, projectRoot: realpathSync(input.projectRoot) });

  mkdirSync(input.runDir, { recursive: true, mode: 0o700 });
  const file = writeRulesetFile(input.runDir, `subagent-${input.agent.id}-${randomUUID()}`, ruleset);
  const wrapped = wrapCommand(file, { command: input.agent.command, args: input.agent.args(input.projectRoot) });
  return {
    ...wrapped,
    env: {
      HOME: home,
      TMPDIR: tmp,
      XDG_CONFIG_HOME: join(home, ".config"),
      XDG_CACHE_HOME: join(home, ".cache"),
      XDG_DATA_HOME: join(home, ".local", "share"),
      XDG_STATE_HOME: join(home, ".local", "state"),
      ...input.agent.homeEnv(home),
    },
  };
}

function realpathOrCreate(dir: string): string {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return realpathSync(dir);
}

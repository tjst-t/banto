// エージェントを起こす形（改訂・2026-09-25、`docs/specs/v4-security.md` §1）。
//
// **閉じ込めは Project のコンテナ**——以前はエージェントごとに Landlock のドメインで包んでいたが、やめた（道具を
// 入れられない・許可リストに穴が出続ける・UNIX ソケットの抜け道があった）。ここでするのは、エージェントごとの
// **専用ホーム**を用意し、`HOME`・`TMPDIR`・XDG をそこへ向けることだけ——会話の記録や設定はエージェント自身の
// 置き場に残る（アーキ仕様 §4.1）。Module の置き場の下なので、コンテナを消さない限り残る。

import { mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import type { AgentDefinition } from "./agents.js";

export interface AgentLaunchShape {
  command: string;
  args: string[];
  /** 専用ホームに向けた環境変数 */
  env: Record<string, string>;
}

export function prepareAgentLaunch(agent: AgentDefinition, projectRoot: string, homeDir: string): AgentLaunchShape {
  mkdirSync(homeDir, { recursive: true, mode: 0o700 });
  const home = realpathSync(homeDir);
  const tmp = join(home, "tmp");
  mkdirSync(tmp, { recursive: true });
  return {
    command: agent.command,
    args: agent.args(projectRoot),
    env: {
      HOME: home,
      TMPDIR: tmp,
      XDG_CONFIG_HOME: join(home, ".config"),
      XDG_CACHE_HOME: join(home, ".cache"),
      XDG_DATA_HOME: join(home, ".local", "share"),
      XDG_STATE_HOME: join(home, ".local", "state"),
      ...agent.homeEnv(home),
    },
  };
}

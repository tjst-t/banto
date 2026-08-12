/**
 * Claude Code の職人を起こせる状態か（設定画面の「使える？」の一行）。
 *
 * **確かめられることだけを言う**（I1）。ここで見るのは「認証の在り処があるか」までで、
 * 実際に通るかは起こしてみるまで分からない——分からないことを「使えます」とは言わない。
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface ClaudeAvailability {
  ok: boolean;
  detail: string;
}

export function claudeAgentAvailability(env: NodeJS.ProcessEnv = process.env): ClaudeAvailability {
  if (env["ANTHROPIC_API_KEY"]) {
    return { ok: true, detail: "ANTHROPIC_API_KEY で認証します" };
  }
  const configDir = env["CLAUDE_CONFIG_DIR"] ?? path.join(os.homedir(), ".claude");
  const credentials = path.join(configDir, ".credentials.json");
  if (fs.existsSync(credentials)) {
    return { ok: true, detail: `Claude Code の認証を使います（${configDir}）` };
  }
  return {
    ok: false,
    detail: `認証が見つかりません（${credentials} も ANTHROPIC_API_KEY も無し）。claude /login で入れてください`,
  };
}

import { test } from "node:test";
import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";
import { hostClaudeCredentialsPath } from "./claude-login-proxy.js";

// 本体の CLI と同じ順で置き場を決める——E2E・疎通確認は CLAUDE_SECURESTORAGE_CONFIG_DIR で本物を指す
test("本体の資格情報の置き場は、CLI と同じ順で決まる", () => {
  assert.equal(
    hostClaudeCredentialsPath({ CLAUDE_SECURESTORAGE_CONFIG_DIR: "/s", CLAUDE_CONFIG_DIR: "/c" }),
    "/s/.credentials.json",
  );
  assert.equal(hostClaudeCredentialsPath({ CLAUDE_CONFIG_DIR: "/c" }), "/c/.credentials.json");
  assert.equal(hostClaudeCredentialsPath({}), join(homedir(), ".claude", ".credentials.json"));
});

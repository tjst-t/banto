// M3 の「host の代わり」：banto の host と同じく、SDK の既定の起こし方（spawnClaudeCodeProcess を渡さない）で CLI を起こし、
// SIGTERM／SIGINT で（スナップショット保存の代わりに少し待ってから）process.exit(0) する（cli.ts の扱いを真似る）
// 使い方（m3.mjs から起こされる）: node m3-host.mjs <configDir> <baseUrl> <workDir>
import { query } from "@anthropic-ai/claude-agent-sdk";
import { childEnv } from "./lib.mjs";

const [configDir, baseUrl, work] = process.argv.slice(2);
for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => {
    console.log(`HOST_GOT ${signal}`);
    setTimeout(() => process.exit(0), 50);
  });
}
let closeInput;
const keepOpen = new Promise((r) => (closeInput = r));
async function* promptStream() {
  yield { type: "user", message: { role: "user", content: "SLEEP_TOOL：sleep 120 を Bash で実行してください。" }, parent_tool_use_id: null };
  await keepOpen;
}
try {
  for await (const m of query({
    prompt: promptStream(),
    options: { cwd: work, model: "claude-haiku-4-5", env: childEnv({ configDir, baseUrl }), settingSources: [], strictMcpConfig: true, tools: ["Bash"], allowedTools: ["Bash"] },
  })) {
    if (m.type === "assistant" && m.message.content.some((b) => b.type === "tool_use")) console.log("TOOL_STARTED");
    if (m.type === "result") closeInput();
  }
} catch (e) {
  console.log(`HOST_QUERY_THREW ${e.message.split("\n")[0]}`);
}

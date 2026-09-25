// プローブ：コンテナの中の Claude Code CLI が、ホストの「ログインの中継」（本物のトークンは渡さない）を使えるか。
// 中継は 127.0.0.1 で待ち受ける作りなので、ここではブリッジのアドレスへの転送を足して、
// 「中継をブリッジ側で待ち受ける」形を真似る（権限を絞った区画では proxy デバイスが禁止のため）。
// usage: sg incus -c "node claude-in-container.mjs <container> <bridgeIp>"
import net from "node:net";
import { spawn } from "node:child_process";
// **spawnSync は使わない**——待っている間は同じプロセスの中継も止まり、子の問い合わせが返らない（踏んだ）
function run(cmd, args, timeout) {
  return new Promise((resolve) => {
    const c = spawn(cmd, args);
    let stdout = "", stderr = "";
    c.stdout.on("data", (d) => (stdout += d)); c.stderr.on("data", (d) => (stderr += d));
    const t = setTimeout(() => c.kill("SIGTERM"), timeout);
    c.on("close", (status) => { clearTimeout(t); resolve({ status, stdout, stderr }); });
  });
}
import { homedir } from "node:os";
const [ctr = "poc9", gw = "10.61.162.1"] = process.argv.slice(2);
const B = "/home/ubuntu/worktrees/banto-v4/banto";
const { startClaudeLoginProxy } = await import(`${B}/packages/modules/subagent/dist/claude-login-proxy.js`);
const proxy = await startClaudeLoginProxy({ credentialsPath: `${homedir()}/.claude/.credentials.json` });
const fwd = net.createServer((c) => { const u = net.connect(Number(new URL(proxy.url).port), "127.0.0.1"); c.pipe(u).pipe(c); c.on("error", () => u.destroy()); u.on("error", () => c.destroy()); });
await new Promise((r) => fwd.listen(0, gw, r));
const url = `http://${gw}:${fwd.address().port}`;
const cli = `${B}/node_modules/@agentclientprotocol/claude-agent-acp/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude`;
// 中継に届くか（合言葉なし → 401 が返るはず）
const reach = await run("incus", ["exec", ctr, "--", "python3", "-c", `import urllib.request as u
try:
  u.urlopen(u.Request("${url}/v1/messages", data=b"{}", headers={"content-type":"application/json"}), timeout=5); print("合言葉なし: 通った")
except Exception as e: print("合言葉なし:", e)`], 20000);
console.log(reach.stdout.trim() || reach.stderr.trim());
const t0 = Date.now();
const r = await run("incus", ["exec", ctr, "--user", "1000", "--group", "1000", "--cwd", "/home/ubuntu/poc9-project",
  "--env", "HOME=/tmp/claude-home", "--env", `ANTHROPIC_BASE_URL=${url}`, "--env", `CLAUDE_CODE_OAUTH_TOKEN=${proxy.secret}`,
  "--env", "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1", "--env", "DISABLE_AUTOUPDATER=1",
  "--", cli, "-p", "Reply with exactly: OK-from-container", "--model", "haiku"], 90000);
console.log("exit", r.status, `${Date.now() - t0}ms`, "stdout:", JSON.stringify(r.stdout.trim().slice(0, 200)), "stderr:", JSON.stringify(r.stderr.trim().slice(0, 300)));
console.log("中継の上流での認証失敗:", proxy.upstreamAuthFailures?.() ?? proxy.upstreamAuthFailures);
fwd.close(); await proxy.close();

// 捨てる。node_modules は PoC の置き場（npm install --include=dev）。banto 本体の Claude ログインを、サブエージェントに**トークンを渡さずに**使わせられるか。
//
// 形：Module が 127.0.0.1 に中継を立て、エージェントには ANTHROPIC_BASE_URL＝中継、
// CLAUDE_CODE_OAUTH_TOKEN＝使い捨ての合言葉だけを渡す。中継は合言葉を確かめてから、
// Authorization を本体の access token（~/.claude から毎回読む）に差し替えて api.anthropic.com へ流す。
//
// 見るもの：①仕事が通るか ②どの道（パス）を中継が通したか ③中継を通らずに外へ出ようとして
// 失敗したものは無いか（stderr）④選べるモデルが本体と同じか
//
// usage: node proxy-probe.mjs
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { client, methods, ndJsonStream, PROTOCOL_VERSION } from "@agentclientprotocol/sdk";

const BANTO = "/home/ubuntu/worktrees/banto-v4/banto";
const secret = `banto-proxy-${randomUUID()}`;
const seen = [];
const realToken = () => JSON.parse(readFileSync(join(homedir(), ".claude/.credentials.json"), "utf8")).claudeAiOauth.accessToken;

const proxy = createServer(async (req, res) => {
  const auth = req.headers.authorization ?? "";
  const ok = auth === `Bearer ${secret}`;
  seen.push(`${req.method} ${req.url} auth=${ok ? "合言葉" : auth ? "別物" : "無し"} beta=${req.headers["anthropic-beta"] ?? "-"}`);
  if (!ok) {
    res.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ error: "合言葉が違う" }));
    return;
  }
  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (["host", "connection", "content-length", "authorization", "x-api-key"].includes(k)) continue;
    headers[k] = Array.isArray(v) ? v.join(", ") : v;
  }
  headers.authorization = `Bearer ${realToken()}`;
  const body = ["GET", "HEAD"].includes(req.method) ? undefined : Readable.toWeb(req);
  const upstream = await fetch(`https://api.anthropic.com${req.url}`, { method: req.method, headers, body, duplex: "half" });
  const out = {};
  upstream.headers.forEach((v, k) => {
    if (!["content-encoding", "content-length", "transfer-encoding", "connection"].includes(k)) out[k] = v;
  });
  res.writeHead(upstream.status, out);
  if (upstream.body) Readable.fromWeb(upstream.body).pipe(res);
  else res.end();
});
await new Promise((r) => proxy.listen(0, "127.0.0.1", r));
const port = proxy.address().port;

// 中継を通らずに外へ出る通信を見る：HTTPS_PROXY に CONNECT だけ記録して素通しする口を立てる
import("node:net").then(() => {});
const { connect } = await import("node:net");
const tunnels = [];
const tunnel = createServer();
tunnel.on("connect", (req, sock, head) => {
  tunnels.push(req.url);
  const [host, p] = req.url.split(":");
  const up = connect(Number(p), host, () => {
    sock.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    up.write(head);
    up.pipe(sock);
    sock.pipe(up);
  });
  up.on("error", () => sock.destroy());
  sock.on("error", () => up.destroy());
});
await new Promise((r) => tunnel.listen(0, "127.0.0.1", r));
const scratch = mkdtempSync(join(tmpdir(), "proxy-probe-"));
const child = spawn(process.execPath, [join(BANTO, "node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js")], {
  cwd: scratch,
  env: {
    PATH: process.env.PATH,
    HOME: scratch,
    CLAUDE_CONFIG_DIR: join(scratch, ".claude"),
    CLAUDE_CODE_OAUTH_TOKEN: secret,
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`,
    HTTPS_PROXY: `http://127.0.0.1:${tunnel.address().port}`,
    NO_PROXY: "127.0.0.1,localhost",
  },
  stdio: ["pipe", "pipe", "pipe"],
});
let stderr = "";
child.stderr.on("data", (d) => (stderr += d));
let text = "";
const result = {};
try {
  await client({ name: "proxy-probe" })
    .onNotification(methods.client.session.update, (ctx) => {
      const u = ctx.params.update;
      if (u.sessionUpdate === "agent_message_chunk" && u.content.type === "text") text += u.content.text;
    })
    .onRequest(methods.client.session.requestPermission, (ctx) => ({ outcome: { outcome: "selected", optionId: ctx.params.options[0].optionId } }))
    .connectWith(ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout)), async (ctx) => {
      await ctx.request(methods.agent.initialize, { protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} });
      const s = await ctx.request(methods.agent.session.new, { cwd: scratch, mcpServers: [] });
      const model = s.configOptions.find((o) => o.category === "model");
      result.models = model.options.map((o) => o.value);
      result.defaultModel = model.currentValue;
      result.defaultLabel = model.options.find((o) => o.value === "default")?.description ?? model.options.find((o) => o.value === "default")?.name;
      await ctx.request(methods.agent.session.setConfigOption, { sessionId: s.sessionId, configId: model.id, value: "haiku" });
      const r = await ctx.request(methods.agent.session.prompt, {
        sessionId: s.sessionId,
        prompt: [{ type: "text", text: "「はい」とだけ答えて。" }],
      });
      result.stopReason = r.stopReason;
    });
} catch (err) {
  result.error = String(err?.message ?? err) + (err?.data ? ` ${JSON.stringify(err.data).slice(0, 400)}` : "");
}
result.reply = text.trim().slice(0, 80);
console.log("RESULT", JSON.stringify(result, null, 1));
console.log("中継が見た道：\n  " + [...new Set(seen)].join("\n  "));
console.log("中継を通らずに出た先（CONNECT）：\n  " + [...new Set(tunnels)].join("\n  "));
tunnel.close();
console.log("stderr（外へ出ようとした跡）：\n" + stderr.split("\n").filter((l) => /error|fail|ENOTFOUND|ECONN|401|403|https?:\/\//i.test(l)).slice(0, 20).join("\n"));
child.kill();
proxy.close();
rmSync(scratch, { recursive: true, force: true });
setTimeout(() => process.exit(0), 300);

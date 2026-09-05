// 実際にAnthropic APIを叩く手動確認スクリプト（自動テストには含めない——課金される）。
// poc/05・06の設計を、本実装のコード（agent-proxy.ts）で検証し直す。
// Runner↔代理サーバは実HTTP接続（決定・2026-09-03、
// docs/notes/2026-09-03-agent-relay-http-transport.md）——in-processの
// `{type:'sdk', instance}`ではElicitationが機能しないため。
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { AgentRelayEndpoint } from "../../dist/relay/agent-relay-endpoint.js";
import { parseModuleMeta } from "../../../module-contract/dist/meta.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const client = new Client(
  { name: "banto-host", version: "0.0.0" },
  { capabilities: { elicitation: {} } },
);
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [join(__dirname, "fixtures", "fake-module.mjs")],
});
await client.connect(transport);
console.log("[host] connected to fake module, pid known only to OS");

const meta = parseModuleMeta(
  { satisfies: ["vault"], dependsOn: [], isolation: "subprocess" },
  "fake-vault",
);

let relayLog = [];
const relayAuthToken = "manual-smoke-token";
const agentRelay = new AgentRelayEndpoint(relayAuthToken, { onRelay: (r) => relayLog.push(r) });
agentRelay.registerModule({ name: "vault", client, meta });

const httpServer = createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : undefined;
  await agentRelay.handleRequest("vault", req, res, body);
});
await new Promise((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
const relayUrl = `http://127.0.0.1:${httpServer.address().port}`;

console.log("[host] agent-relay HTTP endpoint up, running real query() with Runner...");

const result = await query({
  prompt:
    "Call the requestAlias tool from the vault MCP server with no arguments, then report exactly what text content it returned.",
  options: {
    mcpServers: { vault: { type: "http", url: relayUrl, headers: { authorization: `Bearer ${relayAuthToken}` } } },
    permissionMode: "bypassPermissions",
  },
});

const messages = [];
for await (const m of result) messages.push(m);

const init = messages.find((m) => m.type === "system" && m.subtype === "init");
const vaultTools = (init?.tools ?? []).filter((t) => t.startsWith("mcp__vault__"));
console.log("[runner] tools seen from vault server:", vaultTools);

const finalMessage = messages.find((m) => m.type === "result");
console.log("[runner] final result text:", finalMessage?.result);

// --- 検証 ---
let failed = false;

if (!vaultTools.includes("mcp__vault__requestAlias")) {
  console.error("FAIL: agent可視性のtool requestAlias がRunnerに見えていない");
  failed = true;
}
if (vaultTools.includes("mcp__vault__resolveAlias")) {
  console.error("FAIL: module可視性のtool resolveAlias がRunnerに見えてしまっている");
  failed = true;
}
if (typeof finalMessage?.result === "string" && finalMessage.result.includes("SECRET-VALUE")) {
  console.error("FAIL: module可視性のtoolの値が会話に漏れている");
  failed = true;
}
if (!relayLog.some((r) => r.direction === "call" && r.name === "requestAlias" && r.allowed)) {
  console.error("FAIL: requestAliasの中継が記録されていない");
  failed = true;
}

// resource: 一覧に無いURIを直接読もうとして拒否されるか
try {
  await client.readResource; // sanity, unused
} catch {}

console.log(failed ? "RESULT: FAIL" : "RESULT: OK");
await client.close();
httpServer.close();
process.exit(failed ? 1 : 0);

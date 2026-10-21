#!/usr/bin/env node
// **試験用の MCP サーバ：結果で画面を名乗り、要約を頼む Module**（追加・2026-10-21、アーキ仕様 §4.2「札の手がかりを Module が
// あとから足す・結果で画面を名乗る」、Backlog #489）。
//
// 同梱の扱い（目録の隠れた1本 `e2e-bgv`、`modules/declaration.ts`——要約の口は同梱だけが頼める）で Project ごとに起きる。
//
// - `startWork`（AI、`dev.banto/deliversLater`）：裏の仕事を1つ始めたことにする。tool の定義には画面を持たせず、「あとで届ける」
//   結果に `dev.banto/backgroundView`（入口 `ui://e2e-background-view/works` と `select: { workId }`）を載せる。届けはしない
//   ——札は、この Module が止まったときに host が「途中で終わりました」で片づける
// - `summarizeWork`（人の画面、admin）：その仕事の札を添えて host の `relaySummarizeBackgroundWork` を呼ぶ。試験が
//   `/api/projects/:id/ui-tool-call` で呼ぶ（本物はサブエージェントの画面の「いまの様子を要約」）
// - 入口の画面：開いたときに受け取った「見ている場所」（`dev.banto/view-state`）をそのまま出す

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { BACKGROUND_VIEW_META_KEY, RELAY_SUMMARIZE_BACKGROUND_WORK_TOOL } from "@banto/module-contract";

const UI_APP_MIME = "text/html;profile=mcp-app";
const WORKS_URI = "ui://e2e-background-view/works";
/** workId → 札（その仕事を頼んだ呼び出しで host が渡したもの） */
const works = new Map();

let relay;
async function relayClient() {
  if (relay) return relay;
  const url = process.env.BANTO_HOST_MCP_URL;
  const token = process.env.BANTO_HOST_MCP_TOKEN;
  if (!url || !token) throw new Error("中継の口（BANTO_HOST_MCP_URL・BANTO_HOST_MCP_TOKEN）がありません");
  const client = new Client({ name: "e2e-background-view", version: "0.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
  relay = client;
  return client;
}

const WORKS_HTML = `<!doctype html><html><body>
<p data-role="title">試験の仕事の画面</p>
<p data-role="selected">（選んでいない）</p>
<script>
let nextId = 1;
const waiting = new Map();
function send(m) { window.parent.postMessage({ jsonrpc: "2.0", ...m }, "*"); }
window.addEventListener("message", (e) => {
  const m = e.data;
  if (!m || m.jsonrpc !== "2.0" || m.id === undefined || !waiting.has(m.id)) return;
  const w = waiting.get(m.id); waiting.delete(m.id);
  m.error ? w.reject(new Error(m.error.message)) : w.resolve(m.result);
});
function request(method, params) {
  const id = nextId++;
  send({ id, method, params });
  return new Promise((resolve, reject) => waiting.set(id, { resolve, reject }));
}
request("ui/initialize", { protocolVersion: "2026-01-26", appInfo: { name: "e2e-background-view", version: "0.0.0" }, appCapabilities: {} })
  .then((init) => {
    const state = init && init.hostContext && init.hostContext["dev.banto/view-state"];
    document.querySelector('[data-role="selected"]').textContent = state && state.workId ? "選んだ仕事：" + state.workId : "（選んでいない）";
    send({ method: "ui/notifications/initialized", params: {} });
  });
</script></body></html>`;

const server = new Server({ name: "banto-e2e-background-view", version: "0.0.0" }, { capabilities: { tools: {}, resources: {} } });

server.setRequestHandler(ListResourcesRequestSchema, async () => ({
  resources: [
    {
      uri: WORKS_URI,
      name: "試験の仕事",
      description: "結果で名乗った画面（試験用）",
      mimeType: UI_APP_MIME,
      _meta: { "dev.banto/visibility": "admin", "dev.banto/canvas": "launcher" },
    },
  ],
}));

server.setRequestHandler(ReadResourceRequestSchema, async (req) => {
  if (req.params.uri !== WORKS_URI) throw new Error(`unknown resource: ${req.params.uri}`);
  return { contents: [{ uri: WORKS_URI, mimeType: UI_APP_MIME, text: WORKS_HTML }] };
});

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "startWork",
      description: "裏の仕事を1つ始める（試験用）。終わりは届かない",
      inputSchema: { type: "object", properties: { workId: { type: "string" } }, required: ["workId"] },
      _meta: {
        "dev.banto/visibility": "agent",
        "dev.banto/deliversLater": true,
        "dev.banto/card": { title: "試験の裏の仕事：{workId}" },
      },
    },
    {
      name: "summarizeWork",
      description: "その仕事の要約を host に頼む（試験用）",
      inputSchema: { type: "object", properties: { workId: { type: "string" }, text: { type: "string" } }, required: ["workId", "text"] },
      _meta: { "dev.banto/visibility": "admin" },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const args = req.params.arguments ?? {};
  if (req.params.name === "startWork") {
    const workId = String(args.workId ?? "");
    const replyTo = req.params._meta?.["dev.banto/replyTo"];
    if (typeof replyTo === "string") works.set(workId, replyTo);
    return {
      content: [{ type: "text", text: `仕事 ${workId} を始めました。終わったら届きます` }],
      ...(typeof replyTo === "string"
        ? { _meta: { "dev.banto/pendingReply": true, [BACKGROUND_VIEW_META_KEY]: { resourceUri: WORKS_URI, select: { workId } } } }
        : {}),
    };
  }
  if (req.params.name === "summarizeWork") {
    const workId = String(args.workId ?? "");
    const replyTo = works.get(workId);
    const client = await relayClient();
    const result = await client.callTool({
      name: RELAY_SUMMARIZE_BACKGROUND_WORK_TOOL,
      arguments: { ...(replyTo ? { replyTo } : {}), material: { workId, text: String(args.text ?? "") } },
    });
    // 断りも中身のまま返す（試験が理由を見る）
    return { content: result.content, ...(result.isError ? { isError: true } : {}) };
  }
  throw new Error(`知らない tool です: ${req.params.name}`);
});

await server.connect(new StdioServerTransport());

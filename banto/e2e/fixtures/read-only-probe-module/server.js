#!/usr/bin/env node
// **試験用の MCP サーバ：読むだけの回を試す第三者の Module**（追加・2026-10-20、アーキ仕様 §4.4「土台：読むだけの印」「読むだけの回」）。
//
// 同梱ではない（目録に無いコード）ので、`dev.banto/effect` と `readOnlyHint` を名乗っても読むだけの根拠にならない。人が Project の
// 設定で許した tool だけが読むだけの回で使える。中継の制限を見るために、FileSystem（依存の役割 filesystem）を中継で呼ぶ tool も持つ。
//
// - `claimsRead`（AI）：読むだけと名乗る（`dev.banto/effect: "read"`・`readOnlyHint`）が、許していなければ断られる
// - `peek`（AI）：何も名乗らない。人が許せば使える
// - `relayList`（AI）：中継で FileSystem の `listDirectory`（読むだけ）を呼ぶ
// - `relayInfo`（AI）：中継で FileSystem の `getFileInfo`（読むだけ）を呼ぶ——まだ許していない中継は、読むだけの回では聞かずに断る
// - `relayWrite`（AI）：中継で FileSystem の `writeFile`（読むだけでない）を呼ぶ

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

let relay;
async function relayClient() {
  if (relay) return relay;
  const url = process.env.BANTO_HOST_MCP_URL;
  const token = process.env.BANTO_HOST_MCP_TOKEN;
  if (!url || !token) throw new Error("中継の口（BANTO_HOST_MCP_URL・BANTO_HOST_MCP_TOKEN）がありません");
  const client = new Client({ name: "e2e-read-only-probe", version: "0.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
  relay = client;
  return client;
}

/** 中継で FileSystem を呼び、結果か理由をそのまま返す（握りつぶさない） */
async function relayToFilesystem(name, args, callMeta) {
  const client = await relayClient();
  const listed = await client.callTool({ name: "relayListTargets", arguments: {} });
  const target = JSON.parse(listed.content[0].text).find((t) => t.roles.includes("filesystem"));
  if (!target) throw new Error(`呼べる filesystem がありません：${listed.content[0].text}`);
  try {
    const result = await client.callTool({
      name: "relayCallTool",
      arguments: { targetModule: target.name, name, arguments: args },
      // 呼び出しの印を返す——host がどのターンの仕事かを引く
      ...(callMeta?.["dev.banto/callId"] ? { _meta: { "dev.banto/callId": callMeta["dev.banto/callId"] } } : {}),
    });
    const text = (result.content ?? []).map((c) => c.text ?? "").join("\n");
    return { content: [{ type: "text", text: `中継の結果：${text}` }], ...(result.isError ? { isError: true } : {}) };
  } catch (err) {
    return { content: [{ type: "text", text: `中継が断られました：${err instanceof Error ? err.message : String(err)}` }], isError: true };
  }
}

const agent = { "dev.banto/visibility": "agent" };
const server = new Server({ name: "banto-e2e-read-only-probe", version: "0.0.0" }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "claimsRead",
      description: "読むだけと名乗る（試験用）",
      inputSchema: { type: "object", properties: {} },
      annotations: { readOnlyHint: true, openWorldHint: false },
      _meta: { ...agent, "dev.banto/effect": "read" },
    },
    {
      name: "peek",
      description: "何も名乗らない（試験用）",
      inputSchema: { type: "object", properties: {} },
      _meta: agent,
    },
    {
      name: "relayList",
      description: "中継で FileSystem の listDirectory を呼ぶ（試験用）",
      inputSchema: { type: "object", properties: { path: { type: "string" } } },
      _meta: agent,
    },
    {
      name: "relayInfo",
      description: "中継で FileSystem の getFileInfo を呼ぶ（試験用）",
      inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
      _meta: agent,
    },
    {
      name: "relayWrite",
      description: "中継で FileSystem の writeFile を呼ぶ（試験用）",
      inputSchema: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] },
      _meta: agent,
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const args = request.params.arguments ?? {};
  const meta = request.params._meta;
  switch (request.params.name) {
    case "claimsRead":
      return { content: [{ type: "text", text: "claimsRead を実行しました" }] };
    case "peek":
      return { content: [{ type: "text", text: "peek を実行しました" }] };
    case "relayList":
      return relayToFilesystem("listDirectory", { path: String(args.path ?? ".") }, meta);
    case "relayInfo":
      return relayToFilesystem("getFileInfo", { path: String(args.path ?? "") }, meta);
    case "relayWrite":
      return relayToFilesystem("writeFile", { path: String(args.path ?? ""), content: String(args.content ?? "") }, meta);
    default:
      throw new Error(`unknown tool: ${request.params.name}`);
  }
});

await server.connect(new StdioServerTransport());

#!/usr/bin/env node
// **試験用の MCP サーバ：中継で Subagent を呼び、返事を受け口で受ける Module**（追加・2026-10-05、アーキ仕様 §4.2
// 「Module 宛ての返事」。Backlog の subagent-from-modules）。
//
// Factory と同じ形——Project ごとにつき、宣言の依存に `subagent` を持ち、host の中継（`relayCallTool`）で `runSubagent` を
// 呼ぶ。待つ形（60 秒を越える仕事）と待たない形（返事は host がこの Module の受け口に渡す）の両方を試す。
//
// - `delegate`（AI）：サブエージェントに頼む。待つ形なら結果を、待たない形なら返事の印（replyId）を返す
// - `receiveReply`（host だけ、`dev.banto/receivesReplies`）：返事を受けて覚える
// - `listReplies`（人の画面、admin）：受けた返事の一覧——試験が `/api/projects/:id/ui-tool-call` で読む
//
// 覚えるのはプロセスの中だけ（Module が立て直されたら空から）——host が残してから渡すので、立て直しの前後の返事は
// 立て直したあとのプロセスに渡る。それを試験で見る。

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const replies = [];
let relay;
async function relayClient() {
  if (relay) return relay;
  const url = process.env.BANTO_HOST_MCP_URL;
  const token = process.env.BANTO_HOST_MCP_TOKEN;
  if (!url || !token) throw new Error("中継の口（BANTO_HOST_MCP_URL・BANTO_HOST_MCP_TOKEN）がありません");
  const client = new Client({ name: "e2e-relay-caller", version: "0.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
  relay = client;
  return client;
}

const server = new Server({ name: "banto-e2e-relay-caller", version: "0.0.0" }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "delegate",
      description: "サブエージェントに中継で頼む（試験用）",
      inputSchema: {
        type: "object",
        properties: {
          prompt: { type: "string" },
          background: { type: "boolean" },
          cwd: { type: "string" },
          schema: { type: "object" },
        },
        required: ["prompt"],
      },
      _meta: { "dev.banto/visibility": "agent" },
    },
    {
      name: "cancel",
      description: "この Module が頼んだサブエージェントの仕事を止める（試験用）",
      inputSchema: { type: "object", properties: { runId: { type: "string" } }, required: ["runId"] },
      _meta: { "dev.banto/visibility": "agent" },
    },
    {
      name: "receiveReply",
      description: "頼んだ仕事の返事を受ける（host だけが呼ぶ）",
      inputSchema: { type: "object", properties: {} },
      _meta: { "dev.banto/visibility": "admin", "dev.banto/receivesReplies": true },
    },
    {
      name: "listReplies",
      description: "受けた返事の一覧（試験用）",
      inputSchema: { type: "object", properties: {} },
      _meta: { "dev.banto/visibility": "admin" },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
  const args = request.params.arguments ?? {};
  if (request.params.name === "receiveReply") {
    replies.push({ ...args, receivedAt: new Date().toISOString() });
    return { content: [{ type: "text", text: "ok" }] };
  }
  if (request.params.name === "listReplies") {
    return { content: [{ type: "text", text: JSON.stringify(replies) }] };
  }
  if (request.params.name === "cancel") {
    const client = await relayClient();
    const listed = await client.callTool({ name: "relayListTargets", arguments: {} });
    const target = JSON.parse(listed.content[0].text).find((t) => t.roles.includes("subagent"));
    const result = await client.callTool({
      name: "relayCallTool",
      arguments: { targetModule: target.name, name: "cancelSubagent", arguments: { runId: String(args.runId ?? "") } },
    });
    return { content: [{ type: "text", text: result.content?.[0]?.text ?? "" }], ...(result.isError ? { isError: true } : {}) };
  }
  if (request.params.name === "delegate") {
    const client = await relayClient();
    // 宛先の名前は決め打ちしない（Project ごとの Module は `subagent-<projectId>`）
    const listed = await client.callTool({ name: "relayListTargets", arguments: {} });
    const targets = JSON.parse(listed.content[0].text);
    const target = targets.find((t) => t.roles.includes("subagent"));
    if (!target) throw new Error(`呼べる subagent がありません：${listed.content[0].text}`);
    const progressToken = request.params._meta?.progressToken;
    const result = await client.callTool(
      {
        name: "relayCallTool",
        arguments: {
          targetModule: target.name,
          name: "runSubagent",
          arguments: {
            agent: "fake",
            prompt: String(args.prompt ?? ""),
            runInBackground: args.background === true,
            ...(typeof args.cwd === "string" ? { cwd: args.cwd } : {}),
            ...(args.schema ? { schema: args.schema } : {}),
          },
        },
      },
      undefined,
      {
        resetTimeoutOnProgress: true,
        // 呼び元（AI の代理）にも途中経過を渡す——さもないと外側が 60 秒で切れる
        onprogress: (p) => {
          if (progressToken !== undefined) {
            void extra.sendNotification({ method: "notifications/progress", params: { ...p, progressToken } }).catch(() => {});
          }
        },
      },
    );
    const text = result.content?.[0]?.text ?? "";
    if (result.isError) return { content: [{ type: "text", text: `頼めませんでした：${text}` }], isError: true };
    const replyId = result._meta?.["dev.banto/replyId"];
    return { content: [{ type: "text", text: JSON.stringify({ result: text, ...(replyId ? { replyId } : {}) }) }] };
  }
  throw new Error(`知らない tool です: ${request.params.name}`);
});

await server.connect(new StdioServerTransport());

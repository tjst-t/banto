#!/usr/bin/env node
// **試験用の MCP サーバ：人の答えを待つ tool を1つだけ持つ**（追加・2026-10-04、v4-frontend.md §6.33）。
//
// 公開の承認（publish-directory）と同じ形——「終わったら届ける」tool（`dev.banto/deliversLater`）で、結果に
// 「あとで届ける」（`dev.banto/pendingReply`）と「人を待っている」（`dev.banto/waitingOn`）を載せる。
// 公開そのものは E2E で動かせない（Service と Caddy が要る）ので、サイドバーの出し分けはこれで見る。
// **届けはしない**——札は、この Module が止まったときに host が「途中で終わりました」を届けて片づける。
//
// 依存を持たない（`mcp-npm-module` と同じ理由）。stdio の JSON-RPC を手で書く。

import { createInterface } from "node:readline";

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const reply = (id, result) => send({ jsonrpc: "2.0", id, result });
const fail = (id, code, message) => send({ jsonrpc: "2.0", id, error: { code, message } });

const TOOLS = [
  {
    name: "askHuman",
    description: "人に承認を頼み、答えはあとで届ける（試験用）",
    inputSchema: { type: "object", properties: { what: { type: "string" } }, required: ["what"] },
    _meta: { "dev.banto/visibility": "agent", "dev.banto/deliversLater": true },
  },
];

createInterface({ input: process.stdin }).on("line", (line) => {
  const text = line.trim();
  if (text === "") return;
  let msg;
  try {
    msg = JSON.parse(text);
  } catch {
    return;
  }
  if (msg.id === undefined) return;
  switch (msg.method) {
    case "initialize":
      reply(msg.id, {
        protocolVersion: "2025-06-18",
        capabilities: { tools: {}, resources: {} },
        serverInfo: { name: "banto-e2e-ask-human", version: "0.0.0" },
      });
      return;
    case "ping":
      reply(msg.id, {});
      return;
    case "tools/list":
      reply(msg.id, { tools: TOOLS });
      return;
    case "resources/list":
      reply(msg.id, { resources: [] });
      return;
    case "tools/call": {
      if (msg.params?.name !== "askHuman") {
        fail(msg.id, -32602, `知らない tool です: ${msg.params?.name}`);
        return;
      }
      const what = String(msg.params?.arguments?.what ?? "");
      const replyTo = msg.params?._meta?.["dev.banto/replyTo"];
      reply(msg.id, {
        content: [{ type: "text", text: `「${what}」の承認を頼みました。人が答えたら届きます` }],
        ...(typeof replyTo === "string"
          ? { _meta: { "dev.banto/pendingReply": true, "dev.banto/waitingOn": { on: "human", title: `試験の承認：${what}` } } }
          : {}),
      });
      return;
    }
    default:
      fail(msg.id, -32601, `知らない method です: ${msg.method}`);
  }
});

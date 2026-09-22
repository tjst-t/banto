#!/usr/bin/env node
// **試験用の MCP サーバ（npm で配られる形）**（追加・2026-09-21）。
//
// **依存を持たない。** 偽の npm registry はこの1本しか配らないので、
// `@modelcontextprotocol/sdk` に依存すると **npm が本物の registry を見に行く**
// ——外の都合で落ちる試験になる（規則6）。stdio の JSON-RPC は素で書ける程度の
// 大きさなので、ここだけは手で書く。
//
// **banto が繋ぐときに通る道をすべて満たす**：
//   initialize → notifications/initialized → tools/list → resources/list
// `resources/list` は**空で返す**（自己申告はしない＝宣言だけで立つ Module）。
//
// 環境変数 `BANTO_E2E_GREETING` を tool の答えに混ぜる——**人が画面で入れた値が
// 実際に起動まで届いたか**を、受け取った側から確かめるため（規則1）。

import { createInterface } from "node:readline";

const PROTOCOL_VERSION = "2025-06-18";

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function reply(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

function fail(id, code, message) {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

const TOOLS = [
  {
    name: "greet",
    description: "受け取った名前に挨拶を返す（試験用）",
    inputSchema: {
      type: "object",
      properties: { who: { type: "string" } },
      required: ["who"],
    },
  },
];

createInterface({ input: process.stdin }).on("line", (line) => {
  const text = line.trim();
  if (text === "") return;
  let msg;
  try {
    msg = JSON.parse(text);
  } catch {
    // **読めないものを推測で動かさない**——黙って捨てる（相手は id を知らない）
    return;
  }
  // 通知（id が無い）には答えない
  if (msg.id === undefined) return;

  switch (msg.method) {
    case "initialize":
      reply(msg.id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {}, resources: {} },
        serverInfo: { name: "banto-e2e-mcp-module", version: "1.2.3" },
      });
      return;
    case "tools/list":
      reply(msg.id, { tools: TOOLS });
      return;
    case "resources/list":
      // **名乗らない**——宣言（banto 側の Config）だけで立つ Module
      reply(msg.id, { resources: [] });
      return;
    case "tools/call": {
      if (msg.params?.name !== "greet") {
        fail(msg.id, -32602, `知らない tool です: ${msg.params?.name}`);
        return;
      }
      const who = String(msg.params?.arguments?.who ?? "");
      // **起動時に渡された値を、そのまま見せる**——届いたかどうかを
      // 受け取った側から確かめられるようにする
      const greeting = process.env.BANTO_E2E_GREETING ?? "(BANTO_E2E_GREETING は届いていません)";
      reply(msg.id, { content: [{ type: "text", text: `${greeting} / ${who}` }] });
      return;
    }
    default:
      fail(msg.id, -32601, `知らない method です: ${msg.method}`);
  }
});

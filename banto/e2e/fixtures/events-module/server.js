#!/usr/bin/env node
// **試験用の MCP サーバ：出来事を出す Module**（追加・2026-10-16、アーキ仕様 §4.3「段2」、Backlog #345）。
//
// 同梱の扱い（目録の隠れた1本 `e2e-events`、`modules/declaration.ts`）で Project ごとに起き、宣言で `<名前>.happened`
// （属性 item・level・count、主体 item）を名乗る。出来事はまず出口の箱（`@banto/module-contract` の `EventOutbox`、
// 置き場は `BANTO_MODULE_DATA_DIR/outbox`）に書き、host の `relayEmitEvent` へ古い順に出す。起きたとき（host に繋がったとき）
// にも箱を出す——繋がっていない間に書いたものが、繋がったときに届く。
//
// - `emit`（AI）：出来事を1件出す。呼び出しの印（`dev.banto/callId`）を `causedBy` に添える（その仕事を始めた呼び出し）
// - `emitForTest`（人の画面、admin）：試験が出す。`raw` を渡せば名乗りと照らさずそのまま host へ（断られるのを見る）。
//   `queueOnly` なら箱に書くだけで出さない（host に繋がっていない間に起きたのと同じ）
// - `outbox`（admin）：箱に残っている出来事と、出したときの host の答えの記録（どの tool から出したか——起こし直したあとに
//   箱から出したものは `outbox`）

import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { EventOutbox, readEmitReply } from "@banto/module-contract";

const NAME = process.env.BANTO_MODULE_NAME ?? "e2e-events";
const EVENT = `${NAME}.happened`;
const dataDir = process.env.BANTO_MODULE_DATA_DIR;
if (!dataDir) throw new Error("BANTO_MODULE_DATA_DIR がありません");
/** host が出来事に返した答え（試験が読む） */
const replies = [];
const outbox = new EventOutbox({ dir: join(dataDir, "outbox"), log: (m) => console.error(m) });

let relay;
async function relayClient() {
  if (relay) return relay;
  const url = process.env.BANTO_HOST_MCP_URL;
  const token = process.env.BANTO_HOST_MCP_TOKEN;
  if (!url || !token) throw new Error("中継の口（BANTO_HOST_MCP_URL・BANTO_HOST_MCP_TOKEN）がありません");
  const client = new Client({ name: "e2e-events", version: "0.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
  relay = client;
  return client;
}

/** どの tool から出したか（eventId → tool の名前）。箱から出し直したときにも分かるように */
const via = new Map();

async function send(event) {
  const client = await relayClient();
  const result = await client.callTool({ name: "relayEmitEvent", arguments: event });
  // 箱の結果（受け取った・断った。一時の失敗は投げる）
  const outcome = readEmitReply(result);
  // 試験が見るのは host の答えそのもの（積んだ数・重複だったか）
  const reply = JSON.parse(result.content[0].text);
  replies.push({ eventId: event.eventId, name: event.name, reply, via: via.get(event.eventId) ?? "outbox", ...(event.causedBy ? { causedBy: event.causedBy } : {}) });
  return outcome;
}

const flush = () => outbox.flush(send);

const server = new Server({ name: "banto-e2e-events", version: "0.0.0" }, { capabilities: { tools: {} } });

const emitSchema = {
  type: "object",
  properties: {
    item: { type: "string" },
    level: { type: "string" },
    count: { type: "number" },
    text: { type: "string" },
    eventId: { type: "string" },
    queueOnly: { type: "boolean" },
    raw: { type: "object" },
  },
};

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "emit",
      description: "試験の出来事を1件出す（試験用）",
      inputSchema: emitSchema,
      _meta: { "dev.banto/visibility": "agent" },
    },
    {
      name: "emitForTest",
      description: "試験の出来事を出す（人の画面から、試験用）",
      inputSchema: emitSchema,
      _meta: { "dev.banto/visibility": "admin" },
    },
    {
      name: "outbox",
      description: "出口の箱に残っている出来事と、host の答えの記録（試験用）",
      inputSchema: { type: "object", properties: {} },
      _meta: { "dev.banto/visibility": "admin" },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const args = request.params.arguments ?? {};
  if (request.params.name === "outbox") {
    return { content: [{ type: "text", text: JSON.stringify({ queued: outbox.list(), replies }) }] };
  }
  if (request.params.name === "emit" || request.params.name === "emitForTest") {
    if (args.raw) {
      // 名乗りと照らさずに host へ——断られるのを見る
      const event = { eventId: randomUUID(), occurredAt: new Date().toISOString(), ...args.raw };
      via.set(event.eventId, request.params.name);
      await send(event);
      const reply = replies.filter((r) => r.eventId === event.eventId).at(-1)?.reply;
      return { content: [{ type: "text", text: JSON.stringify({ reply }) }] };
    }
    const callId = request.params._meta?.["dev.banto/callId"];
    const event = {
      name: EVENT,
      eventId: typeof args.eventId === "string" ? args.eventId : randomUUID(),
      occurredAt: new Date().toISOString(),
      fields: {
        ...(typeof args.item === "string" ? { item: args.item } : {}),
        ...(typeof args.level === "string" ? { level: args.level } : {}),
        ...(typeof args.count === "number" ? { count: args.count } : {}),
      },
      ...(typeof args.text === "string" ? { text: args.text } : {}),
      ...(typeof callId === "string" ? { causedBy: { callId } } : {}),
    };
    // **先に箱へ書く**——出す前に落ちても失くさない
    via.set(event.eventId, request.params.name);
    outbox.write(event);
    if (args.queueOnly === true) return { content: [{ type: "text", text: JSON.stringify({ eventId: event.eventId, queued: true }) }] };
    const flushed = await flush();
    const reply = replies.filter((r) => r.eventId === event.eventId).at(-1)?.reply;
    return { content: [{ type: "text", text: JSON.stringify({ eventId: event.eventId, flushed, reply }) }] };
  }
  throw new Error(`知らない tool です: ${request.params.name}`);
});

await server.connect(new StdioServerTransport());
// **繋がったら箱を出す**（繋がっていない間に書いたもの）。host が中継の口を開くのを待たずに出すと断られうるので、少し置いてから
// ——出せなければ箱に残り、次に出来事を出すときにまとめて出る
setTimeout(() => {
  void flush().catch((err) => console.error("[e2e-events] 箱を出せませんでした:", err));
}, 1000);

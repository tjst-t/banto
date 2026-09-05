#!/usr/bin/env node
// テスト用の偽Module。stdio上の低レベルServerで、agent/module/adminの
// 3段階のvisibilityを持つtool・resourceを1つずつ公開する。
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const server = new Server(
  { name: "fake-vault", version: "0.0.0" },
  { capabilities: { tools: {}, resources: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "requestAlias",
      description: "agent向け",
      inputSchema: { type: "object", properties: {} },
      _meta: { "dev.banto/visibility": "agent" },
    },
    {
      name: "resolveAlias",
      description: "module向け——Runnerに見えてはいけない",
      inputSchema: { type: "object", properties: {} },
      _meta: { "dev.banto/visibility": "module" },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  if (req.params.name === "requestAlias") {
    return { content: [{ type: "text", text: "REQUEST-ACCEPTED" }] };
  }
  if (req.params.name === "resolveAlias") {
    return { content: [{ type: "text", text: "SECRET-VALUE-should-not-leak" }] };
  }
  throw new Error("unknown tool");
});

server.setRequestHandler(ListResourcesRequestSchema, async () => ({
  resources: [
    {
      uri: "vault://aliases",
      name: "aliases",
      _meta: { "dev.banto/visibility": "agent" },
    },
  ],
}));

server.setRequestHandler(ReadResourceRequestSchema, async (req) => {
  if (req.params.uri === "vault://aliases") {
    return { contents: [{ uri: req.params.uri, text: "github-token" }] };
  }
  if (req.params.uri === "vault://internal/audit") {
    // 一覧には出さない——resources/readで直接読めてしまわないかのテスト対象
    return { contents: [{ uri: req.params.uri, text: "SECRET-AUDIT-should-not-leak" }] };
  }
  throw new Error("not found");
});

await server.connect(new StdioServerTransport());

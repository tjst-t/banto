#!/usr/bin/env node
// docs/specs/v4-modules.md §2.2 FileSystem のインターフェース。
// resourceは`file:///{path}`テンプレート1本（数えきれない資源なのでtemplates/listに乗せる）。

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  ListResourceTemplatesRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { VISIBILITY_META_KEY } from "@banto/module-contract";
import * as ops from "./operations.js";

function tool(name: string, description: string, inputSchema: unknown) {
  return { name, description, inputSchema, _meta: { [VISIBILITY_META_KEY]: "agent" } };
}

export function createFileSystemServer(deps: { projectRoot: string }) {
  const server = new Server(
    { name: "banto-module-filesystem", version: "0.1.0" },
    { capabilities: { tools: {}, resources: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      tool("readFile", "読み取り", { type: "object", properties: { path: { type: "string" } }, required: ["path"] }),
      tool("writeFile", "新規作成／全体上書き", { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] }),
      tool("editFile", "部分編集", { type: "object", properties: { path: { type: "string" }, edits: { type: "array" } }, required: ["path", "edits"] }),
      tool("listDirectory", "直下の一覧", { type: "object", properties: { path: { type: "string" } }, required: ["path"] }),
      tool("searchFiles", "名前検索", { type: "object", properties: { path: { type: "string" }, pattern: { type: "string" } }, required: ["path", "pattern"] }),
      tool("createDirectory", "mkdir -p 相当", { type: "object", properties: { path: { type: "string" } }, required: ["path"] }),
      tool("moveFile", "移動・リネーム", { type: "object", properties: { from: { type: "string" }, to: { type: "string" } }, required: ["from", "to"] }),
      tool("deleteFile", "削除", { type: "object", properties: { path: { type: "string" } }, required: ["path"] }),
      tool("getFileInfo", "サイズ・更新時刻・種別", { type: "object", properties: { path: { type: "string" } }, required: ["path"] }),
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const args = request.params.arguments as Record<string, unknown>;
    const root = deps.projectRoot;
    switch (request.params.name) {
      case "readFile": {
        const block = await ops.readFileOp(root, String(args.path));
        return { content: [block] };
      }
      case "writeFile":
        await ops.writeFileOp(root, String(args.path), String(args.content));
        return { content: [{ type: "text", text: "ok" }] };
      case "editFile": {
        const result = await ops.editFileOp(root, String(args.path), args.edits as ops.Edit[]);
        return { content: [{ type: "text", text: JSON.stringify(result) }] };
      }
      case "listDirectory": {
        const entries = await ops.listDirectoryOp(root, String(args.path));
        return { content: [{ type: "text", text: JSON.stringify(entries) }] };
      }
      case "searchFiles": {
        const results = await ops.searchFilesOp(root, String(args.path), String(args.pattern));
        return { content: [{ type: "text", text: JSON.stringify(results) }] };
      }
      case "createDirectory":
        await ops.createDirectoryOp(root, String(args.path));
        return { content: [{ type: "text", text: "ok" }] };
      case "moveFile":
        await ops.moveFileOp(root, String(args.from), String(args.to));
        return { content: [{ type: "text", text: "ok" }] };
      case "deleteFile":
        await ops.deleteFileOp(root, String(args.path));
        return { content: [{ type: "text", text: "ok" }] };
      case "getFileInfo": {
        const info = await ops.getFileInfoOp(root, String(args.path));
        return { content: [{ type: "text", text: JSON.stringify(info) }] };
      }
      default:
        throw new Error(`unknown tool: ${request.params.name}`);
    }
  });

  server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({
    resourceTemplates: [
      {
        uriTemplate: "file:///{path}",
        name: "Project file",
        _meta: { [VISIBILITY_META_KEY]: "agent" },
      },
    ],
  }));

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const match = request.params.uri.match(/^file:\/\/\/(.+)$/);
    if (!match) throw new Error(`unknown resource: ${request.params.uri}`);
    const block = await ops.readFileOp(deps.projectRoot, match[1]!);
    return {
      contents: [
        {
          uri: request.params.uri,
          mimeType: block.mimeType ?? "text/plain",
          text: block.text,
          blob: block.data,
        },
      ],
    };
  });

  return server;
}

if (process.argv[1] && process.argv[1].endsWith("server.js")) {
  const projectRoot = process.env.BANTO_PROJECT_ROOT;
  if (!projectRoot) {
    console.error("BANTO_PROJECT_ROOT が必要です");
    process.exit(1);
  }
  const server = createFileSystemServer({ projectRoot });
  await server.connect(new StdioServerTransport());
}

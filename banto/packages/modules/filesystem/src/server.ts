#!/usr/bin/env node
// docs/specs/v4-modules.md §2.2 FileSystem のインターフェース。
// resourceは`file:///{path}`テンプレート1本（数えきれない資源なのでtemplates/listに乗せる）。

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  CallToolRequestSchema,
  ListResourceTemplatesRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { VISIBILITY_META_KEY, MODULE_META_KEY, CANVAS_META_KEY } from "@banto/module-contract";
import * as ops from "./operations.js";
import { DIRECTORY_APP_HTML, DIRECTORY_APP_URI, UI_APP_MIME } from "./ui-app.js";
import { CONFIG_APP_HTML, CONFIG_APP_URI } from "./config-app.js";
import { readSettings, writeSettings } from "./settings.js";

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
      // **この tool には画面がある**（MCP Apps、決定・2026-09-06）。
      // 印を付けるだけ——「どこに出すか」は banto が決める（§6.2）。
      {
        // **どう見せるかも頼める**（決定・2026-09-07、ユーザー要望）。
        // MCP Apps の仕様には「最初からこの mode で開く」を宣言する場所が無く、
        // 用意されているのは `ui/request-display-mode`（画面が頼み、host が決める）
        // だけ。そこで**この tool の引数**として受け取り、画面が立ち上がった直後に
        // その mode を頼む——AI が「フルスクリーンで開いて」に応えられるようになる。
        ...tool("listDirectory", "直下の一覧。displayMode で見せ方も頼める", {
          type: "object",
          properties: {
            path: { type: "string" },
            displayMode: {
              type: "string",
              enum: ["inline", "fullscreen"],
              description:
                "一覧の見せ方。fullscreen を指定すると会話の隣に大きく開く（既定は inline＝会話の中に埋め込む）。" +
                "人が「大きく」「フルスクリーンで」「別に開いて」と言ったら fullscreen を指定する。",
            },
          },
          required: ["path"],
        }),
        _meta: { [VISIBILITY_META_KEY]: "agent", ui: { resourceUri: DIRECTORY_APP_URI } },
      },
      tool("searchFiles", "名前検索", { type: "object", properties: { path: { type: "string" }, pattern: { type: "string" } }, required: ["path", "pattern"] }),
      tool("createDirectory", "mkdir -p 相当", { type: "object", properties: { path: { type: "string" } }, required: ["path"] }),
      tool("moveFile", "移動・リネーム", { type: "object", properties: { from: { type: "string" }, to: { type: "string" } }, required: ["from", "to"] }),
      tool("deleteFile", "削除", { type: "object", properties: { path: { type: "string" } }, required: ["path"] }),
      tool("getFileInfo", "サイズ・更新時刻・種別", { type: "object", properties: { path: { type: "string" } }, required: ["path"] }),
      // **この Module 自身の設定**。設定 Canvas から呼ぶもので、AI には見せない
      // （§2.1 の3段——人の管理操作は admin）
      {
        name: "getSettings",
        description: "この Module のいまの設定",
        inputSchema: { type: "object", properties: {} },
        _meta: { [VISIBILITY_META_KEY]: "admin" },
      },
      {
        name: "setSettings",
        description: "この Module の設定を変える",
        inputSchema: {
          type: "object",
          properties: { showHidden: { type: "boolean" } },
          required: ["showHidden"],
        },
        _meta: { [VISIBILITY_META_KEY]: "admin" },
      },
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
      case "getSettings":
        return { content: [{ type: "text", text: JSON.stringify(readSettings()) }] };
      case "setSettings": {
        const next = { showHidden: Boolean(args.showHidden) };
        writeSettings(next);
        return { content: [{ type: "text", text: JSON.stringify(next) }] };
      }
      case "listDirectory": {
        const entries = await ops.listDirectoryOp(root, String(args.path), {
          showHidden: readSettings().showHidden,
        });
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

  // **自分が何者かを名乗る**（決定・2026-09-06）。AI には見せない（admin）。
  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: [
      {
        // listDirectory の結果を描く画面。AI に読ませるものではない（HTML）ので
        // agent には見せない——見せると文脈を HTML で埋めるだけになる
        uri: DIRECTORY_APP_URI,
        // **人が直接開ける入口でもある**（launcher、§6.2、決定・2026-09-07）
        // ——「まずファイルを見たい」は AI に頼む用事ではない（要件C3）。
        // 設定 Canvas と**同じ1つの仕組み**で名乗る（増やさない）。
        // 人に見せる名前と説明は、仕様の `name` / `description` をそのまま使う
        name: "ファイル",
        description: "この Project の直下を見る",
        mimeType: UI_APP_MIME,
        _meta: {
          [VISIBILITY_META_KEY]: "admin",
          [CANVAS_META_KEY]: "launcher",
          ui: { prefersBorder: false },
        },
      },
      {
        // **設定 Canvas**（決定・2026-09-07）。banto の設定画面がこれを埋め込む。
        // 「在るかもしれない」を試させない——**こちらから名乗る**
        uri: CONFIG_APP_URI,
        name: "FileSystem",
        mimeType: UI_APP_MIME,
        _meta: { [VISIBILITY_META_KEY]: "admin", [CANVAS_META_KEY]: "config", ui: { prefersBorder: false } },
      },
      {
        uri: "file://module",
        name: "この Module の申告",
        mimeType: "application/json",
        _meta: {
          [VISIBILITY_META_KEY]: "admin",
          [MODULE_META_KEY]: {
            satisfies: ["filesystem"],
            dependsOn: [],
            isolation: "subprocess",
            scope: "project",
            confinement: { kind: "landlock", root: "project" },
          },
        },
      },
    ],
  }));

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
    if (request.params.uri === CONFIG_APP_URI) {
      return { contents: [{ uri: CONFIG_APP_URI, mimeType: UI_APP_MIME, text: CONFIG_APP_HTML }] };
    }
    if (request.params.uri === DIRECTORY_APP_URI) {
      return { contents: [{ uri: DIRECTORY_APP_URI, mimeType: UI_APP_MIME, text: DIRECTORY_APP_HTML }] };
    }
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

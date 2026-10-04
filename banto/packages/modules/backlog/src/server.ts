#!/usr/bin/env node
// docs/specs/v4-modules.md §4.4 Backlog——仕事の一覧（ストーリー・タスク・バグと依存）。
// Project ごとにつき、Project の根のリポジトリの**一覧のブランチ**（既定 `backlog`。中は tasks.json 1つ、`banto-backlog/1`）を
// git の低レベルのコマンドで読み書きする。送る・取ってくるは Repositories に頼む（中継）——無ければリポジトリの git の設定で。

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { CANVAS_META_KEY, MODULE_META_KEY, VISIBILITY_META_KEY } from "@banto/module-contract";
import { BacklogStore } from "./store.js";
import type { BranchRemote } from "./remote.js";
import { readSettings } from "./settings.js";
import { TOOLS, callTool } from "./tools.js";
import { BOARD_APP_URI, CONFIG_APP_URI, UI_APP_MIME, appHtml } from "./ui-app.js";

export function createBacklogServer(deps: { projectRoot: string; now?: () => string; remote?: BranchRemote }) {
  const server = new Server(
    { name: "banto-module-backlog", version: "0.1.0" },
    { capabilities: { tools: {}, resources: {} } },
  );
  const store = new BacklogStore({
    root: deps.projectRoot,
    branch: () => readSettings().branch,
    ...(deps.remote ? { remote: deps.remote } : {}),
  });
  const ctx = { store, root: deps.projectRoot, ...(deps.now ? { now: deps.now } : {}) };

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (request) =>
    callTool(ctx, request.params.name, request.params.arguments, request.params._meta as Record<string, unknown> | undefined),
  );

  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: [
      {
        // **人が直接開く入口**（launcher）。一覧を見る・足す・並べ替えるは AI に頼む用事ではない
        uri: BOARD_APP_URI,
        name: "Backlog",
        description: "この Project の仕事の一覧（ストーリー・タスク・バグと依存）",
        mimeType: UI_APP_MIME,
        _meta: { [VISIBILITY_META_KEY]: "admin", [CANVAS_META_KEY]: "launcher", ui: { prefersBorder: false } },
      },
      {
        // 設定 Canvas——一覧を置くブランチ
        uri: CONFIG_APP_URI,
        name: "Backlog",
        mimeType: UI_APP_MIME,
        _meta: { [VISIBILITY_META_KEY]: "admin", [CANVAS_META_KEY]: "config", ui: { prefersBorder: false } },
      },
      {
        uri: "backlog://module",
        name: "この Module の申告",
        mimeType: "application/json",
        _meta: {
          [VISIBILITY_META_KEY]: "admin",
          [MODULE_META_KEY]: {
            satisfies: ["backlog"],
            // 一覧のブランチを origin へ送る・取ってくるのを頼む（資格情報は Repositories が持つ）。無くても動く
            // ——そのときはリポジトリ自身の git の設定で試す
            dependsOn: [{ role: "repositories", required: false }],
            isolation: "subprocess",
            scope: "project",
            // git を走らせる（作業ツリーには触らない——低レベルのコマンドで ref と object だけ）
            confinement: { kind: "landlock", root: "project", profile: "exec" },
          },
        },
      },
    ],
  }));

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const uri = request.params.uri;
    if (uri === BOARD_APP_URI) return { contents: [{ uri, mimeType: UI_APP_MIME, text: appHtml("board") }] };
    if (uri === CONFIG_APP_URI) return { contents: [{ uri, mimeType: UI_APP_MIME, text: appHtml("config") }] };
    throw new Error(`unknown resource: ${uri}`);
  });

  return server;
}

if (process.argv[1] && process.argv[1].endsWith("server.js")) {
  const projectRoot = process.env.BANTO_PROJECT_ROOT;
  if (!projectRoot) {
    console.error("BANTO_PROJECT_ROOT が必要です");
    process.exit(1);
  }
  const hostUrl = process.env.BANTO_HOST_MCP_URL;
  const hostToken = process.env.BANTO_HOST_MCP_TOKEN;
  const { RelayingRemote, hostRelayCall } = await import("./remote.js");
  // 中継が渡されていなければ Repositories には頼まない（リポジトリの git の設定だけで送る）
  const relay = hostUrl && hostToken ? hostRelayCall(hostUrl, hostToken) : undefined;
  const server = createBacklogServer({ projectRoot, remote: new RelayingRemote(projectRoot, relay) });
  await server.connect(new StdioServerTransport());
}

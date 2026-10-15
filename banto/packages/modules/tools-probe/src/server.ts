#!/usr/bin/env node
// **同梱の道具用のコンテナを確かめる Module**（追加・2026-10-15、Backlog #309 tools-container）。
//
// 道具用のコンテナ（`docs/specs/v4-security.md` §1 の4つ目の箱）で起き、中から見えるものをそのまま返す：誰で動いているか・
// sudo できるか・名乗ったパッケージが入っているか。E2E が起動を確かめるためのもので、画面の目録には出さない
// （`BUNDLED_CATALOG` の `hidden`）。最初の本物の住人は変換役 `documents`（`v4-modules.md` §2.2）

import { spawnSync } from "node:child_process";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { MODULE_META_KEY, VISIBILITY_META_KEY } from "@banto/module-contract";

/** この Module の申告。目録（core の BUNDLED_CATALOG）の宣言と同じ */
export const TOOLS_PROBE_MODULE_META = {
  satisfies: ["tools-probe"],
  dependsOn: [],
  isolation: "subprocess",
  scope: "instance",
  // 小さく、どの Ubuntu にもあるもの
  toolsContainer: { aptPackages: ["jq"] },
} as const;

/** コマンドを走らせて、終了コードと出力を返す（無いコマンドは code -1） */
function probe(command: string, args: string[]): { code: number; output: string } {
  const r = spawnSync(command, args, { encoding: "utf8", input: "", timeout: 10_000 });
  if (r.error) return { code: -1, output: r.error.message };
  return { code: r.status ?? -1, output: `${r.stdout}${r.stderr}`.trim() };
}

function inspect() {
  const sudo = probe("sudo", ["-n", "true"]);
  return {
    uid: process.getuid?.(),
    inContainer: process.env.BANTO_IN_CONTAINER === "1",
    sudo: { allowed: sudo.code === 0, output: sudo.output },
    packages: Object.fromEntries(
      TOOLS_PROBE_MODULE_META.toolsContainer.aptPackages.map((p) => [p, probe("dpkg-query", ["-W", "-f=${db:Status-Status}", p]).output === "installed"]),
    ),
    jq: probe("jq", ["--version"]).output,
  };
}

const server = new Server({ name: "banto-module-tools-probe", version: "0.1.0" }, { capabilities: { tools: {}, resources: {} } });

server.setRequestHandler(ListResourcesRequestSchema, async () => ({
  resources: [
    {
      uri: "tools-probe://module",
      name: "この Module の申告",
      mimeType: "application/json",
      _meta: { [VISIBILITY_META_KEY]: "admin", [MODULE_META_KEY]: TOOLS_PROBE_MODULE_META },
    },
  ],
}));

server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  if (request.params.uri !== "tools-probe://module") throw new Error(`知らない資源です: ${request.params.uri}`);
  return { contents: [{ uri: request.params.uri, mimeType: "application/json", text: JSON.stringify(TOOLS_PROBE_MODULE_META) }] };
});

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "inspect",
      description: "道具用のコンテナの中から見えるもの（誰で動いているか・sudo できるか・名乗ったパッケージ）を返す",
      inputSchema: { type: "object", properties: {} },
      _meta: { [VISIBILITY_META_KEY]: "admin" },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name !== "inspect") throw new Error(`知らない tool です: ${request.params.name}`);
  return { content: [{ type: "text", text: JSON.stringify(inspect()) }] };
});

await server.connect(new StdioServerTransport());

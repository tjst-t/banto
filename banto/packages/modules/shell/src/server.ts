#!/usr/bin/env node
// docs/specs/v4-modules.md §2.3 Shell のインターフェース。toolは`runCommand`1本のみ。

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  ListResourcesRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { VISIBILITY_META_KEY, MODULE_META_KEY } from "@banto/module-contract";
import { runCommand } from "./run-command.js";
import { HostRelayClient } from "./host-relay-client.js";

export function createShellServer(deps: { projectRoot: string; relayClient: HostRelayClient }) {
  const server = new Server(
    { name: "banto-module-shell", version: "0.1.0" },
    { capabilities: { tools: {}, resources: {} } },
  );

  // **自分が何者かを名乗る**（決定・2026-09-06）。host は宣言（Config）と
  // 突き合わせ、より厳しい方向の申告だけを採る。AI には見せない（admin）。
  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: [
      {
        uri: "shell://module",
        name: "この Module の申告",
        mimeType: "application/json",
        _meta: {
          [VISIBILITY_META_KEY]: "admin",
          [MODULE_META_KEY]: {
            satisfies: ["shell"],
            dependsOn: [{ role: "vault", required: true }],
            isolation: "subprocess",
            scope: "project",
            confinement: { kind: "landlock", root: "project" },
          },
        },
      },
    ],
  }));

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "runCommand",
        description: "コマンドを実行する。Project rootの外には出られない（Landlock）",
        inputSchema: {
          type: "object",
          properties: {
            command: { type: "string" },
            cwd: { type: "string" },
            timeout: { type: "number" },
            envSecrets: { type: "object" },
            secretFiles: { type: "object" },
            sshIdentity: { type: "string" },
          },
          required: ["command"],
        },
        _meta: { [VISIBILITY_META_KEY]: "agent" },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    if (request.params.name !== "runCommand") throw new Error(`unknown tool: ${request.params.name}`);
    const args = request.params.arguments as Record<string, unknown>;
    const progressToken = extra._meta?.progressToken;

    const result = await runCommand(
      {
        command: String(args.command),
        cwd: args.cwd as string | undefined,
        timeout: args.timeout as number | undefined,
        envSecrets: args.envSecrets as Record<string, string> | undefined,
        secretFiles: args.secretFiles as Record<string, string> | undefined,
        sshIdentity: args.sshIdentity as string | undefined,
        signal: extra.signal,
      },
      {
        projectRoot: deps.projectRoot,
        relayClient: deps.relayClient,
        onProgress:
          progressToken !== undefined
            ? (note) => {
                void extra.sendNotification({
                  method: "notifications/progress",
                  params: { progressToken, progress: 0, message: note },
                });
              }
            : undefined,
      },
    );

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(result),
        },
      ],
      isError: result.exitCode !== 0,
    };
  });

  return server;
}

if (process.argv[1] && process.argv[1].endsWith("server.js")) {
  const projectRoot = process.env.BANTO_PROJECT_ROOT;
  const hostUrl = process.env.BANTO_HOST_MCP_URL;
  const hostToken = process.env.BANTO_HOST_MCP_TOKEN;
  if (!projectRoot || !hostUrl || !hostToken) {
    console.error("BANTO_PROJECT_ROOT, BANTO_HOST_MCP_URL, BANTO_HOST_MCP_TOKEN が必要です");
    process.exit(1);
  }
  const relayClient = new HostRelayClient({ url: hostUrl, token: hostToken });
  const server = createShellServer({ projectRoot, relayClient });
  await server.connect(new StdioServerTransport());
}

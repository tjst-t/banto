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

export function createShellServer(deps: { projectRoot: string; relayClient: HostRelayClient; homeDir?: string; inContainer?: boolean }) {
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
            // **窓口と金庫の両方に繋ぐ**（改訂・2026-09-12）。在りかは
            // `vault-directory` に聞き、値はその金庫から直接受け取る
            // ——どちらが欠けても秘密は渡せないので、両方 required
            dependsOn: [
              { role: "vault-directory", required: true },
              { role: "vault", required: true },
            ],
            isolation: "subprocess",
            scope: "project",
            confinement: { kind: "landlock", root: "project", profile: "exec" },
          },
        },
      },
    ],
  }));

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "runCommand",
        // **引数の説明は、AI がこの Module を使えるかどうかそのもの**
        // （追加・2026-09-12、ユーザー指摘「AI が Vault の使い方を分かっていない」）。
        // 以前は `envSecrets: { type: "object" }` としか書いていなかったので、
        // 「何を鍵にして何を値にするのか」も「値を書いてはいけない」ことも
        // 伝わりようがなかった。**秘密の使い方の説明はここにある**
        // ——system prompt は個々の tool を語らない（決定・2026-09-05、規則3）。
        description:
          "コマンドを実行する。Project root の外には出られない（Landlock で強制）。" +
          "**秘密（トークン・鍵）が要るときは、値を command に書かず、Vault の alias 名を " +
          "envSecrets / secretFiles / sshIdentity に渡す**——値は Vault から直接この子プロセスへ渡り、" +
          "あなたの文脈には出ない。使える alias の一覧は resource `vault://aliases`。" +
          "必要な alias が無ければ requestAlias で人に登録を頼む。",
        inputSchema: {
          type: "object",
          properties: {
            command: { type: "string", description: "/bin/sh -c に渡す文字列" },
            cwd: { type: "string", description: "Project root からの相対パス。省略時は root そのもの" },
            timeout: { type: "number", description: "秒。省略時は 120。超えると SIGTERM で止める" },
            envSecrets: {
              type: "object",
              description:
                '環境変数名 → Vault の alias 名。例：{"GITHUB_TOKEN": "github-token"}。' +
                "**値ではなく alias 名を書く。** その環境変数だけがこのコマンドに渡り、結果には現れない",
              additionalProperties: { type: "string" },
            },
            secretFiles: {
              type: "object",
              description:
                'Project root からの相対パス → Vault の alias 名。例：{".npmrc": "npm-token"}。' +
                "その alias の中身をファイル（0600）として書き出し、**コマンドが終わったら消す**",
              additionalProperties: { type: "string" },
            },
            sshIdentity: {
              type: "string",
              description:
                "kind が ssh-identity の alias 名。ssh-agent を立てて SSH_AUTH_SOCK を渡す" +
                "（git push 等に使う）。**秘密鍵はファイルにもあなたの文脈にも出ない**",
            },
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
        homeDir: deps.homeDir,
        inContainer: deps.inContainer,
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
  // **Shell 専用のホーム**（決定・2026-09-23）。host が用意して写してある
  const homeDir = process.env.BANTO_SHELL_HOME || undefined;
  const server = createShellServer({ projectRoot, relayClient, homeDir, inContainer: process.env.BANTO_IN_CONTAINER === "1" });
  await server.connect(new StdioServerTransport());
}

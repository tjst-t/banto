// Shell → HTTP → hostの中継エンドポイント → 窓口(vault-directory) → 実Vault
// (SOPS暗号化)、というフルスタックを実際に繋いで検証する。課金は発生しない
// （Anthropic APIを使わない、SOPS/age/MCPプロトコルの実処理のみ）。
//
// **金庫の名前をわざと `vault` 以外にしてある**（改訂・2026-09-12）。
// Shell はかつて `"vault"` を決め打ちしていたので、この形なら**決め打ちに
// 戻った瞬間ここが落ちる**——2本目の backend に預けた秘密に届かないことが、
// 試験で押さえられる（規則1）。

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { HostRelayEndpoint, RelayRegistry } from "@banto/core";
import { parseModuleMeta } from "@banto/module-contract";
import { createVaultServer } from "@banto/module-vault-local";
import { createVaultDirectoryServer, HostRelayClient as DirectoryRelayClient } from "@banto/module-vault-directory";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { HostRelayClient } from "./host-relay-client.js";
import { runCommand } from "./run-command.js";

test("Shell resolves an envSecret from the real (SOPS-backed) Vault through the real HTTP relay", async () => {
  /** 既定ではない名前。決め打ちに戻ったら、ここが届かなくなる。 */
  const VAULT_NAME = "vault-keychain";
  const PROJECT_ID = "p-full-stack";
  const vaultDir = await mkdtemp(join(tmpdir(), "banto-fullstack-vault-"));
  const projectDir = await mkdtemp(join(tmpdir(), "banto-fullstack-project-"));
  let httpServer: ReturnType<typeof createServer> | undefined;
  // 窓口が**自分で**中継へ張る接続。`directoryClient.close()` では閉じない
  // （そちらは host→窓口の向き）ので、**別に持って閉じる**——閉じ忘れると
  // SSE が開いたままで、試験は緑なのにプロセスが終わらない
  let directoryRelay: DirectoryRelayClient | undefined;
  try {
    // 1. 実Vault（SOPS）を起動し、alias を1つ登録する。
    const vaultServer = createVaultServer(vaultDir);
    const [vaultServerTransport, vaultClientTransport] = InMemoryTransport.createLinkedPair();
    const vaultClient = new Client({ name: "host", version: "0.0.0" });
    await Promise.all([vaultServer.connect(vaultServerTransport), vaultClient.connect(vaultClientTransport)]);
    await vaultClient.callTool({
      name: "createAlias",
      arguments: {
        name: "npm-registry-token",
        kind: "secret",
        forProject: PROJECT_ID,
        value: "npm_REALSECRET123",
      },
    });

    // 2. host の中継レジストリに実Vault接続を登録し、Shell用のtokenを発行する。
    const registry = new RelayRegistry();
    registry.registerModule({
      name: VAULT_NAME,
      client: vaultClient,
      meta: parseModuleMeta({ satisfies: ["vault"], dependsOn: [], isolation: "subprocess" }, VAULT_NAME),
    });
    const directoryMeta = parseModuleMeta(
      {
        satisfies: ["vault-directory"],
        dependsOn: [{ role: "vault", required: true }],
        isolation: "subprocess",
      },
      "vault-directory",
    );
    const directoryToken = registry.issueToken({ moduleName: "vault-directory", meta: directoryMeta });
    const shellMeta = parseModuleMeta(
      {
        satisfies: ["shell"],
        dependsOn: [
          { role: "vault-directory", required: true },
          { role: "vault", required: true },
        ],
        isolation: "subprocess",
      },
      "shell",
    );
    // **Shell は Project 単位で起きる**——host はその身元を持っていて、
    // 中継のたびに「誰のための呼び出しか」を刻む（追加・2026-09-13）。
    // ここを省くと Vault は fail closed で止まる（それが正しい）
    const token = registry.issueToken({ moduleName: "shell", projectId: PROJECT_ID, meta: shellMeta });

    // 3. 実HTTPサーバーで中継エンドポイントを立てる。
    const endpoint = new HostRelayEndpoint({ registry });
    httpServer = createServer((req, res) => void endpoint.handleRequest(req, res));
    await new Promise<void>((resolve) => httpServer!.listen(0, "127.0.0.1", resolve));
    const port = (httpServer.address() as AddressInfo).port;

    // 3.5. 窓口も**実HTTP越しに**金庫を見つける（相手の一覧も中継に聞く）。
    directoryRelay = new DirectoryRelayClient(`http://127.0.0.1:${port}/relay`, directoryToken);
    const directoryServer = createVaultDirectoryServer({ relay: directoryRelay });
    const [dirServerTransport, dirClientTransport] = InMemoryTransport.createLinkedPair();
    const directoryClient = new Client({ name: "host", version: "0.0.0" });
    await Promise.all([
      directoryServer.connect(dirServerTransport),
      directoryClient.connect(dirClientTransport),
    ]);
    registry.registerModule({ name: "vault-directory", client: directoryClient, meta: directoryMeta });

    // 4. Shell側のHostRelayClientから実際にHTTP越しに解決する。
    const relayClient = new HostRelayClient({ url: `http://127.0.0.1:${port}/relay`, token });
    const result = await runCommand(
      { command: 'echo "TOKEN=$NPM_TOKEN"', envSecrets: { NPM_TOKEN: "npm-registry-token" } },
      { projectRoot: projectDir, relayClient },
    );

    assert.equal(result.stdout.trim(), "TOKEN=npm_REALSECRET123");
    await relayClient.close();
    await directoryClient.close();
    await vaultClient.close();
  } finally {
    await directoryRelay?.close();
    httpServer?.closeAllConnections();
    httpServer?.close();
    await rm(vaultDir, { recursive: true, force: true });
    await rm(projectDir, { recursive: true, force: true });
  }
});

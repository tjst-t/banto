// Shell → HTTP → hostの中継エンドポイント → 実Vault(SOPS暗号化)、という
// フルスタックを実際に繋いで検証する。課金は発生しない（Anthropic APIを
// 使わない、SOPS/age/MCPプロトコルの実処理のみ）。

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { HostRelayEndpoint, RelayRegistry } from "@banto/core";
import { parseModuleMeta } from "@banto/module-contract";
import { createVaultServer } from "@banto/module-vault";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { HostRelayClient } from "./host-relay-client.js";
import { runCommand } from "./run-command.js";

test("Shell resolves an envSecret from the real (SOPS-backed) Vault through the real HTTP relay", async () => {
  const vaultDir = await mkdtemp(join(tmpdir(), "banto-fullstack-vault-"));
  const projectDir = await mkdtemp(join(tmpdir(), "banto-fullstack-project-"));
  let httpServer: ReturnType<typeof createServer> | undefined;
  try {
    // 1. 実Vault（SOPS）を起動し、alias を1つ登録する。
    const vaultServer = createVaultServer(vaultDir);
    const [vaultServerTransport, vaultClientTransport] = InMemoryTransport.createLinkedPair();
    const vaultClient = new Client({ name: "host", version: "0.0.0" });
    await Promise.all([vaultServer.connect(vaultServerTransport), vaultClient.connect(vaultClientTransport)]);
    await vaultClient.callTool({
      name: "createAlias",
      arguments: { name: "npm-registry-token", kind: "secret", scope: "project", value: "npm_REALSECRET123" },
    });

    // 2. host の中継レジストリに実Vault接続を登録し、Shell用のtokenを発行する。
    const registry = new RelayRegistry();
    registry.registerModule({
      name: "vault",
      client: vaultClient,
      meta: parseModuleMeta({ satisfies: ["vault"], dependsOn: [], isolation: "subprocess" }, "vault"),
    });
    const shellMeta = parseModuleMeta(
      { satisfies: ["shell"], dependsOn: [{ role: "vault", required: true }], isolation: "subprocess" },
      "shell",
    );
    const token = registry.issueToken({ moduleName: "shell", meta: shellMeta });

    // 3. 実HTTPサーバーで中継エンドポイントを立てる。
    const endpoint = new HostRelayEndpoint({ registry });
    httpServer = createServer((req, res) => void endpoint.handleRequest(req, res));
    await new Promise<void>((resolve) => httpServer!.listen(0, "127.0.0.1", resolve));
    const port = (httpServer.address() as AddressInfo).port;

    // 4. Shell側のHostRelayClientから実際にHTTP越しに解決する。
    const relayClient = new HostRelayClient({ url: `http://127.0.0.1:${port}/relay`, token });
    const result = await runCommand(
      { command: 'echo "TOKEN=$NPM_TOKEN"', envSecrets: { NPM_TOKEN: "npm-registry-token" } },
      { projectRoot: projectDir, relayClient },
    );

    assert.equal(result.stdout.trim(), "TOKEN=npm_REALSECRET123");
    await relayClient.close();
    await vaultClient.close();
  } finally {
    httpServer?.close();
    await rm(vaultDir, { recursive: true, force: true });
    await rm(projectDir, { recursive: true, force: true });
  }
});

// **envSecrets に alias を30件渡しても、Infisical の回数制限に当たらない**（2026-10-18、Backlog #389）。
//
// 25件渡すと毎回断られていた——alias ごとに、窓口の lookupAlias と Vault の resolveAlias がそれぞれ Infisical の一覧
// （listSecrets recursive）を読み直し、1件あたり Infisical へ 5〜7 回の往復になっていた。ここでは Shell → 実 HTTP の
// 中継 → 窓口（vault-directory）→ Vault（vault-infisical の実装、相手だけ偽の Infisical）を繋ぎ、
// **一覧の読み出しが alias の数に比例しない**ことと、**回数制限が続くときに分かる文で断る**ことを見る。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { HostRelayEndpoint, ModuleCallTracker, RelayRegistry } from "@banto/core";
import { parseModuleMeta } from "@banto/module-contract";
import { createVaultDirectoryServer, HostRelayClient as DirectoryRelayClient } from "@banto/module-vault-directory";
import { fakeInfisicalVaultServer } from "@banto/module-vault-infisical/dist/testing/fake-vault-server.js";
import type { FakeRateLimit } from "@banto/module-vault-infisical/dist/testing/fake-connection.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { HostRelayClient } from "./host-relay-client.js";
import { runCommand } from "./run-command.js";

const VAULT_NAME = "vault-infisical";
const PROJECT_ID = "p-rate-limit";
const COUNT = 30;

/** 偽の Infisical の上の Vault に alias を COUNT 件置き、中継と窓口を立てて、Shell から runCommand を流す */
async function withStack(
  rateLimit: FakeRateLimit,
  body: (ctx: {
    run: () => ReturnType<typeof runCommand>;
    vault: ReturnType<typeof fakeInfisicalVaultServer>;
    enableRateLimit: () => void;
  }) => Promise<void>,
) {
  const vaultDir = await mkdtemp(join(tmpdir(), "banto-ratelimit-vault-"));
  const projectDir = await mkdtemp(join(tmpdir(), "banto-ratelimit-project-"));
  let httpServer: ReturnType<typeof createServer> | undefined;
  let directoryRelay: DirectoryRelayClient | undefined;
  const closers: Array<() => Promise<void>> = [];
  try {
    // 置く間は制限しない（数えたいのは runCommand の間だけ）——制限は試験の中で入れる
    const limit: FakeRateLimit = { calls: Number.MAX_SAFE_INTEGER, persistent: rateLimit.persistent };
    const vault = fakeInfisicalVaultServer({ moduleName: VAULT_NAME, dataDir: vaultDir, rateLimit: limit });
    const [vs, vc] = InMemoryTransport.createLinkedPair();
    const vaultClient = new Client({ name: "host", version: "0.0.0" });
    await Promise.all([vault.server.connect(vs), vaultClient.connect(vc)]);
    closers.push(() => vaultClient.close());
    for (let i = 0; i < COUNT; i++) {
      await vaultClient.callTool({
        name: "createAlias",
        arguments: { name: `KEY_${i}`, kind: "secret", forProject: PROJECT_ID, value: `value-${i}` },
      });
    }

    const registry = new RelayRegistry();
    registry.registerModule({
      name: VAULT_NAME,
      client: vaultClient,
      meta: parseModuleMeta({ satisfies: ["vault"], dependsOn: [], isolation: "subprocess" }, VAULT_NAME),
    });
    const directoryMeta = parseModuleMeta(
      { satisfies: ["vault-directory"], dependsOn: [{ role: "vault", required: true }], isolation: "subprocess" },
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
    const token = registry.issueToken({ moduleName: "shell", projectId: PROJECT_ID, meta: shellMeta });

    const endpoint = new HostRelayEndpoint({ registry, moduleCalls: new ModuleCallTracker() });
    httpServer = createServer((req, res) => void endpoint.handleRequest(req, res));
    await new Promise<void>((resolve) => httpServer!.listen(0, "127.0.0.1", resolve));
    const port = (httpServer.address() as AddressInfo).port;

    directoryRelay = new DirectoryRelayClient(`http://127.0.0.1:${port}/relay`, directoryToken);
    const directoryServer = createVaultDirectoryServer({ relay: directoryRelay });
    const [ds, dc] = InMemoryTransport.createLinkedPair();
    const directoryClient = new Client({ name: "host", version: "0.0.0" });
    await Promise.all([directoryServer.connect(ds), directoryClient.connect(dc)]);
    closers.push(() => directoryClient.close());
    registry.registerModule({ name: "vault-directory", client: directoryClient, meta: directoryMeta });

    const relayClient = new HostRelayClient({ url: `http://127.0.0.1:${port}/relay`, token });
    closers.push(() => relayClient.close());
    const envSecrets = Object.fromEntries(Array.from({ length: COUNT }, (_, i) => [`ENV_${i}`, `KEY_${i}`]));
    await body({
      vault,
      enableRateLimit: () => {
        limit.calls = rateLimit.calls;
        vault.resetRateWindow();
      },
      run: () =>
        runCommand(
          { command: `echo "$ENV_0 $ENV_${COUNT - 1}"`, envSecrets },
          { projectRoot: projectDir, relayClient },
        ),
    });
  } finally {
    for (const close of closers.reverse()) await close();
    await directoryRelay?.close();
    httpServer?.closeAllConnections();
    httpServer?.close();
    await rm(vaultDir, { recursive: true, force: true });
    await rm(projectDir, { recursive: true, force: true });
  }
}

test("envSecrets に30件渡した runCommand が、回数制限のある Infisical で通る——一覧の読み出しはグループの数だけ", async () => {
  // 窓の中で 20 回まで（30件の値の読み出しと使った日の書き込みだけで超える）。待つと窓が新しくなる
  await withStack({ calls: 20 }, async ({ run, vault, enableRateLimit }) => {
    vault.listOptions.length = 0;
    enableRateLimit();
    const result = await run();
    assert.equal(result.exitCode, 0, result.stderr);
    assert.equal(result.stdout.trim(), `value-0 value-${COUNT - 1}`);
    // **alias の数に比例しない**：この Vault の置き場は既定の環境の1つ（版付きのグループは無い）なので、
    // 一覧（再帰）も1回。フォルダだけを読む一覧（使った日を書く前の読み直し）は出ない
    const recursive = vault.listOptions.filter((o) => o.recursive === true);
    assert.equal(recursive.length, 1, `一覧の読み出しが ${recursive.length} 回（alias ${COUNT} 件）`);
    assert.equal(vault.listOptions.length, 1, `フォルダの読み直しが出た: ${JSON.stringify(vault.listOptions)}`);
    // 値の読み出しと書き込みで制限を超えたぶんは、言われた秒数だけ待って通っている
    assert.ok(vault.sleeps.length > 0, "回数制限に一度も当たっていない（試験の前提が崩れた）");
    assert.ok(vault.sleeps.every((ms) => ms === 14_000), JSON.stringify(vault.sleeps));
  });
});

test("回数制限が続くときは、「回数制限で読めませんでした」と分かる文で断る", async () => {
  await withStack({ calls: 0, persistent: true }, async ({ run, enableRateLimit }) => {
    enableRateLimit();
    await assert.rejects(run(), (err: Error) => {
      assert.match(err.message, /Infisical の回数制限で読めませんでした（14 秒後にもう一度試してください/);
      return true;
    });
  });
});

// 実際のsops/age/ssh-keygen/ssh-agentバイナリを使う統合テスト（自動テストに含める
// ——外部プロセスへの依存はあるが、課金は発生しない。もし環境にこれらのバイナリが
// 無ければ規則2どおり「たぶん動く」で誤魔化さず、失敗として出す）。

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { SopsBackend } from "./sops-backend.js";
import { AliasRegistry } from "./alias-registry.js";

async function withDir(fn: (dir: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "banto-vault-it-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("SOPS backend: put/get/delete roundtrip actually encrypts at rest", async () => {
  await withDir(async (dir) => {
    const backend = new SopsBackend(dir);
    await backend.init();
    await backend.createGroup("g1");
    await backend.putSecret("g1/github-token", "ghp_supersecret");

    const value = await backend.getSecret("g1/github-token");
    assert.equal(value, "ghp_supersecret");

    // ディスク上のファイルが平文を含んでいないことを確認する（暗号化の実測）。
    const { readFile } = await import("node:fs/promises");
    const raw = await readFile(join(dir, "groups", "g1", "secrets.sops.json"), "utf8");
    assert.ok(!raw.includes("ghp_supersecret"), "secret leaked into the on-disk file unencrypted");
    assert.ok(raw.includes("sops"), "file does not look like a sops-encrypted document");

    await backend.deleteSecret("g1/github-token");
    await assert.rejects(() => backend.getSecret("g1/github-token"));
  });
});

test("SOPS backend: multiple keys in the same group coexist", async () => {
  await withDir(async (dir) => {
    const backend = new SopsBackend(dir);
    await backend.init();
    await backend.createGroup("g1");
    await backend.putSecret("g1/a", "value-a");
    await backend.putSecret("g1/b", "value-b");
    assert.equal(await backend.getSecret("g1/a"), "value-a");
    assert.equal(await backend.getSecret("g1/b"), "value-b");
    const paths = await backend.listPaths();
    assert.ok(paths.includes("g1/a"));
    assert.ok(paths.includes("g1/b"));
  });
});

test("SSH keypair generation and loading into a real ssh-agent", async () => {
  await withDir(async (dir) => {
    const backend = new SopsBackend(dir);
    await backend.init();
    const { publicKey, privateKeyRef } = await backend.generateKeypair("ssh");
    assert.ok(publicKey.startsWith("ssh-ed25519"));

    const { socketPath } = await backend.loadIntoAgent(privateKeyRef);
    assert.ok(existsSync(socketPath), "ssh-agent did not create its socket");

    // 実際にエージェントに鍵が積まれているか ssh-add -l で確認する。
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const execFileP = promisify(execFile);
    const { stdout } = await execFileP("ssh-add", ["-l"], {
      env: { ...process.env, SSH_AUTH_SOCK: socketPath },
    });
    assert.ok(stdout.includes("ED25519"), `expected loaded key, got: ${stdout}`);
  });
});

test("AliasRegistry: metadata is readable without touching the encrypted value", async () => {
  await withDir(async (dir) => {
    const registry = new AliasRegistry(dir);
    await registry.load();
    await registry.create({ name: "github-token", kind: "secret", scope: "project", backendPath: "g1/github-token" });
    const meta = registry.get("github-token");
    assert.equal(meta?.kind, "secret");
    assert.equal(meta?.lastUsedAt, undefined);

    await registry.markUsed("github-token");
    assert.ok(registry.get("github-token")?.lastUsedAt);
  });
});

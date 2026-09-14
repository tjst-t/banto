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
import { LocalFileAliasStore } from "@banto/vault-kit";

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
    const { publicKey, privateKeyRef } = await backend.generateKeypair("ssh", "ssh-identities/e2e-key");
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

test("alias の台帳：暗号化された値に触れずにメタデータを読める", async () => {
  await withDir(async (dir) => {
    const registry = new LocalFileAliasStore(dir);
    await registry.load();
    await registry.create({ name: "github-token", kind: "secret", backendPath: "g1/github-token" });
    const meta = (await registry.list()).find((a) => a.name === "github-token");
    assert.equal(meta?.kind, "secret");
    assert.equal(meta?.lastUsedAt, undefined);

    await registry.markUsed("g1/github-token");
    assert.ok((await registry.list()).find((a) => a.name === "github-token")?.lastUsedAt);
  });
});

// ---- OS の面の穴（`vault-os-surface-hardening`、2026-09-10）--------------------
//
// **Vault は Landlock の対象外**（鍵を持つので閉じ込めの外に置いてある）。
// つまり OS 側で止まってくれる保証が無い——この4つは Vault 自身が塞ぐしかない。

test("グループ名で Vault の置き場の外に出られない（`../` を通さない）", async () => {
  await withDir(async (dir) => {
    const backend = new SopsBackend(dir);
    await backend.init();

    for (const bad of ["../escaped", "..", ".", "a/b", "/abs", "", "-leading"]) {
      await assert.rejects(
        () => backend.createGroup(bad),
        /グループ名に使えるのは/,
        `createGroup(${JSON.stringify(bad)}) が通ってしまった`,
      );
    }
    // 秘密の置き場（path）からも同じ道が開いていない
    await assert.rejects(() => backend.putSecret("../escaped/key", "v"), /グループ名に使えるのは/);
    await assert.rejects(() => backend.getSecret("../escaped/key"), /グループ名に使えるのは/);

    // 置き場の外に何も作られていない
    assert.equal(existsSync(join(dir, "..", "escaped")), false, "Vault の置き場の外にディレクトリができている");
    // 素直な名前は今までどおり通る
    await backend.createGroup("ok-name_1.2");
  });
});

test("暗号化の途中でも、平文はディスクに現れない（残骸ではなく、経過を見る）", async () => {
  await withDir(async (dir) => {
    const backend = new SopsBackend(dir);
    await backend.init();
    await backend.createGroup("g1");

    // **「終わった後に残っていない」では足りない**——以前の実装は平文の一時ファイルを
    // 書いて `finally` で消していたので、正常終了なら残らない（落ちたときだけ残る）。
    // 見たいのは「そもそも作られないこと」なので、**書いている最中を見張る**
    const { watch } = await import("node:fs");
    const seen = new Set<string>();
    const watcher = watch(join(dir, "groups", "g1"), (_event, name) => {
      if (name) seen.add(name);
    });
    try {
      await backend.putSecret("g1/a", "PLAINTEXT-MUST-NOT-LAND");
      await new Promise((r) => setTimeout(r, 50)); // 見張りの取りこぼしを避ける
    } finally {
      watcher.close();
    }

    const unexpected = [...seen].filter((n) => n !== "secrets.sops.json" && n !== "secrets.sops.json.tmp");
    assert.deepEqual(unexpected, [], `暗号文以外のファイルが作られた: ${unexpected.join(", ")}`);

    const { readdir, readFile } = await import("node:fs/promises");
    assert.deepEqual(await readdir(join(dir, "groups", "g1")), ["secrets.sops.json"]);
    const raw = await readFile(join(dir, "groups", "g1", "secrets.sops.json"), "utf8");
    assert.ok(!raw.includes("PLAINTEXT-MUST-NOT-LAND"));
  });
});

test("同じグループへ同時に書いても、どちらの秘密も消えない", async () => {
  await withDir(async (dir) => {
    const backend = new SopsBackend(dir);
    await backend.init();
    await backend.createGroup("g1");

    // 「読んで・足して・書く」が並行すると、後から書いたほうが前の追加を消す
    await Promise.all([
      backend.putSecret("g1/first", "value-1"),
      backend.putSecret("g1/second", "value-2"),
      backend.putSecret("g1/third", "value-3"),
    ]);

    assert.equal(await backend.getSecret("g1/first"), "value-1");
    assert.equal(await backend.getSecret("g1/second"), "value-2");
    assert.equal(await backend.getSecret("g1/third"), "value-3");
  });
});

test("同じ鍵で ssh-agent を増やさない——使い回して、最後に落とす", async () => {
  await withDir(async (dir) => {
    const backend = new SopsBackend(dir);
    await backend.init();
    const { privateKeyRef } = await backend.generateKeypair("ssh", "ssh-identities/e2e-key");

    const first = await backend.loadIntoAgent(privateKeyRef);
    const second = await backend.loadIntoAgent(privateKeyRef);
    const third = await backend.loadIntoAgent(privateKeyRef);

    // 3回呼んでも agent は1つ（socket が同じ＝同じプロセス）
    assert.equal(second.socketPath, first.socketPath, "呼ぶたびに ssh-agent が増えている");
    assert.equal(third.socketPath, first.socketPath);
    assert.ok(existsSync(first.socketPath), "agent の socket が無い");

    // 畳めば、鍵を抱えたプロセスは残らない
    await backend.stopAgents();
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(existsSync(first.socketPath), false, "落としたのに socket が残っている");
  });
});

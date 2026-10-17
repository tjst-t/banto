// **実行場所の SSH 鍵の置き場は core だけが使える**（決定・2026-10-17、Backlog #361、v4-security.md §1「向こうとの道」）。
//
// 共通の置き場の鍵だと、どの Project の AI でも Vault に頼んでその鍵の ssh-agent を開かせ、別の Project の実行場所に
// 入れた。置き場（`RUNTIME_KEYS_GROUP`）を core の印（`{host: true}`）だけが使えるようにし、Project・banto 全体の
// 呼び出しからは名前も見えないこと、紐付け・参照・移す口で抜け道ができないことを見る。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { RUNTIME_KEYS_GROUP } from "@banto/module-contract";
import { createVaultModuleServer } from "./server.js";
import { LocalFileAliasStore } from "./alias-store.js";
import type { VaultBackend } from "./backend.js";

const stamp = (caller: Record<string, unknown>) => ({ "dev.banto/caller": caller });
const ADMIN = stamp({ admin: true });
const HOST = stamp({ host: true });
const INSTANCE = stamp({ instance: true });
const PROJECT = stamp({ project: "p1" });

function memoryBackend(): VaultBackend {
  const secrets = new Map<string, string>();
  return {
    async getSecret(path) {
      const v = secrets.get(path);
      if (v === undefined) throw new Error(`vault secret not found: ${path}`);
      return v;
    },
    async putSecret(path, value) {
      secrets.set(path, String(value));
    },
    async deleteSecret(path) {
      secrets.delete(path);
    },
    async listPaths() {
      return [...secrets.keys()];
    },
    async generateKeypair() {
      throw new Error("使わない");
    },
    async publicKeyOf() {
      throw new Error("使わない");
    },
    async loadIntoAgent() {
      throw new Error("使わない");
    },
    async listGroups() {
      return [];
    },
    async createGroup() {},
  };
}

async function withKit(fn: (c: Client) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "vault-kit-runtime-"));
  try {
    const server = createVaultModuleServer({
      moduleName: "vault-test",
      backend: memoryBackend(),
      aliasStore: new LocalFileAliasStore(dir),
      dataDir: dir,
    });
    const [s, c] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test", version: "0.0.0" });
    await Promise.all([server.connect(s), client.connect(c)]);
    // 共通の置き場・Project p1 の置き場・実行場所の鍵の置き場に1つずつ
    await call(client, "setGroupBinding", { projectId: "p1", group: "g1" }, ADMIN);
    await call(client, "createAlias", { name: "shared-key", kind: "secret", value: "s" }, ADMIN);
    await call(client, "createAlias", { name: "p1-key", kind: "secret", group: "g1", value: "p" }, ADMIN);
    await call(client, "createAlias", { name: "rt-key", kind: "secret", group: RUNTIME_KEYS_GROUP, value: "r" }, ADMIN);
    await fn(client);
    await client.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function call(c: Client, name: string, args: Record<string, unknown>, meta: Record<string, unknown>): Promise<string> {
  const r = await c.callTool({ name, arguments: args, _meta: meta });
  const text = (r.content as { text: string }[])[0]!.text;
  if (r.isError) throw new Error(text);
  return text;
}

const names = async (c: Client, meta: Record<string, unknown>) =>
  (JSON.parse(await call(c, "listAliases", {}, meta)) as Array<{ name: string }>).map((a) => a.name).sort();

test("実行場所の鍵の置き場は、Project・banto 全体の呼び出しからは名前も見えず、値も引けない", async () => {
  await withKit(async (c) => {
    assert.deepEqual(await names(c, PROJECT), ["p1-key", "shared-key"]);
    assert.deepEqual(await names(c, INSTANCE), ["shared-key"]);
    await assert.rejects(() => call(c, "resolveAlias", { name: "rt-key" }, PROJECT), /not found|使えません/);
    await assert.rejects(() => call(c, "resolveAlias", { name: "rt-key", group: RUNTIME_KEYS_GROUP }, PROJECT), /not found|使えません/);
    await assert.rejects(() => call(c, "resolveAlias", { name: "rt-key" }, INSTANCE), /not found|使えません/);
    // 人の管理面には「実行場所」として出る（未割当に混ぜない）
    const admin = JSON.parse(await call(c, "listAliases", {}, ADMIN)) as Array<{ name: string; scope: string }>;
    assert.equal(admin.find((a) => a.name === "rt-key")?.scope, "runtime");
  });
});

test("core の印は、実行場所の鍵の置き場だけを見て使える——共通・Project の鍵は断る", async () => {
  await withKit(async (c) => {
    assert.deepEqual(await names(c, HOST), ["rt-key"]);
    assert.equal(await call(c, "resolveAlias", { name: "rt-key", group: RUNTIME_KEYS_GROUP }, HOST), "r");
    await assert.rejects(() => call(c, "resolveAlias", { name: "shared-key" }, HOST), new RegExp(`実行場所の SSH 鍵の置き場（グループ "${RUNTIME_KEYS_GROUP}"）にありません`));
    await assert.rejects(() => call(c, "resolveAlias", { name: "p1-key", group: "g1" }, HOST), /にありません/);
  });
});

test("実行場所の鍵の置き場は、共通の置き場にも Project の置き場にも紐付けられない", async () => {
  await withKit(async (c) => {
    await assert.rejects(() => call(c, "setSharedGroup", { group: RUNTIME_KEYS_GROUP }, ADMIN), /実行場所の SSH 鍵の置き場/);
    await assert.rejects(() => call(c, "setGroupBinding", { projectId: "p1", group: RUNTIME_KEYS_GROUP }, ADMIN), /実行場所の SSH 鍵の置き場/);
    assert.deepEqual(await names(c, PROJECT), ["p1-key", "shared-key"]);
  });
});

test("参照で Project の置き場へ引き込めない——参照を作る口・参照ごと移す口で断り、前からある参照も辿らせない", async () => {
  await withKit(async (c) => {
    await assert.rejects(() => call(c, "linkAlias", { name: "rt-key", group: RUNTIME_KEYS_GROUP, toGroup: "g1" }, ADMIN), /参照は作れません/);
    // 共通の鍵を Project に参照させたまま実行場所の置き場へ移そうとすると断る（移すと参照が実行場所の鍵を指す）
    await call(c, "linkAlias", { name: "shared-key", toGroup: "g1", toName: "shared-link" }, ADMIN);
    await assert.rejects(
      () => call(c, "migrateAlias", { name: "shared-key", toGroup: RUNTIME_KEYS_GROUP }, ADMIN),
      /参照があります（g1 \/ shared-link）/,
    );
    assert.equal(await call(c, "resolveAlias", { name: "shared-link" }, PROJECT), "s");
    // 参照を消せば移せる。移したあとは Project からは見えず、core からは使える
    await call(c, "deleteAlias", { name: "shared-link", group: "g1" }, ADMIN);
    await call(c, "migrateAlias", { name: "shared-key", toGroup: RUNTIME_KEYS_GROUP }, ADMIN);
    assert.deepEqual(await names(c, PROJECT), ["p1-key"]);
    assert.deepEqual(await names(c, HOST), ["rt-key", "shared-key"]);
  });
});

test("Module・AI は実行場所の鍵の置き場に置けない（置けるのは人の管理画面から）", async () => {
  await withKit(async (c) => {
    await assert.rejects(
      () => call(c, "createAlias", { name: "x", kind: "secret", group: RUNTIME_KEYS_GROUP, value: "v" }, PROJECT),
      /人の管理画面からだけ/,
    );
    await assert.rejects(() => call(c, "putSecret", { name: "y", group: RUNTIME_KEYS_GROUP, value: "v" }, PROJECT), /人の管理画面からだけ/);
    await assert.rejects(() => call(c, "generateSecret", { name: "z", group: RUNTIME_KEYS_GROUP }, INSTANCE), /人の管理画面からだけ/);
  });
});

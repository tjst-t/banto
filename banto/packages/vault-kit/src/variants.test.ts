// グループの「版」と値が空の秘密を、kit の側で見る（決定・2026-10-06、仕様 §2.1「グループの『版』」
// 「値が空の秘密」）。kit は版の意味を知らず、`<グループ>@<版>` の書き方と紐付けだけを扱う。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createVaultModuleServer } from "./server.js";
import { LocalFileAliasStore, type AliasListOptions } from "./alias-store.js";
import { joinVariant, splitVariant, type VaultBackend } from "./backend.js";

const ADMIN = { "dev.banto/caller": { admin: true } } as const;
const PROJECT = { "dev.banto/caller": { project: "P" } } as const;

function memoryBackend(withVariants: boolean) {
  const secrets = new Map<string, string>();
  const backend: VaultBackend = {
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
    ...(withVariants
      ? {
          variants: async () => ({ label: "環境", options: ["dev", "prod"], default: "dev" }),
          countByVariant: async () => [
            { variant: "dev", filled: 0, total: 2 },
            { variant: "prod", filled: 2, total: 2 },
          ],
        }
      : {}),
  };
  return { backend, secrets };
}

/** 版付きのグループの行は、`alsoGroups` で渡されたときだけ返す（版を名乗る backend の振る舞いの写し）。 */
class VariantStore extends LocalFileAliasStore {
  seen: Array<AliasListOptions | undefined> = [];
  override async list(opts?: AliasListOptions) {
    this.seen.push(opts);
    const rows = await super.list();
    return rows.filter((m) => {
      const group = m.backendPath.slice(0, m.backendPath.indexOf("/"));
      return splitVariant(group).variant === undefined || (opts?.alsoGroups ?? []).includes(group);
    });
  }
}

async function withKit(
  withVariants: boolean,
  fn: (c: Client, mem: ReturnType<typeof memoryBackend>, store: VariantStore) => Promise<void>,
) {
  const dir = await mkdtemp(join(tmpdir(), "vault-kit-variants-"));
  try {
    const mem = memoryBackend(withVariants);
    const store = new VariantStore(dir);
    const server = createVaultModuleServer({ moduleName: "vault-test", backend: mem.backend, aliasStore: store, dataDir: dir });
    const [s, c] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test", version: "0.0.0" });
    await Promise.all([server.connect(s), client.connect(c)]);
    await fn(client, mem, store);
    await client.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function call(c: Client, name: string, args: Record<string, unknown>, meta: Record<string, unknown> = ADMIN) {
  const res = (await c.callTool({ name, arguments: args, _meta: meta })) as { isError?: boolean; content: Array<{ text: string }> };
  if (res.isError) throw new Error(res.content[0]!.text);
  return res.content[0]!.text;
}

test("書き方：既定の版は @ を付けない／グループや版に @ を入れられない", () => {
  assert.equal(joinVariant("g", "prod", "dev"), "g@prod");
  assert.equal(joinVariant("g", "dev", "dev"), "g");
  assert.equal(joinVariant("g", undefined, "dev"), "g");
  assert.deepEqual(splitVariant("g@prod"), { group: "g", variant: "prod" });
  assert.deepEqual(splitVariant("g"), { group: "g" });
  assert.throws(() => joinVariant("a@b", "prod"), /"@" は使えません/);
});

test("版を名乗らない backend：describeVariants は null、版つきの紐付けは断る（黙って既定に倒さない）", async () => {
  await withKit(false, async (c) => {
    assert.equal(await call(c, "describeVariants", {}), "null");
    await assert.rejects(() => call(c, "setGroupBinding", { projectId: "P", group: "g", variant: "prod" }), /版がありません/);
    assert.deepEqual(JSON.parse(await call(c, "setGroupBinding", { projectId: "P", group: "g" })), { projectId: "P", group: "g" });
  });
});

test("版を名乗る backend：版つきで紐付けると g@prod、既定の版なら g、無い版・@ 入りのグループは断る", async () => {
  await withKit(true, async (c) => {
    assert.deepEqual(JSON.parse(await call(c, "describeVariants", {})), { label: "環境", options: ["dev", "prod"], default: "dev" });
    assert.deepEqual(JSON.parse(await call(c, "setGroupBinding", { projectId: "P", group: "g", variant: "prod" })), {
      projectId: "P",
      group: "g@prod",
      variant: "prod",
    });
    assert.equal(JSON.parse(await call(c, "setGroupBinding", { projectId: "Q", group: "g", variant: "dev" })).group, "g");
    await assert.rejects(() => call(c, "setGroupBinding", { projectId: "P", group: "g", variant: "stg" }), /環境「stg」はありません/);
    await assert.rejects(() => call(c, "setGroupBinding", { projectId: "P", group: "g@prod" }), /分けて渡してください/);
    const bindings = JSON.parse(await call(c, "listGroupBindings", {}));
    assert.deepEqual(bindings.projects, [
      { projectId: "P", group: "g@prod" },
      { projectId: "Q", group: "g" },
    ]);
  });
});

test("紐付けた版付きのグループは一覧に出る（kit が alsoGroups で渡す）——Project から引けて、行に版が付く", async () => {
  await withKit(true, async (c, _mem, store) => {
    await call(c, "createAlias", { name: "HOST", kind: "secret", group: "g@prod", value: "pve" });
    await call(c, "createAlias", { name: "HOST", kind: "secret", group: "g", value: "dev-host" });
    // 紐付ける前は、版付きのグループは渡さない
    store.seen.length = 0;
    await call(c, "listAliases", {});
    assert.deepEqual(store.seen.at(-1), undefined);

    await call(c, "setGroupBinding", { projectId: "P", group: "g", variant: "prod" });
    assert.equal(await call(c, "resolveAlias", { name: "HOST" }, PROJECT), "pve", "版の値ではなく既定の版の値が返った");
    const rows = JSON.parse(await call(c, "listAliases", {}, PROJECT)) as Array<Record<string, unknown>>;
    assert.deepEqual(rows.map((r) => [r.name, r.group, r.variant, r.scope]), [["HOST", "g@prod", "prod", "project"]]);
    assert.deepEqual(store.seen.at(-1), { alsoGroups: ["g@prod"] });
  });
});

test("値が空の秘密は渡さない——理由をつけて断る（人の管理面には置き場も言う）", async () => {
  await withKit(true, async (c, mem) => {
    await call(c, "setGroupBinding", { projectId: "P", group: "g" });
    await call(c, "createAlias", { name: "TOKEN", kind: "secret", group: "g", value: "x" });
    mem.secrets.set("g/TOKEN", ""); // backend の側で空にされた（Infisical の名前だけの空欄）
    await assert.rejects(() => call(c, "resolveAlias", { name: "TOKEN" }, PROJECT), (err: Error) => {
      assert.match(err.message, /alias "TOKEN" の値が空です/);
      assert.doesNotMatch(err.message, /置き場/, "Project に置き場を見せた");
      return true;
    });
    await assert.rejects(() => call(c, "resolveAlias", { name: "TOKEN" }), /値が空です（置き場 g \/ TOKEN）/);
  });
});

test("版ごとの数は人の管理面からだけ数えられる・版を付けたグループは断る", async () => {
  await withKit(true, async (c) => {
    assert.deepEqual(JSON.parse(await call(c, "countVariants", { group: "g" })), [
      { variant: "dev", filled: 0, total: 2 },
      { variant: "prod", filled: 2, total: 2 },
    ]);
    await assert.rejects(() => call(c, "countVariants", { group: "g" }, PROJECT), /人の管理画面からしか/);
    await assert.rejects(() => call(c, "countVariants", { group: "g@prod" }), /版を付けずに/);
  });
});

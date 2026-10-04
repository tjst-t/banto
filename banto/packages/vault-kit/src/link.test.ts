// **参照は backend の秘密に触らない**（決定・2026-10-04、仕様 §2.1 C節「参照」）。
//
// 組み込み（台帳がローカルのファイル）では、参照は台帳の行だけで秘密を持たない。
// kit が参照に対して `putSecret` / `deleteSecret` を呼ぶと、**存在しない秘密を
// 消しにいく**（＝落ちる）か、**値を写す**（＝参照ではなくなる）。backend への
// 呼び出しを記録して、参照を作る・移す・消すが backend の秘密に触らないことを見る。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createVaultModuleServer } from "./server.js";
import { LocalFileAliasStore } from "./alias-store.js";
import type { VaultBackend } from "./backend.js";

const ADMIN = { "dev.banto/caller": { admin: true } } as const;

/** 秘密を Map に持ち、**呼ばれた口と置き場を記録する** backend。 */
function recordingBackend() {
  const secrets = new Map<string, string>();
  const calls: string[] = [];
  const backend: VaultBackend = {
    async getSecret(path) {
      calls.push(`get ${path}`);
      const v = secrets.get(path);
      if (v === undefined) throw new Error(`vault secret not found: ${path}`);
      return v;
    },
    async putSecret(path, value) {
      calls.push(`put ${path}`);
      secrets.set(path, String(value));
    },
    async deleteSecret(path) {
      calls.push(`delete ${path}`);
      if (!secrets.delete(path)) throw new Error(`vault secret not found: ${path}`);
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
    async createGroup(name) {
      calls.push(`createGroup ${name}`);
    },
  };
  return { backend, secrets, calls };
}

/**
 * 台帳を数え、**`.` を含む置き場は参照で指せない**と言う置き場（Infisical の制約の写し）。
 */
class CountingStore extends LocalFileAliasStore {
  lists = 0;
  override async list() {
    this.lists++;
    return super.list();
  }
  override async assertCanLinkTo(backendPath: string): Promise<void> {
    if (backendPath.includes(".")) throw new Error(`参照で指せません: ${backendPath}`);
  }
}

async function withKit(
  fn: (c: Client, rec: ReturnType<typeof recordingBackend>, store: CountingStore) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "vault-kit-link-"));
  try {
    const rec = recordingBackend();
    const store = new CountingStore(dir);
    const server = createVaultModuleServer({
      moduleName: "vault-test",
      backend: rec.backend,
      aliasStore: store,
      dataDir: dir,
    });
    const [s, c] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test", version: "0.0.0" });
    await Promise.all([server.connect(s), client.connect(c)]);
    await fn(client, rec, store);
    await client.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const call = (c: Client, name: string, args: Record<string, unknown>) =>
  c.callTool({ name, arguments: args, _meta: ADMIN });

test("参照を作る・移す・消すは、backend の秘密に触らない（値を写さない・無い秘密を消しにいかない）", async () => {
  await withKit(async (c, rec) => {
    await call(c, "createAlias", { name: "tok", kind: "secret", group: "src", value: "v1" });
    rec.calls.length = 0;

    await call(c, "linkAlias", { name: "tok", group: "src", toGroup: "dst" });
    await call(c, "migrateAlias", { name: "tok", group: "dst", toGroup: "dst2" });
    await call(c, "deleteAlias", { name: "tok", group: "dst2" });
    const touched = rec.calls.filter((x) => !x.startsWith("createGroup "));
    assert.deepEqual(touched, [], `参照の操作が backend の秘密に触った: ${touched.join(", ")}`);
    assert.deepEqual([...rec.secrets.keys()], ["src/tok"], "元が残っていない、か値が写された");
  });
});

test("参照から引くと、backend に聞くのは元の置き場だけ", async () => {
  await withKit(async (c, rec) => {
    await call(c, "createAlias", { name: "tok", kind: "secret", group: "src", value: "v1" });
    await call(c, "linkAlias", { name: "tok", group: "src", toGroup: "dst", toName: "tok2" });
    rec.calls.length = 0;
    const got = await call(c, "resolveAlias", { name: "tok2", group: "dst" });
    assert.equal((got.content as { text: string }[])[0]!.text, "v1");
    assert.deepEqual(rec.calls, ["get src/tok"]);
  });
});

test("元を移すと参照は指し直す——消す前に（途中で落ちても参照は切れない）", async () => {
  await withKit(async (c, rec) => {
    await call(c, "createAlias", { name: "tok", kind: "secret", group: "src", value: "v1" });
    await call(c, "linkAlias", { name: "tok", group: "src", toGroup: "dst" });
    // **元を消すところで落とす**——参照はもう新しい元を指していなければならない
    const realDelete = rec.backend.deleteSecret.bind(rec.backend);
    rec.backend.deleteSecret = async () => {
      throw new Error("ここで落ちた");
    };
    await assert.rejects(() => call(c, "migrateAlias", { name: "tok", group: "src", toGroup: "moved" }), /ここで落ちた/);
    rec.backend.deleteSecret = realDelete;
    const got = await call(c, "resolveAlias", { name: "tok", group: "dst" });
    assert.equal((got.content as { text: string }[])[0]!.text, "v1");
    const list = JSON.parse(((await call(c, "listAliases", {})).content as { text: string }[])[0]!.text) as Array<{
      group: string;
      linkTo?: { group: string };
    }>;
    assert.equal(list.find((a) => a.group === "dst")!.linkTo!.group, "moved");
  });
});

test("参照から引くとき、台帳は1回しか読まない（元を引くのに読み直さない）", async () => {
  await withKit(async (c, _rec, store) => {
    await call(c, "createAlias", { name: "tok", kind: "secret", group: "src", value: "v1" });
    await call(c, "linkAlias", { name: "tok", group: "src", toGroup: "dst" });
    for (const [tool, args] of [
      ["resolveAlias", { name: "tok", group: "dst" }],
      ["verify", { alias: "tok", group: "dst", payload: "p", signature: "00" }],
    ] as const) {
      store.lists = 0;
      await call(c, tool, args);
      assert.equal(store.lists, 1, `${tool} が台帳を ${store.lists} 回読んだ`);
    }
  });
});

test("指されている元を、参照で指せない置き場へは移さない——写す前に断り、元は1か所のまま", async () => {
  await withKit(async (c, rec) => {
    await call(c, "createAlias", { name: "tok", kind: "secret", group: "src", value: "v1" });
    await call(c, "linkAlias", { name: "tok", group: "src", toGroup: "dst" });
    rec.calls.length = 0;
    await assert.rejects(() => call(c, "migrateAlias", { name: "tok", group: "src", toGroup: "a.b" }), /参照で指せません: a\.b\/tok/);
    assert.deepEqual(rec.calls, [], `断る前に backend に触った: ${rec.calls.join(", ")}`);
    assert.deepEqual([...rec.secrets.keys()], ["src/tok"]);
    // 参照に指されていなければ、制約は関係ない（移せる）
    await call(c, "createAlias", { name: "free", kind: "secret", group: "src", value: "v2" });
    await call(c, "migrateAlias", { name: "free", group: "src", toGroup: "a.b" });
    assert.ok(rec.secrets.has("a.b/free"));
  });
});

test("参照で指せない元なら、置く先のグループを作る前に断る（空のグループを残さない）", async () => {
  await withKit(async (c, rec) => {
    await call(c, "createAlias", { name: "tok", kind: "secret", group: "x.y", value: "v1" });
    rec.calls.length = 0;
    await assert.rejects(() => call(c, "linkAlias", { name: "tok", group: "x.y", toGroup: "dst" }), /参照で指せません/);
    assert.deepEqual(rec.calls, [], `断る前にグループを作った: ${rec.calls.join(", ")}`);
  });
});

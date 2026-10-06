// **banto が置く秘密の持ち主**（追加・2026-10-06、仕様 §2.1 C節）。
//
// `putSecret`（種別 `oauth-token` だけを扱う口）は、新しく置くとき host が刻んだ呼び元の Module（`dev.banto/callerModule`）を
// 持ち主として台帳に残し、置き換えは持ち主と同じ Module からだけ許す。だから「呼び元の Module が持ち主のものだけを
// 書き換える口」（`dev.banto/callerOwned`）を名乗れ、host は同梱の Module からの中継を人に聞かずに通す。
// 持ち主の記録が無いもの（記録を始める前に置かれたもの）は、今までどおり置き換えられ、置き換えた Module が持ち主になる。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createVaultModuleServer } from "./server.js";
import { LocalFileAliasStore } from "./alias-store.js";
import type { VaultBackend } from "./backend.js";

/** 秘密を Map に持つだけの backend */
function memoryBackend() {
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
  };
  return { backend, secrets };
}

/** 中継が刻む形——banto 全体のための呼び出しで、呼び元の Module つき（無ければ人の画面・banto 本体から直接） */
const via = (module?: string) => ({
  "dev.banto/caller": { instance: true },
  // 接続名は持ち主に使わない——宣言の名前と違う形にして、取り違えたら落ちるようにする
  ...(module ? { "dev.banto/callerModule": { name: module, conn: `${module}-conn` } } : {}),
});

async function withKit(
  fn: (c: Client, secrets: Map<string, string>, dir: string, store: LocalFileAliasStore) => Promise<void>,
  opts: { canonicalGroup?: (g: string) => string } = {},
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "vault-kit-owner-"));
  try {
    const { backend, secrets } = memoryBackend();
    if (opts.canonicalGroup) backend.canonicalGroup = opts.canonicalGroup;
    const store = new LocalFileAliasStore(dir);
    const server = createVaultModuleServer({ moduleName: "vault-test", backend, aliasStore: store, dataDir: dir });
    const [s, c] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test", version: "0.0.0" });
    await Promise.all([server.connect(s), client.connect(c)]);
    try {
      await fn(client, secrets, dir, store);
    } finally {
      await client.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const put = (c: Client, value: string, module?: string) =>
  c.callTool({ name: "putSecret", arguments: { name: "oauth-x", value }, _meta: via(module) });

/** 台帳に残った持ち主（`aliases.json` を直接読む——一覧の見せ方に頼らない） */
async function ownerOf(dir: string, name: string): Promise<string | undefined> {
  const rows = JSON.parse(await readFile(join(dir, "aliases.json"), "utf8")) as Array<{ name: string; owner?: string }>;
  return rows.find((r) => r.name === name)?.owner;
}

test("putSecret は「呼び元の Module が持ち主のものだけを書き換える口」を名乗る（値を返す口・ほかの書く口は名乗らない）", async () => {
  await withKit(async (c) => {
    const { tools } = await c.listTools();
    const named = tools.filter((t) => (t._meta as Record<string, unknown> | undefined)?.["dev.banto/callerOwned"] === true).map((t) => t.name);
    assert.deepEqual(named, ["putSecret"]);
  });
});

test("新しく置いた Module が持ち主になり、同じ Module からは置き換えられる——違う Module・Module を介さない呼び出しからは断る", async () => {
  await withKit(async (c, secrets, dir) => {
    await put(c, "v1", "repositories");
    assert.equal(await ownerOf(dir, "oauth-x"), "repositories", "持ち主を記録していない");
    await put(c, "v2", "repositories");
    assert.equal(secrets.get("instance/oauth-x"), "v2");

    await assert.rejects(() => put(c, "乗っ取り", "vault-directory"), /oauth-x" は repositories が置いたものです。vault-directory からは置き換えられません/);
    await assert.rejects(() => put(c, "乗っ取り"), /repositories が置いたものです。Module を介さずには置き換えられません/);
    assert.equal(secrets.get("instance/oauth-x"), "v2", "断ったのに値を置き換えた");
    assert.equal(await ownerOf(dir, "oauth-x"), "repositories", "断った呼び出しで持ち主が変わった");
  });
});

test("持ち主の記録が無い既存のもの：今までどおり置き換えられ、置き換えた Module が持ち主になる。Module を介さない置き換えでは持ち主は決まらない", async () => {
  await withKit(async (c, secrets, dir) => {
    // 記録を始める前の形——呼び元の Module の刻印が無い呼び出しで置かれたもの
    await put(c, "old");
    assert.equal(await ownerOf(dir, "oauth-x"), undefined);
    await put(c, "still-old");
    assert.equal(await ownerOf(dir, "oauth-x"), undefined, "Module を介さない呼び出しで持ち主を決めた");
    assert.equal(secrets.get("instance/oauth-x"), "still-old");

    await put(c, "claimed", "repositories");
    assert.equal(await ownerOf(dir, "oauth-x"), "repositories", "持ち主の無いものを置き換えた Module が持ち主になっていない");
    await assert.rejects(() => put(c, "x", "backlog"), /repositories が置いたもの/);
    assert.equal(secrets.get("instance/oauth-x"), "claimed");
  });
});

test("持ち主があっても、人が預けた秘密には今までどおりこの口から届かない", async () => {
  await withKit(async (c, secrets) => {
    await c.callTool({
      name: "createAlias",
      arguments: { name: "oauth-x", kind: "secret", value: "human" },
      _meta: { "dev.banto/caller": { admin: true } },
    });
    await assert.rejects(() => put(c, "x", "repositories"), /人が預けた秘密です（secret）/);
    assert.equal(secrets.get("instance/oauth-x"), "human");
  });
});

test("人は oauth-token を手で作れない（createAlias が断る。人の管理画面からでも）", async () => {
  await withKit(async (c, secrets) => {
    await assert.rejects(
      () => c.callTool({ name: "createAlias", arguments: { name: "oauth-x", kind: "oauth-token", value: "v" }, _meta: { "dev.banto/caller": { admin: true } } }),
      /oauth-token は banto が置く秘密（ログイン情報）です。手では作れません/,
    );
    assert.deepEqual([...secrets.keys()], []);
    const { tools } = await c.listTools();
    for (const name of ["createAlias", "requestAlias"]) {
      const kinds = (tools.find((t) => t.name === name)!.inputSchema.properties as Record<string, { enum?: string[] }>).kind!.enum;
      assert.deepEqual(kinds, ["secret", "ssh-identity", "file"], `${name} が手で作れない種別を名乗っている`);
    }
  });
});

test("別の Vault から移す口（importOwnedSecret）：人の管理操作の中でだけ、新しい置き場に、持ち主ごと置く", async () => {
  await withKit(async (c, secrets, dir) => {
    const human = { "dev.banto/caller": { admin: true }, "dev.banto/callerModule": { name: "vault-directory", conn: "vault-directory" } };
    await c.callTool({ name: "importOwnedSecret", arguments: { name: "oauth-x", value: "v1", group: "instance", owner: "repositories" }, _meta: human });
    assert.equal(await ownerOf(dir, "oauth-x"), "repositories");
    assert.equal(secrets.get("instance/oauth-x"), "v1");
    // 持ち主の検査を飛ばす道にしない——あるものは書き換えない
    await assert.rejects(
      () => c.callTool({ name: "importOwnedSecret", arguments: { name: "oauth-x", value: "乗っ取り", group: "instance", owner: "backlog" }, _meta: human }),
      /既に別の秘密があります/,
    );
    // 人の管理操作の外（AI のターン・banto 全体のための中継）では受けない
    await assert.rejects(
      () => c.callTool({ name: "importOwnedSecret", arguments: { name: "oauth-y", value: "v", group: "instance", owner: "repositories" }, _meta: via("backlog") }),
      /人の管理画面からしか行えません/,
    );
    assert.equal(secrets.get("instance/oauth-x"), "v1");
    assert.equal(secrets.has("instance/oauth-y"), false);
    // 持ち主の無いものは、持ち主無しのまま移る
    await c.callTool({ name: "importOwnedSecret", arguments: { name: "oauth-z", value: "v", group: "instance" }, _meta: human });
    assert.equal(await ownerOf(dir, "oauth-z"), undefined);
    const { tools } = await c.listTools();
    const t = tools.find((x) => x.name === "importOwnedSecret")!;
    assert.equal(t._meta?.["dev.banto/visibility"], "module", "admin にすると外から入れた Module の画面から承認なしで呼べる");
    assert.equal(t._meta?.["dev.banto/callerOwned"], undefined);
  });
});

test("持ち主は置き場を揃えて比べる——版付きのグループ（g@<既定>）と素の g は同じ置き場", async () => {
  await withKit(
    async (c, secrets, _dir, store) => {
      // 台帳の行が版付きの書き方で残っている形（既定の版を後から変えた等）
      await store.create({ name: "oauth-x", kind: "oauth-token", backendPath: "g@def/oauth-x", owner: "repositories" });
      secrets.set("g@def/oauth-x", "v1");
      await assert.rejects(
        () => c.callTool({ name: "putSecret", arguments: { name: "oauth-x", value: "乗っ取り", group: "g" }, _meta: via("backlog") }),
        /repositories が置いたものです/,
        "揃えずに比べて、持ち主の検査を素通りした",
      );
      await c.callTool({ name: "putSecret", arguments: { name: "oauth-x", value: "v2", group: "g" }, _meta: via("repositories") });
      assert.deepEqual((await store.list()).filter((r) => r.name === "oauth-x").map((r) => r.backendPath), ["g@def/oauth-x"], "同じ置き場に2つ目の行を作った");
    },
    { canonicalGroup: (g) => (g === "g@def" ? "g" : g) },
  );
});

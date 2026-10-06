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

async function withKit(fn: (c: Client, secrets: Map<string, string>, dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "vault-kit-owner-"));
  try {
    const { backend, secrets } = memoryBackend();
    const server = createVaultModuleServer({ moduleName: "vault-test", backend, aliasStore: new LocalFileAliasStore(dir), dataDir: dir });
    const [s, c] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test", version: "0.0.0" });
    await Promise.all([server.connect(s), client.connect(c)]);
    try {
      await fn(client, secrets, dir);
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

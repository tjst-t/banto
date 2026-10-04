// **一覧は起動を待たずに返す**（決定・2026-10-03、ユーザー）。vault-infisical が接続先に届かないと起動に
// 16 秒かかり、その間 host がこの Module を「繋がった」と扱えず、banto 全体の Module の一覧が丸ごと待たされた。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createVaultModuleServer } from "./server.js";
import type { VaultBackend } from "./backend.js";
import type { AliasStore } from "./alias-store.js";

const aliasStore: AliasStore = {
  load: async () => {},
  list: async () => [],
  create: async () => {},
  update: async () => {},
  delete: async () => {},
  markUsed: async () => {},
  createLink: async () => {},
  retargetLink: async () => {},
  deleteLink: async () => {},
};

async function connect(init: () => Promise<void>): Promise<Client> {
  const server = createVaultModuleServer({
    moduleName: "vault-test",
    backend: {} as VaultBackend,
    aliasStore,
    dataDir: mkdtempSync(join(tmpdir(), "vault-kit-init-")),
    configApp: { uri: "ui://vault-test/config", html: "<p>設定</p>", name: "Vault（試験）" },
    init,
  });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "host", version: "0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
}

function within<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return Promise.race([p, new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`${what} が ${ms}ms で返らない`)), ms))]);
}

test("起動が終わらなくても、tool・資源の一覧と設定画面の中身はすぐ返る", async () => {
  let finish!: () => void;
  const client = await connect(() => new Promise<void>((resolve) => (finish = resolve)));
  const tools = await within(client.listTools(), 1000, "tool の一覧");
  assert.ok(tools.tools.some((t) => t.name === "requestAlias"));
  const resources = await within(client.listResources(), 1000, "資源の一覧");
  assert.ok(resources.resources.some((r) => r.uri === "vault-test://module"), "申告が一覧に無い");
  const config = await within(client.readResource({ uri: "ui://vault-test/config" }), 1000, "設定画面の中身");
  assert.equal((config.contents[0] as { text: string }).text, "<p>設定</p>");

  // 中身を扱う呼び出しは、起動が終わるまで待つ
  let settled = false;
  const listing = client.readResource({ uri: "vault://aliases" }).finally(() => (settled = true));
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(settled, false, "起動の途中で中身を扱う呼び出しが返った");
  finish();
  await within(listing.catch(() => undefined), 2000, "起動のあとの呼び出し");
  assert.equal(settled, true);
});

test("起動に失敗したことが分かっていれば、一覧でも断る（host が「繋がらない」と出せる）", async () => {
  const client = await connect(async () => {
    throw new Error("鍵が無い");
  });
  await new Promise((r) => setTimeout(r, 20));
  await assert.rejects(client.listTools(), /鍵が無い/);
  await assert.rejects(client.readResource({ uri: "vault://aliases" }), /鍵が無い/);
});

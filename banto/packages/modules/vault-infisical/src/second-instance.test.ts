// **同じ実装を2本立てられるか**（追加・2026-09-15）。
//
// 自前ホストと Infisical Cloud を並べたい、という要望から出てきた。窓口
// （`vault-directory`）は役割 `vault` の実装を何本でも横断できるので、
// 2本目は「もう1つの宣言」で足りる——はずだった。実際にはコピーすると
// 3つ壊れるので、そこを塞いだことを機械で押さえる。
//
// **Infisical には繋がない**（この試験は繋ぎ方の既定と名前の話だけを見る）。

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createInfisicalVaultServer } from "./server.js";

async function connect(dataDir: string, moduleName?: string) {
  const server = createInfisicalVaultServer(dataDir, moduleName);
  const [s, c] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0.0.0" });
  await Promise.all([server.connect(s), client.connect(c)]);
  return client;
}

function settingsOf(result: unknown): Record<string, unknown> {
  return JSON.parse((result as { content: { text: string }[] }).content[0]!.text);
}

const ADMIN = { "dev.banto/caller": { admin: true } } as const;

test("2本目は、環境変数の既定を引き継がない（黙って1本目と同じ所へ繋がない）", async () => {
  // 環境変数が入っている状態を作る——本番の稼働環境がこの形
  const saved = { ...process.env };
  process.env.BANTO_INFISICAL_SITE_URL = "http://127.0.0.1:9";
  process.env.BANTO_INFISICAL_CLIENT_ID = "id";
  process.env.BANTO_INFISICAL_CLIENT_SECRET = "secret";
  process.env.BANTO_INFISICAL_PROJECT_ID = "proj";
  const dir = await mkdtemp(join(tmpdir(), "infisical-second-"));
  try {
    const copy = await connect(dir, "vault-infisical-cloud");
    const view = settingsOf(await copy.callTool({ name: "getConnectionSettings", arguments: {}, _meta: ADMIN }));
    assert.equal(view.source, "none", `2本目が環境変数の設定を拾っている: ${JSON.stringify(view)}`);
    assert.equal(view.configured, false);
    assert.match(String(view.lastError), /設定画面/);
    await copy.close();
  } finally {
    process.env = saved;
    await rm(dir, { recursive: true, force: true });
  }
});

test("2本目は、設定画面の見出しで見分けが付く", async () => {
  const dirA = await mkdtemp(join(tmpdir(), "infisical-name-a-"));
  const dirB = await mkdtemp(join(tmpdir(), "infisical-name-b-"));
  try {
    const first = await connect(dirA);
    const second = await connect(dirB, "vault-infisical-cloud");
    const nameOf = async (c: Client) =>
      (await c.listResources()).resources.find((r) => String(r.uri).endsWith("/config"))?.name;
    const a = await nameOf(first);
    const b = await nameOf(second);
    assert.equal(a, "Vault（Infisical）");
    assert.notEqual(b, a, "2本目の設定画面が1本目と同じ名前で並ぶ");
    assert.match(String(b), /vault-infisical-cloud/);
    await first.close();
    await second.close();
  } finally {
    await rm(dirA, { recursive: true, force: true });
    await rm(dirB, { recursive: true, force: true });
  }
});

// **未設定でも「自分が何者か」は名乗れる**（訂正・2026-09-15）。
// 2026-09-13 に「未設定でも立つ」と決めたのに、資源の一覧が金庫を読みに
// 行っていたので**一覧そのものが例外**になっていた——host から見ると
// 繋がらない Module と区別が付かない。2本目は設定するまで未設定が普通の
// 状態になるので、ここが通らないと同じ実装を2本立てられない。
test("未設定の Module でも、資源の一覧は出る（申告と設定画面に辿り着ける）", async () => {
  const dir = await mkdtemp(join(tmpdir(), "infisical-unconfigured-"));
  try {
    const client = await connect(dir, "vault-infisical-cloud");
    const { resources } = await client.listResources();
    const uris = resources.map((r) => String(r.uri));
    assert.ok(
      uris.some((u) => u.endsWith("://module")),
      `自分の申告が出ていない（host が繋げない）: ${uris.join(", ")}`,
    );
    assert.ok(
      uris.some((u) => u.endsWith("/config")),
      `設定画面に辿り着けない: ${uris.join(", ")}`,
    );
    // **中身が要るほうは、読んだときに理由つきで断る**（黙って空を返さない）
    await assert.rejects(
      () => client.readResource({ uri: "vault://aliases" }),
      /まだ使えません/,
    );
    await client.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

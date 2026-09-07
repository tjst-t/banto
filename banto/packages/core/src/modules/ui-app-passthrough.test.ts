// **本物の Module を立てて、画面の印が host まで届くかを見る**（規則1）。
//
// これは確かめないと危ない。以前、`initialize` の応答に載せた `_meta` が
// **SDK のスキーマで削られて host に届かない**ことを実測で見ている
// （2026-09-06、自己申告の置き場を resources 側にした理由）。
// tool の `_meta.ui.resourceUri` も同じ経路を通る——「仕様にあるから届く」で
// 済ませない。
import { test } from "node:test";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const filesystemServer = join(__dirname, "..", "..", "..", "modules", "filesystem", "dist", "server.js");

async function withFileSystem(fn: (c: Client) => Promise<void>): Promise<void> {
  const client = new Client({ name: "ui-app-test", version: "0.0.0" }, { capabilities: {} });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [filesystemServer],
      env: { ...process.env, BANTO_PROJECT_ROOT: "/tmp" } as Record<string, string>,
    }),
  );
  try {
    await fn(client);
  } finally {
    await client.close();
  }
}

test("tool の `_meta.ui.resourceUri` は SDK を通っても消えない", async () => {
  await withFileSystem(async (client) => {
    const { tools } = await client.listTools();
    const listDirectory = tools.find((t) => t.name === "listDirectory");
    assert.ok(listDirectory, "listDirectory が無い");
    const uri = (listDirectory._meta as { ui?: { resourceUri?: unknown } } | undefined)?.ui?.resourceUri;
    assert.equal(uri, "ui://banto-filesystem/directory", "画面の印が host まで届いていない");
  });
});

test("画面の資源は仕様どおりの MIME で名乗り、HTML が読める", async () => {
  await withFileSystem(async (client) => {
    const { resources } = await client.listResources();
    const app = resources.find((r) => r.uri === "ui://banto-filesystem/directory");
    assert.ok(app, "画面の資源が resources/list に無い");
    assert.equal(app.mimeType, "text/html;profile=mcp-app");

    const { contents } = await client.readResource({ uri: "ui://banto-filesystem/directory" });
    const html = contents[0] as { mimeType?: string; text?: string } | undefined;
    assert.equal(html?.mimeType, "text/html;profile=mcp-app");
    assert.match(String(html?.text), /<!doctype html>/i);
    // 画面が自分で tool を呼べる形になっている（承認ゲートを通る側）
    assert.match(String(html?.text), /tools\/call/);
  });
});

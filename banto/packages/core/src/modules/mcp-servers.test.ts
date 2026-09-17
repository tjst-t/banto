// **MCP の共通形（`mcpServers`）で受け渡す**（決定・2026-09-16）。
// 仕様 §5.1 は最初から「独自形式を作らない。`mcpServers` 形に寄せる」と
// 決めていたのに、実装は banto 独自の形のままだった（規則8）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_MODULE_DECLARATIONS, parseModuleDeclaration } from "./declaration.js";
import { McpServersError, fromMcpServers, toMcpServers } from "./mcp-servers.js";

test("Claude Code の設定をそのまま貼れる", () => {
  const [d] = fromMcpServers({
    mcpServers: {
      github: {
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-github"],
        env: { GITHUB_TOKEN: "ghp_xxx" },
      },
    },
  });
  assert.equal(d!.name, "github");
  assert.equal(d!.launch.command, "npx");
  assert.deepEqual(d!.launch.args, ["-y", "@modelcontextprotocol/server-github"]);
  // **貼り付けたものは必ず閉じ込める**（外から繋ぐコードなので）
  const parsed = parseModuleDeclaration(d!, "test");
  assert.equal(parsed.meta.confinement?.root, "none", "閉じ込めが掛かっていない");
  assert.equal(parsed.meta.scope, "instance");
  assert.equal(parsed.meta.origin, "external");
});

test("この Project のフォルダを渡していれば、Project ごとになって根も付く", () => {
  const [d] = fromMcpServers({
    mcpServers: {
      files: { command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", "${projectRoot}"] },
    },
  });
  const parsed = parseModuleDeclaration(d!, "test");
  assert.equal(parsed.meta.scope, "project");
  assert.equal(parsed.meta.confinement?.root, "project");
});

test("URL に繋ぐ形は、まだ受けられないとはっきり言う（黙って無視しない）", () => {
  assert.throws(
    () => fromMcpServers({ mcpServers: { remote: { type: "http", url: "https://example.com/mcp" } } }),
    /URL に繋ぐ形/,
  );
  // type を書いていなくても、url があれば同じ
  assert.throws(() => fromMcpServers({ mcpServers: { r: { url: "https://example.com/mcp" } } }), McpServersError);
});

test("形が違えば、理由を言って止まる", () => {
  assert.throws(() => fromMcpServers({ servers: {} }), /"mcpServers" が要ります/);
  assert.throws(() => fromMcpServers({ mcpServers: { x: {} } }), /command が要ります/);
});

test("同梱の宣言を mcpServers の形にして、読み戻すと同じになる（往復）", () => {
  const parsed = DEFAULT_MODULE_DECLARATIONS.map((d) => parseModuleDeclaration(d, "default"));
  const file = toMcpServers(parsed.map((d) => ({ name: d.name, launch: d.launch, meta: d.meta })));

  // **他のクライアントが読める形**——中身はトップレベルの command/args/env
  const vault = file.mcpServers["vault-local"]!;
  assert.equal(vault.type, "stdio");
  assert.equal(typeof vault.command, "string");
  assert.ok(Array.isArray(vault.args));
  // **banto の追加は _meta に入る**（知らないクライアントは無視する）
  assert.ok(vault._meta?.["dev.banto/module"], "banto の申告が _meta に入っていない");

  const back = fromMcpServers(file);
  assert.deepEqual(
    back.map((d) => d.name).sort(),
    parsed.map((d) => d.name).sort(),
  );
  for (const d of back) {
    const before = parsed.find((p) => p.name === d.name)!;
    assert.deepEqual(d.launch, before.launch, `${d.name} の起動の指定が往復で変わった`);
    assert.deepEqual(parseModuleDeclaration(d, "roundtrip").meta, before.meta, `${d.name} の申告が往復で変わった`);
  }
});

test("止めてあることも往復する", () => {
  const file = toMcpServers([
    {
      name: "stopped",
      launch: { command: "/bin/sh", args: ["-c", "true"] },
      enabled: false,
      meta: { satisfies: [], dependsOn: [], isolation: "subprocess", confinement: { kind: "landlock", root: "none" } },
    },
  ]);
  assert.equal(file.mcpServers.stopped!.enabled, false);
});

// **MCP の共通形（`mcpServers`）で受け渡す**（決定・2026-09-16）。
// 仕様 §5.1 は最初から「独自形式を作らない。`mcpServers` 形に寄せる」と
// 決めていたのに、実装は banto 独自の形のままだった（規則8）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_MODULE_DECLARATIONS, parseModuleDeclaration,
  isRemoteLaunch,
  type ModuleLaunch,
  type StdioLaunch,
} from "./declaration.js";
import { McpServersError, fromMcpServers, toMcpServers } from "./mcp-servers.js";


/** **起動する形として読む**（`ModuleLaunch` は2つの形の union・2026-09-17）。 */
function stdio(launch: ModuleLaunch): StdioLaunch {
  assert.ok(!isRemoteLaunch(launch), "起動する形ではありません");
  return launch as StdioLaunch;
}

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
  assert.equal(stdio(d!.launch).command, "npx");
  assert.deepEqual(stdio(d!.launch).args, ["-y", "@modelcontextprotocol/server-github"]);
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

// **URL に繋ぐ形を受ける**（改訂・2026-09-17、ユーザー指示）。以前は断っていた。
test("URL に繋ぐ形を受ける——閉じ込めは付けない（掛からないものを付けたふりをしない）", () => {
  const [d] = fromMcpServers({
    mcpServers: { remote: { type: "http", url: "https://example.com/mcp", headers: { A: "1" } } },
  });
  assert.equal(d!.name, "remote");
  assert.deepEqual(d!.launch, { type: "http", url: "https://example.com/mcp", headers: { A: "1" } });
  // **閉じ込めは書かない**——プロセスがこちらに無いので掛からない。
  // 書くと「閉じ込めてある」と読まれる（規則13）
  assert.equal((d!.meta as { confinement?: unknown }).confinement, undefined);
  assert.equal((d!.meta as { scope?: string }).scope, "instance");

  // type を書いていなくても、url があれば同じ（`mcpServers` の慣習）
  const [inferred] = fromMcpServers({ mcpServers: { r: { url: "https://example.com/mcp" } } });
  assert.equal((inferred!.launch as { type?: string }).type, "http");

  // 知らない繋ぎ方は、理由を言って断る（規則2）
  assert.throws(
    () => fromMcpServers({ mcpServers: { x: { type: "sse", url: "https://example.com" } } }),
    /知らない繋ぎ方/,
  );
  assert.throws(() => fromMcpServers({ mcpServers: { x: { type: "http" } } }), /url が要ります/);
});

test("URL に繋ぐ形も、そのまま取り出せる（往復）", () => {
  const before = fromMcpServers({
    mcpServers: { remote: { type: "http", url: "https://example.com/mcp", headers: { A: "1" } } },
  });
  const after = fromMcpServers(toMcpServers(before));
  assert.deepEqual(after, before);
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

// Module の自己申告を読み、宣言（Config）と突き合わせる（決定・2026-09-06）。
// 4本の Module すべてが**実際に名乗るか**を、本物のプロセスを立てて確かめる
// ——「名乗る仕組みを作った」で終わらせない（規則1）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { classifyMetaDifference, parseModuleMeta } from "@banto/module-contract";
import { readSelfReportedMeta } from "./selfreport.js";
import { DEFAULT_MODULE_DECLARATIONS, parseModuleDeclaration } from "./declaration.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const modulesDir = join(__dirname, "..", "..", "..", "modules");

async function withModule(command: string, args: string[], env: Record<string, string>, fn: (c: Client) => Promise<void>) {
  const client = new Client({ name: "selfreport-test", version: "0.0.0" }, { capabilities: { elicitation: {} } });
  await client.connect(new StdioClientTransport({ command, args, env: { ...process.env, ...env } as Record<string, string> }));
  try {
    await fn(client);
  } finally {
    await client.close();
  }
}

for (const name of ["vault", "shell", "filesystem"] as const) {
  test(`${name} は自分が何者かを名乗り、同梱の宣言と食い違わない`, async () => {
    const declaration = parseModuleDeclaration(
      DEFAULT_MODULE_DECLARATIONS.find((d) => d.name === name)!,
      "default",
    );
    await withModule(
      process.execPath,
      [join(modulesDir, name, "dist", "server.js")],
      {
        BANTO_PROJECT_ROOT: "/tmp",
        BANTO_VAULT_DATA_DIR: "/tmp/banto-selfreport-vault",
        BANTO_HOST_MCP_URL: "http://127.0.0.1:1/relay",
        BANTO_HOST_MCP_TOKEN: "unused",
      },
      async (client) => {
        const reported = await readSelfReportedMeta(client);
        assert.ok(reported, `${name} が名乗っていない`);
        const diff = classifyMetaDifference(declaration.meta, reported);
        assert.deepEqual(
          diff,
          { stricter: [], looser: [], other: [] },
          `${name}: 同梱の宣言と自己申告が食い違っている ${JSON.stringify(diff)}`,
        );
      },
    );
  });
}

test("TypeScript でない Module（Python）も同じ形で名乗る", async (t) => {
  const python = join(modulesDir, "python-demo", ".venv", "bin", "python");
  if (!existsSync(python)) return t.skip("python-demo の venv が無い");
  await withModule(python, [join(modulesDir, "python-demo", "server.py")], {}, async (client) => {
    const reported = await readSelfReportedMeta(client);
    assert.ok(reported, "python-demo が名乗っていない");
    assert.deepEqual(reported.satisfies, ["demo"]);
    assert.equal(reported.scope, "instance");
  });
});

test("名乗っていない Module は undefined（黙って通す——名乗りは任意）", async () => {
  const python = join(modulesDir, "python-demo", ".venv", "bin", "python");
  // 名乗らない Module の代わりに、resources を持たない最小の相手を立てる
  await withModule(process.execPath, ["-e", `
    const { Server } = await import("@modelcontextprotocol/sdk/server/index.js");
    const { StdioServerTransport } = await import("@modelcontextprotocol/sdk/server/stdio.js");
    const s = new Server({ name: "silent", version: "0.0.0" }, { capabilities: {} });
    await s.connect(new StdioServerTransport());
  `], {}, async (client) => {
    assert.equal(await readSelfReportedMeta(client), undefined);
  });
  void python;
});

test("同梱の宣言と、より緩い申告を突き合わせると looser として拾う", () => {
  const declared = parseModuleDeclaration(
    DEFAULT_MODULE_DECLARATIONS.find((d) => d.name === "filesystem")!,
    "default",
  ).meta;
  const lying = parseModuleMeta(
    { satisfies: ["filesystem"], dependsOn: [], isolation: "subprocess", scope: "instance" },
    "lying",
  );
  const diff = classifyMetaDifference(declared, lying);
  assert.ok(diff.looser.includes("confinement"), "閉じ込め無しの申告を緩いと判定していない");
  assert.ok(diff.looser.includes("scope"));
});

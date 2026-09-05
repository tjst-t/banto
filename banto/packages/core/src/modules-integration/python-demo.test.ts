// 要件C6「TypeScriptでないModuleが1本、実際に動いている」の実測。
// Python製MCPサーバに、TypeScript製のClientから実際に接続してtoolを呼ぶ。

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pythonDemoDir = join(__dirname, "..", "..", "..", "modules", "python-demo");
const pythonBin = join(pythonDemoDir, ".venv", "bin", "python");
const serverScript = join(pythonDemoDir, "server.py");

test("a non-TypeScript (Python) Module speaks the same MCP contract", { skip: !existsSync(pythonBin) }, async () => {
  const transport = new StdioClientTransport({ command: pythonBin, args: [serverScript] });
  const client = new Client({ name: "test-host", version: "0.0.0" });
  await client.connect(transport);

  const { tools } = await client.listTools();
  assert.ok(tools.some((t) => t.name === "echo"));

  const result = await client.callTool({ name: "echo", arguments: { text: "hello from TS" } });
  const text = (result.content as { type: string; text: string }[])[0]?.text;
  assert.equal(text, "echo: hello from TS");

  await client.close();
});

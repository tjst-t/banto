// 30秒のプローブ：banto の Module（FileSystem）をコンテナの中で起こし、ホストから標準入出力の MCP で話す。
// usage: sg incus -c "node module-stdio.mjs <container> <projectRoot>"
import { createRequire } from "node:module";
const require = createRequire("/home/ubuntu/worktrees/banto-v4/banto/packages/core/package.json");
const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { StdioClientTransport } = require("@modelcontextprotocol/sdk/client/stdio.js");
const [ctr = "poc9", root = "/home/ubuntu/poc9-project"] = process.argv.slice(2);
const B = "/home/ubuntu/worktrees/banto-v4/banto";
const t0 = Date.now();
const transport = new StdioClientTransport({
  command: "incus",
  args: ["exec", ctr, "--user", "1000", "--group", "1000", "--cwd", root, "--env", `BANTO_PROJECT_ROOT=${root}`, "--env", "HOME=/home/ubuntu",
    "--", "/usr/local/bin/node", `${B}/packages/modules/filesystem/dist/server.js`],
  stderr: "pipe",
});
const client = new Client({ name: "poc9", version: "0.0.0" });
await client.connect(transport);
const t1 = Date.now();
const tools = (await client.listTools()).tools.map((t) => t.name);
console.log("接続まで", t1 - t0, "ms / tools:", tools.slice(0, 8).join(", "), tools.length > 8 ? `…(${tools.length})` : "");
const list = await client.callTool({ name: "listDirectory", arguments: { path: root } }).catch((e) => ({ error: String(e) }));
console.log("listDirectory:", JSON.stringify(list).slice(0, 300));
const outside = await client.callTool({ name: "readFile", arguments: { path: "/home/ubuntu/.claude/.credentials.json" } }).catch((e) => ({ error: String(e) }));
console.log("根の外を読む:", JSON.stringify(outside).slice(0, 200));
await client.close();

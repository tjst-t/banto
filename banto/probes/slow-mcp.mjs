// http（Streamable HTTP）の MCP サーバ。長い tool を1本だけ持つ（slow_task：seconds 秒待って返す）
import { createServer } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

export async function startSlowMcp({ log = () => {} } = {}) {
  const http = createServer(async (req, res) => {
    // 状態を持たない形：要求ごとにサーバと transport を作る
    const server = new McpServer({ name: "slow", version: "0.0.1" });
    server.registerTool(
      "slow_task",
      { description: "seconds 秒かかる仕事", inputSchema: { seconds: z.number() } },
      async ({ seconds }, extra) => {
        log(`slow_task 開始（${seconds}秒）`);
        const done = await new Promise((resolve) => {
          const t = setTimeout(() => resolve(true), seconds * 1000);
          extra.signal.addEventListener("abort", () => (clearTimeout(t), resolve(false)));
          res.on("close", () => (clearTimeout(t), resolve(false)));
        });
        log(done ? "slow_task 完了" : "slow_task 中断（接続が切れた／取り消された）");
        return { content: [{ type: "text", text: done ? `slept ${seconds}s` : "aborted" }] };
      },
    );
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      transport.close();
      server.close();
    });
    await server.connect(transport);
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : undefined;
    await transport.handleRequest(req, res, body);
  });
  await new Promise((r) => http.listen(0, "127.0.0.1", r));
  return {
    url: `http://127.0.0.1:${http.address().port}/mcp`,
    close: () => new Promise((r) => (http.closeAllConnections?.(), http.close(() => r()))),
  };
}

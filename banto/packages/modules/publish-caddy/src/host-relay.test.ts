// host の中継に繋ぐ口（`HostRelay`）の試験。**繋いだ後にセッションが切れても、次の呼び出しで繋ぎ直す**
// （2026-09-28、Fable のレビュー——以前は繋げなかったときだけ忘れ、繋いだ後の切断は Module を起こし直すまで覚え続けた）。

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { HostRelay } from "./host-relay.js";

/** host の中継の口を真似る。`sessions.clear()` で「host がセッションを失った」を作れる */
async function fakeHost(answer: (projectId: string) => unknown) {
  const sessions = new Map<string, StreamableHTTPServerTransport>();
  let opened = 0;
  const http = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const sid = req.headers["mcp-session-id"] as string | undefined;
      let transport = sid ? sessions.get(sid) : undefined;
      if (sid && !transport) {
        res.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32001, message: "Session not found" }, id: null }));
        return;
      }
      if (!transport) {
        const server = new Server({ name: "fake-host", version: "0" }, { capabilities: { tools: {} } });
        server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [] }));
        server.setRequestHandler(CallToolRequestSchema, async (request) => {
          const projectId = String((request.params.arguments as { projectId?: unknown }).projectId);
          const a = answer(projectId);
          if (a instanceof Error) throw a;
          return { content: [{ type: "text", text: JSON.stringify(a) }] };
        });
        const t: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (id) => {
            opened++;
            sessions.set(id, t);
          },
        });
        await server.connect(t);
        transport = t;
      }
      await transport.handleRequest(req, res);
    })();
  });
  await new Promise<void>((r) => http.listen(0, "127.0.0.1", r));
  return {
    url: `http://127.0.0.1:${(http.address() as AddressInfo).port}/relay`,
    sessions,
    opened: () => opened,
    close: () =>
      new Promise<void>((r) => {
        // 中継の client は SSE の待ち受けを開いたままにするので、繋がりごと閉じる
        http.closeAllConnections();
        http.close(() => r());
      }),
  };
}

test("繋いだ後に host がセッションを失っても、次の呼び出しで繋ぎ直す。host の口の断りでは繋ぎ直さない", async () => {
  const host = await fakeHost((projectId) =>
    projectId === "gone"
      ? { unavailable: "コンテナは動いていません（Stopped）" }
      : projectId === "refuse"
        ? new Error("publish-x は Project のアドレスを引けません")
        : { address: "10.61.162.23" },
  );
  const relay = new HostRelay(host.url, "token");
  try {
    assert.deepEqual(await relay.projectAddress("pA"), { address: "10.61.162.23" });
    // 確かに届かないは値で返る（投げない）
    assert.deepEqual(await relay.projectAddress("gone"), { unavailable: "コンテナは動いていません（Stopped）" });
    // host の口が理由つきで断ったもの——繋ぎ直しても同じなので、同じセッションのまま
    await assert.rejects(() => relay.projectAddress("refuse"), /引けません/);
    assert.equal(host.opened(), 1, "口の断りで繋ぎ直した");

    // host がセッションを失った（通信の途切れ・host 側の片付け）——その回は失敗する
    host.sessions.clear();
    await assert.rejects(() => relay.projectAddress("pA"));
    // 次の呼び出しでは繋ぎ直して答えが返る
    assert.deepEqual(await relay.projectAddress("pA"), { address: "10.61.162.23" }, "切れたセッションを覚え続けている");
    assert.equal(host.opened(), 2);
  } finally {
    await host.close();
  }
});

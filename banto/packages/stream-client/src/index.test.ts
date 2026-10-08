// 画面の側の共通部品（アーキ仕様 §5.8「切れたとき」）。Node の WebSocket で、本物の待ち受け（ws）に繋ぐ。
// 見るもの：札を頼んで最初の1通で送る・切れたら札を取り直して繋ぎ直す（最初は 1 秒）・4404 で止める・close で止める
import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { WebSocketServer, type WebSocket as ServerSocket } from "ws";
import { openStream, STREAM_CLIENT_SCRIPT, type StreamState } from "./index.js";

async function withServer(fn: (h: { url: string; sockets: ServerSocket[]; firstMessages: string[] }) => Promise<void>) {
  const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await new Promise<void>((resolve) => wss.once("listening", () => resolve()));
  const url = `ws://127.0.0.1:${(wss.address() as AddressInfo).port}/api/streams`;
  const sockets: ServerSocket[] = [];
  const firstMessages: string[] = [];
  wss.on("connection", (ws) => {
    sockets.push(ws);
    ws.once("message", (data) => {
      firstMessages.push(data.toString());
      ws.on("message", (d, isBinary) => ws.send(d, { binary: isBinary }));
      ws.send("ready");
    });
  });
  try {
    await fn({ url, sockets, firstMessages });
  } finally {
    for (const ws of wss.clients) ws.terminate();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
  }
}

const until = async (cond: () => boolean, ms = 5000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("待っても条件が成り立たない");
    await new Promise((r) => setTimeout(r, 10));
  }
};

test("札を頼み、最初の1通で送る。切れたら札を取り直して繋ぎ直し、4404 で止まる", async () => {
  await withServer(async ({ url, sockets, firstMessages }) => {
    const asked: unknown[] = [];
    let n = 0;
    const bridge = {
      async request(method: string, params: Record<string, unknown>) {
        asked.push({ method, params });
        n += 1;
        return { url, ticket: `t${n}`, expiresAt: "" };
      },
    };
    const states: StreamState[] = [];
    const got: Array<string | ArrayBuffer> = [];
    const stream = openStream(bridge, { name: "echo", params: { a: 1 }, onState: (s) => states.push(s), onMessage: (d) => got.push(d) });
    await until(() => got.includes("ready"));
    assert.deepEqual(asked[0], { method: "dev.banto/stream/open", params: { name: "echo", params: { a: 1 } } });
    assert.deepEqual(firstMessages, [JSON.stringify({ ticket: "t1" })]);
    assert.equal(stream.state, "open");
    assert.equal(stream.send(new Uint8Array([1, 2, 3])), true);
    await until(() => got.some((d) => d instanceof ArrayBuffer));
    assert.deepEqual([...new Uint8Array(got.find((d) => d instanceof ArrayBuffer) as ArrayBuffer)], [1, 2, 3]);

    // host が起こし直しで切った → 1 秒後に新しい札で繋ぎ直す
    const cutAt = Date.now();
    sockets[0]!.close(1012, "起こし直し");
    await until(() => firstMessages.length === 2, 4000);
    assert.ok(Date.now() - cutAt >= 900, "すぐに繋ぎ直した（1 秒待っていない）");
    assert.equal(firstMessages[1], JSON.stringify({ ticket: "t2" }));
    assert.ok(states.includes("reconnecting"));
    await until(() => stream.state === "open");

    // Module が「もう無い」→ 止まって、もう頼まない
    sockets[1]!.close(4404, "もう無い");
    await until(() => stream.state === "ended");
    await new Promise((r) => setTimeout(r, 1300));
    assert.equal(firstMessages.length, 2);
    assert.equal(stream.send("x"), false);
  });
});

test("札を頼めなかったら待って試し直す。close で止まる", async () => {
  let calls = 0;
  const details: Array<{ reason?: string; retryInMs?: number }> = [];
  const stream = openStream(
    { request: async () => { calls += 1; throw new Error("banto を起こし直しています"); } },
    { name: "echo", onState: (_s, d) => details.push(d) },
  );
  await until(() => calls === 1);
  await until(() => details.some((d) => d.retryInMs === 1000));
  assert.equal(details.find((d) => d.retryInMs === 1000)?.reason, "banto を起こし直しています");
  stream.close();
  assert.equal(stream.state, "ended");
  await new Promise((r) => setTimeout(r, 1200));
  assert.equal(calls, 1);
});

test("素の JavaScript に埋め込む形は、同じ関数を定義する", () => {
  assert.match(STREAM_CLIENT_SCRIPT, /^const openStream = function openStream\(bridge, options\)/);
  const make = new Function(`${STREAM_CLIENT_SCRIPT}; return openStream;`) as () => unknown;
  assert.equal(typeof make(), "function");
});

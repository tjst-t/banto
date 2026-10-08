#!/usr/bin/env node
// **試験用の Module：画面と Module の間の流れのこだま**（追加・2026-10-08、アーキ仕様 §5.8）。
//
// - 入口の画面（`ui://stream-echo/main`）が流れ「echo」を名乗る（`dev.banto/streams`）
// - 待ち受けは共通の部品（`@banto/stream-server`）、画面の側も共通の部品（`@banto/stream-client` を埋め込む）
// - 流れ1本ごとに：繋がったら挨拶（文字の JSON：何本目か・この Module の起動の印・刻印の中身）。文字が来たら
//   `echo:<中身>` を返す。2進が来たら、受け取った大きさと SHA-256 を文字で返してから、同じ2進をそのまま返す
// - 流れごとに別の相手——ほかの流れには何も送らない（同じ名前の流れが2本あっても混ざらないことを見る）
//
// MCP は stdio の JSON-RPC を手で書く（`ask-human-module` と同じ。依存を足さない）

import { createHash, randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import { listenStreams } from "@banto/stream-server";
import { STREAM_CLIENT_SCRIPT } from "@banto/stream-client";

const URI = "ui://stream-echo/main";
const MIME = "text/html;profile=mcp-app";
const BOOT = randomUUID().slice(0, 8);
let count = 0;

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

const server = await listenStreams({
  echo(ws, stamp) {
    count += 1;
    const id = count;
    ws.send(JSON.stringify({ type: "hello", id, boot: BOOT, stamp }));
    ws.on("message", (data, isBinary) => {
      if (isBinary) {
        ws.send(JSON.stringify({ type: "binary-received", bytes: data.length, sha256: sha256(data) }));
        ws.send(data, { binary: true });
        return;
      }
      ws.send(`echo:${data.toString("utf8")}`);
    });
  },
});
process.stderr.write(`[stream-echo] 待ち受け ${server.path}（起動の印 ${BOOT}）\n`);

const HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>流れのこだま</title>
<style>body{font:13px system-ui;margin:12px} li{font-family:monospace} button{margin-right:6px}</style></head>
<body>
<div>状態：<span id="state" data-state="connecting">connecting</span></div>
<div>挨拶：<span id="hello" data-testid="hello"></span></div>
<div>閉じた番号：<span id="closes"></span></div>
<div><input id="text" /><button id="send">送る</button><button id="big">大きい2進を送る</button><button id="too-big">1MiB を越える1通を送る</button></div>
<div>送った2進：<span id="big-sent"></span></div>
<div>Module が受け取った2進：<span id="big-at-module"></span></div>
<div>返ってきた2進：<span id="big-back"></span></div>
<ul id="log"></ul>
<script>
${STREAM_CLIENT_SCRIPT}
(() => {
  let nextId = 1;
  const waiting = new Map();
  const send = (m) => window.parent.postMessage(Object.assign({ jsonrpc: "2.0" }, m), "*");
  const request = (method, params) => {
    const id = nextId++;
    send({ id, method, params });
    return new Promise((resolve, reject) => waiting.set(id, { resolve, reject }));
  };
  window.addEventListener("message", (event) => {
    const msg = event.data;
    if (!msg || msg.jsonrpc !== "2.0" || msg.id === undefined || !waiting.has(msg.id)) return;
    const w = waiting.get(msg.id); waiting.delete(msg.id);
    if (msg.error) w.reject(new Error(msg.error.message || "失敗しました")); else w.resolve(msg.result);
  });
  const $ = (id) => document.getElementById(id);
  const hex = async (buf) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", buf))].map((b) => b.toString(16).padStart(2, "0")).join("");
  const closes = [];
  let stream;

  (async () => {
    await request("ui/initialize", { protocolVersion: "2026-01-26", appInfo: { name: "stream-echo", version: "0.0.0" }, appCapabilities: {} });
    send({ method: "ui/notifications/initialized", params: {} });
    stream = openStream({ request }, {
      name: "echo",
      params: { greeting: "こんにちは" },
      onState(state, detail) {
        $("state").textContent = state + (detail.reason ? "（" + detail.reason + "）" : "");
        $("state").dataset.state = state;
        if (detail.code !== undefined) { closes.push(detail.code); $("closes").textContent = closes.join(","); }
      },
      async onMessage(data) {
        if (typeof data !== "string") {
          $("big-back").textContent = data.byteLength + ":" + (await hex(data));
          return;
        }
        if (data.startsWith("{")) {
          const m = JSON.parse(data);
          if (m.type === "hello") {
            $("hello").textContent = "#" + m.id + " " + m.boot + " " + m.stamp.name + " " + JSON.stringify(m.stamp.params) + " human=" + m.stamp.human + " project=" + (m.stamp.projectId ? "yes" : "no");
            $("hello").dataset.boot = m.boot;
            $("hello").dataset.id = String(m.id);
          }
          if (m.type === "binary-received") $("big-at-module").textContent = m.bytes + ":" + m.sha256;
          return;
        }
        const li = document.createElement("li");
        li.textContent = data;
        $("log").append(li);
      },
    });
  })();

  const pattern = (n) => { const b = new Uint8Array(n); for (let i = 0; i < n; i++) b[i] = (i * 31 + 7) & 255; return b; };
  $("send").onclick = () => { if (stream && stream.send($("text").value)) $("text").value = ""; };
  $("big").onclick = async () => {
    const buf = pattern(900 * 1024);
    $("big-sent").textContent = buf.byteLength + ":" + (await hex(buf));
    stream.send(buf);
  };
  $("too-big").onclick = () => stream.send(pattern(1024 * 1024 + 1));
})();
</script>
</body></html>`;

const out = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const reply = (id, result) => out({ jsonrpc: "2.0", id, result });
const fail = (id, code, message) => out({ jsonrpc: "2.0", id, error: { code, message } });

createInterface({ input: process.stdin }).on("line", (line) => {
  const text = line.trim();
  if (text === "") return;
  let msg;
  try {
    msg = JSON.parse(text);
  } catch {
    return;
  }
  if (msg.id === undefined) return;
  switch (msg.method) {
    case "initialize":
      reply(msg.id, {
        protocolVersion: "2025-06-18",
        capabilities: { tools: {}, resources: {} },
        serverInfo: { name: "banto-e2e-stream-echo", version: "0.0.0" },
      });
      return;
    case "ping":
      reply(msg.id, {});
      return;
    case "tools/list":
      reply(msg.id, { tools: [] });
      return;
    case "resources/list":
      reply(msg.id, {
        resources: [
          {
            uri: URI,
            name: "流れのこだま（試験）",
            description: "画面と Module の間の流れを試す",
            mimeType: MIME,
            _meta: { "dev.banto/canvas": "launcher", "dev.banto/streams": ["echo"], "dev.banto/visibility": "admin" },
          },
        ],
      });
      return;
    case "resources/read":
      if (msg.params?.uri !== URI) {
        fail(msg.id, -32602, `知らない資源です: ${msg.params?.uri}`);
        return;
      }
      reply(msg.id, { contents: [{ uri: URI, mimeType: MIME, text: HTML }] });
      return;
    default:
      fail(msg.id, -32601, `Method not found: ${msg.method}`);
  }
});

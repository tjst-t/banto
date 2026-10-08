#!/usr/bin/env node
// **試験用のページ**（単体の試験と E2E が相手にする小さな HTTP サーバ）。E2E は Project のコンテナの中でこれを
// そのまま走らせる（`node test-page.js <port>`）——開発中のアプリを localhost で開くのと同じ形で試すため。
//
// 開くと：Cookie を置き（Set-Cookie。期限つき——期限の無い Cookie はブラウザを閉じると消えるのがブラウザの決まり）、200・500・届かない要求（安全でないポート 9 番）を出し、Authorization 付きの
// 要求も出し、console.error を出す。WebSocket（1フレーム受けて返す）と EventSource（1件）も開く。
// 「例外を出す」ボタンは捕まえない例外を投げる。

import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { Duplex } from "node:stream";

export const TEST_COOKIE = "session=cookie-secret-value-123";
export const TEST_TOKEN = "Bearer token-secret-value-456";
export const TEST_TITLE = "Browser 試験のページ";

const PAGE = `<!doctype html>
<html lang="ja"><head><meta charset="utf-8"><title>${TEST_TITLE}</title></head>
<body>
<h1>試験のページ</h1>
<label>名前 <input id="name" aria-label="名前"></label>
<label>色 <select aria-label="色"><option value="red">赤</option><option value="blue">青</option></select></label>
<button id="send">送る</button>
<button id="boom">例外を出す</button>
<p id="out">まだ</p>
<a href="/second">2ページ目へ</a>
<script>
const auth = { headers: { authorization: ${JSON.stringify(TEST_TOKEN)} } };
fetch('/api/ok', auth).then((r) => r.json()).then((j) => { document.getElementById('out').textContent = 'ok:' + j.ok; });
fetch('/api/fail').catch(() => {});
fetch('http://127.0.0.1:9/unreachable').catch(() => {});
console.error('試験のエラー: ' + 'わざと出した');
document.getElementById('send').addEventListener('click', () => {
  const name = document.getElementById('name').value;
  fetch('/api/echo', { method: 'POST', headers: { 'content-type': 'application/json', authorization: ${JSON.stringify(TEST_TOKEN)} }, body: JSON.stringify({ name }) })
    .then((r) => r.json()).then((j) => { document.getElementById('out').textContent = '送った:' + j.name; });
});
document.getElementById('boom').addEventListener('click', () => { throw new Error('試験の例外'); });
const ws = new WebSocket('ws://' + location.host + '/ws');
ws.onopen = () => ws.send('ping-from-page');
const es = new EventSource('/events');
es.onmessage = () => es.close();
</script>
</body></html>`;

/** 文字のフレーム1つ（サーバ→ページ。マスクしない） */
function wsTextFrame(text: string): Buffer {
  const payload = Buffer.from(text);
  if (payload.length >= 126) throw new Error("試験のフレームは短いものだけ");
  return Buffer.concat([Buffer.from([0x81, payload.length]), payload]);
}

export function createTestPageServer(): Server {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    switch (url.pathname) {
      case "/":
        res.setHeader("set-cookie", `${TEST_COOKIE}; Path=/; Max-Age=86400; SameSite=Lax`);
        res.setHeader("content-type", "text/html; charset=utf-8");
        res.end(PAGE);
        return;
      case "/second":
        res.setHeader("content-type", "text/html; charset=utf-8");
        res.end(`<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>2ページ目</title></head><body><h1>2ページ目</h1></body></html>`);
        return;
      case "/api/ok":
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ ok: true, cookie: req.headers.cookie ? "あり" : "なし" }));
        return;
      case "/api/fail":
        res.statusCode = 500;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ error: "わざと失敗" }));
        return;
      case "/api/echo": {
        let body = "";
        req.on("data", (c: Buffer) => (body += c.toString()));
        req.on("end", () => {
          res.setHeader("content-type", "application/json");
          res.end(body || "{}");
        });
        return;
      }
      case "/events":
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
        res.end("data: tick-1\n\n");
        return;
      default:
        res.statusCode = 404;
        res.end("not found");
    }
  });
  server.on("upgrade", (req, socket: Duplex) => {
    const key = req.headers["sec-websocket-key"];
    if (typeof key !== "string") return socket.destroy();
    const accept = createHash("sha1").update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    socket.write(wsTextFrame("hello-from-server"));
    socket.on("error", () => undefined); // ページが閉じると切れる——試験のサーバなので構わない
  });
  return server;
}

if (process.argv[1] && process.argv[1].endsWith("test-page.js")) {
  const port = Number(process.argv[2] ?? 0);
  const server = createTestPageServer();
  server.listen(port, "127.0.0.1", () => {
    const address = server.address();
    console.log(`listening ${typeof address === "object" && address ? address.port : port}`);
  });
}

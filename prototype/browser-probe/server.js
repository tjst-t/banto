// 試験対象ローカルサーバ。Node標準 + ws のみ。
// 起動: NODE_PATH="/home/ubuntu/ghq/github.com/tjst-t/banto/node_modules" node server.js [port]
const http = require("node:http");
const crypto = require("node:crypto");
const { WebSocketServer } = require("ws");

const PORT = Number(process.argv[2] || 0);

const PNG_1PX = Buffer.from(
  "89504e470d0a1a0a0000000d4948445200000001000000010802000000907753de0000000c4944415478da6360606060000000050001a5f645400000000049454e44ae426082",
  "hex",
);

const HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>probe2</title></head>
<body>
<h1>browser-probe2 test page</h1>
<div id="out"></div>
<script>
navigator.serviceWorker && navigator.serviceWorker.register('/sw.js').catch(e => console.error('sw register failed', e));
</script>
</body></html>
`;

const SW_JS = `
// service worker: fetch をフックして /api/echo を自分で叩く
self.addEventListener('install', (e) => { self.skipWaiting(); });
self.addEventListener('activate', (e) => { e.waitUntil(self.clients.claim()); });
self.addEventListener('fetch', (event) => {
  if (event.request.url.includes('/sw-trigger')) {
    event.respondWith((async () => {
      const r = await fetch('/api/echo?from=service-worker', {
        headers: { 'x-from-sw': '1' },
      });
      const body = await r.text();
      return new Response(body, { headers: { 'content-type': 'application/json' } });
    })());
  }
});
`;

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { "content-type": "application/json" });
  res.end(body);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  const pathname = url.pathname;

  if (pathname === "/") {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(HTML);
    return;
  }

  if (pathname === "/sw.js") {
    res.writeHead(200, { "content-type": "application/javascript" });
    res.end(SW_JS);
    return;
  }

  if (pathname === "/api/echo") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      if (url.searchParams.get("setcookie") === "1") {
        res.setHeader("set-cookie", ["probe=set-by-server; Path=/", "second=another; Path=/"]);
      }
      sendJson(res, 200, {
        method: req.method,
        url: req.url,
        query: Object.fromEntries(url.searchParams.entries()),
        headers: req.headers,
        body,
      });
    });
    return;
  }

  if (pathname === "/api/slow") {
    res.writeHead(200, { "content-type": "text/plain", "transfer-encoding": "chunked" });
    let n = 0;
    const iv = setInterval(() => {
      n++;
      res.write(`chunk-${n} ${"x".repeat(20)}\n`);
      if (n >= 6) {
        clearInterval(iv);
        res.end("done\n");
      }
    }, 500);
    return;
  }

  if (pathname === "/api/big") {
    // 10MB の JSON
    const target = 10 * 1024 * 1024;
    const unit = "0123456789abcdef"; // 16 bytes per item incl separators approx
    const itemsNeeded = Math.ceil(target / 20);
    const arr = new Array(itemsNeeded).fill(unit);
    const payload = JSON.stringify({ size: "10MB-ish", data: arr });
    res.writeHead(200, {
      "content-type": "application/json",
      "content-length": Buffer.byteLength(payload),
    });
    res.end(payload);
    return;
  }

  if (pathname === "/api/image") {
    res.writeHead(200, { "content-type": "image/png", "content-length": PNG_1PX.length });
    res.end(PNG_1PX);
    return;
  }

  if (pathname === "/api/redirect") {
    res.writeHead(302, { location: "/api/echo?redirected=1" });
    res.end();
    return;
  }

  if (pathname === "/sse") {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    let n = 0;
    const iv = setInterval(() => {
      n++;
      res.write(`id: ${n}\ndata: ${JSON.stringify({ n, ts: Date.now() })}\n\n`);
      if (n >= 5) {
        clearInterval(iv);
        res.end();
      }
    }, 1000);
    req.on("close", () => clearInterval(iv));
    return;
  }

  sendJson(res, 404, { error: "not found", pathname });
});

const wss = new WebSocketServer({ server, path: "/ws" });
wss.on("connection", (ws) => {
  ws.send(JSON.stringify({ hello: "from-server" }));
  ws.on("message", (data, isBinary) => {
    if (isBinary) {
      ws.send(data, { binary: true });
    } else {
      ws.send(`echo:${data.toString()}`);
    }
  });
  // サーバ側からも定期送信
  const iv = setInterval(() => {
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify({ serverPush: crypto.randomUUID() }));
    } else {
      clearInterval(iv);
    }
  }, 700);
  ws.on("close", () => clearInterval(iv));
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`LISTENING ${server.address().port}`);
});

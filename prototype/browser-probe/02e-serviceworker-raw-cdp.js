// Q2(f)続き: Target.setAutoAttach(flatten:true) + sessionId付きコマンドで
// service worker自身のターゲットにNetwork.enableを張れるかを、生のCDP(wsパッケージ)で確定させる。
// PlaywrightのCDPSession高レベルAPIはページ/フレームにしか newCDPSession できず、
// child target(worker)へのsessionIdルーティングを公開していないため、素のwebsocketで検証する。
const http = require("node:http");
const { WebSocket } = require("ws");
const { startServer, stopServer } = require("./lib.js");
const { chromium } = require("playwright");

function httpGetJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve(JSON.parse(body)));
    }).on("error", reject);
  });
}

(async () => {
  const s = await startServer();
  const base = `http://127.0.0.1:${s.port}`;

  const REMOTE_PORT = 19222;
  const browser = await chromium.launch({
    headless: true,
    args: [`--remote-debugging-port=${REMOTE_PORT}`],
  });

  await new Promise((r) => setTimeout(r, 300));
  const version = await httpGetJson(`http://127.0.0.1:${REMOTE_PORT}/json/version`);
  const wsUrl = version.webSocketDebuggerUrl;

  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });

  let msgId = 1;
  const pending = new Map();
  const allMessages = [];
  function send(method, params = {}, sessionId) {
    const id = msgId++;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    ws.send(JSON.stringify(payload));
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject, method });
    });
  }
  ws.on("message", (raw) => {
    const msg = JSON.parse(raw.toString());
    allMessages.push(msg);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(JSON.stringify(msg.error)));
      else resolve(msg.result);
    }
  });

  const workerNetworkEvents = [];
  const attachedSessions = [];
  ws.on("message", (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.method === "Target.attachedToTarget") {
      attachedSessions.push(msg.params);
    }
    if (msg.method && msg.method.startsWith("Network.") && msg.sessionId) {
      workerNetworkEvents.push({ sessionId: msg.sessionId, method: msg.method, params: msg.params });
    }
  });

  // 新規ターゲット(worker含む)に自動アタッチ。flatten:trueでsessionId付きルーティングを使う。
  await send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
  await send("Target.setDiscoverTargets", { discover: true });

  // 通常のページを開いてservice workerを登録させる
  const targetResult = await send("Target.createTarget", { url: `${base}/` });
  const pageTargetId = targetResult.targetId;

  // ページ自身のtargetにattach(flatten)してNetwork.enableし、SW登録+トリガーの操作をEvaluateする必要がある。
  const pageAttach = await send("Target.attachToTarget", { targetId: pageTargetId, flatten: true });
  const pageSessionId = pageAttach.sessionId;
  await send("Network.enable", {}, pageSessionId);
  await send("Page.enable", {}, pageSessionId);
  await send("Runtime.enable", {}, pageSessionId);

  // service worker登録完了を待つ(最大5秒ポーリング)
  let swSessionId = null;
  for (let i = 0; i < 50; i++) {
    const found = attachedSessions.find((a) => a.targetInfo.type === "service_worker");
    if (found) {
      swSessionId = found.sessionId;
      break;
    }
    await new Promise((r) => setTimeout(r, 100));
  }

  let swNetworkEnableResult = null;
  if (swSessionId) {
    try {
      swNetworkEnableResult = await send("Network.enable", {}, swSessionId);
    } catch (e) {
      swNetworkEnableResult = { error: e.message };
    }
  }

  // ページからservice worker経由のfetchをトリガー
  await send(
    "Runtime.evaluate",
    { expression: `fetch('/sw-trigger').then(r => r.text())`, awaitPromise: true, returnByValue: true },
    pageSessionId,
  );

  await new Promise((r) => setTimeout(r, 800));

  const swScopedRequests = workerNetworkEvents.filter(
    (e) => e.sessionId === swSessionId && e.method === "Network.requestWillBeSent",
  );

  const result = {
    attachedTargetTypes: attachedSessions.map((a) => a.targetInfo.type),
    swSessionFound: !!swSessionId,
    swNetworkEnableResult,
    swScopedRequestWillBeSentCount: swScopedRequests.length,
    swScopedRequestUrls: swScopedRequests.map((e) => e.params.request.url),
  };

  ws.close();
  await browser.close();
  stopServer(s);
  console.log(JSON.stringify(result, null, 2));
})().catch((e) => {
  console.error("FAILED:", e.stack || e.message);
  process.exit(1);
});

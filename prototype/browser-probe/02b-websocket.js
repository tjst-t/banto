// Q2(d): WebSocket。webSocketCreated / webSocketFrameSent / webSocketFrameReceived / webSocketFrameError
// フレームのpayloadDataが読めるか。バイナリフレームはどう見えるか。
const { startServer, stopServer, launchBrowser } = require("./lib.js");

(async () => {
  const s = await startServer();
  const base = `http://127.0.0.1:${s.port}`;
  const browser = await launchBrowser();
  const page = await browser.newPage();
  const cdp = await page.context().newCDPSession(page);

  const events = { created: [], sent: [], received: [], error: [], closed: [] };
  cdp.on("Network.webSocketCreated", (p) => events.created.push(p));
  cdp.on("Network.webSocketFrameSent", (p) => events.sent.push(p));
  cdp.on("Network.webSocketFrameReceived", (p) => events.received.push(p));
  cdp.on("Network.webSocketFrameError", (p) => events.error.push(p));
  cdp.on("Network.webSocketClosed", (p) => events.closed.push(p));

  await cdp.send("Network.enable");
  await page.goto(`${base}/`);

  const wsResult = await page.evaluate(
    (base) =>
      new Promise((resolve, reject) => {
        const wsUrl = base.replace("http://", "ws://") + "/ws";
        const ws = new WebSocket(wsUrl);
        const received = [];
        ws.onopen = () => {
          ws.send("hello-text");
          // バイナリフレームも送る
          const buf = new Uint8Array([1, 2, 3, 4, 250, 251]);
          ws.send(buf.buffer);
        };
        ws.onmessage = (ev) => {
          if (typeof ev.data === "string") {
            received.push({ type: "text", data: ev.data });
          } else {
            received.push({ type: "blob-or-buffer", size: ev.data.size ?? ev.data.byteLength });
          }
          if (received.length >= 3) {
            setTimeout(() => {
              ws.close();
              resolve(received);
            }, 300);
          }
        };
        ws.onerror = (e) => reject(new Error("ws error"));
        setTimeout(() => reject(new Error("ws timeout")), 5000);
      }),
    base,
  );

  await page.waitForTimeout(500);

  await browser.close();
  stopServer(s);

  console.log(
    JSON.stringify(
      {
        pageReceivedMessages: wsResult,
        cdpCreatedCount: events.created.length,
        cdpCreated: events.created,
        cdpSentCount: events.sent.length,
        cdpSent: events.sent,
        cdpReceivedCount: events.received.length,
        cdpReceived: events.received,
        cdpErrorCount: events.error.length,
        cdpError: events.error,
        cdpClosed: events.closed,
      },
      null,
      2,
    ),
  );
})().catch((e) => {
  console.error("FAILED:", e.stack || e.message);
  process.exit(1);
});

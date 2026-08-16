// Q2(e): SSE (text/event-stream)。流れている最中に読めるか、終わるまで読めないか。
// Network.streamResourceContent が使えるかも試す。
const { startServer, stopServer, launchBrowser } = require("./lib.js");

(async () => {
  const s = await startServer();
  const base = `http://127.0.0.1:${s.port}`;
  const browser = await launchBrowser();
  const page = await browser.newPage();
  const cdp = await page.context().newCDPSession(page);

  let sseRequestId = null;
  const dataReceivedEvents = [];
  const timeline = [];
  const t0 = Date.now();

  cdp.on("Network.requestWillBeSent", (p) => {
    if (p.request.url.includes("/sse")) sseRequestId = p.requestId;
  });
  cdp.on("Network.dataReceived", (p) => {
    if (p.requestId === sseRequestId) {
      dataReceivedEvents.push({ tMs: Date.now() - t0, dataLength: p.dataLength, encodedDataLength: p.encodedDataLength });
    }
  });
  cdp.on("Network.eventSourceMessageReceived", (p) => {
    timeline.push({ tMs: Date.now() - t0, kind: "eventSourceMessageReceived", eventName: p.eventName, eventId: p.eventId, data: p.data });
  });
  let loadingFinishedAtMs = null;
  cdp.on("Network.loadingFinished", (p) => {
    if (p.requestId === sseRequestId) loadingFinishedAtMs = Date.now() - t0;
  });

  await cdp.send("Network.enable");
  await page.goto(`${base}/`);

  // streamResourceContent を試す(先にrequestIdが要る。requestWillBeSent直後に叩いてみる)
  let streamResourceContentAttempt = null;

  const evtSourcePromise = page.evaluate(
    () =>
      new Promise((resolve) => {
        const es = new EventSource("/sse");
        const got = [];
        es.onmessage = (ev) => {
          got.push({ tMs: Date.now(), data: ev.data });
          if (got.length >= 5) {
            es.close();
            resolve(got);
          }
        };
        window.__sseStart = Date.now();
      }),
  );

  // sseRequestIdが判明したら streamResourceContent を試す
  await new Promise((r) => setTimeout(r, 300));
  if (sseRequestId) {
    try {
      const r = await cdp.send("Network.streamResourceContent", { requestId: sseRequestId });
      streamResourceContentAttempt = { ok: true, result: r };
    } catch (e) {
      streamResourceContentAttempt = { ok: false, error: e.message };
    }
  } else {
    streamResourceContentAttempt = { ok: false, error: "sseRequestId not captured within 300ms" };
  }

  const pageEvents = await evtSourcePromise;

  const result = {
    pageEvents,
    cdpDataReceivedEvents: dataReceivedEvents,
    cdpEventSourceMessages: timeline,
    loadingFinishedAtMs,
    streamResourceContentAttempt,
  };

  await browser.close();
  stopServer(s);
  console.log(JSON.stringify(result, null, 2));
})().catch((e) => {
  console.error("FAILED:", e.stack || e.message);
  process.exit(1);
});

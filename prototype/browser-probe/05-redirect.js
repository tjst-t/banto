// Q5: /api/redirect (302 -> /api/echo) で302側と最終応答の両方が観測できるか。requestIdの振られ方。
const { startServer, stopServer, launchBrowser } = require("./lib.js");

(async () => {
  const s = await startServer();
  const base = `http://127.0.0.1:${s.port}`;
  const browser = await launchBrowser();
  const page = await browser.newPage();
  const cdp = await page.context().newCDPSession(page);

  const rwbs = [];
  const responses = [];
  cdp.on("Network.requestWillBeSent", (p) => rwbs.push(p));
  cdp.on("Network.responseReceived", (p) => responses.push(p));

  await cdp.send("Network.enable");
  await page.goto(`${base}/`);
  await page.evaluate(() => fetch("/api/redirect").then((r) => r.text()));
  await page.waitForTimeout(300);

  const relevant = rwbs.filter((p) => p.request.url.includes("/api/redirect") || p.request.url.includes("/api/echo?redirected=1"));
  const relevantResponses = responses.filter((p) => p.response.url.includes("/api/redirect") || p.response.url.includes("/api/echo?redirected=1"));

  console.log(
    JSON.stringify(
      {
        requestWillBeSent_events: relevant.map((p) => ({
          requestId: p.requestId,
          url: p.request.url,
          redirectResponse: p.redirectResponse
            ? { status: p.redirectResponse.status, url: p.redirectResponse.url, headers: p.redirectResponse.headers }
            : null,
        })),
        responseReceived_events: relevantResponses.map((p) => ({
          requestId: p.requestId,
          url: p.response.url,
          status: p.response.status,
        })),
      },
      null,
      2,
    ),
  );

  await browser.close();
  stopServer(s);
})().catch((e) => {
  console.error("FAILED:", e.stack || e.message);
  process.exit(1);
});

// Q4: /api/big (10MB) が取れるか・切り詰められるか。/api/image がbase64Encoded:trueで返るか。取得秒数。
const { startServer, stopServer, launchBrowser } = require("./lib.js");

(async () => {
  const s = await startServer();
  const base = `http://127.0.0.1:${s.port}`;
  const browser = await launchBrowser();
  const page = await browser.newPage();
  const cdp = await page.context().newCDPSession(page);

  const finished = new Map();
  cdp.on("Network.requestWillBeSent", (p) => finished.set(p.requestId, { url: p.request.url }));

  await cdp.send("Network.enable");
  await page.goto(`${base}/`);

  const t0 = Date.now();
  await page.evaluate(() => fetch("/api/big").then((r) => r.text()));
  const bigFetchMs = Date.now() - t0;

  await page.evaluate(() => fetch("/api/image").then((r) => r.arrayBuffer()));

  await page.waitForTimeout(300);

  const results = {};
  for (const [id, info] of finished.entries()) {
    if (info.url.includes("/api/big")) {
      const t1 = Date.now();
      try {
        const body = await cdp.send("Network.getResponseBody", { requestId: id });
        results.big = {
          ok: true,
          base64Encoded: body.base64Encoded,
          bodyStringLength: body.body.length,
          approxByteLength: body.base64Encoded ? Math.floor((body.body.length * 3) / 4) : body.body.length,
          fetchDurationMs: bigFetchMs,
          getResponseBodyDurationMs: Date.now() - t1,
        };
      } catch (e) {
        results.big = { ok: false, error: e.message, fetchDurationMs: bigFetchMs };
      }
    }
    if (info.url.includes("/api/image")) {
      try {
        const body = await cdp.send("Network.getResponseBody", { requestId: id });
        results.image = {
          ok: true,
          base64Encoded: body.base64Encoded,
          bodyStringLength: body.body.length,
          approxByteLength: body.base64Encoded ? Math.floor((body.body.length * 3) / 4) : body.body.length,
        };
      } catch (e) {
        results.image = { ok: false, error: e.message };
      }
    }
  }

  await browser.close();
  stopServer(s);
  console.log(JSON.stringify(results, null, 2));
})().catch((e) => {
  console.error("FAILED:", e.stack || e.message);
  process.exit(1);
});

// Q3続き: レスポンスのSet-CookieがresponseReceivedExtraInfoで見えるか
const { startServer, stopServer, launchBrowser } = require("./lib.js");

(async () => {
  const s = await startServer();
  const base = `http://127.0.0.1:${s.port}`;
  const browser = await launchBrowser();
  const page = await browser.newPage();
  const cdp = await page.context().newCDPSession(page);

  const respExtra = [];
  const rwbs = [];
  cdp.on("Network.responseReceivedExtraInfo", (p) => respExtra.push(p));
  cdp.on("Network.requestWillBeSent", (p) => rwbs.push(p));

  await cdp.send("Network.enable");
  await page.goto(`${base}/`);
  await page.evaluate(() => fetch("/api/echo?setcookie=1"));
  await page.waitForTimeout(300);

  const req = rwbs.find((p) => p.request.url.includes("setcookie=1"));
  const extra = respExtra.find((p) => p.requestId === req?.requestId);

  console.log(
    JSON.stringify(
      {
        responseReceivedExtraInfo_headers: extra?.headers,
        blockedCookies: extra?.blockedCookies,
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

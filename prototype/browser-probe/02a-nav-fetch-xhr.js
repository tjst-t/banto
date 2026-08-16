// Q2(a)(b)(c): 通常のページ遷移 / fetch() / XMLHttpRequest でレスポンス本文が取れるか
const { startServer, stopServer, launchBrowser } = require("./lib.js");

(async () => {
  const s = await startServer();
  const base = `http://127.0.0.1:${s.port}`;
  const browser = await launchBrowser();
  const page = await browser.newPage();
  const cdp = await page.context().newCDPSession(page);

  const finishedIds = [];
  const urlById = new Map();
  cdp.on("Network.requestWillBeSent", (p) => urlById.set(p.requestId, p.request.url));
  cdp.on("Network.loadingFinished", (p) => finishedIds.push(p.requestId));

  await cdp.send("Network.enable");

  // (a) 通常のページ遷移
  await page.goto(`${base}/`);

  // (b) fetch()
  await page.evaluate(() => fetch("/api/echo?via=fetch"));

  // (c) XMLHttpRequest
  await page.evaluate(
    () =>
      new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open("GET", "/api/echo?via=xhr");
        xhr.onload = () => resolve(xhr.responseText);
        xhr.onerror = () => reject(new Error("xhr error"));
        xhr.send();
      }),
  );

  await page.waitForTimeout(500);

  const results = {};
  for (const id of finishedIds) {
    const url = urlById.get(id) || "";
    let kind = null;
    if (url.endsWith("/")) kind = "nav_html";
    else if (url.includes("via=fetch")) kind = "fetch";
    else if (url.includes("via=xhr")) kind = "xhr";
    else continue;
    try {
      const body = await cdp.send("Network.getResponseBody", { requestId: id });
      results[kind] = { ok: true, url, bodyLength: body.body.length, preview: body.body.slice(0, 120) };
    } catch (e) {
      results[kind] = { ok: false, url, error: e.message };
    }
  }

  await browser.close();
  stopServer(s);
  console.log(JSON.stringify(results, null, 2));
})().catch((e) => {
  console.error("FAILED:", e.stack || e.message);
  process.exit(1);
});

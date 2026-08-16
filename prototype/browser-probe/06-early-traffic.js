// Q6: Network.enableを張る前に始まった通信は観測できるか。ページを開いてからCDPを張った場合はどうか。
const { startServer, stopServer, launchBrowser } = require("./lib.js");

(async () => {
  const s = await startServer();
  const base = `http://127.0.0.1:${s.port}`;
  const browser = await launchBrowser();

  // ケース1: Network.enableを送る前にページ遷移+fetchを行い、その後enableする
  const page1 = await browser.newPage();
  const cdp1 = await page1.context().newCDPSession(page1);
  const seen1 = [];
  cdp1.on("Network.requestWillBeSent", (p) => seen1.push(p.request.url));

  await page1.goto(`${base}/`);
  await page1.evaluate(() => fetch("/api/echo?case=before-enable"));
  await page1.waitForTimeout(200);
  await cdp1.send("Network.enable"); // ここで初めて張る
  await page1.evaluate(() => fetch("/api/echo?case=after-enable-same-page"));
  await page1.waitForTimeout(200);

  // ケース2: ページを開いてからCDPセッション自体を新規作成してenable
  const page2 = await browser.newPage();
  await page2.goto(`${base}/`);
  await page2.evaluate(() => fetch("/api/echo?case=before-cdp-session-created"));
  await page2.waitForTimeout(200);
  const cdp2 = await page2.context().newCDPSession(page2);
  const seen2 = [];
  cdp2.on("Network.requestWillBeSent", (p) => seen2.push(p.request.url));
  await cdp2.send("Network.enable");
  await page2.evaluate(() => fetch("/api/echo?case=after-cdp-session-created"));
  await page2.waitForTimeout(200);

  console.log(
    JSON.stringify(
      {
        case1_enableAfterFirstFetch_seenUrls: seen1,
        case2_cdpSessionCreatedAfterFirstFetch_seenUrls: seen2,
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

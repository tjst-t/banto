// §9-6: 同じページに CDP セッションを2本張り、片方が screencast・もう片方が Network を
// 同時に購読できるか(人用/AI用のセッション分離が可能か)。
const { chromium } = require("playwright");
const path = require("node:path");

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.goto("file://" + path.join(__dirname, "page.html"));

  // newCDPSession を同じ page に対して2回呼び、別セッションになるかを見る
  const cdpA = await page.context().newCDPSession(page); // 人役: screencast
  const cdpB = await page.context().newCDPSession(page); // AI役: network

  let framesA = 0;
  cdpA.on("Page.screencastFrame", async (p) => {
    framesA++;
    await cdpA.send("Page.screencastFrameAck", { sessionId: p.sessionId }).catch(() => {});
  });

  const requestsB = [];
  cdpB.on("Network.requestWillBeSent", (p) => requestsB.push(p.request.url));

  await cdpA.send("Page.startScreencast", { format: "jpeg", quality: 50 });
  await cdpB.send("Network.enable");

  // 双方が動いている間にページ操作を行う(A=画面配信、B=通信観測が同時に効くか)
  await page.goto("https://example.com/", { timeout: 8000 }).catch((e) => {
    console.error("goto失敗(参考):", e.message);
  });
  await page.waitForTimeout(2000);

  await cdpA.send("Page.stopScreencast").catch(() => {});

  console.log(JSON.stringify({
    twoSessionsCreated: cdpA !== cdpB,
    screencastFramesReceivedOnSessionA: framesA,
    networkRequestsObservedOnSessionB: requestsB,
    bothActiveSimultaneously: framesA > 0 && requestsB.length > 0,
  }, null, 2));

  await browser.close();
})().catch((e) => {
  console.error("FAILED:", e.stack || e.message);
  process.exit(1);
});

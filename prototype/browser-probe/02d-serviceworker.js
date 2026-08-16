// Q2(f): service worker経由のfetch。ページからのfetchとSW自身が出すfetchの両方が見えるか。
// Network.enableをメインフレームだけに張った場合と、Target.setAutoAttachでworkerにも張った場合の違い。
const { startServer, stopServer, launchBrowser } = require("./lib.js");

async function run(withWorkerAttach) {
  const s = await startServer();
  const base = `http://127.0.0.1:${s.port}`;
  const browser = await require("./lib.js").launchBrowser();
  const context = await browser.newContext();
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);

  const mainFrameRequests = [];
  cdp.on("Network.requestWillBeSent", (p) => {
    mainFrameRequests.push({ url: p.request.url, requestId: p.requestId });
  });

  const workerTargets = [];
  const workerCdpSessions = [];
  const workerRequests = [];

  if (withWorkerAttach) {
    await cdp.send("Target.setAutoAttach", {
      autoAttach: true,
      waitForDebuggerOnStart: false,
      flatten: true,
    });
    cdp.on("Target.attachedToTarget", async (p) => {
      workerTargets.push({ type: p.targetInfo.type, url: p.targetInfo.url });
      if (p.targetInfo.type === "service_worker") {
        try {
          const sessionId = p.sessionId;
          // flatten接続では同じCDPSessionオブジェクト経由で session 指定して送る必要がある。
          // playwrightはCDPSessionを子ターゲット用に別途生成する機能がないため、
          // 生のCDPコマンドをsessionId付きで投げられるか試す。
          await cdp.send("Network.enable", {}, sessionId).catch(() => {});
        } catch (e) {
          workerCdpSessions.push({ error: e.message });
        }
      }
    });
  }

  await cdp.send("Network.enable");
  await page.goto(`${base}/`);
  await page.waitForFunction(() => navigator.serviceWorker.ready.then(() => true), { timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(500);

  // ページから直接fetch
  await page.evaluate(() => fetch("/api/echo?from=page-direct"));
  // service workerがfetchイベントをフックして自分でfetchするパス
  const swFetchResult = await page
    .evaluate(async () => {
      const r = await fetch("/sw-trigger");
      return { status: r.status, body: await r.text() };
    })
    .catch((e) => ({ error: e.message }));

  await page.waitForTimeout(500);

  const seenUrls = mainFrameRequests.map((r) => r.url);

  await browser.close();
  stopServer(s);

  return {
    withWorkerAttach,
    swRegistered: true,
    workerTargets,
    seenRequestUrlsOnMainCdpSession: seenUrls,
    pageDirectFetchSeen: seenUrls.some((u) => u.includes("from=page-direct")),
    swTriggerRequestSeen: seenUrls.some((u) => u.includes("sw-trigger")),
    swInternalEchoFetchSeen: seenUrls.some((u) => u.includes("from=service-worker")),
    swFetchResult,
  };
}

(async () => {
  const withoutAttach = await run(false);
  const withAttach = await run(true);
  console.log(JSON.stringify({ withoutAttach, withAttach }, null, 2));
})().catch((e) => {
  console.error("FAILED:", e.stack || e.message);
  process.exit(1);
});

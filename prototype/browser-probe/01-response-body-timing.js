// Q1: Network.getResponseBody をいつまで呼べるか。
// (a) loadingFinished直後 (b) 5秒後 (c) 別ページ遷移後 (d) Page.reload後
// + maxResourceBufferSize / maxTotalBufferSize の効果
const { startServer, stopServer, launchBrowser } = require("./lib.js");

function waitForLoadingFinished(cdp, matchUrlSubstr) {
  return new Promise((resolve) => {
    const onSent = (p) => {
      if (p.request.url.includes(matchUrlSubstr)) {
        const reqId = p.requestId;
        const onFinished = (f) => {
          if (f.requestId === reqId) {
            cdp.off("Network.loadingFinished", onFinished);
            cdp.off("Network.requestWillBeSent", onSent);
            resolve(reqId);
          }
        };
        cdp.on("Network.loadingFinished", onFinished);
      }
    };
    cdp.on("Network.requestWillBeSent", onSent);
  });
}

async function tryGetBody(cdp, requestId) {
  try {
    const body = await cdp.send("Network.getResponseBody", { requestId });
    return { ok: true, bodyLength: body.body.length, base64Encoded: body.base64Encoded, preview: body.body.slice(0, 80) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

(async () => {
  const s = await startServer();
  const base = `http://127.0.0.1:${s.port}`;
  const browser = await launchBrowser();
  const results = {};

  // (a) 直後
  {
    const page = await browser.newPage();
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Network.enable");
    await page.goto(`${base}/`);
    const waitP = waitForLoadingFinished(cdp, "/api/echo");
    await page.evaluate(() => fetch("/api/echo?case=a"));
    const requestId = await waitP;
    results.a_immediately_after_loadingFinished = await tryGetBody(cdp, requestId);
    await page.close();
  }

  // (b) 5秒後
  {
    const page = await browser.newPage();
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Network.enable");
    await page.goto(`${base}/`);
    const waitP = waitForLoadingFinished(cdp, "/api/echo");
    await page.evaluate(() => fetch("/api/echo?case=b"));
    const requestId = await waitP;
    await page.waitForTimeout(5000);
    results.b_5s_later = await tryGetBody(cdp, requestId);
    await page.close();
  }

  // (c) 別ページへ遷移した後
  {
    const page = await browser.newPage();
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Network.enable");
    await page.goto(`${base}/`);
    const waitP = waitForLoadingFinished(cdp, "/api/echo");
    await page.evaluate(() => fetch("/api/echo?case=c"));
    const requestId = await waitP;
    await page.goto(`${base}/api/image`); // 別ページへ遷移(ナビゲーション)
    results.c_after_navigation = await tryGetBody(cdp, requestId);
    await page.close();
  }

  // (d) Page.reload後
  {
    const page = await browser.newPage();
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Network.enable");
    await page.goto(`${base}/`);
    const waitP = waitForLoadingFinished(cdp, "/api/echo");
    await page.evaluate(() => fetch("/api/echo?case=d"));
    const requestId = await waitP;
    await page.reload();
    results.d_after_reload = await tryGetBody(cdp, requestId);
    await page.close();
  }

  // maxResourceBufferSize / maxTotalBufferSize: 既定値 と 小さい値 で /api/big(10MB)
  {
    const page = await browser.newPage();
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Network.enable"); // パラメータ無し(既定)
    await page.goto(`${base}/`);
    const waitP = waitForLoadingFinished(cdp, "/api/big");
    await page.evaluate(() => fetch("/api/big"));
    const requestId = await waitP;
    results.default_buffer_big_body = await tryGetBody(cdp, requestId);
    await page.close();
  }
  {
    const page = await browser.newPage();
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Network.enable", { maxResourceBufferSize: 1000, maxTotalBufferSize: 1000 });
    await page.goto(`${base}/`);
    const waitP = waitForLoadingFinished(cdp, "/api/big");
    await page.evaluate(() => fetch("/api/big"));
    const requestId = await waitP;
    results.tiny_buffer_1000bytes_big_body = await tryGetBody(cdp, requestId);
    await page.close();
  }
  {
    // small bodyでもtinyバッファに収まらない場合の挙動確認 (echoは小さい)
    const page = await browser.newPage();
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Network.enable", { maxResourceBufferSize: 1000, maxTotalBufferSize: 1000 });
    await page.goto(`${base}/`);
    const waitP = waitForLoadingFinished(cdp, "/api/echo");
    await page.evaluate(() => fetch("/api/echo?case=tinybuf"));
    const requestId = await waitP;
    results.tiny_buffer_1000bytes_small_body = await tryGetBody(cdp, requestId);
    await page.close();
  }

  await browser.close();
  stopServer(s);

  console.log(JSON.stringify(results, null, 2));
})().catch((e) => {
  console.error("FAILED:", e.stack || e.message);
  process.exit(1);
});

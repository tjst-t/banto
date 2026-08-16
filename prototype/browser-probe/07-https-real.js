// Q7: https://example.com/ を1回開き、URL・レスポンスヘッダ・本文が取れることを再確認
const { launchBrowser } = require("./lib.js");

(async () => {
  const browser = await launchBrowser();
  const page = await browser.newPage();
  const cdp = await page.context().newCDPSession(page);

  let reqInfo = null;
  let respInfo = null;
  cdp.on("Network.requestWillBeSent", (p) => {
    if (p.request.url === "https://example.com/") reqInfo = p;
  });
  cdp.on("Network.responseReceived", (p) => {
    if (p.response.url === "https://example.com/") respInfo = p;
  });

  await cdp.send("Network.enable");

  let navOk = false;
  let navError = null;
  try {
    await page.goto("https://example.com/", { timeout: 10000 });
    navOk = true;
  } catch (e) {
    navError = e.message;
  }

  let bodyResult = null;
  if (respInfo) {
    try {
      const body = await cdp.send("Network.getResponseBody", { requestId: respInfo.requestId });
      bodyResult = { ok: true, bodyLength: body.body.length, preview: body.body.slice(0, 200) };
    } catch (e) {
      bodyResult = { ok: false, error: e.message };
    }
  }

  console.log(
    JSON.stringify(
      {
        navOk,
        navError,
        requestUrl: reqInfo?.request.url,
        requestMethod: reqInfo?.request.method,
        responseStatus: respInfo?.response.status,
        responseHeaders: respInfo?.response.headers,
        bodyResult,
      },
      null,
      2,
    ),
  );

  await browser.close();
})().catch((e) => {
  console.error("FAILED:", e.stack || e.message);
  process.exit(1);
});

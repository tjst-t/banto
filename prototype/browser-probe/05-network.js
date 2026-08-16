// §9-5: CDP Network.enable でHTTPSのURL/メソッド/ヘッダ/POSTボディ、レスポンスの
// ステータス/ヘッダ/本文(Network.getResponseBody)が取れるか。外向き通信の可否も見る。
// あわせて recordHar({content:"embed"}) の HAR に本文が入るかを確認。
const { chromium } = require("playwright");
const path = require("node:path");
const fs = require("node:fs");
const http = require("node:http");

const HAR_PATH = "/tmp/browser-probe/out.har";
const OUTBOUND_URL = "https://example.com/";
const OUTBOUND_POST_URL = "https://postman-echo.com/post";

function startLocalServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        res.writeHead(200, { "content-type": "application/json", "x-probe": "local" });
        res.end(JSON.stringify({ receivedBody: body, method: req.method, url: req.url }));
      });
    });
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

(async () => {
  const localServer = await startLocalServer();
  const localPort = localServer.address().port;
  const localPostUrl = `http://127.0.0.1:${localPort}/local-post`;

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    recordHar: { path: HAR_PATH, content: "embed" },
  });
  const page = await context.newPage();
  const cdp = await page.context().newCDPSession(page);

  const seen = [];
  const requestIdToUrl = new Map();

  cdp.on("Network.requestWillBeSent", (p) => {
    requestIdToUrl.set(p.requestId, p.request.url);
    seen.push({
      phase: "request",
      requestId: p.requestId,
      url: p.request.url,
      method: p.request.method,
      headers: p.request.headers,
      postData: p.request.postData ?? null,
      hasPostData: !!p.request.hasPostData,
    });
  });

  const responseInfo = new Map();
  cdp.on("Network.responseReceived", (p) => {
    responseInfo.set(p.requestId, {
      status: p.response.status,
      headers: p.response.headers,
      url: p.response.url,
    });
  });

  await cdp.send("Network.enable");

  let outboundOk = false;
  let outboundError = null;
  try {
    await page.goto(OUTBOUND_URL, { timeout: 8000 });
    outboundOk = true;
  } catch (e) {
    outboundError = e.message;
  }

  // POST: 外向きが通るならpostman-echo、通らないならローカルサーバへ
  const postTargetUrl = outboundOk ? OUTBOUND_POST_URL : localPostUrl;
  let postOk = false;
  let postError = null;
  try {
    await page.evaluate(async (url) => {
      await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ probe: "hello", ja: "日本語ボディ" }),
      });
    }, postTargetUrl);
    postOk = true;
  } catch (e) {
    postError = e.message;
  }

  // ローカルサーバへのPOSTも常に実施しておく(外向き可否によらず、getResponseBodyの検証のため)
  let localPostOk = false;
  let localPostError = null;
  try {
    await page.evaluate(async (url) => {
      await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ probe: "local", ja: "ローカル日本語" }),
      });
    }, localPostUrl);
    localPostOk = true;
  } catch (e) {
    localPostError = e.message;
  }

  await page.waitForTimeout(1500);

  // getResponseBody を全requestIdに対して試す
  const bodies = [];
  for (const [requestId, info] of responseInfo.entries()) {
    try {
      const body = await cdp.send("Network.getResponseBody", { requestId });
      bodies.push({
        url: info.url,
        status: info.status,
        base64Encoded: body.base64Encoded,
        bodyLength: body.body.length,
        bodyPreview: body.body.slice(0, 200),
      });
    } catch (e) {
      bodies.push({ url: info.url, status: info.status, error: e.message });
    }
  }

  await context.close();
  await browser.close();
  await new Promise((r) => localServer.close(r));

  let harStat = null;
  let harHasBody = false;
  let harSample = "";
  if (fs.existsSync(HAR_PATH)) {
    harStat = fs.statSync(HAR_PATH).size;
    const har = JSON.parse(fs.readFileSync(HAR_PATH, "utf-8"));
    const entries = har.log.entries;
    const withText = entries.filter((e) => e.response?.content?.text);
    harHasBody = withText.length > 0;
    if (withText.length > 0) {
      harSample = withText[0].response.content.text.slice(0, 150);
    }
  }

  console.log(JSON.stringify({
    outboundOk,
    outboundError,
    postToOutboundEndpointOk: postOk,
    postToOutboundEndpointError: postError,
    postTargetUrl,
    localPostOk,
    localPostError,
    requests: seen,
    responseBodies: bodies,
    harFileSizeBytes: harStat,
    harHasResponseBodyText: harHasBody,
    harBodySamplePreview: harSample,
  }, null, 2));
})().catch((e) => {
  console.error("FAILED:", e.stack || e.message);
  process.exit(1);
});

// Q3: Authorization/Cookieが requestWillBeSent と requestWillBeSentExtraInfo でどう違うか。
// Set-CookieがresponseReceivedExtraInfoで見えるか。クエリ/POST JSON/multipartの本文、getRequestPostData。
const { startServer, stopServer, launchBrowser } = require("./lib.js");

(async () => {
  const s = await startServer();
  const base = `http://127.0.0.1:${s.port}`;
  const browser = await launchBrowser();
  const context = await browser.newContext();
  await context.addCookies([
    { name: "sid", value: "cookie-abc-123", domain: "127.0.0.1", path: "/" },
  ]);
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);

  const rwbs = []; // requestWillBeSent
  const rwbsExtra = []; // requestWillBeSentExtraInfo
  const respExtra = []; // responseReceivedExtraInfo
  const requestPostDataAvail = [];

  cdp.on("Network.requestWillBeSent", (p) => rwbs.push(p));
  cdp.on("Network.requestWillBeSentExtraInfo", (p) => rwbsExtra.push(p));
  cdp.on("Network.responseReceivedExtraInfo", (p) => respExtra.push(p));

  await cdp.send("Network.enable");
  await page.goto(`${base}/`);

  // Authorization + Cookie付きGET (クエリ文字列あり)
  await page.evaluate(() =>
    fetch("/api/echo?q1=v1&q2=%E6%97%A5%E6%9C%AC%E8%AA%9E", {
      headers: { Authorization: "Bearer testtoken123" },
      credentials: "include",
    }),
  );

  // POST JSON
  await page.evaluate(() =>
    fetch("/api/echo", {
      method: "POST",
      headers: { "content-type": "application/json", Authorization: "Bearer testtoken123" },
      credentials: "include",
      body: JSON.stringify({ hello: "world", ja: "日本語" }),
    }),
  );

  // multipart/form-data POST
  await page.evaluate(() => {
    const fd = new FormData();
    fd.append("field1", "value1");
    fd.append("file1", new Blob(["binary-ish-content"], { type: "text/plain" }), "test.txt");
    return fetch("/api/echo", { method: "POST", credentials: "include", body: fd });
  });

  await page.waitForTimeout(500);

  const findByUrlSubstr = (list, sub, getUrl) => list.find((p) => getUrl(p).includes(sub));

  const authGet = findByUrlSubstr(rwbs, "q1=v1", (p) => p.request.url);
  const authGetExtra = rwbsExtra.find((p) => p.requestId === authGet?.requestId);
  const postJson = rwbs.find((p) => p.request.method === "POST" && p.request.postData && p.request.postData.includes("hello"));
  const postJsonExtra = rwbsExtra.find((p) => p.requestId === postJson?.requestId);
  const postRequests = rwbs.filter((p) => p.request.method === "POST");
  let postMultipart = postRequests.find((p) =>
    Object.entries(p.request.headers).some(([k, v]) => k.toLowerCase() === "content-type" && v.includes("multipart")),
  );
  if (!postMultipart) {
    // requestWillBeSent.headers にcontent-typeが出ないケース: ExtraInfo側で判定
    postMultipart = postRequests.find((p) => {
      const extra = rwbsExtra.find((e) => e.requestId === p.requestId);
      return extra && Object.entries(extra.headers).some(([k, v]) => k.toLowerCase() === "content-type" && String(v).includes("multipart"));
    });
  }
  const postMultipartExtra = rwbsExtra.find((p) => p.requestId === postMultipart?.requestId);

  // getRequestPostData を試す
  let getRequestPostDataResult = null;
  if (postJson) {
    try {
      const r = await cdp.send("Network.getRequestPostData", { requestId: postJson.requestId });
      getRequestPostDataResult = { ok: true, data: r.postData };
    } catch (e) {
      getRequestPostDataResult = { ok: false, error: e.message };
    }
  }
  let getRequestPostDataMultipart = null;
  if (postMultipart) {
    try {
      const r = await cdp.send("Network.getRequestPostData", { requestId: postMultipart.requestId });
      getRequestPostDataMultipart = { ok: true, dataLength: r.postData.length, preview: r.postData.slice(0, 300) };
    } catch (e) {
      getRequestPostDataMultipart = { ok: false, error: e.message };
    }
  }

  // Set-Cookie確認: サーバがSet-Cookieを返す専用の応答はないので、/api/echoのレスポンスヘッダにサーバ側で付けていない。
  // → responseReceivedExtraInfoの構造そのものは authGet 応答で確認する(set-cookieはヘッダに無い前提で「見える構造か」を報告)。
  const authGetRespExtra = respExtra.find((p) => p.requestId === authGet?.requestId);

  const result = {
    authGet_requestWillBeSent_headers: authGet?.request.headers,
    authGet_requestWillBeSentExtraInfo_headers: authGetExtra?.headers,
    authGet_url: authGet?.request.url,
    postJson_requestWillBeSent_postData: postJson?.request.postData,
    postJson_requestWillBeSent_headers: postJson?.request.headers,
    postJson_requestWillBeSentExtraInfo_headers: postJsonExtra?.headers,
    getRequestPostDataResult,
    postRequestsCount: postRequests.length,
    postMultipart_found: !!postMultipart,
    postMultipart_requestWillBeSent_headers: postMultipart?.request.headers,
    postMultipart_requestWillBeSentExtraInfo_headers: postMultipartExtra?.headers,
    postMultipart_hasPostData_flag: postMultipart?.request.hasPostData,
    postMultipart_postData_inline: postMultipart?.request.postData ?? null,
    getRequestPostDataMultipart,
    responseReceivedExtraInfo_headers_sample: authGetRespExtra?.headers,
  };

  await browser.close();
  stopServer(s);
  console.log(JSON.stringify(result, null, 2));
})().catch((e) => {
  console.error("FAILED:", e.stack || e.message);
  process.exit(1);
});

// §9-3: CDP Page.startScreencast で Page.screencastFrame が実際に届くか。
// 10秒間のフレーム数・base64バイト数の中央値・静止時とスクロール時の差を測る。
const { chromium } = require("playwright");
const path = require("node:path");

function median(nums) {
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.goto("file://" + path.join(__dirname, "page.html"));

  const cdp = await page.context().newCDPSession(page);

  const stillSizes = [];
  const scrollSizes = [];
  let stillCount = 0;
  let scrollCount = 0;
  let phase = "still";

  cdp.on("Page.screencastFrame", async (params) => {
    const bytes = Buffer.byteLength(params.data, "base64");
    if (phase === "still") {
      stillCount++;
      stillSizes.push(bytes);
    } else {
      scrollCount++;
      scrollSizes.push(bytes);
    }
    try {
      await cdp.send("Page.screencastFrameAck", { sessionId: params.sessionId });
    } catch (e) {
      console.error("ack失敗:", e.message);
    }
  });

  await cdp.send("Page.startScreencast", {
    format: "jpeg",
    quality: 60,
    maxWidth: 1280,
    maxHeight: 800,
  });

  console.log("[静止フェーズ] 5秒待機...");
  await page.waitForTimeout(5000);

  phase = "scroll";
  console.log("[スクロールフェーズ] 5秒間スクロールさせる...");
  const scrollStart = Date.now();
  while (Date.now() - scrollStart < 5000) {
    await page.mouse.wheel(0, 200);
    await page.waitForTimeout(100);
  }

  await cdp.send("Page.stopScreencast");

  console.log(JSON.stringify({
    stillPhase: {
      seconds: 5,
      frames: stillCount,
      medianBytes: stillSizes.length ? median(stillSizes) : null,
      sizes: stillSizes,
    },
    scrollPhase: {
      seconds: 5,
      frames: scrollCount,
      medianBytes: scrollSizes.length ? median(scrollSizes) : null,
      sizes: scrollSizes,
    },
    totalFramesIn10s: stillCount + scrollCount,
    medianBytesOverall: median([...stillSizes, ...scrollSizes]),
  }, null, 2));

  await browser.close();
})().catch((e) => {
  console.error("FAILED:", e.stack || e.message);
  process.exit(1);
});

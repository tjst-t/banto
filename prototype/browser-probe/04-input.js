// §9-4: page.click/page.fill を使わず、CDP の Input.dispatchMouseEvent /
// Input.dispatchKeyEvent だけでクリックと日本語入力ができるか。
// 日本語は Input.insertText と dispatchKeyEvent の両方を試し、どちらが通ったか比較する。
const { chromium } = require("playwright");
const path = require("node:path");

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.goto("file://" + path.join(__dirname, "page.html"));
  const cdp = await page.context().newCDPSession(page);

  // --- クリック: ボタンの座標を取得し、CDP の生マウスイベントだけで押す ---
  const box = await page.locator("#btn").boundingBox();
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;

  await cdp.send("Input.dispatchMouseEvent", {
    type: "mouseMoved", x: cx, y: cy,
  });
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mousePressed", x: cx, y: cy, button: "left", clickCount: 1,
  });
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mouseReleased", x: cx, y: cy, button: "left", clickCount: 1,
  });

  const afterClickText = await page.locator("#out").textContent();

  // --- 日本語入力その1: dispatchKeyEvent だけ(ASCII相当のkey/textしか送れない想定を確認) ---
  const inputBox = await page.locator("#txt").boundingBox();
  const ix = inputBox.x + inputBox.width / 2;
  const iy = inputBox.y + inputBox.height / 2;
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: ix, y: iy });
  await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: ix, y: iy, button: "left", clickCount: 1 });
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: ix, y: iy, button: "left", clickCount: 1 });

  let keyEventError = null;
  try {
    // 「あ」を rawKeyDown/char/keyUp の3段で送ってみる(ASCII前提のAPIで非ASCII文字がどう扱われるか確認)
    await cdp.send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "あ" });
    await cdp.send("Input.dispatchKeyEvent", { type: "char", text: "あ", unmodifiedText: "あ", key: "あ" });
    await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "あ" });
  } catch (e) {
    keyEventError = e.message;
  }
  const afterKeyEventText = await page.locator("#txt").inputValue();

  // 一旦クリアしてから Input.insertText を試す
  await page.evaluate(() => { document.getElementById("txt").value = ""; });
  let insertTextError = null;
  try {
    await cdp.send("Input.insertText", { text: "日本語テスト" });
  } catch (e) {
    insertTextError = e.message;
  }
  const afterInsertTextText = await page.locator("#txt").inputValue();

  // 比較用: 半角英数の dispatchKeyEvent が通るかも確認(ASCIIなら通る想定)
  await page.evaluate(() => { document.getElementById("txt").value = ""; });
  await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "a", text: "a" });
  await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "a" });
  const afterAsciiKeyEventText = await page.locator("#txt").inputValue();

  console.log(JSON.stringify({
    click: {
      beforeText: "未クリック",
      afterClickText,
      clickViaCdpOnly: afterClickText === "clicked!",
    },
    japaneseInput: {
      viaDispatchKeyEvent: { error: keyEventError, resultingValue: afterKeyEventText, worked: afterKeyEventText === "あ" },
      viaInsertText: { error: insertTextError, resultingValue: afterInsertTextText, worked: afterInsertTextText === "日本語テスト" },
    },
    asciiViaDispatchKeyEvent: { resultingValue: afterAsciiKeyEventText, worked: afterAsciiKeyEventText === "a" },
  }, null, 2));

  await browser.close();
})().catch((e) => {
  console.error("FAILED:", e.stack || e.message);
  process.exit(1);
});

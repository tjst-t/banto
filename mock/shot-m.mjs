import { chromium } from "playwright";
const B = "http://localhost:4173";
const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
const p = await ctx.newPage();
const urls = process.argv.slice(2);
let i = 0;
for (const u of urls) {
  await p.goto(B + u, { waitUntil: "networkidle" });
  await p.waitForTimeout(1500);
  await p.screenshot({ path: `/tmp/shots/m${i}.png` });
  console.log(`/tmp/shots/m${i}.png`, u);
  i++;
}
await b.close();

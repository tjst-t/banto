// 画面の体感を測る（dev と本番ビルドを同じ物差しで比べるための道具）。
// `docs/notes/2026-09-07-codeblock-freeze-and-latency.md` の数値はこれで取った
// ——**次に「遅い」と言われたとき、また一から測り方を考えないため**に残す。
// テストではない（playwright の testDir は specs/ なので拾われない）。
//
// 使い方: node perf-probe.mjs <frontendBaseUrl> <label>
//   例: node perf-probe.mjs http://127.0.0.1:4175 prod
import { chromium } from "@playwright/test";
import { readFileSync } from "node:fs";

const base = process.argv[2] ?? "http://127.0.0.1:4175";
const label = process.argv[3] ?? "dev";
const token = JSON.parse(readFileSync("/home/ubuntu/.config/banto/config.json", "utf8")).authToken;
const host = "http://127.0.0.1:4737";

const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

const browser = await chromium.launch();
const results = { label, base, firstLoad: [], reload: [], longTask: [], projectSwitch: [], vitals: [] };

for (let i = 0; i < 5; i++) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  await page.addInitScript(() => {
    window.__longTasks = 0;
    new PerformanceObserver((l) => {
      for (const e of l.getEntries()) window.__longTasks += e.duration;
    }).observe({ entryTypes: ["longtask"] });
  });
  // helpers.ts の openApp と同じ待ち方（行き先が決まりきるまで）＋ composer が出るまで
  const t0 = Date.now();
  await page.goto(`${base}/?bantoToken=${token}&bantoHost=${host}`);
  await page.waitForURL(/\/p\/[0-9a-f-]+/, { timeout: 60_000 });
  await page.getByPlaceholder(/に送る/).waitFor({ timeout: 60_000 });
  results.firstLoad.push(Date.now() - t0);
  const vitals = await page.evaluate(() => {
    const nav = performance.getEntriesByType("navigation")[0];
    const fcp = performance.getEntriesByName("first-contentful-paint")[0];
    const bytes = performance
      .getEntriesByType("resource")
      .reduce((sum, r) => sum + (r.transferSize || 0), 0);
    return { fcp: fcp ? Math.round(fcp.startTime) : null, dcl: Math.round(nav?.domContentLoadedEventEnd ?? 0), bytes, requests: performance.getEntriesByType("resource").length };
  });
  results.vitals.push(vitals);
  results.longTask.push(await page.evaluate(() => window.__longTasks));

  const t1 = Date.now();
  await page.reload();
  await page.getByPlaceholder(/に送る/).waitFor({ timeout: 60_000 });
  results.reload.push(Date.now() - t1);

  // Project を切り替える（レールの2番目の Project へ）
  const rail = page.locator('a[href^="/p/"]');
  const count = await rail.count();
  if (count > 1) {
    const t2 = Date.now();
    await rail.nth(1).click();
    await page.getByPlaceholder(/に送る/).waitFor({ timeout: 60_000 });
    results.projectSwitch.push(Date.now() - t2);
  }

  await ctx.close();
}
await browser.close();

const summary = Object.fromEntries(
  ["firstLoad", "reload", "longTask", "projectSwitch"].map((k) => [
    k,
    results[k].length ? { median: median(results[k]), worst: Math.max(...results[k]), n: results[k].length } : null,
  ]),
);
console.log(JSON.stringify({ label, base, summary, vitals: results.vitals }, null, 1));

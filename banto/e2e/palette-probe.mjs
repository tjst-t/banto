// Ctrl-K（Command Palette）の開くまでの時間とスクロールのもたつきを測る（2026-09-30、ユーザー指摘）。読むだけ。
// 使い方: PROBE_TOKEN=... [PROBE_API=...] [PROBE_CPU=4] [PROBE_PROFILE=open|scroll] node palette-probe.mjs [base]
import { chromium } from "@playwright/test";

const base = process.argv[2] ?? "https://banto.tjstkm.net";
const api = process.env.PROBE_API ?? base;
const token = process.env.PROBE_TOKEN;
const cpu = Number(process.env.PROBE_CPU ?? "1");
const profileWhat = process.env.PROBE_PROFILE;
const projects = await (await fetch(`${api}/api/projects`, { headers: { authorization: `Bearer ${token}` } })).json();
const target = projects.find((p) => p.name === "Banto開発");

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
const cdp = await ctx.newCDPSession(page);
if (cpu > 1) await cdp.send("Emulation.setCPUThrottlingRate", { rate: cpu });
await page.addInitScript(() => {
  window.__lt = [];
  new PerformanceObserver((l) => {
    for (const e of l.getEntries()) window.__lt.push(Math.round(e.duration));
  }).observe({ entryTypes: ["longtask"] });
});
await page.goto(`${base}/p/${target.id}?bantoToken=${token}&bantoHost=${api}`);
await page.getByPlaceholder(/に送る/).first().waitFor({ timeout: 60_000 });
await page.waitForTimeout(4000);
console.log(`(CPU ×${cpu})`);

const reqs = [];
page.on("request", (r) => {
  if (r.url().includes("/api/")) reqs.push({ url: r.url().replace(/^https?:\/\/[^/]+/, "").slice(0, 70), t: Date.now() });
});
page.on("requestfinished", async (r) => {
  const x = reqs.find((q) => r.url().endsWith(q.url.split("?")[0]) && q.done === undefined);
  if (x) x.done = Date.now() - x.t;
});

async function profile(fn) {
  if (!profileWhat) return fn();
  await cdp.send("Profiler.enable");
  await cdp.send("Profiler.setSamplingInterval", { interval: 200 });
  await cdp.send("Profiler.start");
  const r = await fn();
  const { profile: prof } = await cdp.send("Profiler.stop");
  const byId = new Map(prof.nodes.map((n) => [n.id, n]));
  const self = new Map();
  prof.samples.forEach((id, i) => self.set(id, (self.get(id) ?? 0) + (prof.timeDeltas[i] ?? 0)));
  const agg = new Map();
  for (const [id, us] of self) {
    const cf = byId.get(id).callFrame;
    if (["(idle)", "(program)"].includes(cf.functionName)) continue;
    const key = `${cf.functionName || "(anon)"} ${cf.url.split("/").pop()}:${cf.lineNumber}:${cf.columnNumber}`;
    agg.set(key, (agg.get(key) ?? 0) + us);
  }
  console.log("  -- 関数別（self）");
  for (const [k, v] of [...agg].sort((a, b) => b[1] - a[1]).slice(0, 15)) console.log(`  ${String(Math.round(v / 1000)).padStart(6)} ms  ${k}`);
  return r;
}

for (let round = 0; round < 3; round++) {
  await page.evaluate(() => (window.__lt = []));
  reqs.length = 0;
  const opened = await profile(async () => {
    const t0 = Date.now();
    await page.keyboard.press("Control+k");
    await page.locator("[cmdk-item]").first().waitFor({ timeout: 30_000 });
    const firstItem = Date.now() - t0;
    // 入口（Launcher）が出そろうまで
    let launchers = -1;
    for (let i = 0; i < 40; i++) {
      launchers = await page.locator("[cmdk-group-heading]").filter({ hasText: /入口|Launcher|Module/ }).count();
      if (launchers > 0) break;
      await page.waitForTimeout(100);
    }
    return { firstItem, launchersAt: Date.now() - t0 };
  });
  const stats = await page.evaluate(() => ({
    items: document.querySelectorAll("[cmdk-item]").length,
    groups: [...document.querySelectorAll("[cmdk-group-heading]")].map((h) => h.textContent),
    longTasks: window.__lt,
  }));
  console.log(`#${round} 最初の項目 ${opened.firstItem} ms・入口の見出しまで ${opened.launchersAt} ms・項目 ${stats.items}・long task ${JSON.stringify(stats.longTasks)}`);
  if (round === 0) console.log("   見出し", stats.groups);
  await page.waitForTimeout(1500);
  console.log("   API", reqs.map((r) => `${r.url}(${r.done ?? "?"}ms)`).join(" "));

  if (round === 0) {
    // スクロール：ホイールで下まで。フレームの間隔を測る
    await page.evaluate(() => {
      window.__frames = [];
      let last = performance.now();
      const tick = (t) => {
        window.__frames.push(t - last);
        last = t;
        if (window.__frames.length < 400) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
      window.__lt = [];
    });
    const list = page.locator("[cmdk-list]");
    const box = await list.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await profile(async () => {
      for (let i = 0; i < 30; i++) {
        await page.mouse.wheel(0, 120);
        await page.waitForTimeout(16);
      }
      await page.waitForTimeout(300);
    });
    const f = await page.evaluate(() => {
      const fr = window.__frames.slice(1);
      const sorted = [...fr].sort((a, b) => a - b);
      return { frames: fr.length, p50: Math.round(sorted[Math.floor(sorted.length / 2)]), p95: Math.round(sorted[Math.floor(sorted.length * 0.95)]), max: Math.round(sorted.at(-1)), over50: fr.filter((x) => x > 50).length, longTasks: window.__lt };
    });
    console.log("   スクロール", f);
  }
  await page.keyboard.press("Escape");
  await page.waitForTimeout(800);
}
await browser.close();

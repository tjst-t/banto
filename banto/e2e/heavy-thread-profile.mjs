// heavy-thread-probe.mjs の続き：固まっている間に何が時間を食っているかを CPU プロファイルで見る。
// 使い方: PROBE_TOKEN=... PROBE_CPU=4 node heavy-thread-profile.mjs [base] [open|type|fork]
import { chromium } from "@playwright/test";

const base = process.argv[2] ?? "https://banto.tjstkm.net";
// 画面と API を別の口にするとき（直した画面を 4197 で起こし、API は稼働中の host を使う）
const api = process.env.PROBE_API ?? base;
const what = process.argv[3] ?? "type";
const token = process.env.PROBE_TOKEN;
const cpu = Number(process.env.PROBE_CPU ?? "1");
const projectId = process.env.PROBE_PROJECT;

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
const cdp = await ctx.newCDPSession(page);
if (cpu > 1) await cdp.send("Emulation.setCPUThrottlingRate", { rate: cpu });
await cdp.send("Profiler.enable");
await cdp.send("Profiler.setSamplingInterval", { interval: 200 });

const composer = page.getByPlaceholder(/に送る/).first();
const url = `${base}/p/${projectId}?bantoToken=${token}&bantoHost=${api}`;
if (what === "open") await cdp.send("Profiler.start");
await page.goto(url);
await composer.waitFor({ timeout: 60_000 });
await page.waitForTimeout(what === "open" ? 6000 : 8000);
if (what === "type") {
  await composer.click();
  await cdp.send("Profiler.start");
  await composer.pressSequentially("もっさり計測テストの文字列です abcdefghij", { delay: 30 });
  await page.waitForTimeout(500);
}
if (what === "fork") {
  await cdp.send("Profiler.start");
  await page.getByTestId("sidebar-fork-name").first().click();
  await page.waitForTimeout(6000);
}
const { profile } = await cdp.send("Profiler.stop");
if (what === "type") await composer.fill("");
await browser.close();

// self time を関数（名前＋ファイル＋位置）ごとに集計
const byId = new Map(profile.nodes.map((n) => [n.id, n]));
const dt = profile.timeDeltas;
const self = new Map();
profile.samples.forEach((id, i) => self.set(id, (self.get(id) ?? 0) + (dt[i] ?? 0)));
const agg = new Map();
let total = 0;
for (const [id, us] of self) {
  const n = byId.get(id);
  const cf = n.callFrame;
  if (cf.functionName === "(idle)" || cf.functionName === "(program)") continue;
  total += us;
  const file = cf.url.split("/").pop() || cf.url || "";
  const key = `${cf.functionName || "(anon)"}  ${file}:${cf.lineNumber}:${cf.columnNumber}`;
  agg.set(key, (agg.get(key) ?? 0) + us);
}
// ファイルごと
const byFile = new Map();
for (const [id, us] of self) {
  const cf = byId.get(id).callFrame;
  if (cf.functionName === "(idle)" || cf.functionName === "(program)") continue;
  const file = cf.url.split("/").pop() || cf.functionName;
  byFile.set(file, (byFile.get(file) ?? 0) + us);
}
console.log(`== ${what}（CPU ×${cpu}）忙しかった合計 ${Math.round(total / 1000)} ms`);
console.log("-- ファイル別");
for (const [k, v] of [...byFile].sort((a, b) => b[1] - a[1]).slice(0, 10)) console.log(`${String(Math.round(v / 1000)).padStart(6)} ms  ${k}`);
console.log("-- 関数別");
for (const [k, v] of [...agg].sort((a, b) => b[1] - a[1]).slice(0, 25)) console.log(`${String(Math.round(v / 1000)).padStart(6)} ms  ${k}`);

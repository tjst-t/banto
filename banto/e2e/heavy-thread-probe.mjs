// 長い会話・Fork が画面を重くしているかを測る（2026-09-29、ユーザー指摘
// 「長いセッションでも全ログを画面に保持している。Fork でも全ログが出る」）。
// テストではない。読むだけ（発言・変更はしない）。
//
// 使い方: PROBE_TOKEN=... node heavy-thread-probe.mjs [base] [api|ui|all]
//   base の既定は https://banto.tjstkm.net（画面も API も同じ口）
import { chromium } from "@playwright/test";

const base = process.argv[2] ?? "https://banto.tjstkm.net";
// 画面と API を別の口にするとき（直した画面を 4197 で起こし、API は稼働中の host を使う）
const api = process.env.PROBE_API ?? base;
const mode = process.argv[3] ?? "all";
const token = process.env.PROBE_TOKEN;
if (!token) throw new Error("PROBE_TOKEN が要る");
const auth = { authorization: `Bearer ${token}` };

async function get(path) {
  const t0 = performance.now();
  const res = await fetch(`${api}${path}`, { headers: auth });
  const text = await res.text();
  return { ms: Math.round(performance.now() - t0), bytes: text.length, json: res.ok ? JSON.parse(text) : null, status: res.status };
}

// ---- 1. host の記録の大きさ ----
const projects = (await get("/api/projects")).json.filter((p) => p.status === "active");
const perProject = [];
for (const p of projects) {
  const threads = (await get(`/api/projects/${p.id}/threads`)).json;
  const open = threads.filter((t) => t.status === "active");
  let bytes = 0;
  let msgs = 0;
  const rows = [];
  for (const t of open) {
    const r = await get(`/api/threads/${t.id}`);
    const m = r.json?.messages ?? [];
    const textBytes = m.reduce((s, x) => s + (x.text?.length ?? 0), 0);
    bytes += r.bytes;
    msgs += m.length;
    rows.push({ id: t.id.slice(0, 8), kind: t.kind, msgs: m.length, kb: Math.round(r.bytes / 1024), textKb: Math.round(textBytes / 1024), ms: r.ms });
  }
  perProject.push({ name: p.name, id: p.id, openThreads: open.length, totalThreads: threads.length, msgs, mb: +(bytes / 1048576).toFixed(2), rows });
}
perProject.sort((a, b) => b.msgs - a.msgs);
console.log("== host の記録（開いている Thread だけ）");
for (const p of perProject) {
  console.log(`${p.name}  開いている ${p.openThreads}/${p.totalThreads} 本・発言 ${p.msgs}・${p.mb} MB`);
  for (const r of p.rows) console.log(`   ${r.kind.padEnd(4)} ${r.id} 発言 ${String(r.msgs).padStart(4)}  応答 ${r.kb} KB（本文 ${r.textKb} KB）${r.ms} ms`);
}
if (mode === "api") process.exit(0);

// ---- 2. 画面：一番重い Project を開いて測る ----
const target = perProject[0];
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
// PROBE_CPU=4 で CPU を 4 倍遅くする（ノート PC・携帯の見込み）
const cpu = Number(process.env.PROBE_CPU ?? "1");
if (cpu > 1) {
  const cdp = await ctx.newCDPSession(page);
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: cpu });
}
console.log(`\n(CPU ×${cpu})`);
await page.addInitScript(() => {
  window.__lt = [];
  new PerformanceObserver((l) => {
    for (const e of l.getEntries()) window.__lt.push({ at: Math.round(e.startTime), d: Math.round(e.duration) });
  }).observe({ entryTypes: ["longtask"] });
  window.__ev = [];
  new PerformanceObserver((l) => {
    for (const e of l.getEntries()) window.__ev.push({ name: e.name, d: Math.round(e.duration), proc: Math.round(e.processingEnd - e.processingStart) });
  }).observe({ type: "event", durationThreshold: 16, buffered: true });
});
const composer = page.getByPlaceholder(/に送る/).first();
const t0 = Date.now();
await page.goto(`${base}/p/${target.id}?bantoToken=${token}&bantoHost=${api}`);
await composer.waitFor({ timeout: 60_000 });
// 記録が流し込まれ終わるまで：メッセージの数が 1 秒変わらなくなるまで
let last = -1;
for (let i = 0; i < 30; i++) {
  const n = await page.locator("[data-role]").count();
  if (n === last && n > 0) break;
  last = n;
  await page.waitForTimeout(1000);
}
const openMs = Date.now() - t0;
const snap = async () =>
  page.evaluate(() => ({
    dom: document.getElementsByTagName("*").length,
    heapMb: performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null,
    longTaskMs: window.__lt.reduce((s, e) => s + e.d, 0),
    longTaskMax: Math.max(0, ...window.__lt.map((e) => e.d)),
    msgNodes: document.querySelectorAll("[data-role]").length,
    viewports: document.querySelectorAll(".aui-thread-viewport").length,
  }));
const afterOpen = await snap();
console.log(`\n== 画面：${target.name} を開く`);
console.log(`開いて落ち着くまで ${openMs} ms`, afterOpen);

// 文字を打つ：1文字ごとの反応（event timing の duration）
await page.evaluate(() => {
  window.__lt = [];
  window.__ev = [];
});
await composer.click();
const typeT0 = Date.now();
await composer.pressSequentially("もっさり計測テストの文字列です abcdefghij", { delay: 30 });
const typeMs = Date.now() - typeT0;
const typing = await page.evaluate(() => {
  const ds = window.__ev.filter((e) => ["keydown", "keypress", "keyup", "input", "beforeinput"].includes(e.name)).map((e) => e.d);
  ds.sort((a, b) => a - b);
  return { slowEvents: ds.length, p50: ds[Math.floor(ds.length / 2)] ?? 0, max: ds.at(-1) ?? 0, longTaskMs: window.__lt.reduce((s, e) => s + e.d, 0) };
});
console.log(`文字を打つ（30字・30ms 間隔、理想 ${30 * 30} ms）→ ${typeMs} ms`, typing);
await composer.fill(""); // 書きかけを残さない

// Fork を順に開く（左の一覧の Fork の名前を押す）。押してから、長い処理が止むまで
const forks = page.getByTestId("sidebar-fork-name");
const nForks = Math.min(await forks.count(), 3);
for (let i = 0; i < nForks; i++) {
  const name = await forks.nth(i).innerText();
  await page.evaluate(() => {
    window.__lt = [];
  });
  const before = await page.locator("[data-role]").count();
  const tf = Date.now();
  await forks.nth(i).click();
  // 発言の数が増えて 700ms 変わらなくなるまで
  let prev = -1;
  for (let k = 0; k < 40; k++) {
    await page.waitForTimeout(350);
    const n = await page.locator("[data-role]").count();
    if (n === prev && n !== before) break;
    prev = n;
  }
  const s = await snap();
  console.log(`Fork「${name}」を開く ${Date.now() - tf} ms（落ち着き待ち込み）`, { msgNodes: s.msgNodes, dom: s.dom, heapMb: s.heapMb, longTaskMs: s.longTaskMs, longTaskMax: s.longTaskMax });
}

await ctx.close();
await browser.close();

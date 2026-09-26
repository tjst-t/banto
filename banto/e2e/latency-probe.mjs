// 人の操作ごとに「押してから、画面が必要とする通信がすべて返るまで」を測る。
// perf-probe.mjs は「入力欄が出るまで」しか見ないので、Project を開く・設定画面の
// 節を開く・Command Palette、のように**中身が後から届く画面**の遅さが見えない。
// テストではない（playwright の testDir は specs/ なので拾われない）。
//
// 使い方: node latency-probe.mjs [frontendBaseUrl] [hostUrl] [configPath]
//   例: node latency-probe.mjs http://127.0.0.1:4175 http://127.0.0.1:4737
//   WATCH_FRONT=1 … 画面（Next.js）への要求も並べる／ONLY_FIRST=1 … 初回表示だけ／SHOW=60 … 並べる本数
//   数字の読み方と前回の値は docs/notes/2026-09-26-latency-fixes.md
//
// **本番（4175/4737）に当てると Project を順に開く**——開いた Project の Module が起きる（人が開いたのと同じ）。
// 会話には何も書かない。
// 「落ち着いた」＝ host・サンドボックスへの要求が 400ms 何も起きずに0本になった時点。
// 流しっぱなしの口（SSE）は数えない。
import { chromium } from "@playwright/test";
import { readFileSync } from "node:fs";

const base = process.argv[2] ?? "http://127.0.0.1:4175";
const host = process.argv[3] ?? "http://127.0.0.1:4737";
const configPath = process.argv[4] ?? "/home/ubuntu/.config/banto/config.json";
const token = JSON.parse(readFileSync(configPath, "utf8")).authToken;
const hostPort = new URL(host).port;
const QUIET_MS = 400;

const isStream = (url) => /\/stream(\?|$)|\/api\/events(\?|$)/.test(url);
const frontPort = new URL(base).port;
const WATCH_FRONT = process.env.WATCH_FRONT === "1";
const watched = (url) =>
  url.includes(`:${hostPort}/`) || url.includes(":4176/") || url.includes(":4198/") ||
  (WATCH_FRONT && url.includes(`:${frontPort}/`));

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();

const inflight = new Map();
let log = [];
let lastActivity = Date.now();
const shortUrl = (u) => u.replace(/^https?:\/\/[^/]+/, "").replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, "<id>").slice(0, 110);
ctx.on("request", (r) => {
  if (!watched(r.url()) || isStream(r.url())) return;
  inflight.set(r, Date.now());
  lastActivity = Date.now();
});
const done = (r, failed) => {
  const t = inflight.get(r);
  if (t === undefined) return;
  inflight.delete(r);
  lastActivity = Date.now();
  log.push({ url: `${r.method()} ${shortUrl(r.url())}`, start: t, end: Date.now(), failed });
};
ctx.on("requestfinished", (r) => done(r, false));
ctx.on("requestfailed", (r) => done(r, true));

async function settle(t0, maxMs = 30_000) {
  // 操作が要求を出し始めるまで少し待つ
  await page.waitForTimeout(50);
  while (Date.now() - t0 < maxMs) {
    if (inflight.size === 0 && Date.now() - lastActivity >= QUIET_MS) break;
    await page.waitForTimeout(25);
  }
  const ends = log.map((l) => l.end);
  return (ends.length ? Math.max(...ends) : t0) - t0;
}

const results = [];
async function measure(label, action, { visible } = {}) {
  log = [];
  const t0 = Date.now();
  await action();
  let visibleMs = null;
  if (visible) {
    await visible();
    visibleMs = Date.now() - t0;
  }
  const settled = await settle(t0);
  const reqs = log
    .map((l) => ({ url: l.url, at: l.start - t0, ms: l.end - l.start, failed: l.failed || undefined }))
    .sort((a, b) => a.at - b.at);
  results.push({ label, settledMs: settled, visibleMs, requests: reqs.length });
  console.log(`\n== ${label}: 落ち着くまで ${settled} ms${visibleMs !== null ? ` / 見えるまで ${visibleMs} ms` : ""}（要求 ${reqs.length} 本）`);
  for (const r of reqs.filter((r) => r.ms >= 50 || r.at >= 50).slice(0, Number(process.env.SHOW ?? 25))) {
    console.log(`   +${String(r.at).padStart(5)}  ${String(r.ms).padStart(5)} ms  ${r.url}${r.failed ? " (failed)" : ""}`);
  }
}

const composer = () => page.getByPlaceholder(/に送る/).waitFor({ timeout: 60_000 });

await measure(
  "初回表示",
  () => page.goto(`${base}/?bantoToken=${token}&bantoHost=${host}`),
  { visible: async () => { await page.waitForURL(/\/p\/[0-9a-f-]+/, { timeout: 60_000 }); await composer(); } },
);

if (process.env.ONLY_FIRST === "1") { await browser.close(); process.exit(0); }

// Project を順に開く（サイドバーの Project 名）
const projectLinks = page.locator('a[href^="/p/"]:has([data-testid="sidebar-project-name"])');
const n = await projectLinks.count();
const names = [];
for (let i = 0; i < n; i++) names.push((await projectLinks.nth(i).innerText()).trim());
for (let i = 0; i < n; i++) {
  await measure(`Project を開く: ${names[i]}`, () => projectLinks.nth(i).click(), { visible: composer });
}
// 2周目（温まった状態）
for (let i = 0; i < Math.min(n, 3); i++) {
  await measure(`Project を開く（2回目）: ${names[i]}`, () => projectLinks.nth(i).click(), { visible: composer });
}

// 設定画面
await measure("設定を開く", () => page.getByRole("link", { name: "設定" }).click(), {
  visible: () => page.getByPlaceholder("検索（設定項目の中身も対象）").waitFor(),
});
const labels = await page.evaluate(() => {
  const input = document.querySelector("input[placeholder^='検索（設定項目']");
  let col = input;
  for (let i = 0; i < 6 && col; i++) {
    if (col.querySelectorAll("button").length > 2) break;
    col = col.parentElement;
  }
  return col ? [...col.querySelectorAll("button")].map((b) => b.innerText.trim()).filter(Boolean) : [];
});
for (const label of labels) {
  await measure(`設定の節: ${label}`, () => page.getByRole("button", { name: label, exact: true }).first().click());
}

// Command Palette
await page.keyboard.press("Escape");
await page.waitForTimeout(300);
await measure("Command Palette", () => page.keyboard.press("Control+k"));

console.log("\n=== まとめ ===");
for (const r of results) {
  console.log(`${String(r.settledMs).padStart(6)} ms  ${r.visibleMs !== null ? `(見える ${r.visibleMs} ms) ` : ""}${r.label}`);
}
await browser.close();

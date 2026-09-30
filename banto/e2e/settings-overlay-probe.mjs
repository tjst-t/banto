// 設定を重ねて開く・閉じる／設定を開いたまま Project を切り替える、を実データで確かめる（読むだけ）。
// 使い方: PROBE_TOKEN=... PROBE_API=https://banto.tjstkm.net node settings-overlay-probe.mjs http://127.0.0.1:4197
import { chromium } from "@playwright/test";

const base = process.argv[2] ?? "http://127.0.0.1:4197";
const api = process.env.PROBE_API ?? base;
const token = process.env.PROBE_TOKEN;
const projects = await (await fetch(`${api}/api/projects`, { headers: { authorization: `Bearer ${token}` } })).json();
const a = projects.find((p) => p.name === "Banto開発");
const b = projects.find((p) => p.name === "HOME");

const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
const t0 = Date.now();
await page.goto(`${base}/p/${a.id}?bantoToken=${token}&bantoHost=${api}`);
const composerA = page.getByPlaceholder(/Banto開発 の Base Thread に送る/);
await composerA.waitFor({ timeout: 60_000 });
await page.waitForTimeout(2500);
console.log(`開いた ${Date.now() - t0} ms`);

// 会話の面に目印を付け、上へ少しスクロールし、書きかけを入れる
const vp = page.locator('[data-slot="aui_thread-viewport"]').first();
await vp.evaluate((el) => {
  el.__probeMark = "same";
  el.scrollTo({ top: el.scrollHeight / 2, behavior: "instant" });
});
await composerA.fill("書きかけの文");
const scrollBefore = await vp.evaluate((el) => Math.round(el.scrollTop));

// 設定を開く（サイドバーの「設定」）
const t1 = Date.now();
await page.locator('a[href*="settings=1"]').first().click();
await page.locator("[data-banto-settings]").waitFor({ timeout: 15_000 });
console.log(`設定が出るまで ${Date.now() - t1} ms  URL ${new URL(page.url()).pathname}${new URL(page.url()).search.replace(/bantoToken=[^&]+&?/, "")}`);
const underAlive = await page.evaluate(() => {
  const el = document.querySelector('[data-slot="aui_thread-viewport"]');
  return { alive: el?.__probeMark === "same", inert: !!el?.closest("[inert]") };
});
console.log("設定を開いている間の下の会話", underAlive);

// Escape で閉じる
const t2 = Date.now();
await page.keyboard.press("Escape");
await page.locator("[data-banto-settings]").waitFor({ state: "detached", timeout: 15_000 });
console.log(`閉じるまで ${Date.now() - t2} ms`);
const after = await page.evaluate(() => {
  const el = document.querySelector('[data-slot="aui_thread-viewport"]');
  return { sameElement: el?.__probeMark === "same", scrollTop: Math.round(el?.scrollTop ?? -1) };
});
console.log("閉じた後", after, "スクロール（前）", scrollBefore, "書きかけ", await composerA.inputValue());
await composerA.fill("");

// 設定を開いたまま、別の Project（HOME）を押す
await page.locator('a[href*="settings=1"]').first().click();
await page.locator("[data-banto-settings]").waitFor({ timeout: 15_000 });
const t3 = Date.now();
await page.getByTestId("sidebar-project-name").filter({ hasText: /^HOME$/ }).first().click();
await page.waitForURL((u) => u.pathname === `/p/${b.id}`, { timeout: 15_000 });
console.log(`切り替え ${Date.now() - t3} ms  URL ${new URL(page.url()).pathname}  設定は開いたまま: ${await page.locator("[data-banto-settings]").isVisible()}`);
console.log("設定の層の見出し", (await page.locator("p.tracking-wide").allInnerTexts()).map((s) => s.trim()));
await page.keyboard.press("Escape");
await page.locator("[data-banto-settings]").waitFor({ state: "detached", timeout: 15_000 });
const composerB = page.getByPlaceholder(/HOME の Base Thread に送る/);
await composerB.waitFor({ timeout: 15_000 });
console.log("閉じた後の会話: HOME", await composerB.isVisible());
await browser.close();

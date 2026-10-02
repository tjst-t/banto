// 携帯の幅でナビ（≡ の Drawer）を実データで確かめる（読むだけ。移動と Drawer の開閉しかしない）。
// (1) 別 Project を押すと、Fork があれば Drawer が閉じずにその Project の目次が開く
// (2) Fork の面にも ≡ があり、そこから別の Fork・別 Project へ1回で行ける
// 使い方: PROBE_TOKEN=... PROBE_API=https://banto.tjstkm.net node mobile-nav-probe.mjs http://127.0.0.1:4197 [出力フォルダ]
import { chromium } from "@playwright/test";

const base = process.argv[2] ?? "http://127.0.0.1:4197";
const out = process.argv[3] ?? "/tmp/mobile-nav-probe";
const api = process.env.PROBE_API ?? base;
const token = process.env.PROBE_TOKEN;
const auth = { headers: { authorization: `Bearer ${token}` } };
const projects = await (await fetch(`${api}/api/projects`, auth)).json();
const here = projects.find((p) => p.name === "Banto開発") ?? projects[0];

const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })).newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
await page.goto(`${base}/p/${here.id}?bantoToken=${token}&bantoHost=${api}`);
await page.getByPlaceholder(/の Base Thread に送る/).waitFor({ timeout: 90_000 });
await page.waitForTimeout(1500);

const navButton = page.getByRole("button", { name: "Project と Thread の一覧を開く" });
const drawer = page.getByRole("dialog", { name: "Project と Thread の一覧" });
const pathOf = () => new URL(page.url()).pathname + new URL(page.url()).search.replace(/bantoToken=[^&]+&?|bantoHost=[^&]+&?/g, "");

await navButton.first().click();
await drawer.waitFor({ timeout: 10_000 });
await page.waitForTimeout(500);
await page.screenshot({ path: `${out}-1-drawer.png` });

// Fork を持つ別の Project を探す（Drawer の中の行から）
const names = await drawer.getByTestId("sidebar-project-name").allTextContents();
console.log("Project:", names.join(" / "));
let target = null;
for (const name of names) {
  if (name === here.name) continue;
  const p = projects.find((x) => x.name === name);
  if (!p) continue;
  const threads = await (await fetch(`${api}/api/projects/${p.id}/threads`, auth)).json().catch(() => []);
  const forks = Array.isArray(threads) ? threads.filter((t) => t.kind === "fork" && t.state !== "folded" && t.state !== "closed") : [];
  if (forks.length > 0) { target = name; break; }
}
console.log("Fork のある別 Project:", target);

if (target) {
  await drawer.getByTestId("sidebar-project-name").filter({ hasText: target }).first().click();
  await page.waitForTimeout(2500);
  const stillOpen = await drawer.isVisible();
  const forkNames = await drawer.getByTestId("sidebar-fork-name").allTextContents();
  console.log("(1) 別 Project を押したあと: Drawer", stillOpen ? "開いたまま" : "閉じた", " URL", pathOf(), " 見えている Fork", forkNames.length);
  await page.screenshot({ path: `${out}-2-switched.png` });

  // その Project の Fork を1つ押す
  const forkLink = drawer.locator("a").filter({ has: page.getByTestId("sidebar-fork-name") });
  // 新しく選んだ Project の行の下にある Fork（いま開いている目次は1つだけのはず）
  await forkLink.first().click();
  await page.waitForTimeout(2500);
  console.log("   Fork を押したあと: Drawer", (await drawer.isVisible()) ? "開いたまま" : "閉じた", " URL", pathOf());
  await page.screenshot({ path: `${out}-3-fork.png` });

  // (2) Fork の面から ≡ を押す
  const visibleNav = navButton.locator("visible=true");
  console.log("(2) Fork の面の ≡:", await visibleNav.count(), "個見えている");
  await visibleNav.first().click();
  await drawer.waitFor({ timeout: 10_000 });
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${out}-4-drawer-from-fork.png` });
  // 元の Project（Fork が無ければ閉じる／あれば開いたまま）
  await drawer.getByTestId("sidebar-project-name").filter({ hasText: here.name }).first().click();
  await page.waitForTimeout(2500);
  console.log("   元の Project を押したあと: Drawer", (await drawer.isVisible()) ? "開いたまま" : "閉じた", " URL", pathOf());
  await page.screenshot({ path: `${out}-5-back.png` });
}
console.log("ページのエラー:", errors.length ? errors : "なし");
await browser.close();

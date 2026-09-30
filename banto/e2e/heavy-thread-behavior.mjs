// 「それより前を表示」と Fork の親の分の出し方が、決めたとおりに動くかを実データで見る（読むだけ）。
// 使い方: PROBE_TOKEN=... PROBE_API=https://banto.tjstkm.net node heavy-thread-behavior.mjs http://127.0.0.1:4197
import { chromium } from "@playwright/test";

const base = process.argv[2] ?? "http://127.0.0.1:4197";
const api = process.env.PROBE_API ?? base;
const token = process.env.PROBE_TOKEN;
const projects = await (await fetch(`${api}/api/projects`, { headers: { authorization: `Bearer ${token}` } })).json();
const target = projects.find((p) => p.name === "Banto開発");

const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
await page.goto(`${base}/p/${target.id}?bantoToken=${token}&bantoHost=${api}`);
await page.getByPlaceholder(/に送る/).first().waitFor({ timeout: 60_000 });
await page.waitForTimeout(3000);

const vp = page.locator('[data-slot="aui_thread-viewport"]').first();
const state = () =>
  vp.evaluate((el) => ({
    msgs: el.querySelectorAll("[data-role]").length,
    fromBottom: Math.round(el.scrollHeight - el.scrollTop - el.clientHeight),
    firstVisible: (() => {
      const top = el.getBoundingClientRect().top;
      for (const m of el.querySelectorAll("[data-message-id]")) {
        const r = m.getBoundingClientRect();
        if (r.bottom > top) return { id: m.getAttribute("data-message-id"), offset: Math.round(r.top - top) };
      }
      return null;
    })(),
  }));
console.log("開いた直後（一番下にいるはず）", await state());
const btn = vp.getByTestId("show-earlier-messages");
console.log("ボタン:", await btn.innerText());
// 一番上まで上げてからボタンを押す——見ていた発言がずれないこと
await vp.evaluate((el) => el.scrollTo({ top: 0, behavior: "instant" }));
await page.waitForTimeout(300);
const before = await state();
await btn.click();
await page.waitForTimeout(500);
const after = await state();
console.log("押す前", before);
console.log("押した後", after);
const offsetOf = async (id) =>
  vp.evaluate((el, id) => {
    const m = el.querySelector(`[data-message-id="${id}"]`);
    return m ? Math.round(m.getBoundingClientRect().top - el.getBoundingClientRect().top) : null;
  }, id);
console.log(`押す前に上端にあった発言 ${before.firstVisible?.id} の位置: 前 ${before.firstVisible?.offset} → 後 ${await offsetOf(before.firstVisible?.id)}`);
console.log("ボタン（押した後）:", (await btn.count()) ? await btn.innerText() : "（無し）");

// Fork を開いて、親の分が最後の1件だけか
await page.getByTestId("sidebar-fork-name").first().click();
await page.waitForTimeout(2500);
const panes = page.locator('[data-slot="aui_thread-viewport"]');
for (let i = 0; i < (await panes.count()); i++) {
  const s = await panes.nth(i).evaluate((el) => ({
    msgs: el.querySelectorAll("[data-role]").length,
    ids: [...el.querySelectorAll("[data-message-id]")].slice(0, 3).map((m) => m.getAttribute("data-message-id")),
    button: el.querySelector('[data-testid="show-earlier-messages"]')?.textContent ?? null,
    placeholder: el.querySelector("textarea")?.getAttribute("placeholder"),
  }));
  console.log(`面 ${i}`, s);
}
const cards = await page.getByTestId("fork-open-card").allInnerTexts();
console.log("親の会話の Fork の入口:", cards.map((t) => t.replace(/\s+/g, " ")).slice(0, 5));
await browser.close();

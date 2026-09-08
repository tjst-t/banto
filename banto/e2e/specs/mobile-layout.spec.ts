// 携帯で会話するときの約束（ユーザー報告・2026-09-07、Android 実機）。
//
//   **ヘッダと入力欄は常に見えていて、その間に履歴があり、
//     スクロールすれば一番上から一番下まで辿れる。**
//
// キーボードが出た状態は自動では作れない（実機の機能）。代わりに
// **画面の高さを縮めて**同じ形を再現する——`interactive-widget=resizes-content`
// を指定してある以上、キーボードが出たときに起きることは「レイアウトの高さが
// 縮む」であって、それはここで測れる。
//
// **指定が無いと何が起きるか**：Android Chrome の既定（`resizes-visual`）では
// キーボードでレイアウトが縮まないため、入力欄はキーボードの裏に入り、
// ブラウザが入力欄を見せようと画面を持ち上げてヘッダが上に逃げる。
import { test, expect } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openApp } from "../helpers.js";

test.describe.configure({ mode: "serial" });
test.setTimeout(300_000);
test.use({ viewport: { width: 412, height: 840 }, hasTouch: true });

const PROJECT_NAME = "E2E Mobile Layout";

/** ヘッダ・入力欄・履歴の器の位置を、画面の座標で測る。 */
async function layout(page: import("@playwright/test").Page) {
  return page.evaluate(() => {
    const rect = (el: Element | null) => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { top: Math.round(r.top), bottom: Math.round(r.bottom) };
    };
    const scroller = [...document.querySelectorAll("*")].find(
      (e) => e.scrollHeight > e.clientHeight + 4 && e.clientHeight > 100,
    );
    return {
      innerHeight: window.innerHeight,
      documentScrollHeight: document.documentElement.scrollHeight,
      header: rect(document.querySelector("header")),
      composer: rect(document.querySelector("textarea")),
      scroller: scroller
        ? {
            clientH: scroller.clientHeight,
            scrollH: scroller.scrollHeight,
            scrollTop: Math.round(scroller.scrollTop),
          }
        : null,
    };
  });
}

test("携帯では、ヘッダと入力欄が常に見えて、履歴は端まで辿れる", async ({ page }) => {
  const projectRoot = mkdtempSync(join(tmpdir(), "banto-e2e-mobile-"));

  await openApp(page);
  await page.getByRole("button", { name: "新しい Project", exact: true }).click();
  await page.getByLabel("Project 名").fill(PROJECT_NAME);
  await page.getByLabel("Base パス").fill(projectRoot);
  await page.getByRole("button", { name: "作成する" }).click();
  await expect(page.getByText(`Base Thread — ${PROJECT_NAME}`)).toBeVisible({ timeout: 15_000 });

  // **キーボードでレイアウトを縮める**指定が出ていること（これが無いと実機で崩れる）
  const viewportMeta = await page.locator('meta[name="viewport"]').getAttribute("content");
  expect(viewportMeta, "キーボードでレイアウトを縮める指定が無い").toContain(
    "interactive-widget=resizes-content",
  );

  // 履歴を溢れさせる（1ターンで十分な長さを返させる）
  const composer = page.getByPlaceholder(/に送る/);
  await composer.fill("1 から 60 までの数字を、1行に1つずつ、番号だけ並べて出して。");
  await composer.press("Enter");
  await expect(page.locator('[data-role="assistant"]').filter({ hasText: "60" })).toBeVisible({
    timeout: 120_000,
  });

  for (const height of [840, 400]) {
    await page.setViewportSize({ width: 412, height });
    await page.waitForTimeout(600);
    const l = await layout(page);
    const what = `高さ${height}`;

    // **画面そのものはスクロールしない**（履歴の器だけが動く）
    expect(l.documentScrollHeight, `${what}: 画面ごとスクロールしている`).toBeLessThanOrEqual(
      l.innerHeight + 1,
    );
    // ヘッダは一番上に、入力欄は画面の中に収まっている
    expect(l.header?.top, `${what}: ヘッダが画面の外にある`).toBe(0);
    expect(l.composer, `${what}: 入力欄が無い`).not.toBeNull();
    expect(l.composer!.bottom, `${what}: 入力欄が画面の下に隠れている`).toBeLessThanOrEqual(
      l.innerHeight,
    );
    expect(l.composer!.top, `${what}: 入力欄が画面の上に隠れている`).toBeGreaterThanOrEqual(0);
    // 間に履歴の場所が残っている
    expect(l.scroller?.clientH ?? 0, `${what}: 履歴の場所が無い`).toBeGreaterThan(50);
  }

  // **一番上まで辿れる**（開いた直後は一番下にいる）
  const scrollTo = async (to: "top" | "bottom") =>
    page.evaluate((to) => {
      const el = [...document.querySelectorAll("*")].find(
        (e) => e.scrollHeight > e.clientHeight + 4 && e.clientHeight > 100,
      );
      if (!el) return;
      el.scrollTo({ top: to === "top" ? 0 : el.scrollHeight, behavior: "instant" });
    }, to);

  await scrollTo("top");
  await page.waitForTimeout(500);
  await expect(
    page.locator('[data-role="user"]').first(),
    "一番上まで辿っても、最初の発言が見えない",
  ).toBeVisible();

  await scrollTo("bottom");
  await page.waitForTimeout(500);
  await expect(
    page.locator('[data-role="assistant"]').last(),
    "一番下まで辿っても、最後の返事が見えない",
  ).toBeVisible();
});

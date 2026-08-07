/**
 * 広い画面の器。
 *
 * 狭いときと違い、チャットとキャンバスは**同時に出る**。境界は掴んで動かせる（PO要望
 * 2026-07-31）ので、その掴み手が在ることまで見る。
 *
 * 前提: `npm run build:web` 済み（packages/banto-web/dist）。
 */

import { test, expect } from "@playwright/test";
import { startLayoutHost, type LayoutHost } from "./layoutHost.js";

let host: LayoutHost;

test.beforeAll(async () => {
  host = await startLayoutHost();
});

test.afterAll(async () => {
  await host.close();
});

test.describe("広い画面の器", () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1400, height: 900 });
    await page.goto(`http://127.0.0.1:${host.port}/`);
    await page.waitForSelector(".shell");
  });

  test("チャットとキャンバスが同時に出て、境界を掴める", async ({ page }) => {
    await expect(page.locator(".chat-scroll")).toBeVisible();
    await expect(page.locator(".canvas-tabbar")).toBeVisible();
    // 下端の切替はスマホ用。広い画面では出さない
    await expect(page.locator(".mobile-footer")).toBeHidden();

    const resizer = page.locator(".pane-resizer");
    await expect(resizer).toBeVisible();
  });

  /**
   * 境界は**どの家でも掴める**。符牒は見た目を1本の罫（1px）に落としているので、
   * 掴める幅は罫の左右へ食み出した当たり（`::before`）が持つ——見た目を細くした結果
   * 掴めなくなっていないかを、家ごとに確かめる（PO報告 2026-08-06）。
   */
  for (const family of ["washi", "fucho"]) {
    test(`境界をドラッグするとチャット欄の幅が変わる：${family}`, async ({ page }) => {
      await page.evaluate((f) => localStorage.setItem("banto.theme", `${f}:light`), family);
      await page.reload();
      await page.waitForSelector(".shell");

      const chat = page.locator(".chat-pane");
      const before = (await chat.boundingBox())!.width;

      const handle = (await page.locator(".pane-resizer").boundingBox())!;
      const y = handle.y + handle.height / 2;
      await page.mouse.move(handle.x + handle.width / 2, y);
      await page.mouse.down();
      // チャットは右側にあるので、左へ動かすほど広くなる
      await page.mouse.move(handle.x - 120, y, { steps: 8 });
      await page.mouse.up();

      const after = (await chat.boundingBox())!.width;
      expect(after, "境界を掴めていない").toBeGreaterThan(before + 80);
    });
  }

  test("中身を送っても、タブ列は上端に居座る", async ({ page }) => {
    const tabbar = page.locator(".canvas-tabbar");
    const before = await tabbar.boundingBox();

    const scroller = page.locator(".canvas-body .cv-scroll").first();
    const moved = await scroller.evaluate((el) => {
      el.scrollTop = el.scrollHeight;
      return el.scrollTop;
    });
    expect(moved, "キャンバスの中身が短すぎて送れていない").toBeGreaterThan(0);

    expect((await tabbar.boundingBox())?.y).toBe(before?.y);
  });
});

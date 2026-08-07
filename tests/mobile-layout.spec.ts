/**
 * 狭い画面の器（スマホ幅）。
 *
 * 見たいのは**道具立てが居座ること**——キャンバスの中身をどれだけ送っても、タブ列と
 * 「開く」は上端に残る。以前はこれを `position: sticky` が付いているかで見ていたが、
 * 器は「タブ列＝伸びない枠 ＋ 中身＝自分でスクロールする箱」で組んであり、sticky は
 * 使っていない（付けても何もしない）。**姿勢ではなく振る舞いで確かめる**。
 *
 * 前提: `npm run build:web` 済み（packages/banto-web/dist）。
 */

import { test, expect, type Page } from "@playwright/test";
import { startLayoutHost, type LayoutHost } from "./layoutHost.js";

let host: LayoutHost;

test.beforeAll(async () => {
  host = await startLayoutHost();
});

test.afterAll(async () => {
  await host.close();
});

test.describe("狭い画面の器", () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 780 });
    await page.goto(`http://127.0.0.1:${host.port}/`);
    await page.waitForSelector(".shell");
    // 狭い画面ではチャットとキャンバスが排他。キャンバス側へ移る
    await page.locator(".mobile-footer-btn", { hasText: "キャンバス" }).click();
    await expect(page.locator(".canvas-tabbar")).toBeVisible();
  });

  test("中身を送っても、タブ列は上端に居座る", async ({ page }) => {
    const tabbar = page.locator(".canvas-tabbar");
    const before = await tabbar.boundingBox();
    expect(before, "タブ列が描かれていない").not.toBeNull();

    // キャンバスの中身（ファイル一覧）を送る。送れる高さが無いと検証にならない
    const scroller = page.locator(".canvas-body .cv-scroll").first();
    const moved = await scroller.evaluate((el) => {
      el.scrollTop = el.scrollHeight;
      return el.scrollTop;
    });
    expect(moved, "キャンバスの中身が短すぎて送れていない").toBeGreaterThan(0);

    const after = await tabbar.boundingBox();
    expect(after?.y).toBe(before?.y);
    await expect(tabbar).toBeInViewport();
  });

  test("面そのものは動かない（ページごと横にも縦にもずれない）", async ({ page }) => {
    const overflow = await page.evaluate(() => ({
      x: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      y: document.documentElement.scrollHeight - document.documentElement.clientHeight,
    }));
    expect(overflow.x, "横スクロールが生えている").toBeLessThanOrEqual(0);
    expect(overflow.y, "ページごとスクロールしている").toBeLessThanOrEqual(0);
  });

  test("チャットとキャンバスは排他（下端の切替で入れ替わる）", async ({ page }: { page: Page }) => {
    await expect(page.locator(".chat-scroll")).toBeHidden();

    await page.locator(".mobile-footer-btn", { hasText: "チャット" }).click();
    await expect(page.locator(".chat-scroll")).toBeVisible();
    await expect(page.locator(".canvas-tabbar")).toBeHidden();
  });
});

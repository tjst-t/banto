/**
 * 狭い画面の器（スマホ幅）。**重ねる**（ADR-0017 決定79）。
 *
 * 幹が地、作業する面は下から上がる紙で、上端に幹が覗く。下端の切替は無くなった
 * ——覗きが戻り道そのものなので、同じことを2通りに持たない。
 *
 * 見たいのは**道具立てが居座ること**——面の中身をどれだけ送っても、タブ列と「開く」は
 * 上端に残る。器は「タブ列＝伸びない枠 ＋ 中身＝自分でスクロールする箱」で組んであり、
 * sticky は使っていない。**姿勢ではなく振る舞いで確かめる**。
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

test.describe("狭い画面の器", () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 780 });
    await page.goto(`http://127.0.0.1:${host.port}/`);
    await page.waitForSelector(".shell");
    // 面が開いていれば、それが上がってきた紙として出ている（決定79）
    await expect(page.locator(".canvas-tabbar")).toBeVisible();
  });

  test("中身を送っても、タブ列は上端に居座る", async ({ page }) => {
    const tabbar = page.locator(".canvas-tabbar");
    const before = await tabbar.boundingBox();
    expect(before, "タブ列が描かれていない").not.toBeNull();

    const scroller = page.locator(".canvas-body .cv-scroll").first();
    const moved = await scroller.evaluate((el) => {
      el.scrollTop = el.scrollHeight;
      return el.scrollTop;
    });
    expect(moved, "面の中身が短すぎて送れていない").toBeGreaterThan(0);

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

  test("面は上がってきた紙。上端に幹が覗き、押すと幹へ戻る", async ({ page }) => {
    await expect(page.locator(".work")).toHaveClass(/is-raised/);
    // 幹は**地として在り続ける**（畳めない・決定77）
    await expect(page.locator(".room--trunk")).toBeAttached();

    const peek = page.locator(".peek");
    await expect(peek).toBeVisible();
    await peek.click();

    await expect(page.locator(".work")).toHaveCount(0);
    await expect(page.locator(".room--trunk .chat-scroll")).toBeVisible();
    await expect(page.locator(".peek")).toHaveCount(0);
  });
});

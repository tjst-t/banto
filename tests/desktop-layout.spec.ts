/**
 * 広い画面の器（ADR-0017 決定79）。
 *
 * **作業する面が開いているときだけ**、会話と面が同時に出る——会話は細い帯になり、
 * つまんで幅を変えられる。面が無いときは会話が全幅を使う（400px の列に押し込まない）。
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

  test("面が開いていると、会話は細い帯として左に残る", async ({ page }) => {
    await expect(page.locator(".chat-scroll")).toBeVisible();
    await expect(page.locator(".work-head")).toBeVisible();
    // **話しかけられる**——そこで読むのではなく、話しかけるための幅だから
    await expect(page.locator(".room .chat-input")).toBeVisible();
    // 下端の切替はスマホ用。広い画面では出さない
    await expect(page.locator(".mobile-footer")).toHaveCount(0);

    const room = (await page.locator(".room").boundingBox())!;
    expect(room.width, "細い帯の下限（260px）を割っている").toBeGreaterThanOrEqual(260);
    expect(room.width, "細い帯の上限（620px）を超えている").toBeLessThanOrEqual(620);
  });

  /**
   * 帯は**どの家でも掴める**。符牒は見た目を1本の罫（1px）に落としているので、
   * 掴める幅は罫の左右へ食み出した当たり（`::before`）が持つ（PO報告 2026-08-06）。
   */
  for (const family of ["washi", "fucho"]) {
    test(`帯をドラッグすると会話の幅が変わる：${family}`, async ({ page }) => {
      await page.evaluate((f) => localStorage.setItem("banto.theme", `${f}:light`), family);
      await page.reload();
      await page.waitForSelector(".shell");

      const room = page.locator(".room");
      const before = (await room.boundingBox())!.width;

      const handle = (await page.locator(".room-grip").boundingBox())!;
      const y = handle.y + handle.height / 2;
      await page.mouse.move(handle.x + handle.width / 2, y);
      await page.mouse.down();
      // 会話は左にあるので、右へ動かすほど広くなる
      await page.mouse.move(handle.x + 140, y, { steps: 8 });
      await page.mouse.up();

      const after = (await room.boundingBox())!.width;
      expect(after, "帯を掴めていない").toBeGreaterThan(before + 80);
    });
  }

  test("中身を送っても、面の頭は上端に居座る", async ({ page }) => {
    const tabbar = page.locator(".work-head");
    const before = await tabbar.boundingBox();

    const scroller = page.locator(".canvas-body .cv-scroll").first();
    const moved = await scroller.evaluate((el) => {
      el.scrollTop = el.scrollHeight;
      return el.scrollTop;
    });
    expect(moved, "キャンバスの中身が短すぎて送れていない").toBeGreaterThan(0);

    expect((await tabbar.boundingBox())?.y).toBe(before?.y);
  });

  test("面を全部閉じると、会話が全幅を使う", async ({ page }) => {
    const room = page.locator(".room");
    const slim = (await room.boundingBox())!.width;

    // 面は1枚ずつ畳む（タブ列は無い。開いた面はレールの点に並ぶ）
    for (let i = 0; i < 4 && (await page.locator(".work").count()) > 0; i++) {
      await page.locator(".work-head .room-back").click();
      await page.waitForTimeout(150);
    }

    await expect(page.locator(".work")).toHaveCount(0);
    const wide = (await room.boundingBox())!.width;
    expect(wide, "面を畳んでも会話が細いまま").toBeGreaterThan(slim + 200);
  });
});

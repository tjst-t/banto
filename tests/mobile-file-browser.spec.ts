/**
 * 狭い画面のファイル閲覧（spec-file-browser §2.4・§6.2・§6.4）。
 *
 * PO報告 2026-08-08「操作部分が場所を取りすぎて、ファイルの表示領域が小さすぎる」。
 * 直したものを**測って守る**——畳んだ道具立ては、放っておくと戻ってくる。
 *
 * `mobile-layout.spec.ts` が器（タブ列が居座るか・面ごとずれないか）を見るのに対し、
 * ここは**面の中の寸法**を見る。当たりの大きさを誰も測っていなかったのが inc-0040。
 *
 * 前提: `npm run build:web` 済み（packages/banto-web/dist）。
 */

import { test, expect, type Page } from "@playwright/test";
import { startLayoutHost, type LayoutHost } from "./layoutHost.js";

/** 実機の目安。狭さの判定はキャンバスの幅（760px）なので、これで十分に狭い。 */
const PHONE = { width: 390, height: 780 };

let host: LayoutHost;

test.beforeAll(async () => {
  host = await startLayoutHost();
});

test.afterAll(async () => {
  await host.close();
});

async function openCanvas(page: Page): Promise<void> {
  await page.setViewportSize(PHONE);
  await page.goto(`http://127.0.0.1:${host.port}/`);
  await page.waitForSelector(".shell");
  await page.locator(".mobile-footer-btn", { hasText: "キャンバス" }).click();
  await page.waitForSelector(".fb-entry");
}

/** 面の中で「押せるもの」の高さ。38px を下回っていたら名前つきで返す。 */
async function tooSmall(page: Page, min: number, selector: string): Promise<string[]> {
  return page.evaluate(
    ({ min, selector }) =>
      Array.from(document.querySelectorAll(selector))
        .filter((el) => (el as HTMLElement).offsetParent !== null)
        .map((el) => ({ el, h: el.getBoundingClientRect().height }))
        .filter(({ h }) => h > 0 && h < min)
        .map(({ el, h }) => `${el.className || el.tagName}: ${Math.round(h)}px`),
    { min, selector }
  );
}

test.describe("狭い画面のファイル閲覧", () => {
  test.beforeEach(async ({ page }) => {
    await openCanvas(page);
  });

  test("一覧の行は 44px、そのほかの当たりは 38px 以上", async ({ page }) => {
    // 一覧の行はこの面で最も押すもの。38px は下限であって、続けて押すものの寸法ではない
    const rows = await tooSmall(page, 44, ".fb-entry");
    expect(rows, `一覧の行が小さい: ${rows.join(" / ")}`).toEqual([]);

    const controls = await tooSmall(
      page,
      38,
      ".cv .cv-btn:not(.is-small), .cv .cv-chip, .cv .cv-seg-opt, .cv .cv-iconbtn, .cv .cv-search-input, .fb-crumb, .place-btn"
    );
    expect(controls, `指で押せない当たり: ${controls.join(" / ")}`).toEqual([]);
  });

  test("パンくずの末尾（いまいる所）は必ず見えている", async ({ page }) => {
    // 深いところへ潜っても、切れて消えるのが「いまいる所」であってはならない
    for (const name of ["packages", "packages", "packages"]) {
      await page.locator(".fb-entry", { hasText: name }).first().click();
      await page.waitForTimeout(120);
    }
    const state = await page.evaluate(() => {
      const bar = document.querySelector(".fb-crumbs");
      const crumbs = Array.from(document.querySelectorAll(".fb-crumb"));
      const last = crumbs[crumbs.length - 1];
      if (!bar || !last) return null;
      const b = bar.getBoundingClientRect();
      const l = last.getBoundingClientRect();
      return {
        visible: l.right <= b.right + 1 && l.left >= b.left - 1,
        text: last.textContent,
        // 横に流していないこと（隠れていることも数も見えなくなる）
        scrollable: bar.scrollWidth > bar.clientWidth + 1,
      };
    });
    expect(state?.visible, `末尾が器の外: ${state?.text ?? "(無し)"}`).toBe(true);
    expect(state?.scrollable, "パンくずが横に流れている").toBe(false);
  });

  test("ファイルを開くと、本文が画面の 70% 以上を使う", async ({ page }) => {
    await page.locator(".fb-entry", { hasText: "README.md" }).first().click();
    await page.waitForSelector(".fb-body");

    const m = await page.evaluate(() => {
      const box = (s: string): number => {
        const el = document.querySelector(s);
        return el ? el.getBoundingClientRect().height : 0;
      };
      return {
        body: box(".fb-body"),
        head: box(".fb-file-head"),
        // 読んでいる間、上段（場所・パンくず）は畳む
        whereVisible: document.querySelector(".fb-where") !== null
          ? (document.querySelector(".fb-where") as HTMLElement).offsetParent !== null
          : false,
        viewport: window.innerHeight,
      };
    });
    expect(m.whereVisible, "読んでいる間に上段が居座っている").toBe(false);
    expect(m.head, "中身の頭が1段に収まっていない").toBeLessThanOrEqual(52);
    expect(
      m.body / m.viewport,
      `本文が ${Math.round(m.body)}px / ${m.viewport}px しかない`
    ).toBeGreaterThan(0.7);
  });

  test("送ると頭と屋号の帯が退き、上へ送ると戻る", async ({ page }) => {
    await page.locator(".fb-entry", { hasText: "README.md" }).first().click();
    await page.waitForSelector(".fb-body");

    const headShown = async (): Promise<boolean> =>
      page.locator(".fb-file-head").isVisible();
    expect(await headShown()).toBe(true);

    await page.locator(".fb-body").evaluate((el) => {
      el.scrollTop = 400;
      el.dispatchEvent(new Event("scroll"));
    });
    await page.waitForTimeout(200);
    expect(await headShown(), "送っても頭が退かない").toBe(false);
    expect(
      await page.evaluate(() => document.documentElement.hasAttribute("data-retract")),
      "屋号の帯へ伝わっていない"
    ).toBe(true);

    // 上へ送れば戻る。**戻すための新しい操作を作らない**
    await page.locator(".fb-body").evaluate((el) => {
      el.scrollTop = 200;
      el.dispatchEvent(new Event("scroll"));
    });
    await page.waitForTimeout(200);
    expect(await headShown(), "上へ送っても頭が戻らない").toBe(true);
  });

  test("道具立ては常設2段（92px 前後）に収まる", async ({ page }) => {
    const bars = await page.evaluate(() =>
      Array.from(document.querySelectorAll(".cv .cv-bar")).map((el) =>
        Math.round(el.getBoundingClientRect().height)
      )
    );
    expect(bars.length, `道具立てが ${bars.length} 段ある`).toBe(2);
    const total = bars.reduce((a, b) => a + b, 0);
    expect(total, `道具立てが ${total}px を取っている`).toBeLessThanOrEqual(100);
  });

  test("HTML は隔離した枠で描く（allow-same-origin を付けない）", async ({ page }) => {
    await page.locator(".fb-entry", { hasText: "page.html" }).first().click();
    const frame = page.locator(".fb-frame");
    await expect(frame).toBeVisible();
    const sandbox = await frame.getAttribute("sandbox");
    expect(sandbox, "sandbox が無い").not.toBeNull();
    expect(sandbox ?? "", "allow-same-origin を付けてはいけない").not.toContain("allow-same-origin");
  });

  test("画像はそのまま出し、別タブへも出せる", async ({ page }) => {
    await page.locator(".fb-entry", { hasText: "shot.png" }).first().click();
    await expect(page.locator(".fb-image")).toBeVisible();
    const href = await page.locator(".fb-open").getAttribute("href");
    expect(href, "別タブの行き先が無い").toContain("/raw/");
    expect(await page.locator(".fb-open").getAttribute("target")).toBe("_blank");
  });

  test("面ごと横にも縦にもずれない", async ({ page }) => {
    await page.locator(".fb-entry", { hasText: "README.md" }).first().click();
    await page.waitForSelector(".fb-body");
    const overflow = await page.evaluate(() => ({
      x: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      y: document.documentElement.scrollHeight - document.documentElement.clientHeight,
    }));
    expect(overflow.x, "横スクロールが生えている").toBeLessThanOrEqual(0);
    expect(overflow.y, "ページごとスクロールしている").toBeLessThanOrEqual(0);
  });
});

test.describe("絞ると探す（§4.3・§4.4）", () => {
  test.beforeEach(async ({ page }) => {
    await openCanvas(page);
  });

  test("欄は1つ。打つと絞る", async ({ page }) => {
    const fields = page.locator(".cv .cv-search-input");
    await expect(fields).toHaveCount(1);
    await fields.fill("README");
    await expect(page.locator(".fb-entry")).toHaveCount(1);
  });

  test("欄から ↓ で一覧へ入り、キーで辿れる（§4.5）", async ({ page }) => {
    await page.locator(".cv-search-input").focus();
    await page.keyboard.press("ArrowDown");
    expect(await page.evaluate(() => document.activeElement?.className)).toContain("fb-entry");
    await page.keyboard.press("ArrowDown");
    const second = await page.evaluate(() => document.activeElement?.textContent);
    await page.keyboard.press("ArrowUp");
    const first = await page.evaluate(() => document.activeElement?.textContent);
    expect(first).not.toBe(second);
    // → でディレクトリへ入る
    await page.keyboard.press("ArrowRight");
    await expect(page.locator(".fb-crumb.is-last")).toHaveText("packages");
    // ← で親へ戻る
    await page.locator(".fb-entry").first().focus();
    await page.keyboard.press("ArrowLeft");
    await expect(page.locator(".fb-crumb.is-home.is-last")).toBeVisible();
  });

  test("ディレクトリを移ると絞りは外れる", async ({ page }) => {
    await page.locator(".cv-search-input").fill("packages");
    await expect(page.locator(".fb-entry")).toHaveCount(1);
    await page.locator(".fb-entry", { hasText: "packages" }).first().click();
    await expect(page.locator(".cv-search-input")).toHaveValue("");
    // 絞りが残っていると、移った先が空に見える
    expect(await page.locator(".fb-entry").count()).toBeGreaterThan(1);
  });
});

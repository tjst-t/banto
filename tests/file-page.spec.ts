/**
 * 別タブで開く1枚と、整形表示の幅（spec-file-browser §5.8.4・§5.6）。
 *
 * PO報告 2026-08-09：
 *
 * > マークダウンとかを別タブで開いたときにソースファイル表示になるけど、別タブでは
 * > マークダウンに限らずすべてプレビュー表示にしてほしい
 * > あとマークダウンのプレビュー表示だけど、謎の空白が右側にできるので全幅使ってほしい
 *
 * どちらも**見た目でしか分からない**——`file.raw` へ送っていたことも、`max-width` で
 * 余っていたことも、型と単体試験は素通りしていた。だからここは実際に描いて測る。
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

test.describe("別タブの1枚（§5.8.4）", () => {
  test("Markdown が整形で出る（原文に戻らない）", async ({ page }) => {
    await page.goto(
      `http://127.0.0.1:${host.port}/?file=README.md&place=demo&ep=${encodeURIComponent("/api/file")}`
    );
    await page.waitForSelector(".fp-body");

    // 偽ホストが返す中身には `## 見出し` が入っている。整形されていれば h2 になる
    await expect(page.locator(".fp-body .markdown h2").first()).toBeVisible();
    // 会話もキャンバスも立てない（1枚のために殻ごと起こさない）
    expect(await page.locator(".shell").count(), "殻まで立ち上がっている").toBe(0);
  });

  test("「原文」に切り替えれば行番号つきで読める", async ({ page }) => {
    await page.goto(
      `http://127.0.0.1:${host.port}/?file=README.md&place=demo&ep=${encodeURIComponent("/api/file")}`
    );
    await page.waitForSelector(".fp-body .markdown");

    await page.locator(".cv-seg-opt", { hasText: "原文" }).click();
    await expect(page.locator(".fp-body .fb-code").first()).toBeVisible();
  });

  test("外を指す到達先は「別タブの位置」として認めない", async ({ page }) => {
    await page.goto(
      `http://127.0.0.1:${host.port}/?file=README.md&place=demo&ep=${encodeURIComponent("//evil.example/api")}`
    );
    // いつもの画面が出る（1枚は出さない）
    await page.waitForSelector(".shell");
    expect(await page.locator(".fp").count()).toBe(0);
  });
});

test.describe("面から別タブへの行き先", () => {
  test("Markdown は1枚へ、HTML は raw のまま", async ({ page }) => {
    // **一覧と詳細が同時に出る幅**で見る。作業する面はレールと会話の帯を除いた残りなので、
    // 既定の 1280 だと面の内幅が 760px を割り、一覧がドリルダウンへ切り替わる（§2）
    await page.setViewportSize({ width: 1600, height: 900 });
    await page.goto(`http://127.0.0.1:${host.port}/`);
    await page.waitForSelector(".fb-entry");

    const openHref = async (name: string): Promise<string> => {
      await page.locator(".fb-entry", { hasText: name }).first().click();
      await page.waitForSelector(".fb-file-head");
      await page.locator(".fb-file-head .cv-iconbtn").last().click();
      const href = await page
        .locator(".fb-menu a", { hasText: "別タブで開く" })
        .getAttribute("href");
      await page.keyboard.press("Escape");
      return href ?? "";
    };

    // 整形で読める種別は1枚へ送る（raw だと text/plain ＝原文しか出せない）
    expect(await openHref("README.md")).toContain("file=README.md");
    // ブラウザ自身が描ける種別は raw のまま——1枚に載せると iframe の中に押し込むことになる
    expect(await openHref("page.html")).toContain("/raw/");
  });
});

test.describe("整形表示の幅（§5.6）", () => {
  test("Markdown の本文が器の幅を使い切る", async ({ page }) => {
    await page.setViewportSize({ width: 1600, height: 900 });
    await page.goto(`http://127.0.0.1:${host.port}/`);
    await page.waitForSelector(".fb-entry");
    await page.locator(".fb-entry", { hasText: "README.md" }).first().click();
    await page.waitForSelector(".fb-preview .markdown");

    const m = await page.evaluate(() => {
      const wrap = document.querySelector(".fb-preview");
      const md = document.querySelector(".fb-preview .markdown");
      if (!wrap || !md) return null;
      const w = wrap.getBoundingClientRect();
      const style = getComputedStyle(wrap);
      const inner = w.width - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
      return { inner, text: md.getBoundingClientRect().width };
    });
    expect(m, "整形表示が出ていない").not.toBeNull();
    // 右に余りを作らない。**測るのは器の内側**（余白は意匠として残す）
    expect(
      Math.round(m!.text),
      `本文が ${Math.round(m!.text)}px / 器 ${Math.round(m!.inner)}px しか使っていない`
    ).toBeGreaterThanOrEqual(Math.round(m!.inner) - 1);
  });
});

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
    const scroller = document.querySelector<HTMLElement>('[data-slot="aui_thread-viewport"]');
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
      const el = document.querySelector<HTMLElement>('[data-slot="aui_thread-viewport"]');
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

/**
 * 一番下にいるときの「位置関係」を測る。
 *
 * **間隔の px を比べてはいけない**（実測・2026-09-07で踏んだ）——中身が画面を
 * 埋めていないときの間隔は「余白」であって位置関係ではない（高さ840では317px、
 * 縮めて中身が溢れると35px）。**約束は「一番下のまま、最後の発言が隠れない」**。
 */
async function bottomState(page: import("@playwright/test").Page) {
  return page.evaluate(() => {
    const sc = document.querySelector<HTMLElement>('[data-slot="aui_thread-viewport"]');
    if (!sc) return null;
    const last = [...sc.querySelectorAll("[data-role]")].at(-1);
    const composer = document.querySelector("textarea");
    const header = document.querySelector("header");
    if (!last || !composer || !header) return null;
    const lastRect = last.getBoundingClientRect();
    return {
      atBottom: sc.scrollHeight - sc.scrollTop - sc.clientHeight <= 4,
      overflowing: sc.scrollHeight > sc.clientHeight + 4,
      scrollTop: Math.round(sc.scrollTop),
      lastBottom: Math.round(lastRect.bottom),
      lastTop: Math.round(lastRect.top),
      composerTop: Math.round(composer.getBoundingClientRect().top),
      headerBottom: Math.round(header.getBoundingClientRect().bottom),
    };
  });
}

test("一番下にいるときは、キーボードが出ても一番下のまま", async ({ page }) => {
  // **一番下にいた人が最後の発言を見失わない**（ユーザー要望・2026-09-07）。
  // 実測（直す前）：高さを縮めると `atBottom` が false に落ち、最後の発言は
  // 入力欄より下（bottom=703 / 入力欄 top=319）に取り残されていた。
  // **一番下以外では位置を動かさない**（読んでいるものを奪わない）。
  const projectRoot = mkdtempSync(join(tmpdir(), "banto-e2e-mobile-kb-"));

  await openApp(page);
  await page.getByRole("button", { name: "新しい Project", exact: true }).click();
  await page.getByLabel("Project 名").fill("E2E Mobile Keyboard");
  await page.getByLabel("Base パス").fill(projectRoot);
  await page.getByRole("button", { name: "作成する" }).click();
  await expect(page.getByText("Base Thread — E2E Mobile Keyboard")).toBeVisible({ timeout: 15_000 });

  const composer = page.getByPlaceholder(/に送る/);
  await composer.fill("1 から 80 までの数字を、1行に1つずつ、番号だけ並べて出して。");
  await composer.press("Enter");
  await expect(page.locator('[data-role="assistant"]').filter({ hasText: "80" })).toBeVisible({
    timeout: 120_000,
  });
  await page.waitForTimeout(1000);

  const toBottom = async () =>
    page.evaluate(() => {
      const sc = document.querySelector<HTMLElement>('[data-slot="aui_thread-viewport"]');
      sc?.scrollTo({ top: sc.scrollHeight, behavior: "instant" });
    });

  // **着くまで待つ**——返事の直後は中身の高さがまだ動く
  // （`mobile-transcript-height-jump`）。待ちを延ばすのではなく、着いたことを条件にする
  await expect
    .poll(async () => {
      await toBottom();
      return (await bottomState(page))?.atBottom ?? false;
    }, { timeout: 20_000 })
    .toBe(true);

  // キーボードが出た相当（レイアウトが縮む）
  await page.setViewportSize({ width: 412, height: 420 });
  await page.waitForTimeout(1000);
  const after = await bottomState(page);
  expect(after?.overflowing, "縮めても中身が溢れていない（この試験の意味が無い）").toBe(true);
  expect(after?.atBottom, "キーボードで一番下から外れた").toBe(true);
  expect(
    after!.lastBottom,
    `最後の発言が入力欄より下に取り残されている（発言の下端 ${after!.lastBottom} / 入力欄の上端 ${after!.composerTop}）`,
  ).toBeLessThanOrEqual(after!.composerTop);
  expect(after!.lastBottom, "最後の発言が画面より上に消えている").toBeGreaterThan(after!.headerBottom);

  // ---- 一番下以外では動かさない -------------------------------------------
  // **溢れている状態で**途中を読む形を作る（高さ840では中身が溢れず、
  // 「途中」を作れない——実測で踏んだ）。キーボードがさらに高くなる場合に相当
  const middle = await page.evaluate(() => {
    const sc = document.querySelector<HTMLElement>('[data-slot="aui_thread-viewport"]');
    if (!sc) return 0;
    sc.scrollTo({ top: Math.round((sc.scrollHeight - sc.clientHeight) / 2), behavior: "instant" });
    return Math.round(sc.scrollTop);
  });
  expect(middle, "途中の位置を作れていない").toBeGreaterThan(20);
  await page.waitForTimeout(500);

  await page.setViewportSize({ width: 412, height: 320 });
  await page.waitForTimeout(1000);
  const afterMiddle = await bottomState(page);
  expect(afterMiddle?.atBottom, "前提が崩れている（途中のはずが一番下にいる）").toBe(false);
  expect(
    Math.abs((afterMiddle?.scrollTop ?? 0) - middle),
    `途中を読んでいたのに位置が動いた（${middle} → ${afterMiddle?.scrollTop}）`,
  ).toBeLessThanOrEqual(8);
});

/**
 * 設定面に埋まったビューの上で、ホイールが効くこと（PO報告 2026-08-10）。
 *
 * **「マウスを端に持っていかないとスクロールできない」** という報告の再現。原因は
 * 埋まった面の中のスクロール領域（`.cv-scroll`）が、その場では**スクロールできない高さ**
 * なのに `overscroll-behavior: contain` でホイールを飲み込んでいたこと。
 *
 * ここはブラウザでしか出ない壊れ方（CSS の連鎖の話）なので、ブラウザ試験で押さえる。
 */

import { test, expect } from "@playwright/test";
import { startSettingsHost, type SettingsHost } from "./settingsHost.js";

let host: SettingsHost;

test.beforeAll(async () => {
  host = await startSettingsHost();
});

test.afterAll(async () => {
  await host.close();
});

test("設定のLLMの面は、中身の上でホイールを回してもスクロールする", async ({ page }) => {
  await page.setViewportSize({ width: 1200, height: 700 });
  await page.goto(`http://127.0.0.1:${host.port}/?view=settings&section=llm`);

  // 面が出るまで（埋まっているビューの中身で待つ）
  await expect(page.locator(".sp-content .llm-view")).toBeVisible();
  await expect(page.locator(".llm-prov").first()).toBeVisible();

  const scroller = page.locator(".sp-content");
  await expect(scroller).toHaveJSProperty("scrollTop", 0);

  // 中身が器より高いこと（高くなければ、この試験は何も確かめていない）
  const scrollable = await scroller.evaluate((el) => el.scrollHeight - el.clientHeight);
  expect(scrollable).toBeGreaterThan(100);

  // **埋まったビューのど真ん中**でホイールを回す（報告された操作そのもの）。
  // 位置は**画面の中央**を採る——埋まったビューは器より遥かに高いので、要素の箱の
  // 中心を使うと画面の外を指してしまい、ホイールがどこにも届かない
  const center = { x: 600, y: 350 };
  const under = await page.evaluate(
    (p) => (document.elementFromPoint(p.x, p.y)?.closest(".cv-scroll") ? "view" : "outside"),
    center
  );
  expect(under).toBe("view");
  await page.mouse.move(center.x, center.y);
  await page.mouse.wheel(0, 400);

  await expect
    .poll(async () => await scroller.evaluate((el) => el.scrollTop), { timeout: 3000 })
    .toBeGreaterThan(0);
});

test("職人の設定はモジュールの GUI として描かれ、変更は設定画面の口から送られる", async ({ page }) => {
  await page.setViewportSize({ width: 1200, height: 700 });
  await page.goto(`http://127.0.0.1:${host.port}/?view=settings&section=worker-pool`);

  // モジュールの区画でも GUI が描ける（決定43 の開放）
  await expect(page.locator(".ws-view")).toBeVisible();
  await expect(page.locator(".ws-backend-name", { hasText: "Claude Code" })).toBeVisible();
  // 使えるかどうかは**確かめられた分だけ**出す（I1）
  await expect(page.locator(".ws-backend-state", { hasText: "認証が見つかりません" })).toBeVisible();

  // 等級ごとのモデルは、どのバックエンドのものも同じ表から選べる
  const select = page.getByLabel("高精度（reasoning） に当てるモデル");
  await expect(select).toHaveValue("opus");
  const options = await select.locator("option").allTextContents();
  expect(options.some((o) => o.includes("Claude Code: opus"))).toBe(true);
  expect(options.some((o) => o.includes("pi: 見本モデル 1"))).toBe(true);

  // 変更は settings.update を通る（モジュールが独自の口を生やさない）
  await select.selectOption("demo-provider/demo-model-01");
  await expect(page.locator(".cv-note", { hasText: "変えました。" }).first()).toBeVisible();
});

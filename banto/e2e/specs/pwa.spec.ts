// **アプリとして入れられる**（追加・2026-10-10、ユーザー報告「Windows では PWA にできたが Android ではできない」、
// docs/specs/v4-frontend.md §6.37）。画面に manifest が無く、Android の Chrome はインストールできなかった。
//
// Android の Chrome が入れる条件のうち、画面の側が持つものを見る：
//   1. ページが manifest を指し、manifest に名前・start_url・display・192 と 512 のアイコンがある
//   2. manifest・アイコンはログインしていなくても読める（ログインの前の端末がインストールする）
//   3. Service Worker を置かない（古い画面を抱え込み、更新したら画面も新しくする仕組み §6.34 とぶつかる）
import { test, expect } from "../test-base.js";

test("manifest とアイコンがログインの前から読め、Service Worker は置かない", async ({ browser, baseURL }) => {
  // ログインしていない端末として開く（test-base の context はログイン済みなので使わない）
  const context = await browser.newContext({ baseURL });
  const page = await context.newPage();
  await page.goto("/");

  const href = await page.locator('link[rel="manifest"]').getAttribute("href");
  expect(href, "ページが manifest を指していない").toBeTruthy();
  const res = await page.request.get(href!);
  expect(res.status(), "manifest が読めない").toBe(200);
  expect(res.headers()["content-type"]).toContain("manifest+json");
  const manifest = await res.json();
  expect(manifest.name).toBe("banto");
  expect(manifest.short_name).toBe("banto");
  expect(manifest.start_url).toBe("/");
  expect(manifest.display).toBe("standalone");

  const icons: { src: string; sizes: string; purpose?: string }[] = manifest.icons;
  for (const size of ["192x192", "512x512"]) {
    expect(icons.some((i) => i.sizes === size && (i.purpose ?? "any").includes("any")), `${size} のアイコンが無い`).toBe(true);
  }
  expect(icons.some((i) => i.purpose === "maskable"), "maskable のアイコンが無い").toBe(true);
  for (const icon of icons) {
    const r = await page.request.get(icon.src);
    expect(r.status(), `${icon.src} が読めない`).toBe(200);
    expect(r.headers()["content-type"]).toBe("image/png");
  }

  // タブと iOS のアイコンも読める
  for (const rel of ["icon", "apple-touch-icon"]) {
    const iconHref = await page.locator(`link[rel="${rel}"]`).first().getAttribute("href");
    expect(iconHref, `${rel} のリンクが無い`).toBeTruthy();
    expect((await page.request.get(iconHref!)).status(), `${rel} が読めない`).toBe(200);
  }

  const registrations = await page.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).length);
  expect(registrations, "Service Worker が登録された").toBe(0);
  await context.close();
});

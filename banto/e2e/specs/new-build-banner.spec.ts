// **banto を更新したあと、開いたままの画面に「新しい版の画面があります」を出す**（追加・2026-10-05、ユーザー報告
// 「更新したけど何も変わってなさそう」）。画面から更新しても、開いていたページは古い画面のプログラムのまま動いていた。
//
// ページは組み立てたときの印を持ち、画面のサーバは `/banto-build` で自分の印を返す。E2E の画面のサーバは1回しか
// 組み立てないので、「サーバが新しい版を返す」は `/banto-build` の返事を差し替えて作る。見るのは：
//   1. 同じ版なら出ない（読み込み直しを勧めない）
//   2. host に繋いだとき（hello）サーバの版が違えば出る・タブに戻ったときにも確かめる
//   3. 「読み込み直す」で読み込み直り、同じ版になれば消える
import { test, expect } from "../test-base.js";
import { openApp } from "../helpers.js";

test.setTimeout(120_000);

test("サーバの画面が新しい版なら帯を出し、読み込み直すと消える", async ({ page }) => {
  await openApp(page);
  const banner = page.getByTestId("new-build-banner");

  // 1. 同じ版——印は実際に返っていて、繋いだあとの確かめ（0秒・3秒）を過ぎても出ない
  const real = await (await page.request.get("/banto-build")).json();
  expect(typeof real.build, "画面のサーバが印を返さない").toBe("string");
  await page.waitForTimeout(4_500);
  await expect(banner, "同じ版なのに帯が出た").toHaveCount(0);

  // 2a. タブに戻ったときに確かめる
  await page.route("**/banto-build", (route) => route.fulfill({ json: { build: "e2e-newer-build" } }));
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await expect(banner, "タブに戻ったときに新しい版に気づかない").toBeVisible({ timeout: 10_000 });
  await expect(banner).toContainText("新しい版の画面があります");

  // 2b. 繋いだとき（hello）にも確かめる——読み込み直したページは、何もしなくても気づく
  await page.reload();
  await expect(banner, "繋いだときに新しい版に気づかない").toBeVisible({ timeout: 30_000 });

  // 3. 「読み込み直す」——サーバが同じ版を返すようになれば、読み込み直したあとは出ない
  await page.unroute("**/banto-build");
  await Promise.all([page.waitForEvent("load"), banner.getByRole("button", { name: "読み込み直す" }).click()]);
  await page.waitForTimeout(4_500);
  await expect(banner, "読み込み直しても帯が残った").toHaveCount(0);
});

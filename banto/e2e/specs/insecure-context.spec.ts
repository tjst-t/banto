// http（安全でない文脈）で開いたら、使わせずに HTTPS の住所へ案内する（決定・2026-10-03、ユーザー）。
//
// 携帯から http で開いていて、`crypto.randomUUID` が無く送信が落ちた（a029ea1a）。http ではほかにも
// ブラウザが出さない機能があり、合言葉も平文で流れるので、途中まで動かさず最初に止める。
//
// E2E の画面は 127.0.0.1（安全な文脈）で動いているので、**名前の付いた http の住所に見せかけて**同じ画面を
// 返す（Playwright の route で中身だけ 127.0.0.1 から取ってくる）。
import { test, expect } from "../test-base.js";
import { AUTH_TOKEN, FRONTEND_BASE_URL } from "../config.js";

const INSECURE_ORIGIN = "http://banto-insecure.test";

test("http の住所で開くと、合言葉を覚えずに「HTTPS で開いてください」と出し、同じ場所の https へ案内する", async ({ page }) => {
  await page.route(`${INSECURE_ORIGIN}/**`, async (route) => {
    const url = new URL(route.request().url());
    const response = await route.fetch({ url: `${FRONTEND_BASE_URL}${url.pathname}${url.search}` });
    await route.fulfill({ response });
  });

  await page.goto(`${INSECURE_ORIGIN}/p/some-project?bantoToken=${AUTH_TOKEN}`);
  expect(await page.evaluate(() => window.isSecureContext), "見せかけが安全な文脈になっている").toBe(false);

  const gate = page.getByTestId("insecure-gate");
  await expect(gate).toBeVisible({ timeout: 30_000 });
  await expect(gate.getByRole("heading", { name: "HTTPS で開いてください" })).toBeVisible();
  // 同じ名前・同じ場所の https へ（合言葉も一緒に運ぶ——http 側では覚えない）
  await expect(gate.getByRole("link", { name: "HTTPS で開き直す" })).toHaveAttribute(
    "href",
    `https://banto-insecure.test/p/some-project?bantoToken=${AUTH_TOKEN}`,
  );
  await expect(page.getByTestId("connect-gate"), "http なのに合言葉の入口が出た").toHaveCount(0);
  const stored = await page.evaluate(() => JSON.stringify(window.localStorage));
  expect(stored, "http の側に合言葉を覚えた").not.toContain(AUTH_TOKEN);
});

// **失敗したら見せる。そして巻き戻す**（`frontend-error-surfacing`、2026-09-10）。
//
// 画面側には「console.error だけ」「catch すら無い」が点在していた——host に
// 届かなかったのに、人には**何も起きていないように見える**。規則2 は
// 「エラーを握りつぶさない」で、それは画面でも同じ。
//
// 失敗のさせ方は**通信を止める**（`page.route` で abort）——core を落とすと
// 他の spec の足元まで崩れるうえ、見たいのは「画面がどう振る舞うか」なので、
// 届かない状況を作れば足りる。
import { test, expect } from "../test-base.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CORE_BASE_URL, AUTH_TOKEN } from "../config.js";
import { createProject, expectProjectOpen, openApp } from "../helpers.js";

test.describe.configure({ mode: "serial" });
test.setTimeout(180_000);
test.use({ viewport: { width: 390, height: 844 } });

const PROJECT_NAME = "E2E Error Surfacing Project";

test("permissionMode を保存できなかったら、そう言って元に戻す", async ({ page }) => {
  const projectRoot = mkdtempSync(join(tmpdir(), "banto-e2e-err-"));
  await openApp(page);
  await createProject(page, PROJECT_NAME, projectRoot);

  const indicator = page.getByRole("button", { name: /permissionMode/ });
  await expect(indicator).toHaveAccessibleName(/現在：auto/);

  // ここから先、保存は届かない
  await page.route("**/api/threads/*/permission-mode", (route) => route.abort("failed"));

  await indicator.click();
  await page.getByRole("menuitemradio", { name: /^plan/ }).click();

  // **失敗が見える**
  await expect(page.getByText(/permissionMode を保存できませんでした/)).toBeVisible({ timeout: 15_000 });
  // **巻き戻る**——選んだように見えたまま残らない（§6.4「見失わない」）
  await expect(indicator, "保存できなかったのに、選んだ値が残っている").toHaveAccessibleName(
    /現在：auto/,
    { timeout: 15_000 },
  );

  await page.unroute("**/api/threads/*/permission-mode");
});

test("会話を読み込めなかったら、そう言う（「読み込んでいます…」のまま黙らない）", async ({ page }) => {
  await page.route("**/api/projects/*/threads", (route) => route.abort("failed"));
  await page.goto(`/?bantoToken=${AUTH_TOKEN}&bantoHost=${CORE_BASE_URL}`);

  await expect(page.getByText(/読み込めませんでした|繋がりません/).first()).toBeVisible({
    timeout: 30_000,
  });
  await page.unroute("**/api/projects/*/threads");
});

test("banto に繋がらないとき、ホームは真っ白にならない——理由と、やり直す口を出す", async ({ page }) => {
  // 何も待ち受けていない口を指す（host を落とさずに「届かない」を作る）
  await page.goto(`/?bantoToken=${AUTH_TOKEN}&bantoHost=http://127.0.0.1:1`);

  const error = page.locator('[data-testid="home-load-error"]');
  await expect(error, "真っ白のまま止まっている").toBeVisible({ timeout: 30_000 });
  await expect(error.getByText("banto に繋がりません")).toBeVisible();
  await expect(error.getByRole("button", { name: "もう一度読み込む" })).toBeVisible();

  // 押せば取り直す（届く先に切り替えれば、ちゃんと進む）
  await page.goto(`/?bantoToken=${AUTH_TOKEN}&bantoHost=${CORE_BASE_URL}`);
  await expect(page.locator('[data-testid="home-load-error"]')).toHaveCount(0, { timeout: 30_000 });
});

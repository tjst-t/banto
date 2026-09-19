// **繋がっていないときに「無い」と言わない**（追加・2026-09-18、ユーザー要望）。
//
// 実際に踏んだ：http と https は**別のオリジン**なので、https で開いた瞬間に
// 保存済みの合言葉が見えなくなり、**Project が全部消えたように見えた**。
// データは無事だったが、画面が「まだ Project がありません」と言い切っていた
// ——**API を1回も呼ばずに**（規則2・規則13）。
//
// 見るのは4つ：
//   1. 合言葉が無ければ**ログインの面**が出る（「Project がありません」ではない）
//   2. **API を1回も呼んでいない**ことを、その面が言っている
//   3. **違う合言葉は覚えない**（間違った値を覚えると次も同じ空を見る）
//   4. 正しい合言葉を入れて Enter すると**実際に中身が出る**
import { test, expect } from "@playwright/test";
import { CORE_BASE_URL, AUTH_TOKEN, FRONTEND_BASE_URL } from "../config.js";

test.describe.configure({ mode: "serial" });
test.setTimeout(120_000);

test("合言葉が無いときは、ログインの面が出る——「Project がありません」とは言わない", async ({
  page,
}) => {
  // **合言葉を持たずに開く**（localStorage は空のまま）
  await page.goto(`${FRONTEND_BASE_URL}/`);

  await expect(page.getByTestId("connect-gate"), "ログインの面が出ない").toBeVisible({
    timeout: 30_000,
  });
  // **聞いていないのに「無い」と言わない**（ここが今回の本題）
  await expect(page.locator("body")).not.toContainText("まだ Project がありません");
  await expect(page.locator("body")).toContainText("まだ banto に繋がっていません");
});

test("違う合言葉は覚えない——通らなかったとそう言う", async ({ page }) => {
  await page.goto(`${FRONTEND_BASE_URL}/`);
  await page.getByLabel("合言葉").fill("wrong-token-0000");
  await page.getByLabel("banto の場所").fill(CORE_BASE_URL);
  await page.getByLabel("合言葉").press("Enter");

  await expect(page.getByTestId("connect-error"), "通らなかった理由が出ない").toContainText(
    "合言葉が違います",
    { timeout: 30_000 },
  );
  // **覚えていない**——覚えると、次に開いたときまた同じ空を見ることになる
  expect(
    await page.evaluate(() => window.localStorage.getItem("banto.backend")),
    "違う合言葉を覚えてしまった",
  ).toBeNull();
  // 面はそのまま（黙って中へ入れない）
  await expect(page.getByTestId("connect-gate")).toBeVisible();

  // **ヘッダに載らない文字も、そうと分かる形で断る**（追加・2026-09-18）
  // ——そのまま fetch に渡すと「non ISO-8859-1 code point」という、
  // 何を直せばよいか分からない文言が出ていた
  await page.getByLabel("合言葉").fill("でたらめな合言葉");
  await page.getByLabel("合言葉").press("Enter");
  await expect(page.getByTestId("connect-error")).toContainText("使えない文字");
});

test("正しい合言葉を入れて Enter すると、中身が出る", async ({ page }) => {
  await page.goto(`${FRONTEND_BASE_URL}/`);
  await page.getByLabel("合言葉").fill(AUTH_TOKEN);
  await page.getByLabel("banto の場所").fill(CORE_BASE_URL);
  await page.getByLabel("合言葉").press("Enter");

  // **ログインの面が消えて、本体が出る**（規則14——押せたで終わらせない）
  await expect(page.getByTestId("connect-gate"), "繋いだのに面が残っている").toHaveCount(0, {
    timeout: 30_000,
  });
  // **本体が出ている**（`openApp` と同じ区切り——先頭の Project へ移るか、
  // 本当に1つも無いかのどちらかに着く）
  await Promise.race([
    page.waitForURL(/\/p\/[0-9a-f-]+/, { timeout: 30_000 }),
    page.getByText("まだ Project がありません").waitFor({ state: "visible", timeout: 30_000 }),
  ]);

  // **合言葉は URL に残さない**（履歴とブックマークに焼き付く）
  expect(page.url(), "合言葉が URL に残っている").not.toContain("bantoToken");

  // 覚えている——**次に開いたときは、もう聞かれない**
  await page.reload();
  await expect(page.getByTestId("connect-gate")).toHaveCount(0, { timeout: 30_000 });
});

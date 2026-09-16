// **banto 全体の Module を、人が画面から触れる**（追加・2026-09-15、§10 item 14 (a)）。
//
// 見るのは規則13・規則14 の意味で「繋がっていること」：
//   1. 画面が**本物の宣言**を見ている（同梱5本が役割ごとに出る）
//   2. **止めると、押す前に何が断るかが出る**（§6.1）
//   3. 止めた結果が**実 host に届く**（画面の自己申告を信じない・規則1）
//   4. **外から足した Module は消せる／同梱は消せない**
//   5. **「この Project のフォルダ」を渡したかで、どこに立つかが変わる**——聞かない
import { test, expect } from "@playwright/test";
import { CORE_BASE_URL, AUTH_TOKEN } from "../config.js";
import { openApp } from "../helpers.js";

test.describe.configure({ mode: "serial" });
test.setTimeout(300_000);

const ADDED = `e2e-weather-${Date.now()}`;

async function openModuleSettings(page: import("@playwright/test").Page) {
  await openApp(page);
  await page.goto("/settings");
  await page.getByRole("button", { name: "役割と Module" }).click();
  await expect(page.getByTestId("instance-modules"), "Module の一覧が出ない").toBeVisible({
    timeout: 60_000,
  });
}

test("画面が本物の宣言を見ている——同梱が役割ごとに出る", async ({ page }) => {
  await openModuleSettings(page);
  // **実 host の宣言と突き合わせる**（画面の自己申告を信じない）
  const real = (await (
    await page.request.get(`${CORE_BASE_URL}/api/modules`, {
      headers: { authorization: `Bearer ${AUTH_TOKEN}` },
    })
  ).json()) as Array<{ name: string; origin: string }>;
  expect(real.length, "host が宣言を返していない").toBeGreaterThanOrEqual(5);

  for (const m of real) {
    await expect(page.locator(`[data-module="${m.name}"]`), `${m.name} が画面に出ていない`).toBeVisible();
  }
  // 同梱と外からを見分けられる
  await expect(page.locator('[data-module="vault-local"]')).toContainText("同梱");
  // どこに立つかが出ている
  await expect(page.locator('[data-module="shell"]')).toContainText("Project ごと");
  await expect(page.locator('[data-module="vault-directory"]')).toContainText("全体で1本");
});

test("止めるときは、押す前に何が断るかが出る——止めた結果は実 host に届く", async ({ page }) => {
  await openModuleSettings(page);

  await page.locator('[data-module="vault-directory"]').getByRole("switch").click();
  // **依存している Module の名前が、押す前に出る**（§6.1・規則2）
  await expect(page.getByText("vault-directory を止めますか")).toBeVisible();
  await expect(page.getByRole("alertdialog"), "何が断るようになるか出ていない").toContainText("shell");
  await page.getByRole("button", { name: "やめる" }).click();

  // 依存が無いものは、そう言う
  await page.locator('[data-module="filesystem"]').getByRole("switch").click();
  await expect(page.getByRole("alertdialog")).toContainText("依存している Module はありません");
  await page.getByRole("button", { name: "止める" }).click();

  // **画面が言うだけでなく、host に届いている**
  await expect
    .poll(
      async () => {
        const list = (await (
          await page.request.get(`${CORE_BASE_URL}/api/modules`, {
            headers: { authorization: `Bearer ${AUTH_TOKEN}` },
          })
        ).json()) as Array<{ name: string; enabled: boolean }>;
        return list.find((m) => m.name === "filesystem")?.enabled;
      },
      { timeout: 30_000, message: "止めたのに host に届いていない" },
    )
    .toBe(false);

  // **止めても一覧に残る**——消えたのか止めたのか分かる
  await expect(page.locator('[data-module="filesystem"]')).toBeVisible();
  await expect(page.getByTestId("module-state-filesystem")).toContainText("止めてあります");

  // 戻す（次の試験と実機を汚さない）
  await page.locator('[data-module="filesystem"]').getByRole("switch").click();
  await expect(page.getByTestId("module-state-filesystem")).not.toContainText("止めてあります", {
    timeout: 30_000,
  });
});

test("外から Module を足せる——どこに立つかは書いたもので決まり、同梱は消せない", async ({ page }) => {
  await openModuleSettings(page);

  await page.getByRole("button", { name: "Module を追加" }).click();
  await page.getByLabel("名前").fill(ADDED);
  await page.getByLabel("コマンド").fill("/bin/sh");
  await page.getByLabel("引数（空白区切り）").fill("-c true");
  // **聞かずに、書いたものから決まる**
  await expect(page.getByTestId("add-module-effect")).toContainText("banto 全体で1本");
  await page.getByRole("button", { name: "＋ この Project のフォルダを渡す" }).click();
  await expect(page.getByTestId("add-module-effect")).toContainText("Project ごとに1本");
  // この試験では全体で1本のほうを足す（Project を作らずに確かめられる）
  await page.getByLabel("引数（空白区切り）").fill("-c true");
  await expect(page.getByTestId("add-module-effect")).toContainText("banto 全体で1本");
  await page.getByRole("button", { name: "追加する" }).click();

  const row = page.locator(`[data-module="${ADDED}"]`);
  await expect(row, "足したのに一覧に出ない").toBeVisible({ timeout: 30_000 });
  await expect(row, "外から足したのに同梱扱い").toContainText("外から");
  // **外から繋ぐコードは必ず閉じ込める**
  await expect(row, "閉じ込めが掛かっていない").toContainText("閉じ込め");

  // **同梱には消すボタンが出ない**
  await expect(
    page.locator('[data-module="vault-local"]').getByRole("button", { name: /を消す/ }),
    "同梱に消すボタンが出ている",
  ).toHaveCount(0);

  // 外から足したものは消せる。**データは消さないと言ってから消す**
  await row.getByRole("button", { name: `${ADDED} を消す` }).click();
  await expect(page.getByRole("alertdialog")).toContainText("金庫に預けた秘密は消しません");
  await page.getByRole("button", { name: "消す" }).click();
  // **成功したときにだけ起きること**を待つ（規則14——押した直後に
  // 「エラーが出ていないこと」を見ても何も見ていない）。
  // 失敗しているなら、その理由をそのまま出す
  const gone = row.waitFor({ state: "detached", timeout: 30_000 }).then(() => "消えた");
  const failed = page
    .getByTestId("instance-modules-error")
    .waitFor({ state: "visible", timeout: 30_000 })
    .then(async () => `消せませんでした：${await page.getByTestId("instance-modules-error").innerText()}`);
  expect(await Promise.race([gone, failed])).toBe("消えた");
});

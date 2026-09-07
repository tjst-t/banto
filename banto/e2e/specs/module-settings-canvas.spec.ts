// Module 自身の設定画面（MCP Apps の設定 Canvas、§6.2、決定・2026-09-07）。
//
// **iOS でアプリの設定が OS の設定アプリに出てくるのと同じ形。**
// banto は値を持たない——読み書きはその Module 自身の tool で、banto は
// 「どこに出すか」を決めるだけ。だから確かめるのは：
//   1. 名乗った Module の設定画面が、設定の中に出る（中身まで）
//   2. **変えた値が Module 側に残る**（開き直しても戻らない）
//   3. **その値が実際に効く**（一覧の中身が変わる）
//
// **承認は求めない**（改訂・2026-09-07、ユーザー指示）——設定画面がその Module
// 自身の設定を読み書きするのは、画面が仕事をしているだけ。ここでは
// **承認が出ないこと**も確かめる（出ると、設定を見るたびに人を待たせる）。
import { test, expect } from "@playwright/test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openApp } from "../helpers.js";

test.describe.configure({ mode: "serial" });
test.setTimeout(300_000);
test.use({ viewport: { width: 390, height: 844 } });

const PROJECT_NAME = "E2E Module Settings";

test("Module の設定画面が出て、変えた値が Module に残り、実際に効く", async ({ page }) => {
  const projectRoot = mkdtempSync(join(tmpdir(), "banto-e2e-settings-"));
  // 隠しファイル（設定で出す／出さないが切り替わる対象）と、普通のファイル
  const hidden = `.hidden-${Date.now()}.txt`;
  const plain = `plain-${Date.now()}.txt`;
  writeFileSync(join(projectRoot, hidden), "隠し\n");
  writeFileSync(join(projectRoot, plain), "普通\n");

  const pageErrors: string[] = [];
  page.on("pageerror", (err) => pageErrors.push(err.message));

  await openApp(page);
  await page.getByRole("button", { name: "新しい Project", exact: true }).click();
  await page.getByLabel("Project 名").fill(PROJECT_NAME);
  await page.getByLabel("Base パス").fill(projectRoot);
  await page.getByRole("button", { name: "作成する" }).click();
  await expect(page.getByText(`Base Thread — ${PROJECT_NAME}`)).toBeVisible({ timeout: 15_000 });

  // 既定では隠しファイルも一覧に出る（あとで「出さない」に変える）
  const composer = page.getByPlaceholder(/に送る/);
  await composer.fill("このプロジェクトの直下（.）の一覧を取ってください。");
  await composer.press("Enter");
  const inner = page
    .frameLocator('[data-testid="module-canvas-frame"]')
    .frameLocator("iframe");
  await expect(inner.getByText(hidden), "既定では隠しファイルが出るはず").toBeVisible({ timeout: 120_000 });

  // ---- 1. 設定の中に、Module の設定画面が出る -----------------------------
  const canvas = await openModuleSettings(page);

  const settingsInner = canvas.locator("iframe").contentFrame().frameLocator("iframe");
  const checkbox = settingsInner.getByRole("checkbox");
  // **承認は出ない**——開いた瞬間に読めている
  await expect(page.locator('[data-testid="canvas-approval"]')).toHaveCount(0);
  await expect(checkbox, "いまの設定を読めていない").toBeChecked({ timeout: 30_000 });

  // ---- 2. 変えると、Module 側に残る ---------------------------------------
  await checkbox.uncheck();
  await settingsInner.getByRole("button", { name: "保存する" }).click();
  await expect(settingsInner.getByText(/保存しました/)).toBeVisible({ timeout: 30_000 });

  // 設定を開き直しても戻らない（＝banto が覚えているのではなく Module が持っている）
  await page.reload();
  await expect(page.getByText(`Base Thread — ${PROJECT_NAME}`)).toBeVisible({ timeout: 30_000 });
  const reopenedCanvas = await openModuleSettings(page);
  const reopened = reopenedCanvas.locator("iframe").contentFrame().frameLocator("iframe");
  await expect(reopened.getByRole("checkbox"), "開き直したら設定が戻ってしまった").not.toBeChecked({
    timeout: 30_000,
  });

  // ---- 3. その値が実際に効く ----------------------------------------------
  await page.getByRole("button", { name: "Project 設定を閉じる" }).click();
  await expect(page.getByText(/^Project 設定 —/).first()).not.toBeVisible({ timeout: 15_000 });
  const composer2 = page.getByPlaceholder(/に送る/);
  await composer2.fill("filesystem の listDirectory をもう一度呼んで、いまの直下（.）の一覧を見せて。");
  await composer2.press("Enter");
  // **いちばん新しい一覧が、変えた設定どおりになるまで待つ**。
  // 数で待つと脆い（会話の組み直しで前の画面が消えることがある）ので、
  // **見たい中身そのもの**を待つ（規則14）
  await expect(async () => {
    const f = page.locator('[data-testid="module-canvas-frame"]').last().contentFrame().frameLocator("iframe");
    await expect(f.getByText(plain), "一覧が出ていない").toBeVisible({ timeout: 5_000 });
    await expect(f.getByText(hidden), "**設定を変えたのに隠しファイルが出たまま**").toHaveCount(0);
  }).toPass({ timeout: 120_000 });

  expect(pageErrors, `画面側で例外が出た: ${pageErrors.join(" / ")}`).toEqual([]);
});

/** Project 設定 →「Module の設定」を開いて、filesystem の設定画面が出るまで待つ。
 *  **開き切ってから次へ進む**——途中で押すと、押した先が無い（実測・2026-09-07）。 */
async function openModuleSettings(page: import("@playwright/test").Page) {
  // **リロードしても開いたまま**（設定の開閉は URL が持っている）。開いているのに
  // もう一度開こうとすると、その場所にある×を押して閉じてしまう（実測・2026-09-07）
  const title = page.getByText(/^Project 設定 —/).first();
  if (!(await title.isVisible())) {
    await page.getByRole("button", { name: "Project 設定" }).click();
  }
  await expect(title).toBeVisible({ timeout: 30_000 });
  // **左メニューに Module ごとに並ぶ**（モックが決めた形、決定・2026-09-07）
  await page.getByRole("button", { name: "FileSystem", exact: true }).click();
  const canvas = page.locator('[data-testid="module-settings-canvas"][data-module="filesystem"]');
  await expect(canvas, "Module の設定画面が出ていない").toBeVisible({ timeout: 30_000 });
  return canvas;
}


test("設定の置き場は Module の scope が決める——Vault は全体、FileSystem は Project", async ({ page }) => {
  // instance に1本の Module（Vault）の設定を Project ごとに出すのはおかしい
  // （ユーザー指摘・2026-09-07）。置き場の判断を別に持たず、**既にある scope から
  // 導く**（規則3）ので、ここでは「どちらにどれが出るか」を直接見る。
  await openApp(page);

  // banto 全体の設定には Vault が出て、FileSystem は出ない
  await page.goto("/settings");
  // 左メニューには Vault が並び、Project ごとの Module（FileSystem）は並ばない
  const vaultNav = page.getByRole("button", { name: "Vault", exact: true });
  await expect(vaultNav, "全体の設定の左メニューに Vault が出ていない").toBeVisible({ timeout: 30_000 });
  await expect(
    page.getByRole("button", { name: "FileSystem", exact: true }),
    "Project ごとの Module が全体の設定の左メニューに出ている",
  ).toHaveCount(0);
  await vaultNav.click();
  await expect(
    page.locator('[data-testid="module-settings-canvas"][data-module="vault"]'),
    "全体の設定に Vault が出ていない",
  ).toBeVisible({ timeout: 30_000 });
  await expect(
    page.locator('[data-testid="module-settings-canvas"][data-module="filesystem"]'),
    "Project ごとの Module が全体の設定に出ている",
  ).toHaveCount(0);

  // 中身も本物（Vault が名乗った画面が描かれている）
  const vaultInner = page
    .locator('[data-testid="module-settings-canvas"][data-module="vault"] iframe')
    .contentFrame()
    .frameLocator("iframe");
  await expect(vaultInner.getByText(/alias|件/)).toBeVisible({ timeout: 60_000 });
});

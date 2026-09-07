// **人が、AI を介さずに Module の画面を開く**（launcher、§6.2、要件C3）。
//
// 「まずファイルを見たい」は AI に頼む用事ではない。Module が「入口である」と
// 名乗った Canvas を、Command Palette から直接開く。
//
// 見るのは3つ：
//   1. **その Project に繋がっている Module の入口だけ**が出る
//   2. 開くと**会話の隣に**開き、**会話は消えない**（fullscreen、§6.2）
//   3. **中身が本物**（tool の結果は無いので、Canvas が自分で取りに行く）
import { test, expect } from "@playwright/test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openApp } from "../helpers.js";

test.describe.configure({ mode: "serial" });
test.setTimeout(300_000);

const PROJECT_NAME = "E2E Launcher Project";

test("Command Palette の「Module の入口」から、AI を介さずに画面が開く", async ({ page }) => {
  const projectRoot = mkdtempSync(join(tmpdir(), "banto-e2e-launcher-"));
  const marker = `launcher-marker-${Date.now()}.txt`;
  writeFileSync(join(projectRoot, marker), "入口から見えるはず\n");

  const pageErrors: string[] = [];
  page.on("pageerror", (err) => pageErrors.push(err.message));

  await openApp(page);
  await page.getByRole("button", { name: "新しい Project", exact: true }).click();
  await page.getByLabel("Project 名").fill(PROJECT_NAME);
  await page.getByLabel("Base パス").fill(projectRoot);
  await page.getByRole("button", { name: "作成する" }).click();
  await expect(page.getByText(`Base Thread — ${PROJECT_NAME}`)).toBeVisible({ timeout: 15_000 });

  // ---- 1. 入口が出る（**AI には一言も頼んでいない**）---------------------
  await page.getByRole("button", { name: "検索（Command Palette）" }).click();
  await expect(page.getByText("Module の入口")).toBeVisible({ timeout: 30_000 });

  // FileSystem が名乗った名前と説明が、そのまま出ている（§6.2）
  const entry = page.getByRole("option", { name: /ファイル/ });
  await expect(entry).toBeVisible({ timeout: 15_000 });
  await expect(entry).toContainText("この Project の直下を見る");

  // 名乗っていない Module（shell・vault）の入口は出ない
  await expect(page.getByRole("option", { name: /shell|vault/i })).toHaveCount(0);

  // ---- 2. 開くと会話の隣。会話は消えない -------------------------------
  await entry.click();
  await expect(page.getByText(/^Canvas — filesystem$/), "入口から Canvas が開かなかった").toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByText(`Base Thread — ${PROJECT_NAME}`), "Canvas を開いたら会話が消えた").toBeVisible();

  // ---- 3. 中身が本物（Canvas が自分で取りに行く）------------------------
  await expect(
    page.frameLocator('[data-testid="module-canvas-frame"]').frameLocator("iframe").getByText(marker),
    "入口から開いた画面に中身が出ていない（自分で取りに行けていない）",
  ).toBeVisible({ timeout: 60_000 });

  // URL に残るので、リロードしても同じ面が開き直る
  await page.reload();
  await expect(page.getByText(/^Canvas — filesystem$/)).toBeVisible({ timeout: 30_000 });

  // ---- 4. 別タブでも出る（決定・2026-09-07）-----------------------------
  // **入口から開いた面は tool 呼び出しの記録を持たない**——別タブ側は
  // どの Project のどの Module かだけを URL から受け取って描き直す
  await page.setViewportSize({ width: 1280, height: 900 });
  const [tab] = await Promise.all([
    page.context().waitForEvent("page"),
    page.getByRole("button", { name: "別タブで開く" }).click(),
  ]);
  await expect(
    tab.frameLocator('[data-testid="module-canvas-frame"]').frameLocator("iframe").getByText(marker),
    "入口から開いた面が別タブで出ていない",
  ).toBeVisible({ timeout: 60_000 });
  await expect(
    page.getByText(/^Canvas — filesystem$/),
    "別タブへ出したのに元の Canvas が開いたまま",
  ).toBeHidden({ timeout: 15_000 });
  await tab.close();

  expect(pageErrors, `画面側で例外が出た: ${pageErrors.join(" / ")}`).toEqual([]);
});

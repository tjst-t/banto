// **AI が動いている Thread は、サイドバーの行のアイコンが回る**（決定・2026-10-03、ユーザー要望。v4-frontend.md §6.33）。
//
// 見るのは：
//   1. Base Thread で AI が動いている間だけ、その行のアイコンが回る輪になる（終われば元の吹き出しに戻る）
//   2. 走っている途中にリロードしても回っている——繋いだときの hello に、その時点で走っている Thread が載る
//   3. Fork で動いているときは、その Fork の行だけが回る（Base は回らない）

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, expect } from "../test-base.js";
import { confirmForkDialog, createProject, fakeTurn, openApp } from "../helpers.js";

// サイドバーが出る幅で見る
test.use({ viewport: { width: 1280, height: 800 } });

test("AI が動いている Thread は、サイドバーの行のアイコンが回る", async ({ page }) => {
  await openApp(page);
  await createProject(page, "回る印の spec", mkdtempSync(join(tmpdir(), "banto-e2e-running-")));

  const sidebar = page.locator('[data-slot="sidebar-container"]');
  const baseRow = sidebar.getByRole("link", { name: /Base Thread/ });
  await expect(baseRow).toBeVisible({ timeout: 15_000 });
  await expect(baseRow.getByTestId("thread-running"), "動いていないのに回っている").toHaveCount(0);

  // ---- 1・2. Base で動いている間だけ回る。途中でリロードしても回っている --------------
  const composer = page.getByPlaceholder(/に送る/);
  await composer.fill(`ゆっくり返して${fakeTurn({ say: "ゆっくり流れる返事です。".repeat(8), streamMs: 8_000 })}`);
  await composer.press("Enter");
  await expect(baseRow.getByTestId("thread-running"), "動いているのに回っていない").toBeVisible({ timeout: 15_000 });

  await page.reload();
  await expect(baseRow, "リロード後にサイドバーが出ない").toBeVisible({ timeout: 30_000 });
  await expect(
    baseRow.getByTestId("thread-running"),
    "走っている途中にリロードしたら回らなくなった（hello に走っている Thread が無い）",
  ).toBeVisible({ timeout: 15_000 });

  await expect(baseRow.getByTestId("thread-running"), "終わっても回り続けている").toHaveCount(0, {
    timeout: 60_000,
  });

  // ---- 3. Fork で動いているときは、その Fork の行だけ回る -----------------------------
  await page.getByRole("button", { name: "Fork を開く" }).click();
  await confirmForkDialog(page, { title: "回す Fork" });
  const forkRow = sidebar.getByRole("link", { name: /回す Fork/ });
  await expect(forkRow).toBeVisible({ timeout: 15_000 });
  const forkComposer = page.getByPlaceholder("この Fork Thread に送る");
  await forkComposer.fill(`ゆっくり返して${fakeTurn({ say: "Fork の返事です。".repeat(8), streamMs: 6_000 })}`);
  await forkComposer.press("Enter");
  await expect(forkRow.getByTestId("thread-running"), "Fork が動いているのに回っていない").toBeVisible({
    timeout: 15_000,
  });
  await expect(baseRow.getByTestId("thread-running"), "Fork が動いているのに Base まで回っている").toHaveCount(0);
  await expect(forkRow.getByTestId("thread-running"), "Fork が終わっても回り続けている").toHaveCount(0, {
    timeout: 60_000,
  });
});

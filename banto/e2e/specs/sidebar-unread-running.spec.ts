// **サイドバーで、どこで AI が動いていて、どこがまだ読まれていないかが見て分かる**（決定・2026-10-03、ユーザー要望。
// v4-frontend.md §6.33）。
//
// 見るのは：
//   1. いま開いていない Project のどれかの Thread で AI が動いている間、広いサイドバーのその Project の行のアイコンが回る
//   2. 終わって人がまだ開いていなければ、その Project の名前が太字になる。開けば太字でなくなる
//   3. いま開いている Project の中でも、まだ開いていない Thread（Fork）の名前は太字。開けば戻る
//   4. いま開いている Project の行は回らない（Thread の目次で分かる）
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, expect } from "../test-base.js";
import { confirmForkDialog, createProject, fakeTurn, openApp } from "../helpers.js";

test.use({ viewport: { width: 1280, height: 800 } });

test("いま開いていない Project で動いていれば回り、返ったあと開くまで太字", async ({ page }) => {
  await openApp(page);
  const sidebar = page.locator('[data-slot="sidebar-container"]');
  await createProject(page, "読む前の A", mkdtempSync(join(tmpdir(), "banto-e2e-unread-a-")));

  // ---- 3. 同じ Project の中：Fork で返事が来て、まだ開いていなければ太字 -------------------
  await page.getByRole("button", { name: "Fork を開く" }).click();
  await confirmForkDialog(page, { title: "あとで読む Fork" });
  const forkComposer = page.getByPlaceholder("この Fork Thread に送る");
  await forkComposer.fill(`返して${fakeTurn({ say: "Fork の返事です。".repeat(4), streamMs: 6_000 })}`);
  await forkComposer.press("Enter");
  // 走り始めたのを見てから、返事が終わる前に Base へ戻る（Fork は開いていない）
  const forkRow = sidebar.getByRole("link", { name: /あとで読む Fork/ });
  await expect(forkRow.getByTestId("thread-running"), "Fork のターンが始まらない").toBeVisible({ timeout: 15_000 });
  await page.getByRole("button", { name: /Base Thread に戻る$/ }).click();
  const forkName = sidebar.getByTestId("sidebar-fork-name").filter({ hasText: "あとで読む Fork" });
  await expect(forkName, "開いていない Fork に返事が来たのに太字にならない").toHaveAttribute("data-unread", "", { timeout: 30_000 });
  await expect(sidebar.getByTestId("sidebar-base-name").first(), "見ている Base まで太字になった").not.toHaveAttribute("data-unread", "");
  await sidebar.getByRole("link", { name: /あとで読む Fork/ }).click();
  await expect(forkName, "開いたのに太字のまま").not.toHaveAttribute("data-unread", "", { timeout: 15_000 });
  await page.getByRole("button", { name: /Base Thread に戻る$/ }).click();

  // ---- 1. A でゆっくり返させて、その間に B へ移る ---------------------------------------
  const composer = page.getByPlaceholder(/の Base Thread に送る/);
  await composer.fill(`ゆっくり${fakeTurn({ say: "ゆっくり流れる返事です。".repeat(8), streamMs: 8_000 })}`);
  await composer.press("Enter");
  const rowA = sidebar.getByRole("link", { name: /読む前の A/ }).first();
  // 4. いま開いている Project の行は回らない
  await expect(sidebar.getByTestId("thread-running").first()).toBeVisible({ timeout: 15_000 });
  await expect(rowA.getByTestId("project-running"), "いま開いている Project の行が回っている").toHaveCount(0);

  await createProject(page, "見ている B", mkdtempSync(join(tmpdir(), "banto-e2e-unread-b-")));
  await expect(rowA.getByTestId("project-running"), "開いていない Project で動いているのに回らない").toBeVisible({ timeout: 15_000 });

  // ---- 2. 終わると回るのをやめ、A の名前が太字。開くと戻る -----------------------------
  const nameA = rowA.getByTestId("sidebar-project-name");
  await expect(rowA.getByTestId("project-running"), "終わっても回り続けている").toHaveCount(0, { timeout: 60_000 });
  await expect(nameA, "返事が来たのに太字にならない").toHaveAttribute("data-unread", "", { timeout: 15_000 });
  await rowA.click();
  await expect(page.getByPlaceholder("読む前の A の Base Thread に送る")).toBeVisible({ timeout: 15_000 });
  await expect(nameA, "開いたのに太字のまま").not.toHaveAttribute("data-unread", "", { timeout: 15_000 });
  // B に戻っても A は太字に戻らない（読んだ）
  await sidebar.getByRole("link", { name: /見ている B/ }).first().click();
  await expect(page.getByPlaceholder("見ている B の Base Thread に送る")).toBeVisible({ timeout: 15_000 });
  await expect(nameA).not.toHaveAttribute("data-unread", "");
});

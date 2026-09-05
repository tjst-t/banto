// ステージ3（G1〜G3・G5）の回帰。Project設定のMemory一覧から人が直接
// 決定事項を足す→一覧に出る→取り消す→取り消し線になる、をブラウザで
// 一通り確認する。remember_decision toolによるAI側の自動記録は非決定的
// （project-thread-fork.spec.tsと同じ理由でAIの挙動そのものは検証しない）
// ——ここでは人が直接操作する経路だけを固定する。
import { test, expect } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CORE_BASE_URL, AUTH_TOKEN } from "../config.js";

test.describe.configure({ mode: "serial" });
test.use({ viewport: { width: 390, height: 844 } });

test("Memory一覧に人が直接足す→出る→取り消す→取り消し線になる", async ({ page }) => {
  const projectRoot = mkdtempSync(join(tmpdir(), "banto-e2e-memory-"));

  await page.goto(`/?bantoToken=${AUTH_TOKEN}&bantoHost=${CORE_BASE_URL}`);

  await page.getByRole("button", { name: "新しい Project", exact: true }).click();
  await page.getByLabel("Project 名").fill("E2E Memory Project");
  await page.getByLabel("Base パス").fill(projectRoot);
  await page.getByRole("button", { name: "作成する" }).click();
  await expect(page.getByText(/Base Thread —/)).toBeVisible({ timeout: 15_000 });

  await page.getByRole("button", { name: "Project 設定" }).click();
  await page.getByRole("button", { name: "Memory" }).click();

  await expect(page.getByText("まだ無い")).toBeVisible({ timeout: 10_000 });

  const draft = page.getByPlaceholder("決まったことを直接足す");
  await draft.fill("目印としてのメモ「メモリー確認741」");
  await page.getByRole("button", { name: "足す" }).click();

  const row = page.getByText("目印としてのメモ「メモリー確認741」");
  await expect(row).toBeVisible({ timeout: 10_000 });
  await expect(row).not.toHaveClass(/line-through/);

  await page.getByRole("button", { name: "この決定事項を取り消す" }).click();
  await expect(row).toHaveClass(/line-through/, { timeout: 10_000 });
  // 取り消し済みには取り消しボタンが無い（物理削除ではない、無効化のまま一覧に残る）
  await expect(page.getByRole("button", { name: "この決定事項を取り消す" })).not.toBeVisible();
});

// Global Memory（アーキ仕様§2.2、決定・2026-09-05）の回帰。
// /settings は大半がまだmockなので、**Global Memoryだけが出ていて、
// mockのセクションが出ていない**ことまで見る（規則13——繋がっていない入口を
// 画面に残さない。ここを見ないと、フラグを間違えてmock画面が復活しても気づけない）。
import { test, expect } from "@playwright/test";
import { CORE_BASE_URL, AUTH_TOKEN } from "../config.js";

test.describe.configure({ mode: "serial" });
test.use({ viewport: { width: 390, height: 844 } });

test("Global Memoryに人が足す→出る→取り消す→取り消し線になる", async ({ page }) => {
  await page.goto(`/settings?bantoToken=${AUTH_TOKEN}&bantoHost=${CORE_BASE_URL}`);

  // 繋がっているセクションだけがnavに出る
  await expect(page.getByRole("button", { name: "Global Memory" })).toBeVisible({ timeout: 15_000 });
  for (const mockSection of ["役割と Module", "既定値", "資格情報", "通知"]) {
    await expect(page.getByRole("button", { name: mockSection })).toHaveCount(0);
  }

  await page.getByRole("button", { name: "Global Memory" }).click();
  await expect(page.getByText("まだ無い")).toBeVisible({ timeout: 10_000 });

  const draft = page.getByPlaceholder("覚えておいてほしいことを足す");
  await draft.fill("呼び方は「たくみ」");
  await page.getByRole("button", { name: "足す" }).click();

  const row = page.getByText("呼び方は「たくみ」");
  await expect(row).toBeVisible({ timeout: 10_000 });
  await expect(row).not.toHaveClass(/line-through/);

  await page.getByRole("button", { name: "この記憶を取り消す" }).click();
  await expect(row).toHaveClass(/line-through/, { timeout: 10_000 });
  // 取り消し済みは無効化のまま一覧に残る（物理削除ではない、規則3）
  await expect(page.getByRole("button", { name: "この記憶を取り消す" })).not.toBeVisible();
});

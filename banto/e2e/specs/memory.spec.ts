// ステージ3（G1〜G3・G5）の回帰。Project設定のMemory一覧から人が直接
// 決定事項を足す→一覧に出る→取り消す→一覧から消える（改訂・2026-10-18、アーキ §2.2「取り消した行は見せない」）、をブラウザで
// 一通り確認する。remember_decision toolによるAI側の自動記録は非決定的
// （project-thread-fork.spec.tsと同じ理由でAIの挙動そのものは検証しない）
// ——ここでは人が直接操作する経路だけを固定する。
import { test, expect } from "../test-base.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CORE_BASE_URL, AUTH_TOKEN } from "../config.js";
import { createProject, openApp, openProjectSettings } from "../helpers.js";

test.describe.configure({ mode: "serial" });
test.use({ viewport: { width: 390, height: 844 } });

test("Memory一覧に人が直接足す→出る→取り消す→一覧から消える", async ({ page }) => {
  const projectRoot = mkdtempSync(join(tmpdir(), "banto-e2e-memory-"));

  await openApp(page);

  await createProject(page, "E2E Memory Project", projectRoot);

  // **設定画面は1つ**（§6.16）。全体の層に「Global Memory」が並んでいるので、
  // この Project の「Memory」は完全一致で選ぶ
  await openProjectSettings(page, "Memory");

  await expect(page.getByText("まだ無い")).toBeVisible({ timeout: 10_000 });

  const draft = page.getByPlaceholder("決まったことを直接足す");
  await draft.fill("目印としてのメモ「メモリー確認741」");
  await page.getByRole("button", { name: "足す" }).click();

  const row = page.getByText("目印としてのメモ「メモリー確認741」");
  await expect(row).toBeVisible({ timeout: 10_000 });

  await page.getByRole("button", { name: "この決定事項を取り消す" }).click();
  // 取り消した行は一覧に出さない（記録には残る。改訂・2026-10-18）
  await expect(row).toHaveCount(0, { timeout: 10_000 });
  await expect(page.getByText("まだ無い")).toBeVisible();
});

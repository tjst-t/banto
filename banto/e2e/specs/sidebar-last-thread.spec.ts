// **Project ごとに最後に開いた Thread を覚え、ほかの Project から名前を押して移るとそこを開く**
// （決定・2026-10-13、ユーザー要望。v4-frontend.md §6.40）。
//
// 見るのは：
//   1. A で Fork を開いたまま B へ移り、サイドバーの A の名前を押すと、A の Fork が開く
//   2. 読み込み直しても覚えている（localStorage）
//   3. いま見ている Project の名前を押したときは Base Thread へ戻る（今までどおり）
//   4. 覚えていた Fork を閉じたら、戻ったときは Base Thread
//   5. 畳んだレールの頭文字でも同じ
//   6. 名前を押すと目次も開け閉めする（いま見ている Project は切り替え、ほかの Project は開く）

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, expect } from "../test-base.js";
import { confirmForkDialog, createProject, openApp, openForkFromHeader } from "../helpers.js";

const A = "最後の Thread の spec A";
const B = "最後の Thread の spec B";

test("ほかの Project から名前を押して戻ると、その Project で最後に開いていた Thread が開く", async ({ page }) => {
  await openApp(page);
  await createProject(page, A, mkdtempSync(join(tmpdir(), "banto-e2e-lastthread-a-")));
  const sidebar = page.locator('[data-slot="sidebar"]');
  const projectLink = (name: string) => sidebar.getByTestId("sidebar-project-name").filter({ hasText: name }).first();

  // A で Fork を開く
  await openForkFromHeader(page);
  await confirmForkDialog(page, { title: "覚えておく Fork" });
  await expect(page).toHaveURL(/\?.*fork=/, { timeout: 15_000 });
  const aUrl = new URL(page.url());
  const aPath = aUrl.pathname;
  const forkId = aUrl.searchParams.get("fork")!;

  // B を作る（B へ移る）
  await createProject(page, B, mkdtempSync(join(tmpdir(), "banto-e2e-lastthread-b-")));
  await expect(page).not.toHaveURL(new RegExp(aPath), { timeout: 15_000 });

  // ---- 1. A の名前を押すと、A の Fork が開く ----
  await projectLink(A).click();
  await expect.poll(() => new URL(page.url()).pathname, { timeout: 15_000 }).toBe(aPath);
  await expect.poll(() => new URL(page.url()).searchParams.get("fork")).toBe(forkId);

  // ---- 2. 読み込み直しても覚えている（B へ移ってから読み込み直し、A を押す） ----
  await projectLink(B).click();
  await expect(page).not.toHaveURL(new RegExp(aPath), { timeout: 15_000 });
  await page.reload();
  await projectLink(A).click();
  await expect.poll(() => new URL(page.url()).searchParams.get("fork"), { timeout: 15_000 }).toBe(forkId);

  // ---- 3. いま見ている Project の名前を押すと Base Thread ----
  await projectLink(A).click();
  await expect.poll(() => new URL(page.url()).searchParams.get("fork"), { timeout: 15_000 }).toBeNull();
  await expect.poll(() => new URL(page.url()).pathname).toBe(aPath);

  // ---- 6. 名前を押すと目次も開け閉めする（2026-10-18、ユーザー要望）——いま見ている Project なら切り替え、
  //         ほかの Project なら（畳んでいても）開く ----
  const forkLink = sidebar.getByTestId("sidebar-fork-name").filter({ hasText: "覚えておく Fork" });
  await expect(forkLink).toHaveCount(0); // 3. で押したので畳んだ
  await projectLink(A).click();
  await expect(forkLink).toHaveCount(1);
  await projectLink(A).click();
  await expect(forkLink).toHaveCount(0);
  await projectLink(B).click();
  await expect(page).not.toHaveURL(new RegExp(aPath), { timeout: 15_000 });
  await projectLink(A).click();
  await expect.poll(() => new URL(page.url()).pathname, { timeout: 15_000 }).toBe(aPath);
  await expect(forkLink).toHaveCount(1);

  // ---- 5. 畳んだレールでも同じ（Base を見たので、A は Base を覚えている。Fork へ戻してから） ----
  await sidebar.getByRole("link", { name: "覚えておく Fork" }).click();
  await expect.poll(() => new URL(page.url()).searchParams.get("fork"), { timeout: 15_000 }).toBe(forkId);
  await projectLink(B).click();
  await expect(page).not.toHaveURL(new RegExp(aPath), { timeout: 15_000 });
  await page.keyboard.press("Control+b");
  // 畳んだレールの頭文字は名前を Tooltip に持つので、行き先（href）で探す。見えている sidebar だけ
  await page.locator(`[data-slot="sidebar-container"] a[href^="${aPath}"]:visible`).first().click();
  await expect.poll(() => new URL(page.url()).searchParams.get("fork"), { timeout: 15_000 }).toBe(forkId);
  await page.keyboard.press("Control+b");

  // ---- 4. 覚えていた Fork を閉じたら、戻ったときは Base ----
  const forkRow = sidebar.getByTestId("sidebar-fork-name").filter({ hasText: "覚えておく Fork" }).first()
    .locator("xpath=ancestor::*[@data-sortable-id][1]");
  await forkRow.hover();
  await forkRow.getByTestId("sidebar-item-more").first().click();
  await page.getByRole("menuitem", { name: /閉じる|Close/ }).first().click();
  const confirm = page.getByRole("alertdialog");
  if (await confirm.isVisible().catch(() => false)) await confirm.getByRole("button", { name: /閉じる/ }).last().click();
  await expect(sidebar.getByTestId("sidebar-fork-name").filter({ hasText: "覚えておく Fork" })).toHaveCount(0, { timeout: 15_000 });
  await projectLink(B).click();
  await expect(page).not.toHaveURL(new RegExp(aPath), { timeout: 15_000 });
  await projectLink(A).click();
  await expect.poll(() => new URL(page.url()).pathname, { timeout: 15_000 }).toBe(aPath);
  await expect.poll(() => new URL(page.url()).searchParams.get("fork")).toBeNull();
});

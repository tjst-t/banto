// サイドバー（決定・2026-09-09、ユーザー指摘「幅が狭くてアイコンしか出ないので
// Project 名が読めない」）の回帰。**デスクトップ幅**で、
//   - Project 名が読めること
//   - その下に Thread の目次（Base Thread ＋ 開いている Fork）が並ぶこと
//   - 目次から Base ⇄ Fork を行き来できること
//   - 畳む／開くが効き、**別のルートへ移っても畳んだままである**こと
// を見る。Base/Fork が横に並ぶ幅なので、同じ名前の要素が複数出る
// （panel-stack.tsx）——探すときは必ずサイドバーの中に絞る。
import { test, expect } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProject, openApp } from "../helpers.js";
import type { Locator } from "@playwright/test";

test.describe.configure({ mode: "serial" });

const PROJECT_NAME = "E2E Sidebar Project";

/** 幅は200msかけて変わる（transition-[width]）——止まるまで待ってから測る
 *  （待ち時間を決め打ちしない、規則6） */
async function expectSidebarWidth(sidebar: Locator, expected: number): Promise<void> {
  await expect
    .poll(async () => Math.round((await sidebar.boundingBox())?.width ?? 0), { timeout: 5_000 })
    .toBe(expected);
}

test("サイドバー：Project 名と Thread の目次が読めて、畳んだ状態が残る", async ({ page }) => {
  const projectRoot = mkdtempSync(join(tmpdir(), "banto-e2e-"));

  await openApp(page);

  await createProject(page, PROJECT_NAME, projectRoot);

  const sidebar = page.locator('[data-slot="sidebar-container"]');

  // ---- 名前が読める（アイコンだけではない）--------------------------------
  await expect(sidebar.getByRole("link", { name: PROJECT_NAME })).toBeVisible({ timeout: 15_000 });
  await expect(sidebar.getByRole("link", { name: "Base Thread" })).toBeVisible();
  await expectSidebarWidth(sidebar, 256);

  // ---- Fork を作ると、目次に並ぶ ------------------------------------------
  await page.getByRole("button", { name: "Fork を開く" }).click();
  const forkRow = sidebar.getByRole("link", { name: "Fork 1" });
  await expect(forkRow, "目次に Fork が出ていない").toBeVisible({ timeout: 15_000 });
  // いま開いている行が選択中として出る（どこにいるかが目次で分かる）
  await expect(forkRow).toHaveAttribute("data-active", "true");
  await expect(sidebar.getByRole("link", { name: "Base Thread" })).toHaveAttribute(
    "data-active",
    "false",
  );

  // ---- 目次から Base Thread へ戻れる --------------------------------------
  await sidebar.getByRole("link", { name: "Base Thread" }).click();
  await expect(page).toHaveURL(/\/p\/[0-9a-f-]+$/, { timeout: 15_000 });
  await expect(sidebar.getByRole("link", { name: "Base Thread" })).toHaveAttribute(
    "data-active",
    "true",
  );

  // ---- 畳む／開く ---------------------------------------------------------
  await sidebar.getByRole("button", { name: "サイドバーを畳む" }).click();
  await expect(sidebar.getByRole("link", { name: PROJECT_NAME })).toBeHidden({ timeout: 5_000 });
  await expectSidebarWidth(sidebar, 58);

  // **別のルートへ移っても畳んだまま**——/settings と /p/[id] はレイアウトが
  // 別なので、覚えていないと行き来のたびに開いてしまう（実装：localStorage）
  await sidebar.getByRole("link", { name: "設定" }).click();
  await expect(page).toHaveURL(/\/settings$/, { timeout: 15_000 });
  await expectSidebarWidth(sidebar, 58);

  await sidebar.getByRole("button", { name: "サイドバーを開く（⌘B / Ctrl-B）" }).click();
  await expect(sidebar.getByRole("link", { name: PROJECT_NAME })).toBeVisible({ timeout: 5_000 });
  await expectSidebarWidth(sidebar, 256);

  // ---- ドラッグで幅を変える（決定・2026-09-09、ユーザー要望）--------------
  const handle = sidebar.getByRole("separator", { name: "サイドバーの幅" });
  const box = (await handle.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + 200);
  await page.mouse.down();
  await page.mouse.move(360, box.y + 200, { steps: 10 });
  await page.mouse.up();
  await expectSidebarWidth(sidebar, 360);

  // 上限で止まる（画面いっぱいまで広がらない）
  await page.mouse.move(360, box.y + 200);
  await page.mouse.down();
  await page.mouse.move(900, box.y + 200, { steps: 10 });
  await page.mouse.up();
  await expectSidebarWidth(sidebar, 480);

  // 下限で止まる
  await page.mouse.move(480, box.y + 200);
  await page.mouse.down();
  await page.mouse.move(20, box.y + 200, { steps: 10 });
  await page.mouse.up();
  await expectSidebarWidth(sidebar, 200);

  // 変えた幅はリロードしても残る（畳んだ状態と同じ扱いで覚える）
  await page.reload();
  await expect(sidebar.getByRole("link", { name: PROJECT_NAME })).toBeVisible({ timeout: 30_000 });
  await expectSidebarWidth(sidebar, 200);

  // キーボードでも動かせる（マウスでしか変えられない寸法にしない）
  await handle.focus();
  await page.keyboard.press("ArrowRight");
  await expectSidebarWidth(sidebar, 216);

  // ダブルクリックで既定に戻る
  await handle.dblclick();
  await expectSidebarWidth(sidebar, 256);
});

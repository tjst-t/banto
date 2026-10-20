// 会話と Canvas の境をつかんで大きさを変える（修正・2026-10-20、ユーザー報告：「小さくしようとしても小さくならない」
// 「クリックをやめても大きさの変更が続く」。v4-frontend.md §6.9）。
//
// 見るのは：
//   1. 境を右へ（Canvas の iframe の上を通って）動かすと、Canvas が画面の半分より小さくなる
//   2. 左へ動かすと大きくなる
//   3. 離したあとマウスを動かしても、大きさは変わらない（iframe の上で離しても）
//   4. 掴んでいる間だけ iframe がポインタを取らない印が立ち、離せば消える
import { test, expect, type Page } from "../test-base.js";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProject, openApp, waitForProjectModule, openPaletteEntry } from "../helpers.js";

test.setTimeout(180_000);
test.use({ viewport: { width: 1400, height: 900 } });

const PROJECT_NAME = "E2E Canvas Resize";

async function canvasWidth(page: Page) {
  return page.locator('[data-layer="canvas"]').evaluate((el) => el.getBoundingClientRect().width);
}

test("会話と Canvas の境を iframe の上へ動かして小さく・大きくでき、離したら止まる", async ({ page }) => {
  const projectRoot = mkdtempSync(join(tmpdir(), "banto-e2e-canvas-resize-"));
  writeFileSync(join(projectRoot, "notes.txt"), "メモ\n");
  await openApp(page);
  await createProject(page, PROJECT_NAME, projectRoot);
  await waitForProjectModule(page, PROJECT_NAME, "filesystem");
  await openPaletteEntry(page, /ファイル/);
  await expect(page.getByText(/^Canvas — filesystem$/)).toBeVisible({ timeout: 30_000 });
  const fs = page.locator('[data-testid="module-canvas-frame"]').contentFrame().frameLocator("iframe");
  await expect(fs.locator('.tree-body > .row[data-path="notes.txt"]')).toBeVisible({ timeout: 60_000 });

  const split = page.getByRole("separator", { name: "Base Thread と Canvas の境界" });
  const container = await page.locator('[data-layer="canvas"]').evaluate((el) => {
    const r = el.parentElement!.getBoundingClientRect();
    return { left: r.left, width: r.width };
  });
  const before = await canvasWidth(page);
  const box = (await split.boundingBox())!;
  const y = box.y + box.height / 2;
  const x0 = box.x + box.width / 2;

  // ---- 1. 右へ（Canvas の iframe の上を通って）動かすと、Canvas が半分より小さくなる ----
  await page.mouse.move(x0, y);
  await page.mouse.down();
  await expect(page.locator("html")).toHaveAttribute("data-canvas-resizing", "");
  const target = container.left + container.width * 0.7;
  await page.mouse.move(target, y, { steps: 20 });
  await expect.poll(() => canvasWidth(page)).toBeLessThan(container.width * 0.5);
  // 3. iframe の上で離す。そのあとマウスを動かしても変わらない
  await page.mouse.up();
  await expect(page.locator("html")).not.toHaveAttribute("data-canvas-resizing");
  const afterShrink = await canvasWidth(page);
  expect(afterShrink).toBeLessThan(before);
  await page.mouse.move(container.left + container.width * 0.4, y, { steps: 10 });
  await page.mouse.move(container.left + container.width * 0.6, y, { steps: 10 });
  await page.waitForTimeout(300);
  expect(await canvasWidth(page), "離したのに大きさが変わり続けた").toBe(afterShrink);

  // ---- 2. 左へ動かすと大きくなる ----
  const box2 = (await split.boundingBox())!;
  await page.mouse.move(box2.x + box2.width / 2, y);
  await page.mouse.down();
  await page.mouse.move(container.left + container.width * 0.3, y, { steps: 20 });
  await page.mouse.up();
  await expect.poll(() => canvasWidth(page)).toBeGreaterThan(afterShrink + container.width * 0.2);
  await expect(page.locator("html")).not.toHaveAttribute("data-canvas-resizing");
});

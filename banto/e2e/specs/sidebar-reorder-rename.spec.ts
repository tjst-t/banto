// **左のサイドバーで、並べ替えと名前の変更ができる**（決定・2026-09-11、ユーザー要望）。
//
// 見るのは「操作が通った」ではなく**中身**（規則14）——並びは一覧の文字列そのもの、
// 名前は変えた先の文字が出ているところまで。さらに**リロードしても残る**
// （＝host が持っている。ブラウザの覚えではない、規則3）。

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, expect, type Locator, type Page } from "@playwright/test";
import { CORE_BASE_URL, AUTH_TOKEN } from "../config.js";
import { createProject, openApp } from "../helpers.js";

test.setTimeout(300_000);

/**
 * その名前の行の**掴む／右クリックする場所**。
 *
 * **行（`li`）そのものを指さない**（実測・2026-09-11）。開いている Project の
 * 行は下にぶら下がる目次まで含むので、(1) 真ん中を押すと Base Thread の行に
 * 当たり、(2) 文字で絞ると Fork の名前でも**親の Project の行**に当たる
 * ——「Fork の名前を変える」つもりで Project の名前を変えていた。
 * 名前そのものから、いちばん近い取っ手へ辿る。
 */
function handleOf(name: Locator) {
  return name.first().locator('xpath=ancestor::*[@data-slot="context-menu-trigger"][1]');
}

function projectHandle(page: Page, name: string) {
  return handleOf(page.getByTestId("sidebar-project-name").filter({ hasText: name }));
}

function forkHandle(page: Page, name: string) {
  return handleOf(page.getByTestId("sidebar-fork-name").filter({ hasText: name }));
}

/** サイドバーに出ている Project 名を、上から順に */
async function projectNames(page: Page): Promise<string[]> {
  return page.getByTestId("sidebar-project-name").allTextContents();
}

test("Project を掴んで並べ替えられる——リロードしても残る", async ({ page }) => {
  await openApp(page);
  await createProject(page, "並びA", mkdtempSync(join(tmpdir(), "banto-e2e-order-a-")));
  await createProject(page, "並びB", mkdtempSync(join(tmpdir(), "banto-e2e-order-b-")));

  const before = await projectNames(page);
  expect(before.slice(-2), "作った2つが一覧の末尾に並んでいない").toEqual(["並びA", "並びB"]);

  // B を A の上へ運ぶ。**先に画面へ入れる**——一覧は Project が増えると
  // スクロールするので、見えていない行の座標へマウスを動かしても
  // そこには別のもの（一覧の外）がある（実測・2026-09-11：15件あると掴めない）
  const a = projectHandle(page, "並びA");
  const b = projectHandle(page, "並びB");
  await b.scrollIntoViewIfNeeded();
  await a.scrollIntoViewIfNeeded();
  const box = await a.boundingBox();
  const from = await b.boundingBox();
  await page.mouse.move(from!.x + from!.width / 2, from!.y + from!.height / 2);
  await page.mouse.down();
  // 8px 動かして初めて掴む（押しただけでは動かない）ので、途中の点も踏む
  await page.mouse.move(from!.x + from!.width / 2, from!.y + from!.height / 2 - 12, { steps: 5 });
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2 - 2, { steps: 10 });
  // 掴めていることを、落とす前に確かめる（掴めていなければここで分かる）
  await expect(page.locator("[data-dragging]"), "掴めていない").toHaveCount(1);
  await page.mouse.up();

  await expect
    .poll(async () => (await projectNames(page)).slice(-2), { timeout: 10_000 })
    .toEqual(["並びB", "並びA"]);

  // **host が持っている**——リロードしても、別の経路（API）から見ても同じ
  await page.reload();
  await expect(page.locator('[data-slot="sidebar"]')).toBeVisible({ timeout: 30_000 });
  await expect.poll(async () => (await projectNames(page)).slice(-2), { timeout: 30_000 }).toEqual([
    "並びB",
    "並びA",
  ]);
  const listed = (await (
    await page.request.get(`${CORE_BASE_URL}/api/projects`, {
      headers: { authorization: `Bearer ${AUTH_TOKEN}` },
    })
  ).json()) as Array<{ name: string }>;
  expect(listed.map((p) => p.name).slice(-2)).toEqual(["並びB", "並びA"]);
});

test("右クリックのメニューから、Project の名前を変えられる", async ({ page }) => {
  await openApp(page);
  await createProject(page, "まえの名前", mkdtempSync(join(tmpdir(), "banto-e2e-rename-")));

  await projectHandle(page, "まえの名前").click({ button: "right" });
  await page.getByRole("menuitem", { name: "名前を変える…" }).click();

  const dialog = page.getByTestId("rename-dialog");
  await expect(dialog).toBeVisible({ timeout: 10_000 });
  // **いまの名前から始まる**（打ち直しを強いない）
  await expect(dialog.getByLabel("名前")).toHaveValue("まえの名前");
  await dialog.getByLabel("名前").fill("あとの名前");
  await dialog.getByRole("button", { name: "保存する" }).click();
  await expect(dialog).toBeHidden({ timeout: 10_000 });

  await expect(page.locator('[data-slot="sidebar"]').getByText("あとの名前")).toBeVisible();
  await page.reload();
  await expect(
    page.locator('[data-slot="sidebar"]').getByText("あとの名前"),
    "リロードしたら元の名前に戻った（host が持っていない）",
  ).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('[data-slot="sidebar"]').getByText("まえの名前")).toHaveCount(0);
});

test("Fork も、メニューから名前を変えられる・並べ替えられる", async ({ page }) => {
  await openApp(page);
  await createProject(page, "Fork の並び", mkdtempSync(join(tmpdir(), "banto-e2e-forkorder-")));

  // Fork を2つ作る（会話は要らない——分ける操作だけ）
  for (let i = 0; i < 2; i += 1) {
    await page.getByRole("button", { name: "Fork を開く" }).click();
    const back = page.getByRole("button", { name: /Base Thread に戻る$/ });
    await expect(back).toBeVisible({ timeout: 15_000 });
    await back.click();
    await expect(back).toBeHidden({ timeout: 15_000 });
  }

  const forkRows = page.getByTestId("sidebar-fork-name");
  await expect
    .poll(async () => forkRows.allTextContents(), { timeout: 15_000 })
    .toEqual(["Fork 1", "Fork 2"]);

  // 名前を変える
  await forkHandle(page, "Fork 1").click({ button: "right" });
  await page.getByRole("menuitem", { name: "名前を変える…" }).click();
  const dialog = page.getByTestId("rename-dialog");
  await expect(dialog).toBeVisible({ timeout: 10_000 });
  await dialog.getByLabel("名前").fill("設計の枝");
  await dialog.getByRole("button", { name: "保存する" }).click();
  await expect(dialog).toBeHidden({ timeout: 10_000 });
  await expect.poll(async () => forkRows.allTextContents(), { timeout: 10_000 }).toEqual([
    "設計の枝",
    "Fork 2",
  ]);

  // メニューから並べ替える（掴めない場面でも並べ替えられる）
  await forkHandle(page, "Fork 2").click({ button: "right" });
  await page.getByRole("menuitem", { name: "上へ移動" }).click();
  await expect.poll(async () => forkRows.allTextContents(), { timeout: 10_000 }).toEqual([
    "Fork 2",
    "設計の枝",
  ]);

  // **どちらも host が持っている**
  await page.reload();
  await expect(page.locator('[data-slot="sidebar"]')).toBeVisible({ timeout: 30_000 });
  await expect.poll(async () => forkRows.allTextContents(), { timeout: 30_000 }).toEqual([
    "Fork 2",
    "設計の枝",
  ]);
});

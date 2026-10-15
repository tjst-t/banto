// **表（xlsx）を計算し直した値で読む**（v4-modules.md §2.2「PDF・Office…」の xlsx、Backlog #306、2026-10-15）。
//
// AI の showFile が xlsx を指すと、host は PDF と同じ画面（`ui://banto-filesystem/document`）を選び、画面は表の面で描く。
// 値は変換役（LibreOffice、道具用のコンテナ）が計算し直した写しから読む——openpyxl で作った xlsx には式の値が無い
// （`<v />`）。規則14——「開けた」で終わらせず、画面が出している中身を一つずつ見る：式の値（書式つき）・別のシートを指す式・
// 結合・列の幅・3枚のシートのタブと切り替えた先の中身・「LibreOffice で計算した値」の断り・選んだセルの番地と式・
// セルへのコメント・大きく開いた画面・大きすぎる表の理由。
import { test, expect, type FrameLocator, type Page } from "../test-base.js";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProject, fakeTurn, openApp, waitForProjectModule } from "../helpers.js";
import { makeOpenpyxlXlsx } from "../office-fixture.js";

// 変換役を初めて使う回は、道具用のコンテナを作り LibreOffice 一式（約600MB）を入れる——数分
test.setTimeout(900_000);

const PROJECT = "E2E FS XLSX";

/** 大きく開いた表の画面（会話の隣）。枠がいくつあっても、表が出ている最後の枠を選ぶ */
async function fullscreenSheet(page: Page): Promise<FrameLocator> {
  const frames = page.locator('[data-testid="module-canvas-frame"]');
  let index = -1;
  await expect(async () => {
    const count = await frames.count();
    for (let i = count - 1; i >= 0; i -= 1) {
      const inner = frames.nth(i).contentFrame().frameLocator("iframe");
      const mode = await inner.locator("body").getAttribute("data-mode", { timeout: 1_000 }).catch(() => null);
      if (mode === "fullscreen" && (await inner.getByTestId("sheet-grid").isVisible().catch(() => false))) {
        index = i;
        return;
      }
    }
    throw new Error(`大きく開いた表の画面が無い（枠は ${count} 個）`);
  }).toPass({ timeout: 60_000 });
  return frames.nth(index).contentFrame().frameLocator("iframe");
}

const cell = (view: FrameLocator, address: string) => view.locator(`[data-cell="${address}"]`);

/** 1枚目のシート（売上）の中身を、画面に出ている形で一つずつ見る */
async function expectSalesSheet(view: FrameLocator): Promise<void> {
  await expect(view.getByTestId("sheet-tab")).toHaveText(["売上", "集計", "メモ"]);
  await expect(view.locator('[data-testid="sheet-tab"][aria-selected="true"]')).toHaveText("売上");
  // 見出しと文字
  for (const [address, text] of [
    ["A1", "品目"],
    ["B1", "数量"],
    ["D1", "金額"],
    ["A2", "りんご"],
    ["B2", "12"],
    ["C2", "100"],
    ["C3", "45.5"],
    ["A4", "合計"],
  ]) await expect(cell(view, address!), `${address} の中身`).toHaveText(text!);
  // **式の値**（元のファイルには入っていない）。合計は `#,##0` の書式で
  await expect(cell(view, "D2"), "B2*C2 の値が出ていない").toHaveText("1200");
  await expect(cell(view, "D3"), "B3*C3 の値が出ていない").toHaveText("1365");
  await expect(cell(view, "D4"), "SUM(D2:D3) が書式つきで出ていない").toHaveText("2,565");
  // 数は右に寄る
  expect(await cell(view, "D2").evaluate((e) => getComputedStyle(e).justifyContent)).toBe("flex-end");
  // 結合したセルは A6:D6 を1つで覆う（B6〜D6 は描かない）
  await expect(cell(view, "A6")).toHaveText("結合したセル");
  await expect(cell(view, "A6")).toHaveAttribute("data-merge", "A6:D6");
  for (const address of ["B6", "C6", "D6"]) await expect(cell(view, address)).toHaveCount(0);
  const width = (address: string) => cell(view, address).evaluate((e) => e.getBoundingClientRect().width);
  const merged = await width("A6");
  expect(Math.abs(merged - ((await width("A1")) + (await width("B1")) + (await width("C1")) + (await width("D1"))))).toBeLessThanOrEqual(1);
  // 列の幅：A は 20 字（140px）、ほかは既定（64px）
  expect(await width("A1")).toBeCloseTo(140, 0);
  expect(await width("B1")).toBeCloseTo(64, 0);
  await expect(view.getByTestId("sheet-recalc-note")).toHaveText("LibreOffice で計算し直した値です（Excel と違うことがあります）");
}

test("openpyxl で作った式入りの xlsx を、計算し直した値の表で読む——3枚のシートを切り替え、セルにコメントを付け、大きく開いても読める", async ({ page }) => {
  const projectRoot = mkdtempSync(join(tmpdir(), "banto-e2e-fsxlsx-"));
  try {
    mkdirSync(join(projectRoot, "data"));
    writeFileSync(join(projectRoot, "data/sales.xlsx"), makeOpenpyxlXlsx());
    writeFileSync(join(projectRoot, "data/big.xlsx"), Buffer.alloc(7 * 1024 * 1024 + 1));
    const pageErrors: string[] = [];
    page.on("pageerror", (err) => pageErrors.push(err.message));

    await openApp(page);
    await createProject(page, PROJECT, projectRoot);
    await waitForProjectModule(page, PROJECT, "filesystem");

    const composer = page.getByPlaceholder(/に送る/);
    await composer.fill("売上の表を見せて。" + fakeTurn({ tools: [{ server: "filesystem", name: "showFile", args: { path: "data/sales.xlsx" } }] }));
    await composer.press("Enter");

    // ---- 会話の中：document の画面の表の面 ----------------------------------------------
    const embed = page.locator('[data-testid="inline-module-view"][data-module="filesystem"]');
    await expect(embed).toBeVisible({ timeout: 120_000 });
    const card = page.frameLocator('[data-testid="module-canvas-frame"]').frameLocator("iframe");
    await expect(card.locator("body")).toHaveAttribute("data-surface", "document", { timeout: 60_000 });
    await expect(card.getByTestId("sheet-view")).toBeVisible();
    await expect(card.getByTestId("pdf-view")).toHaveCount(0);
    await expect(card.getByTestId("docx-view")).toHaveCount(0);
    await expect(card.getByTestId("open-path")).toHaveText("data/sales.xlsx");
    // 初めて使う回は変換役を入れる（数分）。表が出るまで待つ——出たら中身を見る
    await expect(card.getByTestId("sheet-grid"), "計算し直した表が出ない").toBeVisible({ timeout: 840_000 });
    await expect(card.getByTestId("sheet-error-state")).toHaveCount(0);
    await expectSalesSheet(card);

    // ---- 3枚のシートを切り替える ----------------------------------------------------------
    await card.getByTestId("sheet-tab").filter({ hasText: "集計" }).click();
    await expect(card.locator('[data-testid="sheet-tab"][aria-selected="true"]')).toHaveText("集計");
    await expect(cell(card, "A1")).toHaveText("売上の合計");
    await expect(cell(card, "B1"), "別のシートを指す式（売上!D4）の値が出ていない").toHaveText("2,565");
    await expect(cell(card, "D2"), "前のシートのセルが残っている").toHaveCount(0);
    await card.getByTestId("sheet-tab").filter({ hasText: "メモ" }).click();
    await expect(card.locator('[data-testid="sheet-tab"][aria-selected="true"]')).toHaveText("メモ");
    await expect(cell(card, "A1")).toHaveText("三枚目のシート");
    await expect(cell(card, "B1"), "前のシートのセルが残っている").toHaveCount(0);
    await card.getByTestId("sheet-tab").filter({ hasText: "売上" }).click();
    await expect(cell(card, "D4")).toHaveText("2,565");

    // ---- セルを選ぶと番地と値・式が出て、コメントを付けられる -------------------------------------
    await cell(card, "D4").click();
    await expect(card.getByTestId("sheet-address")).toHaveText("D4");
    await expect(card.getByTestId("sheet-value")).toHaveText("2,565　=SUM(D2:D3)");
    await cell(card, "D2").click();
    await cell(card, "D3").click({ modifiers: ["Shift"] });
    await expect(card.getByTestId("sheet-address")).toHaveText("D2:D3");
    await expect(card.getByTestId("sheet-selection")).toHaveAttribute("data-range", "D2:D3");
    await card.getByTestId("comments-toggle").click();
    await card.getByTestId("comment-for-cell").click();
    await expect(card.getByTestId("comment-draft-anchor")).toHaveText("`売上!D2:D3`（値 1200、1365）");
    await card.getByTestId("comment-input").fill("金額は税込か確かめて");
    await card.getByTestId("comment-add").click();
    const item = card.getByTestId("comment-item");
    await expect(item).toHaveCount(1);
    await expect(item.getByTestId("comment-anchor")).toHaveText("`売上!D2:D3`（値 1200、1365）");
    await expect(item.getByTestId("comment-body")).toHaveText("金額は税込か確かめて");
    await expect(card.getByTestId("comments-count")).toHaveText("コメント（1件）");
    // 別のシートから一覧を押すと、そのシートのそのセルへ飛ぶ
    await card.getByTestId("sheet-tab").filter({ hasText: "メモ" }).click();
    await item.getByTestId("comment-anchor").click();
    await expect(card.locator('[data-testid="sheet-tab"][aria-selected="true"]')).toHaveText("売上");
    await expect(card.getByTestId("sheet-address")).toHaveText("D2:D3");

    // ---- 大きく開く：同じ表とコメントが出る ----------------------------------------------------
    await card.getByRole("button", { name: "大きく表示" }).click();
    await expect(page.getByText(/^Canvas — filesystem$/)).toBeVisible({ timeout: 30_000 });
    const full = await fullscreenSheet(page);
    await expect(full.getByTestId("open-path")).toHaveText("data/sales.xlsx");
    await expect(full.getByRole("button", { name: "大きく表示" })).toBeHidden();
    await expectSalesSheet(full);
    await full.getByTestId("comments-toggle").click();
    await expect(full.getByTestId("comment-item").getByTestId("comment-body")).toHaveText("金額は税込か確かめて");

    // ---- 大きすぎる表は理由を出す（白い画面のままにしない）-----------------------------------------
    await page.getByRole("button", { name: "閉じる" }).first().click().catch(() => undefined);
    await composer.fill("大きな表を見せて。" + fakeTurn({ tools: [{ server: "filesystem", name: "showFile", args: { path: "data/big.xlsx" } }] }));
    await composer.press("Enter");
    const bigCard = page.frameLocator('[data-testid="module-canvas-frame"]').last().frameLocator("iframe");
    await expect(bigCard.getByTestId("open-path")).toHaveText("data/big.xlsx", { timeout: 120_000 });
    await expect(bigCard.getByTestId("sheet-error")).toContainText("大きすぎて変換できません（7MB まで）", { timeout: 60_000 });
    await expect(bigCard.getByTestId("sheet-grid")).toBeHidden();

    expect(pageErrors, "画面で例外が出た").toEqual([]);
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});
